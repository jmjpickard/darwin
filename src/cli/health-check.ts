#!/usr/bin/env tsx
/**
 * Health Check - Verify Darwin dependencies are available
 *
 * Usage: npm run test:health
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { loadConfig } from '../core/config.js';

const execAsync = promisify(exec);

interface CheckResult {
  name: string;
  ok: boolean;
  message: string;
}

async function checkOllama(): Promise<CheckResult> {
  try {
    const response = await fetch('http://localhost:11434/api/tags');
    if (response.ok) {
      return { name: 'Ollama', ok: true, message: 'Running' };
    }
    return { name: 'Ollama', ok: false, message: `Status ${response.status}` };
  } catch {
    return { name: 'Ollama', ok: false, message: 'Not running. Run: ollama serve' };
  }
}

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

async function checkModels(provider: 'ollama' | 'openrouter', model: string, apiKey?: string): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  if (provider === 'openrouter') {
    if (!apiKey) {
      results.push({
        name: 'OpenRouter API key',
        ok: false,
        message: 'Not configured. Set openrouter.apiKey in config',
      });
      return results;
    }

    try {
      const response = await fetch(`${OPENROUTER_BASE_URL}/models`, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
        },
      });

      if (!response.ok) {
        results.push({
          name: 'OpenRouter models',
          ok: false,
          message: `Failed to fetch models: ${response.status}`,
        });
        return results;
      }

      const data = await response.json() as { data: Array<{ id: string }> };
      const models = data.data?.map(m => m.id) || [];
      const hasBrainModel = models.some(m => m === model || m.includes(model));
      results.push({
        name: `OpenRouter model (${model})`,
        ok: hasBrainModel,
        message: hasBrainModel ? 'Available' : 'Not found in OpenRouter model list',
      });
    } catch (error) {
      results.push({ name: 'OpenRouter models', ok: false, message: String(error) });
    }

    return results;
  }

  try {
    const response = await fetch('http://localhost:11434/api/tags');
    const data = await response.json() as { models: Array<{ name: string }> };
    const models = data.models?.map(m => m.name) || [];

    const hasBrainModel = models.some(m => m.includes(model));
    results.push({
      name: `Ollama model (${model})`,
      ok: hasBrainModel,
      message: hasBrainModel ? 'Available' : `Not found. Darwin will pull on startup, or run: ollama pull ${model}`,
    });
  } catch {
    results.push({ name: 'Models', ok: false, message: 'Could not check (Ollama not running)' });
  }

  return results;
}

async function testBrainModel(model: string): Promise<CheckResult> {
  try {
    const response = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: 'Say "ready" if you can hear me.',
        stream: false,
        options: { num_predict: 10 },
      }),
    });

    if (!response.ok) {
      return { name: 'Brain model test', ok: false, message: `Error: ${response.status}` };
    }

    const data = await response.json() as { response: string };
    return {
      name: 'Brain model test',
      ok: true,
      message: `Response: "${data.response.slice(0, 50).trim()}"`,
    };
  } catch (error) {
    return { name: 'Brain model test', ok: false, message: String(error) };
  }
}

async function testOpenRouterModel(model: string, apiKey: string): Promise<CheckResult> {
  try {
    const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://darwin.local',
        'X-Title': 'Darwin Home Intelligence',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Say "ready" if you can hear me.' }],
        max_tokens: 10,
        temperature: 0.2,
      }),
    });

    if (!response.ok) {
      return { name: 'OpenRouter model test', ok: false, message: `Error: ${response.status}` };
    }

    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content || '';
    return {
      name: 'OpenRouter model test',
      ok: true,
      message: `Response: "${content.slice(0, 50).trim()}"`,
    };
  } catch (error) {
    return { name: 'OpenRouter model test', ok: false, message: String(error) };
  }
}

async function checkCli(command: string, name: string): Promise<CheckResult> {
  try {
    await execAsync(`which ${command}`);
    return { name, ok: true, message: 'Installed' };
  } catch {
    return { name, ok: false, message: `Not found. Install ${command}` };
  }
}

async function main(): Promise<void> {
  console.log('Darwin Health Check\n');

  const results: CheckResult[] = [];
  const userConfig = await loadConfig();
  const brainProvider = userConfig.brain?.provider || 'ollama';
  const brainModel = userConfig.brain?.model || (brainProvider === 'openrouter'
    ? (userConfig.openrouter?.defaultModel || 'deepseek/deepseek-r1')
    : 'llama3.2:1b');

  // 1. Check Ollama (only required for Ollama provider)
  console.log('1. Checking Ollama...');
  if (brainProvider === 'ollama') {
    const ollamaResult = await checkOllama();
    results.push(ollamaResult);
    console.log(`   ${ollamaResult.ok ? 'OK' : 'FAIL'} ${ollamaResult.message}`);
  } else {
    console.log('   -- Skipped (OpenRouter provider)');
  }

  // 2. Check models
  console.log('\n2. Checking models...');
  const modelResults = await checkModels(brainProvider, brainModel, userConfig.openrouter?.apiKey);
  for (const r of modelResults) {
    results.push(r);
    console.log(`   ${r.ok ? 'OK' : '--'} ${r.name}: ${r.message}`);
  }

  // 3. Test brain model (only if available)
  if (brainProvider === 'openrouter') {
    if (userConfig.openrouter?.apiKey) {
      console.log('\n3. Testing OpenRouter model...');
      const testResult = await testOpenRouterModel(brainModel, userConfig.openrouter.apiKey);
      results.push(testResult);
      console.log(`   ${testResult.ok ? 'OK' : 'FAIL'} ${testResult.message}`);
    } else {
      console.log('\n3. Skipping OpenRouter model test (API key missing)');
    }
  } else if (results.find(r => r.name.includes('Ollama model') && r.ok)) {
    console.log('\n3. Testing brain model...');
    const testResult = await testBrainModel(brainModel);
    results.push(testResult);
    console.log(`   ${testResult.ok ? 'OK' : 'FAIL'} ${testResult.message}`);
  } else {
    console.log('\n3. Skipping brain model test (not available)');
  }

  // 4. Check CLI tools
  console.log('\n4. Checking CLI tools...');
  const cliTools = [
    { command: 'claude', name: 'Claude Code CLI' },
    { command: 'bd', name: 'Beads CLI' },
    { command: 'gh', name: 'GitHub CLI' },
  ];

  for (const tool of cliTools) {
    const result = await checkCli(tool.command, tool.name);
    results.push(result);
    console.log(`   ${result.ok ? 'OK' : '--'} ${result.name}: ${result.message}`);
  }

  // Summary
  const passed = results.filter(r => r.ok).length;
  const total = results.length;
  const allPassed = passed === total;

  console.log(`\n${allPassed ? 'OK' : 'ISSUES'} Health check: ${passed}/${total} checks passed`);

  if (!allPassed) {
    console.log('\nTo fix issues:');
    for (const r of results.filter(r => !r.ok)) {
      console.log(`  - ${r.name}: ${r.message}`);
    }
  }

  process.exit(allPassed ? 0 : 1);
}

main().catch(console.error);
