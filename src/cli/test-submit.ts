#!/usr/bin/env tsx
/**
 * Test different submission strategies for Claude Code
 *
 * This script tests various ways to send input and trigger submission
 * in Claude Code's Ink-based TUI running in a PTY.
 */

import * as pty from 'node-pty';

const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function log(color: string, prefix: string, msg: string) {
  const time = new Date().toISOString().slice(11, 23);
  console.log(`${DIM}${time}${RESET} ${color}[${prefix}]${RESET} ${msg}`);
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function escapeForLog(data: string): string {
  return data
    .replace(/\x1b/g, '<ESC>')
    .replace(/\r/g, '<CR>')
    .replace(/\n/g, '<LF>')
    .replace(/[\x00-\x1f]/g, (c) => `<0x${c.charCodeAt(0).toString(16).padStart(2, '0')}>`);
}

interface Strategy {
  name: string;
  description: string;
  execute: (pty: pty.IPty, text: string) => Promise<void>;
}

const strategies: Strategy[] = [
  {
    name: 'single-write',
    description: 'Text + CR in single write',
    execute: async (p, text) => {
      log(GREEN, 'SEND', 'Single write: text + \\r');
      p.write(text + '\r');
    },
  },
  {
    name: 'separate-cr',
    description: 'Text, delay, then CR',
    execute: async (p, text) => {
      log(GREEN, 'SEND', 'Writing text...');
      p.write(text);
      await sleep(300);
      log(GREEN, 'SEND', 'Writing \\r');
      p.write('\r');
    },
  },
  {
    name: 'separate-lf',
    description: 'Text, delay, then LF',
    execute: async (p, text) => {
      log(GREEN, 'SEND', 'Writing text...');
      p.write(text);
      await sleep(300);
      log(GREEN, 'SEND', 'Writing \\n');
      p.write('\n');
    },
  },
  {
    name: 'double-enter-cr',
    description: 'Text + CR, delay, CR again',
    execute: async (p, text) => {
      log(GREEN, 'SEND', 'Writing text + \\r');
      p.write(text + '\r');
      await sleep(300);
      log(GREEN, 'SEND', 'Writing \\r again');
      p.write('\r');
    },
  },
  {
    name: 'double-enter-lf',
    description: 'Text + LF, delay, LF again',
    execute: async (p, text) => {
      log(GREEN, 'SEND', 'Writing text + \\n');
      p.write(text + '\n');
      await sleep(300);
      log(GREEN, 'SEND', 'Writing \\n again');
      p.write('\n');
    },
  },
  {
    name: 'paste-brackets-cr',
    description: 'Paste brackets around text + CR',
    execute: async (p, text) => {
      const PASTE_START = '\x1b[200~';
      const PASTE_END = '\x1b[201~';
      log(GREEN, 'SEND', 'Writing paste brackets + text + \\r');
      p.write(PASTE_START + text + PASTE_END + '\r');
    },
  },
  {
    name: 'paste-then-cr',
    description: 'Paste brackets, delay, then CR separately',
    execute: async (p, text) => {
      const PASTE_START = '\x1b[200~';
      const PASTE_END = '\x1b[201~';
      log(GREEN, 'SEND', 'Writing paste brackets + text');
      p.write(PASTE_START + text + PASTE_END);
      await sleep(500);
      log(GREEN, 'SEND', 'Writing \\r');
      p.write('\r');
    },
  },
  {
    name: 'paste-double-cr',
    description: 'Paste brackets, delay, CR, delay, CR',
    execute: async (p, text) => {
      const PASTE_START = '\x1b[200~';
      const PASTE_END = '\x1b[201~';
      log(GREEN, 'SEND', 'Writing paste brackets + text');
      p.write(PASTE_START + text + PASTE_END);
      await sleep(500);
      log(GREEN, 'SEND', 'Writing \\r (first)');
      p.write('\r');
      await sleep(300);
      log(GREEN, 'SEND', 'Writing \\r (second)');
      p.write('\r');
    },
  },
  {
    name: 'crlf',
    description: 'Text + CRLF',
    execute: async (p, text) => {
      log(GREEN, 'SEND', 'Writing text + \\r\\n');
      p.write(text + '\r\n');
    },
  },
  {
    name: 'char-by-char',
    description: 'Text char-by-char (slow), then CR',
    execute: async (p, text) => {
      log(GREEN, 'SEND', 'Writing char-by-char...');
      for (const char of text.slice(0, 50)) { // Only first 50 chars
        p.write(char);
        await sleep(10);
      }
      if (text.length > 50) {
        p.write(text.slice(50)); // Rest in bulk
      }
      await sleep(100);
      log(GREEN, 'SEND', 'Writing \\r');
      p.write('\r');
    },
  },
];

async function main() {
  const args = process.argv.slice(2);
  const strategyName = args[0];

  console.log('\n' + '='.repeat(70));
  console.log('  Claude Code Input Submission Test');
  console.log('='.repeat(70) + '\n');

  if (!strategyName || strategyName === '--list') {
    console.log('Available strategies:\n');
    for (const s of strategies) {
      console.log(`  ${CYAN}${s.name.padEnd(20)}${RESET} ${s.description}`);
    }
    console.log(`\nUsage: npm run test:submit -- <strategy-name>`);
    console.log(`   or: tsx src/cli/test-submit.ts <strategy-name>\n`);
    return;
  }

  const strategy = strategies.find(s => s.name === strategyName);
  if (!strategy) {
    console.log(`${RED}Unknown strategy: ${strategyName}${RESET}`);
    console.log('Run with --list to see available strategies');
    return;
  }

  log(CYAN, 'INFO', `Testing strategy: ${strategy.name}`);
  log(CYAN, 'INFO', `Description: ${strategy.description}`);
  console.log();

  // Spawn Claude Code
  log(CYAN, 'INFO', 'Spawning Claude Code...');
  const ptyProcess = pty.spawn('claude', [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: process.cwd(),
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    } as { [key: string]: string },
  });

  let outputBuffer = '';
  let lastOutputTime = Date.now();

  ptyProcess.onData((data: string) => {
    outputBuffer += data;
    lastOutputTime = Date.now();
    process.stdout.write(data);
  });

  ptyProcess.onExit(({ exitCode }) => {
    log(YELLOW, 'EXIT', `Claude exited with code ${exitCode}`);
    process.exit(exitCode ?? 0);
  });

  // Wait for Claude to initialize
  log(CYAN, 'INFO', 'Waiting for Claude to initialize...');
  await sleep(5000);

  // Check if we see the prompt
  if (outputBuffer.includes('>') || outputBuffer.includes('Try')) {
    log(GREEN, 'OK', 'Claude prompt detected');
  } else {
    log(YELLOW, 'WARN', 'No prompt detected, proceeding anyway');
  }

  // Test prompt
  const testPrompt = 'Say exactly "SUCCESS" if you received this message.';
  log(CYAN, 'INFO', `Sending test prompt: "${testPrompt}"`);
  console.log();

  // Execute the strategy
  await strategy.execute(ptyProcess, testPrompt);

  // Wait and observe
  log(CYAN, 'INFO', 'Waiting for response (15s timeout)...');
  const startTime = Date.now();
  const timeout = 15000;

  while (Date.now() - startTime < timeout) {
    await sleep(1000);

    // Check if Claude started processing
    if (outputBuffer.includes('SUCCESS')) {
      log(GREEN, 'SUCCESS', 'Claude responded with SUCCESS!');
      break;
    }

    // Check for signs of processing
    const timeSinceOutput = Date.now() - lastOutputTime;
    if (timeSinceOutput > 3000) {
      log(YELLOW, 'WAIT', 'No output for 3s - Claude may be stuck');
    }
  }

  // Final analysis
  console.log('\n' + '='.repeat(70));
  log(CYAN, 'INFO', 'Test complete. Analysis:');

  if (outputBuffer.includes('SUCCESS')) {
    log(GREEN, 'RESULT', `Strategy "${strategy.name}" WORKED!`);
  } else if (outputBuffer.includes('[Pasted text')) {
    log(YELLOW, 'RESULT', 'Paste was detected but submission may have failed');
  } else {
    log(RED, 'RESULT', 'No clear response detected');
  }

  // Show last 500 chars of output
  console.log('\n--- Last 500 chars of output ---');
  const lastOutput = outputBuffer.slice(-500).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  console.log(lastOutput);

  // Exit
  log(CYAN, 'INFO', 'Sending Ctrl+D to exit...');
  ptyProcess.write('\x04');
  await sleep(2000);
  process.exit(0);
}

// Handle Ctrl+C
process.on('SIGINT', () => {
  console.log('\nCaught Ctrl+C, exiting...');
  process.exit(0);
});

main().catch(console.error);
