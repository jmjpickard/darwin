/**
 * Terminal Controller - PTY-based terminal emulation for Claude Code interaction
 *
 * Provides a real terminal environment for Claude Code, allowing observation
 * of output and injection of input just like a human would interact.
 *
 * Uses node-pty for proper terminal emulation including:
 * - ANSI escape code handling
 * - Terminal resize
 * - Signal forwarding (Ctrl+C, Ctrl+D)
 */

import { EventEmitter } from 'events';
import * as pty from 'node-pty';
import { Logger } from './logger.js';
import { ensureNodePtyHelperExecutable } from './terminal-pty-helper.js';
import {
  TerminalBackend,
  TerminalState,
  TerminalAction,
  TerminalObservation,
  TerminalControllerConfig,
  TerminalPatterns,
  TerminalEvents,
  ActionResult,
  DEFAULT_PATTERNS,
  containsDangerousPattern,
} from './terminal-types.js';
import { spawnProxyTerminal } from './terminal-proxy.js';

// Re-export types for convenience
export type { TerminalBackend, TerminalState, TerminalAction, TerminalObservation, TerminalControllerConfig };

/**
 * Strip ANSI escape codes from terminal output
 */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
            .replace(/\x1b\][^\x07]*\x07/g, '')  // OSC sequences
            .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, '') // DCS/PM/APC/SOS
            .replace(/[\x00-\x09\x0b\x0c\x0e-\x1f]/g, ''); // Control chars except \n\r
}

function formatArgsForLog(args: string[]): string {
  const redacted = [...args];
  for (let i = 0; i < redacted.length; i += 1) {
    const value = redacted[i];
    if (value === '-p' || value === '--prompt') {
      if (i + 1 < redacted.length) {
        redacted[i + 1] = '<prompt>';
      }
      continue;
    }
    if (value.startsWith('--prompt=')) {
      redacted[i] = '--prompt=<prompt>';
    }
  }
  return redacted.join(' ');
}

function normalizeBackend(value: string | undefined): TerminalBackend | null {
  if (!value) return null;
  const normalized = value.toLowerCase();
  if (normalized === 'pty' || normalized === 'proxy') {
    return normalized as TerminalBackend;
  }
  return null;
}

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: Required<TerminalControllerConfig> = {
  backend: 'pty',
  shell: '/bin/bash',
  cwd: process.cwd(),
  env: {},
  maxBufferSize: 50000,
  observationWindowSize: 4000,
  streamingTimeout: 500,
  cols: 120,
  rows: 40,
  proxySocketPath: '',
  proxyToken: '',
  proxyTimeoutMs: 5000,
};

interface TerminalProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(callback: (data: string) => void): void;
  onExit(callback: (event: { exitCode: number | null; signal?: string | number | null }) => void): void;
  onError?(callback: (error: Error) => void): void;
  close?(): void;
}

export class TerminalController extends EventEmitter {
  private config: Required<TerminalControllerConfig>;
  private patterns: TerminalPatterns;
  private logger: Logger;

  private ptyProcess: TerminalProcess | null = null;
  private outputBuffer: string = '';
  private state: TerminalState = 'idle';
  private sessionStartTime: number = 0;
  private lastActionTime: number = 0;
  private lastOutputTime: number = 0;
  private detectedQuestion: string | null = null;
  private detectedLimitResetTime: Date | null = null;

  constructor(config: TerminalControllerConfig, patterns: TerminalPatterns = DEFAULT_PATTERNS) {
    super();
    this.logger = new Logger('Terminal');
    const merged = { ...DEFAULT_CONFIG, ...config };
    const envBackend = normalizeBackend(process.env.DARWIN_TERMINAL_BACKEND);
    if (!config.backend && envBackend) {
      merged.backend = envBackend;
    } else if (!config.backend && process.env.DARWIN_TERMINAL_BACKEND && !envBackend) {
      this.logger.warn(`Unknown DARWIN_TERMINAL_BACKEND: ${process.env.DARWIN_TERMINAL_BACKEND}`);
    }

    if (!config.proxySocketPath && process.env.DARWIN_TERMINAL_PROXY_SOCKET) {
      merged.proxySocketPath = process.env.DARWIN_TERMINAL_PROXY_SOCKET;
    }

    if (!config.proxyToken && process.env.DARWIN_TERMINAL_PROXY_TOKEN) {
      merged.proxyToken = process.env.DARWIN_TERMINAL_PROXY_TOKEN;
    }

    if (!config.proxyTimeoutMs && process.env.DARWIN_TERMINAL_PROXY_TIMEOUT_MS) {
      const parsed = Number(process.env.DARWIN_TERMINAL_PROXY_TIMEOUT_MS);
      if (Number.isFinite(parsed) && parsed > 0) {
        merged.proxyTimeoutMs = parsed;
      }
    }

    this.config = merged;
    this.patterns = patterns;
  }

