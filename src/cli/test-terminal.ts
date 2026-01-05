#!/usr/bin/env tsx
/**
 * Terminal Controller Test Script
 *
 * Tests the PTY-based terminal emulation for Claude Code interaction.
 * Run with: npm run test:terminal
 *
 * Test modes:
 *   --shell     Test with a basic bash shell (default)
 *   --claude    Test with Claude Code REPL (requires Claude CLI)
 *   --echo      Test with a simple echo server
 */

import { TerminalController } from '../core/terminal-controller.js';
import { TerminalState } from '../core/terminal-types.js';
import { setLogLevel } from '../core/logger.js';

// Enable debug logging
setLogLevel('debug');

const args = process.argv.slice(2);
const mode = args.includes('--claude') ? 'claude' : args.includes('--echo') ? 'echo' : 'shell';
const backend = args.includes('--proxy') ? 'proxy' : args.includes('--pty') ? 'pty' : undefined;

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║           Darwin Terminal Controller Test                   ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log();
  console.log(`Mode: ${mode}`);
  console.log(`Backend: ${backend || 'default'}`);
  console.log();

  const terminal = new TerminalController({
    cwd: process.cwd(),
    cols: 120,
    rows: 40,
    ...(backend ? { backend } : {}),
  });

  // Set up event listeners
  terminal.on('output', (data) => {
    process.stdout.write(data);
  });

  terminal.on('stateChange', (from, to) => {
    console.log(`\n[STATE] ${from} -> ${to}`);
  });

  terminal.on('question', (question) => {
    console.log(`\n[QUESTION] ${question}`);
  });

  terminal.on('limitReached', (resetTime) => {
    console.log(`\n[LIMIT] Usage limit reached, resets at ${resetTime?.toISOString()}`);
  });

  terminal.on('exit', (code, signal) => {
    console.log(`\n[EXIT] code=${code}, signal=${signal}`);
  });

  terminal.on('error', (error) => {
    console.error(`\n[ERROR] ${error.message}`);
  });

  try {
    switch (mode) {
      case 'shell':
        await testShell(terminal);
        break;
      case 'echo':
        await testEcho(terminal);
        break;
      case 'claude':
        await testClaude(terminal);
        break;
    }
  } catch (error) {
    console.error('Test failed:', error);
  } finally {
    await terminal.stop(true);
    console.log('\n[DONE] Terminal controller test complete.');
  }
}

/**
 * Test with bash shell - basic PTY functionality
 */
async function testShell(terminal: TerminalController) {
  console.log('Testing with bash shell...\n');

  await terminal.start('/bin/bash', ['--norc', '--noprofile']);

  // Wait for prompt
  await sleep(500);

  console.log('\n--- Test 1: Simple echo command ---');
  await terminal.executeAction({ type: 'send', content: 'echo "Hello from Darwin PTY!"' });
  await sleep(500);

  console.log('\n--- Test 2: Check state observation ---');
  const obs = terminal.getObservation();
  console.log('Observation:', {
    state: obs.state,
    promptVisible: obs.promptVisible,
    isStreaming: obs.isStreaming,
    bufferLines: obs.bufferLines,
    elapsedMs: obs.elapsedMs,
  });

  console.log('\n--- Test 3: Multiple commands ---');
  await terminal.executeAction({ type: 'send', content: 'pwd' });
  await sleep(300);
  await terminal.executeAction({ type: 'send', content: 'echo $TERM' });
  await sleep(300);

  console.log('\n--- Test 4: Ctrl+C handling ---');
  await terminal.executeAction({ type: 'send', content: 'sleep 10' });
  await sleep(200);
  await terminal.executeAction({ type: 'ctrl_c' });
  await sleep(300);

  console.log('\n--- Test 5: Exit command ---');
  await terminal.executeAction({ type: 'send', content: 'exit' });
  await sleep(500);

  console.log('\n--- Buffer contents ---');
  console.log('Lines:', terminal.getFullBuffer().split('\n').length);
}

/**
 * Test with echo server - pattern detection
 */
async function testEcho(terminal: TerminalController) {
  console.log('Testing pattern detection with bash...\n');

  await terminal.start('/bin/bash', ['--norc', '--noprofile']);
  await sleep(500);

  console.log('\n--- Test 1: Simulate y/n question ---');
  await terminal.executeAction({
    type: 'send',
    content: 'echo "Do you want to proceed? [y/n]"',
  });
  await sleep(500);

  console.log('\n--- Test 2: Simulate limit message ---');
  await terminal.executeAction({
    type: 'send',
    content: 'echo "Usage limit reached. Resets at 2pm."',
  });
  await sleep(500);

  console.log('\n--- Test 3: Check observations ---');
  const obs = terminal.getObservation();
  console.log('Final observation:', obs);

  await terminal.executeAction({ type: 'send', content: 'exit' });
}

/**
 * Test with Claude Code REPL - full integration
 */
async function testClaude(terminal: TerminalController) {
  console.log('Testing with Claude Code REPL...\n');
  console.log('Note: This requires Claude CLI to be installed and authenticated.\n');

  try {
    await terminal.startClaude();
  } catch (error) {
    console.error('Failed to start Claude. Is the CLI installed?');
    console.error('Install with: npm install -g @anthropic-ai/claude-code');
    throw error;
  }

  // Wait for Claude to start
  console.log('Waiting for Claude prompt...');
  const ready = await terminal.waitForState('ready', 30000);

  if (!ready.reached) {
    console.log('Claude did not reach ready state within 30s');
    console.log('Current state:', ready.state);
    console.log('Buffer:', terminal.getFullBuffer().slice(-500));
    return;
  }

  console.log('Claude is ready!');

  // Send a simple request
  console.log('\n--- Sending test prompt ---');
  await terminal.executeAction({
    type: 'send',
    content: 'What is 2 + 2? Reply with just the number.',
  });

  // Wait for response
  console.log('Waiting for response...');
  const idle = await terminal.waitForIdle(2000, 30000);

  if (idle.idle) {
    console.log('Claude finished responding.');
    const obs = terminal.getObservation();
    console.log('\nFinal state:', obs.state);
    console.log('Recent output:', obs.recentOutput.slice(-500));
  } else {
    console.log('Timeout waiting for Claude response.');
  }

  // Exit Claude
  console.log('\n--- Exiting Claude ---');
  await terminal.executeAction({ type: 'send', content: '/exit' });
  await sleep(1000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch(console.error);
