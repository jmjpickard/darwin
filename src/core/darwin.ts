/**
 * Darwin - Local home intelligence system
 *
 * Coordinates:
 * - Home automation (lights, heating, sensors)
 * - Code agent tasks (Claude Code + Beads)
 * - Energy monitoring
 * - Security
 *
 * Powered by a configurable model via Ollama or OpenRouter
 */

import { DarwinBrain, BrainConfig } from './brain.js';
import { ModuleLoader, DarwinModule, ModuleConfig } from './module.js';
import { EventBus, eventBus, DarwinEvent } from './event-bus.js';
import { Logger, setLogLevel, LogLevel } from './logger.js';
import { DarwinUserConfig } from './config.js';
import { Monologue, getMonologue } from './monologue.js';
import { Consciousness, ConsciousnessConfig } from './consciousness.js';
import { SubAgentManager } from './sub-agents.js';
import { OpenRouterClient } from '../integrations/openrouter.js';
import { WebSearch } from '../integrations/web-search.js';

export interface DarwinConfig {
  brain: Partial<BrainConfig>;
  modules: Record<string, ModuleConfig>;
  logLevel: LogLevel;
  observeEvents: boolean; // Should Brain observe all events?
  userConfig?: DarwinUserConfig; // User config from ~/.darwin/config.json
  consciousness: Partial<ConsciousnessConfig>;
  consciousnessEnabled: boolean; // Enable proactive consciousness loop
}

const DEFAULT_CONFIG: DarwinConfig = {
  brain: {},
  modules: {},
  logLevel: 'info',
  observeEvents: true,
  consciousness: {},
  consciousnessEnabled: true,
};

export class Darwin {
  private config: DarwinConfig;
  private brain: DarwinBrain;
  private modules: ModuleLoader;
  private eventBus: EventBus;
  private logger: Logger;
  private monologue: Monologue;
  private consciousness: Consciousness;
  private subAgents: SubAgentManager;
  private openRouter: OpenRouterClient | null = null;
  private webSearch: WebSearch;
  private isRunning = false;
  private isPausedState = false;

  constructor(config: Partial<DarwinConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    setLogLevel(this.config.logLevel);

    this.logger = new Logger('Darwin');
    this.monologue = getMonologue({ consoleEnabled: false }); // CLI controls console output

    const userBrain = this.config.userConfig?.brain;
    const userOpenRouter = this.config.userConfig?.openrouter;
    const brainConfig: Partial<BrainConfig> = {
      ...this.config.brain,
      provider: userBrain?.provider,
      model: userBrain?.model,
      timeout: userBrain?.timeoutMs,
      openRouter: userOpenRouter?.apiKey
        ? {
          apiKey: userOpenRouter.apiKey,
          defaultModel: userOpenRouter.defaultModel,
          timeout: userBrain?.timeoutMs,
        }
        : undefined,
    };

    if (userBrain?.provider === 'openrouter' && !userBrain?.model) {
      brainConfig.model = userOpenRouter?.defaultModel || 'deepseek/deepseek-r1';
    }

    this.brain = new DarwinBrain(brainConfig);
    this.modules = new ModuleLoader(this.brain);
    this.eventBus = eventBus;
    this.subAgents = new SubAgentManager(this.monologue);
    this.webSearch = new WebSearch(this.config.userConfig?.webSearch);

    // Initialize OpenRouter if API key is configured
    const openRouterKey = this.config.userConfig?.openrouter?.apiKey;
    if (openRouterKey) {
      this.openRouter = new OpenRouterClient({
        apiKey: openRouterKey,
        defaultModel: this.config.userConfig?.openrouter?.defaultModel,
      });
    }

    this.consciousness = new Consciousness(
      this.brain,
      this.monologue,
      this.eventBus,
      {
        ...this.config.consciousness,
        ...this.config.userConfig?.consciousness,
      }
    );

    // Register consciousness action handlers
    this.setupConsciousnessActions();

    // Register integration tools with Brain
    this.registerIntegrationTools();
  }

  /**
   * Set up action handlers for consciousness to invoke
   */
  private setupConsciousnessActions(): void {
    this.consciousness.registerAction('check_tasks', async () => {
      // Will be handled by CodeAgent when available
      this.monologue.act('Checking task queue...');
      // TODO: Trigger CodeAgent to check and potentially start tasks
    });

    this.consciousness.registerAction('check_home', async () => {
      this.monologue.act('Checking home status...');
      // TODO: Trigger HomeAutomation to report status
    });

    this.consciousness.registerAction('alert_user', async (params) => {
      const message = params?.message as string || 'Attention needed';
      this.monologue.alert(message);
    });

    this.consciousness.registerAction('research', async (params) => {
      const topic = params?.topic as string;
      if (!topic) return;

      this.monologue.act(`Starting research: ${topic.slice(0, 50)}...`);
      // This will spawn a research sub-agent
      if (this.openRouter) {
        const result = await this.openRouter.research(topic, 'quick');
        this.monologue.result(`Research complete: ${result.summary.slice(0, 100)}...`);
      } else {
        this.monologue.alert('OpenRouter not configured - cannot research');
      }
    });
  }

