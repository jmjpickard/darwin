#!/usr/bin/env tsx
/**
 * Darwin CLI - Main entry point
 *
 * Usage:
 *   npm run start              # Interactive REPL mode
 *   npm run start -- --auto    # Headless daemon mode
 *   npm run start -- --config /path/to/config.json
 */

import { Darwin } from '../core/darwin.js';
import { CodeAgentModule } from '../modules/code-agent.js';
import { HomeAutomationModule } from '../modules/home-automation.js';
import { SchedulerModule } from '../modules/scheduler.js';
import { LogLevel } from '../core/logger.js';
import { loadConfig, getConfigPath, getEnabledRepos, DarwinUserConfig } from '../core/config.js';

interface CliArgs {
  config?: string;
  auto: boolean;
  log: LogLevel;
  help: boolean;
}

function parseArgs(): CliArgs {
  const args: CliArgs = {
    auto: false,
    log: 'info',
    help: false,
  };

  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--config' && argv[i + 1]) {
      args.config = argv[++i];
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
  Powered by your configured brain model
`);
}

function printHelp(): void {
  console.log(`
Usage: npm run start -- [options]

Options:
  --config <path>  Path to config file (default: ~/.darwin/config.json)
  --auto           Headless mode: auto-start tasks, no interactive prompt
  --log <level>    Log level: debug, info, warn, error (default: info)
  --help, -h       Show this help message

Modes:
  Interactive (default): Chat with Darwin, manage tasks, attach to sessions
  Headless (--auto):     Daemon mode, auto-works through task queue

Config file (${getConfigPath()}):
  {
    "repos": [
      { "path": "/path/to/project", "name": "my-project", "enabled": true }
    ],
    "defaults": {
      "testCommand": "npm test",
      "checkIntervalMs": 300000,
      "maxSessionMinutes": 30,
      "usageThreshold": 80
    },
    "brain": {
      "provider": "ollama",
      "model": "llama3.2:1b",
      "timeoutMs": 60000
    },
    "openrouter": {
      "apiKey": "sk-...",
      "defaultModel": "deepseek/deepseek-r1"
    }
  }

Examples:
  npm run start                    # Interactive mode
  npm run start -- --auto          # Headless daemon
  npm run start -- --log debug     # Debug logging
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

  // Load config
  const userConfig = await loadConfig(args.config);
  const enabledRepos = getEnabledRepos(userConfig);

  if (enabledRepos.length === 0) {
    console.log('No enabled repositories configured.');
    console.log(`Edit ${getConfigPath()} to add repositories.\n`);
  } else {
    console.log(`Configured repos: ${enabledRepos.map((r) => r.name).join(', ')}\n`);
  }

  const darwin = new Darwin({
    logLevel: args.log,
    userConfig,
  });

  darwin
    .use(CodeAgentModule, {
      enabled: enabledRepos.length > 0,
      repos: enabledRepos,
      autoStart: args.auto,
      defaults: userConfig.defaults,
    })
    .use(SchedulerModule, {
      enabled: true,
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

    if (args.auto) {
      // Headless daemon mode
      console.log('\nDarwin running in headless mode. Press Ctrl+C to stop.\n');
      setInterval(() => {}, 1 << 30);
    } else {
      // Interactive REPL mode
      const { startRepl } = await import('./repl.js');
      await startRepl(darwin);
    }
  } catch (error) {
    console.error('Failed to start Darwin:', error);
    process.exit(1);
  }
}

main().catch(console.error);
