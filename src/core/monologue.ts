/**
 * Monologue - Darwin's internal thought stream
 *
 * Provides visibility into Darwin's thinking process.
 * Thoughts are emitted in real-time and can be:
 * - Displayed in the CLI (streaming above user input)
 * - Logged to file (~/.darwin/monologue.log)
 * - Published to EventBus for other modules
 */

import { EventEmitter } from 'events';
import { appendFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { eventBus } from './event-bus.js';

export type ThoughtType =
  | 'idle'        // Nothing happening, just observing
  | 'observation' // Noticed something (event, condition)
  | 'reasoning'   // Working through a problem
  | 'decision'    // Made a choice about what to do
  | 'action'      // Taking an action
  | 'result'      // Outcome of an action
  | 'alert'       // Something needs attention
  | 'question'    // Asking the user something
  | 'status';     // Periodic status update

export type Priority = 'low' | 'normal' | 'high' | 'urgent';

export interface Thought {
  id: string;
  type: ThoughtType;
  content: string;
  timestamp: Date;
  priority: Priority;
  context?: Record<string, unknown>;
}

// Icons for each thought type (for CLI display)
const THOUGHT_ICONS: Record<ThoughtType, string> = {
  idle: '\u{1F4AD}',        // thought bubble
  observation: '\u{1F440}', // eyes
  reasoning: '\u{1F9E0}',   // brain
  decision: '\u{1F3AF}',    // target
  action: '\u{26A1}',       // lightning
  result: '\u{2705}',       // check
  alert: '\u{1F6A8}',       // siren
  question: '\u{2753}',     // question mark
  status: '\u{1F4CA}',      // chart
};

// ANSI colors for priority levels
const PRIORITY_COLORS: Record<Priority, string> = {
  low: '\x1b[90m',      // dim gray
  normal: '\x1b[0m',    // default
  high: '\x1b[33m',     // yellow
  urgent: '\x1b[31m',   // red
};

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

export interface MonologueConfig {
  /** Enable console output */
  consoleEnabled: boolean;
  /** Enable file logging */
  fileLoggingEnabled: boolean;
  /** Log file path (default: ~/.darwin/monologue.log) */
  logFilePath?: string;
  /** Enable EventBus publishing */
  eventBusEnabled: boolean;
  /** Maximum thoughts to keep in memory */
  maxHistory: number;
}

const DEFAULT_CONFIG: MonologueConfig = {
  consoleEnabled: true,
  fileLoggingEnabled: true,
  eventBusEnabled: true,
  maxHistory: 100,
};

type ThoughtHandler = (thought: Thought) => void;

export class Monologue extends EventEmitter {
  private config: MonologueConfig;
  private history: Thought[] = [];
  private handlers: Set<ThoughtHandler> = new Set();
  private logFileReady = false;
  private thoughtCounter = 0;

  constructor(config: Partial<MonologueConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.initLogFile();
  }

  private async initLogFile(): Promise<void> {
    if (!this.config.fileLoggingEnabled) return;

    try {
      const logDir = this.config.logFilePath
        ? this.config.logFilePath.replace(/\/[^/]+$/, '')
        : join(homedir(), '.darwin');

      await mkdir(logDir, { recursive: true });
      this.logFileReady = true;
    } catch {
      // Silently fail - file logging is optional
    }
  }

  private getLogFilePath(): string {
    return this.config.logFilePath || join(homedir(), '.darwin', 'monologue.log');
  }

  /**
   * Emit a thought
   */
  think(
    type: ThoughtType,
    content: string,
    options: { priority?: Priority; context?: Record<string, unknown> } = {}
  ): Thought {
    const thought: Thought = {
      id: `thought-${++this.thoughtCounter}-${Date.now()}`,
      type,
      content,
      timestamp: new Date(),
      priority: options.priority || 'normal',
      context: options.context,
    };

    // Add to history
    this.history.push(thought);
    if (this.history.length > this.config.maxHistory) {
      this.history.shift();
    }

    // Output to console
    if (this.config.consoleEnabled) {
      this.outputToConsole(thought);
    }

    // Log to file
    if (this.config.fileLoggingEnabled && this.logFileReady) {
      this.logToFile(thought);
    }

    // Publish to EventBus
    if (this.config.eventBusEnabled) {
      eventBus.publish('darwin', 'thought', {
        id: thought.id,
        type: thought.type,
        content: thought.content,
        priority: thought.priority,
        context: thought.context,
      });
    }

    // Notify subscribers
    for (const handler of this.handlers) {
      try {
        handler(thought);
      } catch {
        // Don't let handler errors break the monologue
      }
    }

    // Emit event for EventEmitter subscribers
    this.emit('thought', thought);

    return thought;
  }

  /**
   * Format and output thought to console
   */
  private outputToConsole(thought: Thought): void {
    const time = thought.timestamp.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    const icon = THOUGHT_ICONS[thought.type];
    const color = PRIORITY_COLORS[thought.priority];

    // Format: [HH:MM:SS] icon content
    const line = `${DIM}[${time}]${RESET} ${icon} ${color}${thought.content}${RESET}`;
    console.log(line);
  }

  /**
   * Log thought to file
   */
  private async logToFile(thought: Thought): Promise<void> {
    try {
      const timestamp = thought.timestamp.toISOString();
      const line = JSON.stringify({
        timestamp,
        type: thought.type,
        content: thought.content,
        priority: thought.priority,
        context: thought.context,
      }) + '\n';

      await appendFile(this.getLogFilePath(), line);
    } catch {
      // Silently fail - file logging is optional
    }
  }

  /**
   * Subscribe to thoughts
   */
  subscribe(handler: ThoughtHandler): void {
    this.handlers.add(handler);
  }

  /**
   * Unsubscribe from thoughts
   */
  unsubscribe(handler: ThoughtHandler): void {
    this.handlers.delete(handler);
  }

  /**
   * Get recent thoughts
   */
  getRecent(count?: number): Thought[] {
    const limit = count ?? this.config.maxHistory;
    return this.history.slice(-limit);
  }

  /**
   * Get thoughts by type
   */
  getByType(type: ThoughtType, count?: number): Thought[] {
    const filtered = this.history.filter(t => t.type === type);
    return count ? filtered.slice(-count) : filtered;
  }

  /**
   * Clear thought history
   */
  clearHistory(): void {
    this.history = [];
  }

  /**
   * Enable/disable console output (for switching modes)
   */
  setConsoleEnabled(enabled: boolean): void {
    this.config.consoleEnabled = enabled;
  }

  /**
   * Format a thought for display (without outputting)
   */
  format(thought: Thought): string {
    const time = thought.timestamp.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    const icon = THOUGHT_ICONS[thought.type];
    const color = PRIORITY_COLORS[thought.priority];

    return `${DIM}[${time}]${RESET} ${icon} ${color}${thought.content}${RESET}`;
  }

  // Convenience methods for common thought types

  idle(content: string): Thought {
    return this.think('idle', content, { priority: 'low' });
  }

  observe(content: string, context?: Record<string, unknown>): Thought {
    return this.think('observation', content, { context });
  }

  reason(content: string): Thought {
    return this.think('reasoning', content);
  }

  decide(content: string, context?: Record<string, unknown>): Thought {
    return this.think('decision', content, { context });
  }

  act(content: string, context?: Record<string, unknown>): Thought {
    return this.think('action', content, { context });
  }

  result(content: string, context?: Record<string, unknown>): Thought {
    return this.think('result', content, { context });
  }

  alert(content: string, context?: Record<string, unknown>): Thought {
    return this.think('alert', content, { priority: 'high', context });
  }

  question(content: string): Thought {
    return this.think('question', content, { priority: 'high' });
  }

  status(content: string): Thought {
    return this.think('status', content);
  }
}

// Singleton instance
let monologueInstance: Monologue | null = null;

export function getMonologue(config?: Partial<MonologueConfig>): Monologue {
  if (!monologueInstance) {
    monologueInstance = new Monologue(config);
  }
  return monologueInstance;
}

export function resetMonologue(): void {
  monologueInstance = null;
}
