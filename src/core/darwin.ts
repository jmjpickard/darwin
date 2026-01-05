/**
 * Darwin - Local home intelligence system
 *
 * Coordinates:
 * - Home automation (lights, heating, sensors)
 * - Code agent tasks (Claude Code + Beads)
 * - Energy monitoring
 * - Security
 *
 * Powered by Qwen2.5 3B via Ollama
 */

import { DarwinBrain, BrainConfig } from './brain.js';
import { ModuleLoader, DarwinModule, ModuleConfig } from './module.js';
import { EventBus, eventBus, DarwinEvent } from './event-bus.js';
import { Logger, setLogLevel, LogLevel } from './logger.js';
import { DarwinUserConfig } from './config.js';

export interface DarwinConfig {
  brain: Partial<BrainConfig>;
  modules: Record<string, ModuleConfig>;
  logLevel: LogLevel;
  observeEvents: boolean; // Should Brain observe all events?
  userConfig?: DarwinUserConfig; // User config from ~/.darwin/config.json
}

const DEFAULT_CONFIG: DarwinConfig = {
  brain: {},
  modules: {},
  logLevel: 'info',
  observeEvents: true,
};

export class Darwin {
  private config: DarwinConfig;
  private brain: DarwinBrain;
  private modules: ModuleLoader;
  private eventBus: EventBus;
  private logger: Logger;
  private isRunning = false;
  private isPausedState = false;

  constructor(config: Partial<DarwinConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    setLogLevel(this.config.logLevel);

    this.logger = new Logger('Darwin');
    this.brain = new DarwinBrain(this.config.brain);
    this.modules = new ModuleLoader(this.brain);
    this.eventBus = eventBus;
  }

  /**
   * Register a module
   */
  use(
    ModuleClass: new (brain: DarwinBrain, config: ModuleConfig) => DarwinModule,
    config?: Partial<ModuleConfig>
  ): this {
    const moduleName = ModuleClass.name.replace('Module', '').toLowerCase();
    const moduleConfig: ModuleConfig = {
      ...{ enabled: true },
      ...this.config.modules[moduleName],
      ...config,
    };
    this.modules.register(ModuleClass, moduleConfig);
    return this;
  }

  /**
   * Start Darwin
   */
  async start(): Promise<void> {
    this.logger.info('Starting Darwin...');

    // Check brain health
    const health = await this.brain.checkHealth();
    if (!health.healthy) {
      throw new Error(health.error || `Model ${health.model} not available. Run: ollama pull ${health.model}`);
    }
    this.logger.info(`   Model (${health.model}): OK`);

    // Set up event observation
    if (this.config.observeEvents) {
      this.setupEventObservation();
    }

    // Initialize and start modules
    await this.modules.initAll();
    await this.modules.startAll();

    this.isRunning = true;
    this.logger.info('Darwin running');

    // Emit startup event
    this.eventBus.publish('darwin', 'started', {
      modules: this.modules.getModuleNames(),
    });
  }

  /**
   * Stop Darwin
   */
  async stop(): Promise<void> {
    this.logger.info('Stopping Darwin...');
    this.isRunning = false;

    await this.modules.stopAll();
    await this.brain.shutdown();

    this.eventBus.publish('darwin', 'stopped', {});
    this.logger.info('Darwin stopped');
  }

  /**
   * Set up Brain to observe events and potentially react
   */
  private setupEventObservation(): void {
    // Events that should trigger Brain dispatch
    const dispatchPatterns = [
      /^home:motion:/,
      /^home:temperature:/,
      /^home:door:/,
      /^code:task_completed/,
      /^code:task_failed/,
      /^energy:power_spike/,
      /^security:alert/,
    ];

    // Debounce to avoid overwhelming the Brain
    let pendingEvents: DarwinEvent[] = [];
    let debounceTimer: NodeJS.Timeout | null = null;

    this.eventBus.subscribeToAll(async (event) => {
      // Check if this event should trigger dispatch
      const eventName = `${event.source}:${event.type}`;
      const shouldDispatch = dispatchPatterns.some(p => p.test(eventName));

      if (!shouldDispatch) return;

      pendingEvents.push(event);

      // Debounce - collect events for 1 second then dispatch
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        if (pendingEvents.length === 0) return;

        const events = pendingEvents;
        pendingEvents = [];

        // Format events for Brain
        const summary = events.map(e =>
          `[${e.source}:${e.type}] ${JSON.stringify(e.data)}`
        ).join('\n');

        try {
          await this.brain.dispatch(`Events occurred:\n${summary}`);
        } catch (error) {
          this.logger.error('Brain dispatch failed:', error);
        }
      }, 1000);
    });
  }

  /**
   * Get the Brain instance (for modules to use)
   */
  getBrain(): DarwinBrain {
    return this.brain;
  }

  /**
   * Get the event bus
   */
  getEventBus(): EventBus {
    return this.eventBus;
  }

  /**
   * Get module statuses
   */
  getStatus(): {
    running: boolean;
    modules: ReturnType<ModuleLoader['getStatuses']>;
    tools: string[];
  } {
    return {
      running: this.isRunning,
      modules: this.modules.getStatuses(),
      tools: this.brain.getTools().map(t => t.function.name),
    };
  }

  /**
   * Manually trigger a Brain dispatch (for testing/CLI)
   */
  async dispatch(event: string): Promise<unknown[]> {
    return this.brain.dispatch(event);
  }

  /**
   * Ask the reasoner a question (for complex decisions)
   */
  async reason(prompt: string): Promise<string> {
    return this.brain.reason(prompt);
  }

  /**
   * Chat with Darwin - the main conversational interface
   */
  async chat(message: string): Promise<import('./brain.js').ChatResponse> {
    return this.brain.chat(message);
  }

  /**
   * Clear conversation history
   */
  clearChat(): void {
    this.brain.clearHistory();
  }

  /**
   * Pause Darwin - finish current task but don't pick up new ones
   */
  pause(): void {
    this.isPausedState = true;
    this.logger.info('Darwin paused - will finish current task but not start new ones');
    this.eventBus.publish('darwin', 'paused', {});
  }

  /**
   * Resume Darwin - start picking up tasks again
   */
  resume(): void {
    this.isPausedState = false;
    this.logger.info('Darwin resumed - will pick up tasks');
    this.eventBus.publish('darwin', 'resumed', {});
  }

  /**
   * Check if Darwin is paused
   */
  isPaused(): boolean {
    return this.isPausedState;
  }

  /**
   * Get the user config
   */
  getUserConfig(): DarwinUserConfig | undefined {
    return this.config.userConfig;
  }

  /**
   * Get the module loader (for accessing specific modules)
   */
  getModules(): ModuleLoader {
    return this.modules;
  }
}

// Keep old name as alias for backwards compatibility
export { Darwin as Homebase };

// Re-export for convenience
export { DarwinBrain, DarwinModule, eventBus, Logger };
export type { ModuleConfig } from './module.js';
export type { Tool, ToolCall } from './brain.js';
export type { ModuleStatus } from './module.js';
export type { DarwinEvent } from './event-bus.js';
