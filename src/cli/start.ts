#!/usr/bin/env tsx
/**
 * Darwin CLI - Main entry point
 *
 * Usage:
 *   npm run start
 *   npm run start -- --repo /path/to/project
 *   npm run start -- --auto --log debug
 */

import { Darwin } from '../core/darwin.js';
import { CodeAgentModule } from '../modules/code-agent.js';
import { HomeAutomationModule } from '../modules/home-automation.js';
import { LogLevel } from '../core/logger.js';

interface CliArgs {
  repo: string;
  auto: boolean;
  log: LogLevel;
  help: boolean;
}

function parseArgs(): CliArgs {
  const args: CliArgs = {
    repo: process.cwd(),
    auto: false,
    log: 'info',
    help: false,
  };

  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repo' && argv[i + 1]) {
      args.repo = argv[++i];
    } else if (arg === '--auto') {
      args.auto = true;
    } else if (arg === '--log' && argv[i + 1]) {
      args.log = argv[++i] as LogLevel;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    }
  }

  return args;
}

function printBanner(): void {
  console.log(`
  ____                      _
 |  _ \\  __ _ _ ____      _(_)_ __
 | | | |/ _\` | '__\\ \\ /\\ / / | '_ \\
 | |_| | (_| | |   \\ V  V /| | | | |
 |____/ \\__,_|_|    \\_/\\_/ |_|_| |_|

  Local Home Intelligence System
  Powered by FunctionGemma + Gemma 3 1B
`);
}

function printHelp(): void {
  console.log(`
Usage: npm run start -- [options]

Options:
  --repo <path>    Path to code repository (default: current directory)
  --auto           Automatically start Code Agent tasks when capacity available
  --log <level>    Log level: debug, info, warn, error (default: info)
  --help, -h       Show this help message

Examples:
  npm run start
  npm run start -- --repo /path/to/project --auto
  npm run start -- --log debug
`);
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.help) {
    printBanner();
    printHelp();
    process.exit(0);
  }

  printBanner();

  const darwin = new Darwin({
    logLevel: args.log,
  });

  darwin
    .use(CodeAgentModule, {
      enabled: true,
      repoPath: args.repo,
      autoStart: args.auto,
    })
    .use(HomeAutomationModule, {
      enabled: true,
      mockMode: true,
    });

  // Handle shutdown gracefully
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\nReceived ${signal}, shutting down...`);
    await darwin.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await darwin.start();

    const status = darwin.getStatus();
    console.log('\nModules:');
    for (const [name, info] of Object.entries(status.modules)) {
      const icon = info.status === 'running' ? '  OK' : '  --';
      console.log(`  ${icon} ${name}`);
    }

    console.log('\nTools:');
    for (const tool of status.tools) {
      console.log(`  - ${tool}`);
    }

    console.log('\nDarwin is running. Press Ctrl+C to stop.\n');

    // Keep the process alive with an interval
    setInterval(() => {}, 1 << 30); // ~12 days, effectively forever
  } catch (error) {
    console.error('Failed to start Darwin:', error);
    process.exit(1);
  }
}

main().catch(console.error);