  /**
   * Start a new terminal session with the given command
   */
  async start(command: string, args: string[] = []): Promise<void> {
    if (this.state !== 'idle') {
      throw new Error(`Cannot start: terminal is in state ${this.state}`);
    }

    this.setState('starting');
    this.sessionStartTime = Date.now();
    this.lastActionTime = Date.now();
    this.outputBuffer = '';

    // Merge environment
    const env = {
      ...process.env,
      ...this.config.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    };

    const formattedArgs = args.length > 0 ? ` ${formatArgsForLog(args)}` : '';
    this.logger.info(`Starting terminal (${this.config.backend}): ${command}${formattedArgs}`);
    this.logger.debug(`CWD: ${this.config.cwd}`);

    try {
      if (this.config.backend === 'proxy') {
        this.logger.debug(`Proxy socket: ${this.config.proxySocketPath || 'default'}`);
        this.ptyProcess = await spawnProxyTerminal(
          {
            socketPath: this.config.proxySocketPath || undefined,
            token: this.config.proxyToken || undefined,
            timeoutMs: this.config.proxyTimeoutMs,
            logger: this.logger,
          },
          {
            command,
            args,
            cwd: this.config.cwd,
            env: env as { [key: string]: string },
            cols: this.config.cols,
            rows: this.config.rows,
          }
        );
      } else {
        await ensureNodePtyHelperExecutable(this.logger);
        this.ptyProcess = pty.spawn(command, args, {
          name: 'xterm-256color',
          cols: this.config.cols,
          rows: this.config.rows,
          cwd: this.config.cwd,
          env: env as { [key: string]: string },
        });
      }

      this.setupHandlers();
    } catch (error) {
      this.setState('error');
      throw error;
    }
  }

  /**
   * Start Claude Code in interactive REPL mode
   */
  async startClaude(additionalArgs: string[] = []): Promise<void> {
    // Claude REPL mode - just run 'claude' without -p flag
    const args = [...additionalArgs];
    await this.start('claude', args);
  }

  /**
   * Stop the terminal session
   */
  async stop(force = false): Promise<void> {
    if (!this.ptyProcess || this.state === 'idle') {
      return;
    }

    this.setState('stopping');

    if (force) {
      this.ptyProcess.kill();
    } else {
      // Try graceful shutdown first
      this.write('\x03'); // Ctrl+C
      await this.wait(100);
      this.write('/exit\n');

      // Wait for exit or force kill after timeout
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (this.ptyProcess) {
            this.logger.warn('Graceful shutdown timed out, killing process');
            this.ptyProcess.kill();
          }
          resolve();
        }, 3000);

        const onExit = () => {
          clearTimeout(timeout);
          resolve();
        };

