#!/usr/bin/env tsx
/**
 * Test Brain - Interactive CLI to test Darwin brain dispatch
 *
 * Usage: npm run test:brain
 */

import * as readline from 'readline';
import { Darwin } from '../core/darwin.js';
import { CodeAgentModule } from '../modules/code-agent.js';
import { HomeAutomationModule } from '../modules/home-automation.js';

async function main(): Promise<void> {
  console.log('Darwin Brain Test\n');
  console.log('Testing Darwin brain model\n');

  const darwin = new Darwin({ logLevel: 'info' });

  darwin
    .use(CodeAgentModule, { enabled: true, repoPath: process.cwd() })
    .use(HomeAutomationModule, { enabled: true, mockMode: true });

  await darwin.start();

  const status = darwin.getStatus();
  console.log('\nAvailable tools:');
  for (const tool of status.tools) {
    console.log(`  - ${tool}`);
  }

  console.log('\n---');
  console.log('Type an event/situation and see what tools the brain calls.');
  console.log('Prefix with "reason:" to use the reasoning path instead.');
  console.log('Type "quit" to exit.\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = (): void => {
    rl.question('> ', async (input) => {
      const trimmed = input.trim();

      if (trimmed === 'quit' || trimmed === 'exit') {
        await darwin.stop();
        rl.close();
        process.exit(0);
      }

      if (trimmed.startsWith('reason:')) {
        // Use reasoner
        const query = trimmed.slice(7).trim();
        console.log('\n[Using brain reasoning...]\n');
        try {
          const response = await darwin.reason(query);
          console.log(`Response: ${response}\n`);
        } catch (error) {
          console.error('Error:', error);
        }
      } else {
        // Use dispatcher
        console.log('\n[Using brain dispatcher...]\n');
        try {
          const results = await darwin.dispatch(trimmed);
          if (results.length === 0) {
            console.log('No tools called.\n');
          } else {
            console.log('Results:');
            for (const r of results) {
              console.log(JSON.stringify(r, null, 2));
            }
            console.log();
          }
        } catch (error) {
          console.error('Error:', error);
        }
      }

      prompt();
    });
  };

  prompt();
}

main().catch(console.error);
