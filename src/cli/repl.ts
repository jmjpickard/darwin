/**
 * Darwin Interactive REPL
 *
 * A streaming interface that shows Darwin's internal monologue
 * while allowing you to interject with questions/commands at any time.
 *
 * The monologue streams above, your input stays at the bottom.
 * Just start typing to talk to Darwin.
 *
 * Built-in commands:
 *   help     - Show available commands
 *   status   - What's Darwin doing right now?
 *   tasks    - Show ready tasks
 *   pause    - Stop picking up new tasks
 *   resume   - Resume picking up tasks
 *   attach   - Watch live Claude output (Ctrl+C to detach)
 *   thoughts - Show recent thoughts
 *   logs     - Recent activity events
 *   clear    - Start fresh conversation
 *   quit     - Exit Darwin
 *
 * Or just chat naturally - Darwin understands natural language.
 */

import * as readline from 'readline';
import { Darwin } from '../core/darwin.js';
import { CodeAgentModule } from '../modules/code-agent.js';
import { eventBus } from '../core/event-bus.js';
import type { Thought } from '../core/monologue.js';

type ReplMode = 'normal' | 'attached';

interface ReplContext {
  darwin: Darwin;
  rl: readline.Interface;
  mode: ReplMode;
  outputHandler: ((line: string) => void) | null;
  thoughtHandler: ((thought: Thought) => void) | null;
  monologueEnabled: boolean;
}

// ANSI escape codes for cursor manipulation
const SAVE_CURSOR = '\x1b[s';
const RESTORE_CURSOR = '\x1b[u';
const CLEAR_LINE = '\x1b[2K';
const MOVE_UP = '\x1b[1A';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

/**
 * Start the interactive REPL with streaming monologue
 */
export async function startRepl(darwin: Darwin): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${DIM}>${RESET} `,
  });

  const ctx: ReplContext = {
    darwin,
    rl,
    mode: 'normal',
    outputHandler: null,
    thoughtHandler: null,
    monologueEnabled: true,
  };

  // Wire up pause check to CodeAgent
  const codeAgent = darwin.getModules().get('CodeAgentModule') as CodeAgentModule | undefined;
  if (codeAgent) {
    codeAgent.setPauseCheck(() => darwin.isPaused());
  }

  // Subscribe to monologue
  setupMonologueStream(ctx);

  console.log('\nDarwin is thinking... Type to chat, "help" for commands.\n');
  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();

    if (!input) {
      rl.prompt();
      return;
    }

    // Temporarily disable monologue while handling input
    const wasEnabled = ctx.monologueEnabled;
    ctx.monologueEnabled = false;

    try {
      await handleInput(ctx, input);
    } catch (error) {
      console.error('Error:', error);
    }

    ctx.monologueEnabled = wasEnabled;

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
 * Set up the monologue stream to show Darwin's thoughts
 */
function setupMonologueStream(ctx: ReplContext): void {
  const monologue = ctx.darwin.getMonologue();

  // Enable console output on the monologue
  monologue.setConsoleEnabled(true);

  // Subscribe to get thoughts for potential filtering/formatting
  ctx.thoughtHandler = (thought: Thought) => {
    if (!ctx.monologueEnabled) return;

    // The monologue itself handles console output
    // This handler is for any additional processing we might want

    // Re-display prompt after thought (keeps input at bottom)
    // Use setImmediate to avoid interfering with the thought output
    setImmediate(() => {
      if (ctx.mode === 'normal') {
        // Clear current line and re-show prompt
        process.stdout.write(CLEAR_LINE + '\r');
        ctx.rl.prompt(true);
      }
    });
  };

  monologue.subscribe(ctx.thoughtHandler);
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

  if (lower === 'thoughts') {
    showThoughts(ctx);
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

  if (lower === 'mute' || lower === 'quiet') {
    ctx.monologueEnabled = false;
    ctx.darwin.getMonologue().setConsoleEnabled(false);
    console.log('Monologue muted. Type "unmute" to resume.\n');
    return;
  }

  if (lower === 'unmute' || lower === 'verbose') {
    ctx.monologueEnabled = true;
    ctx.darwin.getMonologue().setConsoleEnabled(true);
    console.log('Monologue enabled.\n');
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
${DIM}Darwin's thoughts stream above. Just type to chat.${RESET}

Commands:
  status       - What's Darwin doing right now?
  tasks        - Show ready tasks
  thoughts     - Show recent thoughts
  pause        - Stop picking up new tasks
  resume       - Resume picking up tasks
  attach       - Watch live Claude output (Ctrl+C to detach)
  logs         - Recent activity events
  mute/unmute  - Toggle monologue stream
  clear        - Start fresh conversation
  quit         - Exit Darwin

Or just chat naturally:
  "create a new task for fixing the login bug"
  "research the best approach for implementing X"
  "what are you thinking about?"
`);
}

/**
 * Show current status
 */
async function showStatus(ctx: ReplContext): Promise<void> {
  const consciousness = ctx.darwin.getConsciousness();
  const state = consciousness.getState();

  console.log(`\n${DIM}Consciousness:${RESET} ${state}`);

  // Also ask Darwin for a conversational status
  const response = await ctx.darwin.chat('What are you currently working on? Give me a quick status update.');
  console.log('');
  console.log(response.message);
  console.log('');
}

/**
 * Show recent thoughts
 */
function showThoughts(ctx: ReplContext): void {
  const monologue = ctx.darwin.getMonologue();
  const thoughts = monologue.getRecent(15);

  if (thoughts.length === 0) {
    console.log('No recent thoughts.');
    return;
  }

  console.log('\nRecent thoughts:');
  for (const thought of thoughts) {
    console.log(monologue.format(thought));
  }
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

  // Disable monologue while attached
  ctx.monologueEnabled = false;
  ctx.darwin.getMonologue().setConsoleEnabled(false);

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

  // Re-enable monologue
  ctx.monologueEnabled = true;
  ctx.darwin.getMonologue().setConsoleEnabled(true);

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