        if (this.ptyProcess) {
          this.ptyProcess.onExit(onExit);
        } else {
          clearTimeout(timeout);
          resolve();
        }
      });
    }

    this.cleanup();
  }

  /**
   * Execute an action on the terminal
   */
  async executeAction(action: TerminalAction): Promise<ActionResult> {
    if (!this.ptyProcess || this.state === 'idle' || this.state === 'stopping') {
      return {
        success: false,
        error: `Cannot execute action: terminal is ${this.state}`,
        newState: this.state,
      };
    }

    // Safety check
    if (action.content) {
      const safety = containsDangerousPattern(action.content);
      if (safety.dangerous) {
        this.logger.error(`BLOCKED dangerous pattern: ${safety.pattern}`);
        (this as TerminalController & { emit(event: 'error', err: Error): boolean }).emit(
          'error',
          new Error(`Dangerous pattern blocked: ${safety.pattern}`)
        );
        return {
          success: false,
          error: `Dangerous pattern blocked: ${safety.pattern}`,
          newState: this.state,
        };
      }
    }

    this.lastActionTime = Date.now();

    try {
      switch (action.type) {
        case 'type':
          if (action.content) {
            this.write(action.content);
          }
          break;

        case 'enter':
          this.write('\r');
          this.setState('waiting_response');
          break;

        case 'send':
          if (action.content) {
            this.write(action.content + '\r');
            this.setState('waiting_response');
          }
          break;

        case 'answer':
          if (action.content) {
            this.write(action.content + '\r');
            this.detectedQuestion = null;
            this.setState('waiting_response');
          }
          break;

        case 'ctrl_c':
          this.write('\x03');
          break;

        case 'ctrl_d':
          this.write('\x04');
          break;

        case 'wait':
          if (action.waitMs) {
            await this.wait(action.waitMs);
          }
          break;

        default:
          return {
            success: false,
            error: `Unknown action type: ${action.type}`,
            newState: this.state,
          };
      }

      this.logger.debug(`Action executed: ${action.type}${action.content ? ` "${action.content.slice(0, 50)}..."` : ''}`);

      return {
        success: true,
        newState: this.state,
      };
    } catch (error) {
      this.logger.error(`Action failed: ${error}`);
      return {
        success: false,
        error: String(error),
        newState: this.state,
      };
    }
  }

  /**
   * Get current observation of terminal state
   */
  getObservation(): TerminalObservation {
    const now = Date.now();
    const recentOutput = this.getRecentOutput();
    const isStreaming = now - this.lastOutputTime < this.config.streamingTimeout;

    return {
      state: this.state,
      recentOutput,
      promptVisible: this.isPromptVisible(recentOutput),
      lastQuestion: this.detectedQuestion || undefined,
      limitResetTime: this.detectedLimitResetTime || undefined,
      elapsedMs: this.sessionStartTime ? now - this.sessionStartTime : 0,
      timeSinceLastActionMs: this.lastActionTime ? now - this.lastActionTime : 0,
      bufferLines: this.outputBuffer.split('\n').length,
      isStreaming,
    };
  }

  /**
   * Get current state
   */
  getState(): TerminalState {
    return this.state;
  }

  /**
   * Get full output buffer
   */
  getFullBuffer(): string {
    return this.outputBuffer;
  }

  /**
   * Clear the output buffer
   */
  clearBuffer(): void {
    this.outputBuffer = '';
  }

  /**
   * Wait for a specific state or timeout
   * Useful for waiting until Claude is ready or processing completes
   */
  waitForState(
    targetState: TerminalState | TerminalState[],
    timeoutMs: number = 30000
  ): Promise<{ reached: boolean; state: TerminalState; timedOut: boolean }> {
    const targets = Array.isArray(targetState) ? targetState : [targetState];

    return new Promise((resolve) => {
      // Check if already in target state
      if (targets.includes(this.state)) {
        resolve({ reached: true, state: this.state, timedOut: false });
        return;
      }

      const timeout = setTimeout(() => {
        this.off('stateChange', onStateChange);
        resolve({ reached: false, state: this.state, timedOut: true });
      }, timeoutMs);

      const onStateChange = (_from: TerminalState, to: TerminalState) => {
        if (targets.includes(to)) {
          clearTimeout(timeout);
          this.off('stateChange', onStateChange);
          resolve({ reached: true, state: to, timedOut: false });
        }
      };

      this.on('stateChange', onStateChange);
    });
  }

  /**
   * Wait for output to contain a pattern or timeout
   * Useful for waiting for specific Claude responses
   */
  waitForOutput(
    pattern: RegExp | string,
    timeoutMs: number = 30000
  ): Promise<{ found: boolean; match?: string; timedOut: boolean }> {
    const regex = typeof pattern === 'string' ? new RegExp(pattern) : pattern;

    return new Promise((resolve) => {
      // Check current buffer first
      const currentMatch = this.outputBuffer.match(regex);
      if (currentMatch) {
        resolve({ found: true, match: currentMatch[0], timedOut: false });
        return;
      }

      const timeout = setTimeout(() => {
        this.off('output', onOutput);
        resolve({ found: false, timedOut: true });
      }, timeoutMs);

      const onOutput = () => {
        const match = this.outputBuffer.match(regex);
        if (match) {
          clearTimeout(timeout);
          this.off('output', onOutput);
          resolve({ found: true, match: match[0], timedOut: false });
        }
      };

      this.on('output', onOutput);
    });
  }

  /**
   * Wait for the terminal to become idle (no output for specified duration)
   * Useful for detecting when Claude has finished responding
   */
  waitForIdle(idleDurationMs: number = 1000, timeoutMs: number = 60000): Promise<{ idle: boolean; timedOut: boolean }> {
    return new Promise((resolve) => {
      let idleTimer: NodeJS.Timeout | null = null;

      const timeout = setTimeout(() => {
        if (idleTimer) clearTimeout(idleTimer);
        this.off('output', onOutput);
        resolve({ idle: false, timedOut: true });
      }, timeoutMs);

      const resetIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          clearTimeout(timeout);
          this.off('output', onOutput);
          resolve({ idle: true, timedOut: false });
        }, idleDurationMs);
      };

      const onOutput = () => {
        resetIdleTimer();
      };

      this.on('output', onOutput);
      resetIdleTimer(); // Start the idle timer
    });
  }

  /**
   * Resize the terminal
   */
  resize(cols: number, rows: number): void {
    if (this.ptyProcess) {
      this.ptyProcess.resize(cols, rows);
      this.config.cols = cols;
      this.config.rows = rows;
    }
  }

  // Private methods

  private setupHandlers(): void {
    if (!this.ptyProcess) return;

    this.ptyProcess.onData((data: string) => {
      this.lastOutputTime = Date.now();

      // Append to buffer (strip ANSI for clean storage)
      const cleanData = stripAnsi(data);
      this.outputBuffer += cleanData;

      // Trim buffer if too large
      if (this.outputBuffer.length > this.config.maxBufferSize) {
        const trimPoint = this.outputBuffer.length - this.config.maxBufferSize;
        // Find next newline to trim cleanly
        const newlineIdx = this.outputBuffer.indexOf('\n', trimPoint);
        this.outputBuffer = this.outputBuffer.slice(newlineIdx + 1);
      }

      // Emit raw data for subscribers who want it
      (this as TerminalController & { emit(event: 'output', data: string): boolean }).emit('output', data);

      // Analyze output for state changes
      this.analyzeOutput(cleanData);
    });

    this.ptyProcess.onExit(({ exitCode, signal }) => {
      this.logger.info(`Terminal exited: code=${exitCode}, signal=${signal}`);
      (this as TerminalController & { emit(event: 'exit', code: number | null, signal: string | null): boolean }).emit(
        'exit',
        exitCode,
        signal !== undefined ? String(signal) : null
      );
      this.cleanup();
    });

    this.ptyProcess.onError?.((error: Error) => {
      this.logger.error(`Terminal error: ${error.message}`);
      this.setState('error');
      (this as TerminalController & { emit(event: 'error', err: Error): boolean }).emit('error', error);
    });
  }

  private analyzeOutput(data: string): void {
    const recent = this.getRecentLines(12).join('\n');

    // Check for questions
    for (const pattern of this.patterns.questions) {
      const match = recent.match(pattern);
      if (match) {
        // Extract the question context (line containing the match)
        const lines = recent.split('\n');
        const questionLine = lines.find(line => pattern.test(line));
        if (questionLine) {
          this.detectedQuestion = questionLine.trim();
          this.setState('question');
          (this as TerminalController & { emit(event: 'question', q: string): boolean }).emit('question', this.detectedQuestion);
          return;
        }
      }
    }

    // Check for prompt (ready state)
    if (this.isPromptVisible(recent)) {
      if (this.state !== 'ready') {
        this.setState('ready');
      }
      return;
    }

    // Check for menu-style prompts only when we see explicit selection hints
    const hasMenuHint = /(?:arrow keys|select (?:an|a) option|select one|choose (?:an|a) option|choose one)/i.test(recent);
    if (hasMenuHint) {
      const menuLines = recent
        .split('\n')
        .filter((line) =>
          /^\s*[>]\s+\S+/.test(line) ||
          /^\s*\([xX ]\)\s+\S+/.test(line) ||
          /^\s*\[[xX ]\]\s+\S+/.test(line) ||
          /^\s*\d+[.)]\s+\S+/.test(line)
        );

      if (menuLines.length >= 2 && this.state !== 'ready') {
        this.detectedQuestion = menuLines[0].trim();
        this.setState('question');
        (this as TerminalController & { emit(event: 'question', q: string): boolean }).emit(
          'question',
          this.detectedQuestion
        );
        return;
      }
    }

    // Check for limit reached (avoid stale matches when prompt is visible)
    if (this.patterns.limitReached.test(recent)) {
      if (this.state !== 'limit_reached') {
        const resetMatch = recent.match(this.patterns.limitResetTime);
        if (resetMatch) {
          this.detectedLimitResetTime = this.parseResetTime(resetMatch[1]);
        }
        this.setState('limit_reached');
        (this as TerminalController & { emit(event: 'limitReached', time: Date | undefined): boolean }).emit(
          'limitReached',
          this.detectedLimitResetTime || undefined
        );
      }
      return;
    }

    // If we have output and not in specific states, we're processing
    if (data.trim()) {
      if (this.state === 'waiting_response' || this.state === 'starting') {
        this.setState('processing');
      }
    }
  }

  private isPromptVisible(text: string): boolean {
    // Check last few lines for prompt
    const lines = text.split('\n').slice(-5);
    const lastContent = lines.join('\n');
    return this.patterns.prompt.test(lastContent);
  }

  private getRecentOutput(): string {
    if (this.outputBuffer.length <= this.config.observationWindowSize) {
      return this.outputBuffer;
    }
    return this.outputBuffer.slice(-this.config.observationWindowSize);
  }

  private getRecentLines(count: number): string[] {
    const recent = this.getRecentOutput();
    const lines = recent.split('\n');
    if (lines.length <= count) {
      return lines;
    }
    return lines.slice(-count);
  }

  private parseResetTime(timeStr: string): Date {
    // Parse time strings like "2pm", "2:30pm", "14:30"
    const now = new Date();
    const match = timeStr.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);

    if (!match) {
      // Default to 1 hour from now
      return new Date(now.getTime() + 60 * 60 * 1000);
    }

    let hours = parseInt(match[1], 10);
    const minutes = match[2] ? parseInt(match[2], 10) : 0;
    const period = match[3]?.toLowerCase();

    if (period === 'pm' && hours < 12) hours += 12;
    if (period === 'am' && hours === 12) hours = 0;

    const resetTime = new Date(now);
    resetTime.setHours(hours, minutes, 0, 0);

    // If time is in the past, assume next day
    if (resetTime.getTime() < now.getTime()) {
      resetTime.setDate(resetTime.getDate() + 1);
    }

    return resetTime;
  }

  private setState(newState: TerminalState): void {
    if (this.state !== newState) {
      const oldState = this.state;
      this.state = newState;
      this.logger.debug(`State: ${oldState} -> ${newState}`);
      (this as TerminalController & { emit(event: 'stateChange', from: TerminalState, to: TerminalState): boolean }).emit(
        'stateChange',
        oldState,
        newState
      );
    }
  }

  private write(data: string): void {
    if (this.ptyProcess) {
      this.ptyProcess.write(data);
    }
  }

  private wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private cleanup(): void {
    this.ptyProcess?.close?.();
    this.ptyProcess = null;
    this.setState('idle');
    this.outputBuffer = '';
    this.detectedQuestion = null;
    this.detectedLimitResetTime = null;
    this.sessionStartTime = 0;
    this.lastActionTime = 0;
  }


  // Typed event emitter methods
  override on<K extends keyof TerminalEvents>(event: K, listener: TerminalEvents[K]): this {
    return super.on(event, listener);
  }

  override once<K extends keyof TerminalEvents>(event: K, listener: TerminalEvents[K]): this {
    return super.once(event, listener);
  }

  override off<K extends keyof TerminalEvents>(event: K, listener: TerminalEvents[K]): this {
    return super.off(event, listener);
  }
}
