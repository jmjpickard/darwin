/**
 * Darwin Interactive REPL
 *
 * Chat with Darwin, manage tasks, attach to live Claude sessions.
 *
 * Built-in commands (direct, reliable):
 *   help     - Show available commands
 *   status   - Show current status
 *   pause    - Stop picking up new tasks
 *   resume   - Resume picking up tasks
 *   attach   - Hook into live Claude stdout
 *   logs     - Show recent activity
 *   quit     - Exit Darwin
 *
 * Natural language (via Brain):
 *   "what are you working on?"
 *   "add task to synapse: implement email"
 *   "how many tasks are queued?"
 */

import * as readline from 'readline';
import { Darwin } from '../core/darwin.js';
import { CodeAgentModule } from '../modules/code-agent.js';
import { eventBus } from '../core/event-bus.js';

type ReplMode = 'normal' | 'attached';

interface ReplContext {
  darwin: Darwin;
  rl: readline.Interface;
  mode: ReplMode;
  outputHandler: ((line: string) => void) | null;
}

/**
 * Start the interactive REPL
 */
export async function startRepl(darwin: Darwin): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'darwin> ',
  });

  const ctx: ReplContext = {
    darwin,
    rl,
    mode: 'normal',
    outputHandler: null,
  };

  // Wire up pause check to CodeAgent
  const codeAgent = darwin.getModules().get('CodeAgentModule') as CodeAgentModule | undefined;
  if (codeAgent) {
    codeAgent.setPauseCheck(() => darwin.isPaused());
  }

  console.log('\nType "help" for commands, or chat naturally.\n');
  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();

    if (!input) {
      rl.prompt();
      return;
    }

    try {
      await handleInput(ctx, input);
    } catch (error) {
      console.error('Error:', error);
    }

    if (ctx.mode === 'normal') {
      rl.prompt();
    }
  });

  rl.on('close', async () => {
    console.log('\nShutting down...');
    await darwin.stop();
    process.exit(0);
  });

  // Handle Ctrl+C
  rl.on('SIGINT', () => {
    if (ctx.mode === 'attached') {
      detachFromSession(ctx);
      rl.prompt();
    } else {
      rl.close();
    }
  });
}

/**
 * Handle user input
 */
async function handleInput(ctx: ReplContext, input: string): Promise<void> {
  const lower = input.toLowerCase();

  // Built-in commands (exact match for reliability)
  if (lower === 'help' || lower === '?') {
    showHelp();
    return;
  }

  if (lower === 'status') {
    await showStatus(ctx);
    return;
  }

  if (lower === 'pause') {
    ctx.darwin.pause();
    console.log('Paused - will finish current task but not start new ones.');
    return;
  }

  if (lower === 'resume') {
    ctx.darwin.resume();
    console.log('Resumed - will pick up tasks.');
    return;
  }

  if (lower === 'attach') {
    attachToSession(ctx);
    return;
  }

  if (lower === 'logs') {
    showLogs(ctx);
    return;
  }

  if (lower === 'quit' || lower === 'exit') {
    ctx.rl.close();
    return;
  }

  if (lower === 'clear' || lower === 'new' || lower === 'reset') {
    ctx.darwin.clearChat();
    console.log('Conversation cleared. Fresh start!\n');
    return;
  }

  // Direct shortcuts for common operations (bypass AI for reliability)
  if (lower === 'tasks' || lower.match(/^(show |list |get )?tasks$/)) {
    await showTasks(ctx);
    return;
  }

  if (lower.match(/^tasks?\s+(in\s+)?(\w+)$/) || lower.match(/^(check|show|list)\s+tasks?\s+(in\s+)?(\w+)$/)) {
    const match = lower.match(/(\w+)$/);
    if (match) {
      await showTasks(ctx, match[1]);
      return;
    }
  }

  // Natural language - route through Brain
  await handleNaturalLanguage(ctx, input);
}

/**
 * Show help
 */
