/**
 * Terminal Types - State machine and interfaces for PTY-based terminal control
 *
 * Defines the state machine for observing and controlling a Claude Code session.
 * The local model observes terminal output and decides what actions to take.
 */

/**
 * Terminal session state machine
 *
 * State transitions:
 *   idle -> starting (spawn PTY)
 *   starting -> ready (prompt detected)
 *   ready -> waiting_response (input sent)
 *   waiting_response -> processing (Claude working)
 *   processing -> ready (prompt returned)
 *   processing -> question (Claude asks something)
 *   question -> waiting_response (answer sent)
 *   processing -> limit_reached (usage limit hit)
 *   any -> error (fatal error)
 *   any -> stopping (shutdown requested)
 *   stopping -> idle (process exited)
 */
export type TerminalState =
  | 'idle'              // No session running
  | 'starting'          // Claude CLI launching
  | 'ready'             // Prompt visible, awaiting input
  | 'waiting_response'  // Sent input, waiting for Claude to process
  | 'processing'        // Claude is working (output streaming)
  | 'question'          // Claude asked a question requiring response
  | 'limit_reached'     // Usage limit hit, need to wait
  | 'error'             // Fatal error occurred
  | 'stopping';         // Graceful shutdown in progress

/**
 * Actions the model can request to control the terminal
 */
export type TerminalActionType =
  | 'type'      // Type text (without pressing enter)
  | 'enter'     // Press enter (submit current line)
  | 'send'      // Type text and press enter (combined)
  | 'ctrl_c'    // Send interrupt signal
  | 'ctrl_d'    // Send EOF
  | 'wait'      // Do nothing, wait for more output
  | 'answer';   // Answer a question (type + enter)

export type TerminalBackend = 'pty' | 'proxy';

export interface TerminalAction {
  type: TerminalActionType;
  /** Text to type (for 'type', 'send', 'answer' actions) */
  content?: string;
  /** How long to wait in ms (for 'wait' action) */
  waitMs?: number;
  /** Reason for this action (for logging/debugging) */
  reason?: string;
}

/**
 * What the model observes about the terminal state
 * This is passed to the AI for decision making
 */
export interface TerminalObservation {
  /** Current state machine state */
  state: TerminalState;
  /** Recent terminal output (last N characters, stripped of ANSI codes) */
  recentOutput: string;
  /** Whether the Claude prompt (>) is visible at end of output */
  promptVisible: boolean;
  /** If state is 'question', the detected question text */
  lastQuestion?: string;
  /** If state is 'limit_reached', when the limit resets */
  limitResetTime?: Date;
  /** Time since session started in ms */
  elapsedMs: number;
  /** Time since last action was sent in ms */
  timeSinceLastActionMs: number;
  /** Number of lines in the output buffer */
  bufferLines: number;
  /** Whether output is actively streaming (received data recently) */
  isStreaming: boolean;
}

/**
 * Configuration for the terminal controller
 */
export interface TerminalControllerConfig {
  /** Terminal backend to use (default: DARWIN_TERMINAL_BACKEND or 'pty') */
  backend?: TerminalBackend;
  /** Path to shell to use (default: /bin/bash) */
  shell?: string;
  /** Initial working directory */
  cwd: string;
  /** Environment variables to pass */
  env?: Record<string, string>;
  /** Max characters to keep in output buffer (default: 50000) */
  maxBufferSize?: number;
  /** Characters of recent output to include in observations (default: 4000) */
  observationWindowSize?: number;
  /** Ms of no output before considering streaming stopped (default: 500) */
  streamingTimeout?: number;
  /** Terminal columns (default: 120) */
  cols?: number;
  /** Terminal rows (default: 40) */
  rows?: number;
  /** Unix socket path for proxy backend (default: ~/.darwin/terminald.sock) */
  proxySocketPath?: string;
  /** Auth token for proxy backend */
  proxyToken?: string;
  /** Timeout for proxy connection/spawn in ms (default: 5000) */
  proxyTimeoutMs?: number;
}

/**
 * Patterns for detecting terminal state
 */
