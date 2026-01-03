/**
 * Module - Base class and loader for Darwin modules
 */

import { DarwinBrain, Tool } from './brain.js';
import { Logger } from './logger.js';

export interface ModuleConfig {
  enabled: boolean;
  [key: string]: unknown;
}

export type ModuleStatus = 'stopped' | 'starting' | 'running' | 'error';

/**
 * Base class for all Darwin modules
 */
export abstract class DarwinModule {
  abstract readonly name: string;
  abstract readonly description: string;

  protected brain: DarwinBrain;
  protected config: ModuleConfig;
  protected logger: Logger;
  protected _enabled = false;
  protected _healthy = false;
  protected _status: ModuleStatus = 'stopped';
  protected _lastActivity: Date = new Date();

  constructor(brain: DarwinBrain, config: ModuleConfig) {
    this.brain = brain;
    this.config = config;
    this.logger = new Logger(this.constructor.name.replace('Module', ''));
  }

  /**
   * Initialize the module (register tools, set up resources)
   */
  abstract init(): Promise<void>;

  /**
   * Start the module (begin processing)
   */
  abstract start(): Promise<void>;

  /**
   * Stop the module (cleanup)
   */
  abstract stop(): Promise<void>;

  /**
   * Register a tool with the Brain
   */
  protected registerTool(
    name: string,
    description: string,
    parameters: Tool['function']['parameters'],
    handler: (args: Record<string, unknown>) => Promise<unknown>
  ): void {
    this.brain.registerTool(name, description, parameters, handler);
  }

  /**
   * Update last activity timestamp
   */
  protected touch(): void {
    this._lastActivity = new Date();
  }

  get enabled(): boolean {
    return this._enabled;
  }

  get healthy(): boolean {
    return this._healthy;
  }

  get status(): ModuleStatus {
    return this._status;
  }

  get lastActivity(): Date {
    return this._lastActivity;
  }
}

// Keep old name as alias for backwards compatibility
export { DarwinModule as HomebaseModule };

interface RegisteredModule {
  ModuleClass: new (brain: DarwinBrain, config: ModuleConfig) => DarwinModule;
  config: ModuleConfig;
  instance?: DarwinModule;
}

/**
 * Manages module lifecycle
 */
export class ModuleLoader {
  private brain: DarwinBrain;
  private modules: Map<string, RegisteredModule> = new Map();
  private logger: Logger;

  constructor(brain: DarwinBrain) {
    this.brain = brain;
    this.logger = new Logger('ModuleLoader');
  }

  /**
   * Register a module class with its config
   */
  register(
    ModuleClass: new (brain: DarwinBrain, config: ModuleConfig) => DarwinModule,
    config: ModuleConfig
  ): void {
    const name = ModuleClass.name;
    this.modules.set(name, { ModuleClass, config });
    this.logger.debug(`Registered: ${name}`);
  }

  /**
   * Initialize all registered modules
   */
  async initAll(): Promise<void> {
    for (const [name, reg] of this.modules) {
      if (!reg.config.enabled) {
        this.logger.debug(`Skipping disabled module: ${name}`);
        continue;
      }

      try {
        reg.instance = new reg.ModuleClass(this.brain, reg.config);
        reg.instance['_status'] = 'starting';
        await reg.instance.init();
        this.logger.info(`Initialized: ${name}`);
      } catch (error) {
        this.logger.error(`Failed to init ${name}:`, error);
        if (reg.instance) {
          reg.instance['_status'] = 'error';
        }
      }
    }
  }

  /**
   * Start all initialized modules
   */
  async startAll(): Promise<void> {
    for (const [name, reg] of this.modules) {
      if (!reg.instance || reg.instance.status === 'error') continue;

      try {
        await reg.instance.start();
        reg.instance['_status'] = 'running';
        this.logger.info(`Started: ${name}`);
      } catch (error) {
        this.logger.error(`Failed to start ${name}:`, error);
        reg.instance['_status'] = 'error';
      }
    }
  }

  /**
   * Stop all running modules
   */
  async stopAll(): Promise<void> {
    for (const [name, reg] of this.modules) {
      if (!reg.instance) continue;

      try {
        await reg.instance.stop();
        reg.instance['_status'] = 'stopped';
        this.logger.info(`Stopped: ${name}`);
      } catch (error) {
        this.logger.error(`Failed to stop ${name}:`, error);
      }
    }
  }

  /**
   * Get names of all registered modules
   */
  getModuleNames(): string[] {
    return Array.from(this.modules.keys());
  }

  /**
   * Get status of all modules
   */
  getStatuses(): Record<string, { enabled: boolean; status: ModuleStatus; healthy: boolean }> {
    const statuses: Record<string, { enabled: boolean; status: ModuleStatus; healthy: boolean }> = {};

    for (const [name, reg] of this.modules) {
      statuses[name] = {
        enabled: reg.config.enabled,
        status: reg.instance?.status ?? 'stopped',
        healthy: reg.instance?.healthy ?? false,
      };
    }

    return statuses;
  }

  /**
   * Get a module instance by name
   */
  get(name: string): DarwinModule | undefined {
    return this.modules.get(name)?.instance;
  }
}
