#!/usr/bin/env tsx
/**
 * Health Check - Verify Darwin dependencies are available
 *
 * Usage: npm run test:health
 */

import { exec } from 'child_process';
import { promisify } from 'util';

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

async function checkModels(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  try {
    const response = await fetch('http://localhost:11434/api/tags');
    const data = await response.json() as { models: Array<{ name: string }> };
    const models = data.models?.map(m => m.name) || [];

    // Check FunctionGemma
    const hasDispatcher = models.some(m => m.includes('functiongemma'));
    results.push({
      name: 'FunctionGemma (dispatcher)',
      ok: hasDispatcher,
      message: hasDispatcher ? 'Available' : 'Not found. Run: ollama pull functiongemma',
    });

    // Check Gemma 1B
    const hasReasoner = models.some(m => m.includes('gemma3:1b'));
    results.push({
      name: 'Gemma 3 1B (reasoner)',
      ok: hasReasoner,
      message: hasReasoner ? 'Available' : 'Not found. Run: ollama pull gemma3:1b',
    });
  } catch {
    results.push({ name: 'Models', ok: false, message: 'Could not check (Ollama not running)' });
  }

  return results;
}

async function testDispatcher(): Promise<CheckResult> {
  try {
    const response = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'functiongemma',
        prompt: 'Say "ready" if you can hear me.',
        stream: false,
        options: { num_predict: 10 },
      }),
    });

    if (!response.ok) {
      return { name: 'FunctionGemma test', ok: false, message: `Error: ${response.status}` };
    }

    const data = await response.json() as { response: string };
    return {
      name: 'FunctionGemma test',
      ok: true,
      message: `Response: "${data.response.slice(0, 50).trim()}"`,
    };
  } catch (error) {
    return { name: 'FunctionGemma test', ok: false, message: String(error) };
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

  // 1. Check Ollama
  console.log('1. Checking Ollama...');
  const ollamaResult = await checkOllama();
  results.push(ollamaResult);
  console.log(`   ${ollamaResult.ok ? 'OK' : 'FAIL'} ${ollamaResult.message}`);

  // 2. Check models
  console.log('\n2. Checking models...');
  const modelResults = await checkModels();
  for (const r of modelResults) {
    results.push(r);
    console.log(`   ${r.ok ? 'OK' : '--'} ${r.name}: ${r.message}`);
  }

  // 3. Test FunctionGemma (only if available)
  if (results.find(r => r.name.includes('FunctionGemma') && r.ok)) {
    console.log('\n3. Testing FunctionGemma...');
    const testResult = await testDispatcher();
    results.push(testResult);
    console.log(`   ${testResult.ok ? 'OK' : 'FAIL'} ${testResult.message}`);
  } else {
    console.log('\n3. Skipping FunctionGemma test (not available)');
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