export interface TerminalPatterns {
  /** Pattern to detect Claude prompt (ready for input) */
  prompt: RegExp;
  /** Pattern to detect usage limit reached */
  limitReached: RegExp;
  /** Patterns to detect questions */
  questions: RegExp[];
  /** Pattern to detect multi-choice questions (not y/n) */
  multiChoice: RegExp;
  /** Pattern to extract limit reset time */
  limitResetTime: RegExp;
}

/**
 * Default patterns for Claude Code REPL
 */
export const DEFAULT_PATTERNS: TerminalPatterns = {
  // Claude prompt is typically ">" at start of line
  prompt: /^\s*>\s*$/m,

  // Limit messages
  limitReached: /(?:^|\n).*?(?:usage limit reached|claude.*limit.*(?:reached|exceeded|hit)|limit reached.*(?:resets?|try again)|quota.*(?:reached|exceeded|hit)|rate limit.*(?:resets?|try again))/im,

  // Question patterns that require response
  questions: [
    /\?\s*\[y\/n\]/i,           // [y/n] prompts
    /\?\s*\(y\/n\)/i,           // (y/n) prompts
    /proceed\?/i,               // proceed?
    /continue\?/i,              // continue?
    /should I\s+\w+\?/i,        // should I ...?
    /do you want/i,             // do you want...
    /would you like/i,          // would you like...
    /apply.*\?/i,               // apply changes?
    /create.*\?/i,              // create file?
    /delete.*\?/i,              // delete file?
    /overwrite.*\?/i,           // overwrite?
    /press\s+enter/i,           // press enter to continue
    /hit\s+enter/i,             // hit enter to continue
    /press\s+return/i,          // press return
    /use (?:the )?arrow keys/i, // menu selection prompts
    /select (?:an|a) option/i,  // select an option
    /choose (?:an|a) option/i,  // choose an option
  ],

  // Multi-choice questions (numbered options)
  multiChoice: /^\s*[1-9]\.\s+.+$/m,

  // Extract reset time from limit message
  limitResetTime: /resets?\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i,
};

/**
 * Events emitted by the terminal controller
 */
export interface TerminalEvents {
  /** Emitted when output is received */
  output: (data: string) => void;
  /** Emitted when state changes */
  stateChange: (from: TerminalState, to: TerminalState) => void;
  /** Emitted when a question is detected */
  question: (question: string) => void;
  /** Emitted when limit is reached */
  limitReached: (resetTime?: Date) => void;
  /** Emitted when process exits */
  exit: (code: number | null, signal: string | null) => void;
  /** Emitted on error */
  error: (error: Error) => void;
}

/**
 * Result of executing an action
 */
export interface ActionResult {
  success: boolean;
  /** Error message if success is false */
  error?: string;
  /** New state after action */
  newState: TerminalState;
}

/**
 * Dangerous patterns that should never be typed
 * These are hardcoded safety blocks
 */
export const DANGEROUS_PATTERNS: RegExp[] = [
  /rm\s+-rf\s+[\/~]/i,           // rm -rf with absolute/home path
  /rm\s+-rf\s+\*/i,              // rm -rf *
  /sudo\s+rm/i,                  // sudo rm
  /sudo\s+dd/i,                  // sudo dd
  /dd\s+if=.*of=\/dev\//i,       // dd to device
  />\s*\/dev\/sd[a-z]/i,         // write to disk device
  />\s*\/dev\/null/i,            // not dangerous but suspicious
  /--force.*push\s+.*main/i,     // force push to main
  /--force.*push\s+.*master/i,   // force push to master
  /drop\s+table/i,               // SQL drop table
  /drop\s+database/i,            // SQL drop database
  /truncate\s+table/i,           // SQL truncate
  /delete\s+from\s+\w+\s*;/i,    // DELETE without WHERE
  /npm\s+publish/i,              // prevent accidental publish
  /:\(\)\s*\{\s*:\|:\s*&\s*\};:/, // fork bomb
];

/**
 * Check if content contains dangerous patterns
 */
export function containsDangerousPattern(content: string): { dangerous: boolean; pattern?: string } {
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(content)) {
      return { dangerous: true, pattern: pattern.source };
    }
  }
  return { dangerous: false };
}