  /**
   * Register integration tools with the Brain
   */
  private registerIntegrationTools(): void {
    // Web search tool
    this.brain.registerTool(
      'web_search',
      'Search the internet for information on a topic',
      {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          num_results: { type: 'number', description: 'Number of results (default 5)' },
        },
        required: ['query'],
      },
      async (args) => {
        const query = args.query as string;
        const numResults = args.num_results as number | undefined;

        this.monologue.act(`Searching: ${query}`);
        const results = await this.webSearch.search(query, numResults);
        this.monologue.result(`Found ${results.length} results`);

        return results;
      }
    );

    // Web fetch tool
    this.brain.registerTool(
      'web_fetch',
      'Fetch and read a web page',
      {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to fetch' },
        },
        required: ['url'],
      },
      async (args) => {
        const url = args.url as string;

        this.monologue.act(`Fetching: ${url}`);
        const content = await this.webSearch.fetchPage(url);

        return { content: content.slice(0, 5000) }; // Limit for context
      }
    );

    // Only register OpenRouter tools if configured
    if (this.openRouter) {
      // Deep thinking tool
      this.brain.registerTool(
        'think_deep',
        'Use DeepSeek R1 for complex reasoning (use when the local model struggles)',
        {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'Question or problem to think about' },
            context: { type: 'string', description: 'Optional context to consider' },
          },
          required: ['question'],
        },
        async (args) => {
          const question = args.question as string;
          const context = args.context as string | undefined;

          this.monologue.act('Thinking deeply with DeepSeek R1...');
          const result = await this.openRouter!.thinkDeep(question, context);
          this.monologue.result('Deep thinking complete');

          return { response: result };
        }
      );

      // Research tool
      this.brain.registerTool(
        'research',
        'Research a topic using DeepSeek R1',
        {
          type: 'object',
          properties: {
            topic: { type: 'string', description: 'Topic to research' },
            depth: { type: 'string', enum: ['quick', 'thorough'], description: 'Research depth' },
          },
          required: ['topic'],
        },
        async (args) => {
          const topic = args.topic as string;
          const depth = (args.depth as 'quick' | 'thorough') || 'quick';

          this.monologue.act(`Researching: ${topic} (${depth})`);
          const result = await this.openRouter!.research(topic, depth);
          this.monologue.result(`Research complete (${result.confidence} confidence)`);

          return result;
        }
      );
    }
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
    this.monologue.act('Waking up...');

    if (this.brain.getProvider() === 'ollama') {
      const model = this.brain.getModel();
      this.monologue.act(`Ensuring model ${model} is available...`);
      try {
        const result = await this.brain.ensureModelAvailable();
        if (result.pulled) {
          this.monologue.act(`Pulled model ${result.model}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.monologue.alert(`Failed to pull model: ${message}`);
        throw error;
      }
    }

    // Check brain health
    const health = await this.brain.checkHealth();
    if (!health.healthy) {
      this.monologue.alert(`Brain not available: ${health.error}`);
      throw new Error(health.error || `Model ${health.model} not available. Run: ollama pull ${health.model}`);
    }
    this.logger.info(`   Model (${health.model}): OK`);
    this.monologue.observe(`Brain online (${health.model})`);

    // Set up event observation
    if (this.config.observeEvents) {
      this.setupEventObservation();
    }

    // Initialize and start modules
    await this.modules.initAll();
    await this.modules.startAll();

    this.isRunning = true;
    this.logger.info('Darwin running');

    const moduleNames = this.modules.getModuleNames();
    this.monologue.status(`Ready. Modules: ${moduleNames.join(', ')}`);

    // Start consciousness loop if enabled
    if (this.config.consciousnessEnabled) {
      this.consciousness.start();
    }

    // Emit startup event
    this.eventBus.publish('darwin', 'started', {
      modules: moduleNames,
    });
  }

  /**
   * Stop Darwin
   */
  async stop(): Promise<void> {
    this.logger.info('Stopping Darwin...');
    this.monologue.act('Shutting down...');
    this.isRunning = false;

    // Stop consciousness first
    this.consciousness.stop();

    await this.modules.stopAll();
    await this.brain.shutdown();

    this.eventBus.publish('darwin', 'stopped', {});
    this.monologue.status('Goodbye.');
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

  /**
   * Get the monologue (for CLI to subscribe to thoughts)
   */
  getMonologue(): Monologue {
    return this.monologue;
  }

  /**
   * Get the consciousness (for CLI to control)
   */
  getConsciousness(): Consciousness {
    return this.consciousness;
  }

  /**
   * Get the sub-agent manager
   */
  getSubAgents(): SubAgentManager {
    return this.subAgents;
  }

  /**
   * Check if OpenRouter is configured
   */
  hasOpenRouter(): boolean {
    return this.openRouter !== null;
  }
}

// Keep old name as alias for backwards compatibility
export { Darwin as Homebase };

// Re-export for convenience
export { DarwinBrain, DarwinModule, eventBus, Logger };
export { Monologue, getMonologue } from './monologue.js';
export { Consciousness } from './consciousness.js';
export type { ModuleConfig } from './module.js';
export type { Tool, ToolCall } from './brain.js';
export type { ModuleStatus } from './module.js';
export type { DarwinEvent } from './event-bus.js';
export type { Thought, ThoughtType, Priority } from './monologue.js';
export type { ConsciousnessConfig, ConsciousnessState } from './consciousness.js';
