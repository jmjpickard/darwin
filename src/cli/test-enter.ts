#!/usr/bin/env tsx
/**
 * Test script to diagnose Enter key issues with Claude Code
 *
 * This tests various methods of sending Enter to an Ink-based application
 * running in a PTY.
 */

import * as pty from 'node-pty';
import * as readline from 'readline';

const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

function log(color: string, prefix: string, msg: string) {
  console.log(`${color}[${prefix}]${RESET} ${msg}`);
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('\n=== PTY Enter Key Test for Claude Code ===\n');

  // Spawn Claude Code in a PTY
  log(CYAN, 'INFO', 'Spawning Claude Code via node-pty...');

  const ptyProcess = pty.spawn('claude', [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: process.cwd(),
    env: process.env as { [key: string]: string },
  });

  let outputBuffer = '';

  // Capture output
  ptyProcess.onData((data: string) => {
    outputBuffer += data;
    process.stdout.write(data);
  });

  ptyProcess.onExit(({ exitCode }) => {
    log(YELLOW, 'EXIT', `Claude exited with code ${exitCode}`);
    process.exit(exitCode ?? 0);
  });

  // Wait for Claude to start
  log(CYAN, 'INFO', 'Waiting for Claude to initialize (5s)...');
  await sleep(5000);

  // Setup readline for interactive testing
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log('\n' + '='.repeat(60));
  console.log('Interactive PTY Input Test');
  console.log('='.repeat(60));
  console.log(`
Commands:
  1  - Send \\r (CR)
  2  - Send \\n (LF)
  3  - Send \\r\\n (CRLF)
  4  - Type "hello" then \\r
  5  - Type "hello" then \\n
  6  - Paste mode: \\x1b[200~hello\\x1b[201~\\r
  7  - Paste mode WITHOUT enter: \\x1b[200~hello\\x1b[201~
  8  - Send raw Enter key code \\x0d
  9  - Type multi-line with paste brackets + double enter
  t  - Type custom text (then press enter in THIS terminal)
  p  - Paste custom text with brackets + \\r
  s  - Send text + enter (single write)
  q  - Quit

Enter command: `);

  const testPrompt = 'Say "working" if you can read this.';

  rl.on('line', async (input) => {
    const cmd = input.trim().toLowerCase();

    switch (cmd) {
      case '1':
        log(GREEN, 'SEND', 'Sending \\r (CR)');
        ptyProcess.write('\r');
        break;

      case '2':
        log(GREEN, 'SEND', 'Sending \\n (LF)');
        ptyProcess.write('\n');
        break;

      case '3':
        log(GREEN, 'SEND', 'Sending \\r\\n (CRLF)');
        ptyProcess.write('\r\n');
        break;

      case '4':
        log(GREEN, 'SEND', 'Typing "hello" then \\r');
        ptyProcess.write('hello');
        await sleep(50);
        ptyProcess.write('\r');
        break;

      case '5':
        log(GREEN, 'SEND', 'Typing "hello" then \\n');
        ptyProcess.write('hello');
        await sleep(50);
        ptyProcess.write('\n');
        break;

      case '6':
        log(GREEN, 'SEND', 'Paste mode: \\x1b[200~hello\\x1b[201~\\r');
        ptyProcess.write('\x1b[200~hello\x1b[201~\r');
        break;

      case '7':
        log(GREEN, 'SEND', 'Paste mode WITHOUT enter');
        ptyProcess.write('\x1b[200~hello\x1b[201~');
        break;

      case '8':
        log(GREEN, 'SEND', 'Raw Enter \\x0d');
        ptyProcess.write('\x0d');
        break;

      case '9':
        log(GREEN, 'SEND', 'Multi-line paste + double enter');
        const multiLine = 'Line 1\nLine 2\nLine 3';
        // Paste brackets
        ptyProcess.write('\x1b[200~' + multiLine + '\x1b[201~');
        await sleep(100);
        // First enter (Claude multi-line mode)
        ptyProcess.write('\r');
        await sleep(100);
        // Second enter (submit)
        ptyProcess.write('\r');
        break;

      case 't':
        rl.question('Enter text to type: ', (text) => {
          log(GREEN, 'SEND', `Typing: "${text}" (no enter)`);
          ptyProcess.write(text);
        });
        break;

      case 'p':
        rl.question('Enter text to paste: ', (text) => {
          log(GREEN, 'SEND', `Pasting with brackets + \\r: "${text}"`);
          ptyProcess.write('\x1b[200~' + text + '\x1b[201~\r');
        });
        break;

      case 's':
        rl.question('Enter text to send: ', (text) => {
          log(GREEN, 'SEND', `Sending in single write: "${text}\\r"`);
          ptyProcess.write(text + '\r');
        });
        break;

      case 'q':
        log(YELLOW, 'QUIT', 'Sending Ctrl+D to exit Claude');
        ptyProcess.write('\x04');
        await sleep(500);
        rl.close();
        process.exit(0);
        break;

      default:
        // If it looks like actual text, just send it
        if (cmd.length > 0) {
          log(GREEN, 'SEND', `Sending raw: "${cmd}"`);
          ptyProcess.write(cmd);
        }
    }

    console.log('\nEnter command: ');
  });

  // Handle Ctrl+C
  process.on('SIGINT', () => {
    log(YELLOW, 'SIGINT', 'Caught Ctrl+C, cleaning up...');
    ptyProcess.write('\x03');
    setTimeout(() => {
      ptyProcess.kill();
      process.exit(0);
    }, 1000);
  });
}

main().catch(console.error);