function showHelp(): void {
  console.log(`
Commands:
  status       - What's Darwin doing right now?
  tasks        - Show ready tasks
  pause        - Stop picking up new tasks
  resume       - Resume picking up tasks
  attach       - Watch live Claude output (Ctrl+C to detach)
  logs         - Recent activity
  clear        - Start fresh conversation
  quit         - Exit Darwin

Or just chat naturally:
  "create a new task for fixing the login bug"
  "which repos do I have?"
  "start working on bd-abc123"
`);
}

/**
 * Show current status
 */
async function showStatus(ctx: ReplContext): Promise<void> {
  // Use chat for a conversational status update
  const response = await ctx.darwin.chat('What are you currently working on? Give me a quick status update.');
  console.log('');
  console.log(response.message);
  console.log('');
}

/**
 * Attach to live Claude output
 */
function attachToSession(ctx: ReplContext): void {
  const codeAgent = ctx.darwin.getModules().get('CodeAgentModule') as CodeAgentModule | undefined;

  if (!codeAgent) {
    console.log('CodeAgent not available.');
    return;
  }

  const session = codeAgent.getCurrentSession();
  if (!session) {
    console.log('No active Claude session to attach to.');
    return;
  }

  console.log(`\n[Attached to ${session.taskId} - Ctrl+C to detach]\n`);

  // Show recent buffer
  const recentOutput = codeAgent.getOutputBuffer();
  if (recentOutput.length > 0) {
    console.log('--- Recent output ---');
    for (const line of recentOutput.slice(-20)) {
      console.log(line);
    }
    console.log('--- Live output ---\n');
  }

  // Subscribe to live output
  ctx.outputHandler = (line: string) => {
    console.log(line);
  };
  codeAgent.onOutput(ctx.outputHandler);

  ctx.mode = 'attached';
}

/**
 * Detach from Claude output
 */
function detachFromSession(ctx: ReplContext): void {
  const codeAgent = ctx.darwin.getModules().get('CodeAgentModule') as CodeAgentModule | undefined;

  if (codeAgent && ctx.outputHandler) {
    codeAgent.offOutput(ctx.outputHandler);
    ctx.outputHandler = null;
  }

  console.log('\n[Detached]\n');
  ctx.mode = 'normal';
}

/**
 * Show recent logs (from event bus history)
 */
function showLogs(ctx: ReplContext): void {
  const history = eventBus.getHistory(20);

  if (history.length === 0) {
    console.log('No recent events.');
    return;
  }

  console.log('\nRecent events:');
  for (const event of history) {
    const time = event.timestamp.toLocaleTimeString();
    const summary = summarizeEventData(event.data);
    console.log(`  ${time} [${event.source}:${event.type}] ${summary}`);
  }
  console.log('');
}

/**
 * Summarize event data for display
 */
function summarizeEventData(data: Record<string, unknown>): string {
  const parts: string[] = [];

  if (data.taskId) parts.push(`task=${data.taskId}`);
  if (data.repo) parts.push(`repo=${data.repo}`);
  if (data.title) parts.push(`"${String(data.title).slice(0, 30)}"`);
  if (data.prUrl) parts.push(`PR=${data.prUrl}`);
  if (data.error) parts.push(`error="${String(data.error).slice(0, 30)}"`);
  if (data.reason) parts.push(`reason="${data.reason}"`);

  return parts.join(' ') || JSON.stringify(data).slice(0, 50);
}

/**
 * Show tasks from repos
 */
async function showTasks(ctx: ReplContext, repoFilter?: string): Promise<void> {
  // Use chat for a conversational task list
  const query = repoFilter
    ? `What tasks are ready in the ${repoFilter} repository?`
    : 'What tasks are ready across all repos?';

  const response = await ctx.darwin.chat(query);
  console.log('');
  console.log(response.message);
  console.log('');
}

/**
 * Handle natural language input via Brain's conversational chat
 */
async function handleNaturalLanguage(ctx: ReplContext, input: string): Promise<void> {
  console.log(''); // spacing

  try {
    const response = await ctx.darwin.chat(input);

    // Just print the conversational response
    console.log(response.message);
    console.log('');
  } catch (error) {
    console.log(`Error: ${error}\n`);
  }
}
