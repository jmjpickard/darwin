/**
 * Consciousness - Darwin's proactive thinking loop
 *
 * This is what makes Darwin an intelligent assistant rather than
 * just a reactive tool. The consciousness loop:
 *
 * 1. Runs continuously (configurable tick interval)
 * 2. Gathers context (events, time, system state)
 * 3. Asks the brain "What should I do right now?"
 * 4. Executes decided actions
 * 5. Emits thoughts about what's happening
 *
 * Even when idle, Darwin shares its internal state so you
 * can see it's alive and monitoring.
 */

import { DarwinBrain } from './brain.js';
import { Monologue } from './monologue.js';
import { EventBus, DarwinEvent } from './event-bus.js';
import { Logger } from './logger.js';

export interface ConsciousnessConfig {
  /** How often to "think" in ms (default: 30000 = 30s) */
  tickIntervalMs: number;
  /** Emit idle thoughts when nothing is happening */
  idleThinkingEnabled: boolean;
  /** Minimum time between idle thoughts (prevents spam) */
  minIdleIntervalMs: number;
  /** Maximum events to process per tick */
  maxEventsPerTick: number;
}

const DEFAULT_CONFIG: ConsciousnessConfig = {
  tickIntervalMs: 30_000,
  idleThinkingEnabled: true,
  minIdleIntervalMs: 60_000, // At least 1 minute between idle thoughts
  maxEventsPerTick: 10,
};

export type ConsciousnessState = 'stopped' | 'running' | 'thinking' | 'acting';

interface ContextSnapshot {
  timestamp: Date;
  pendingEvents: DarwinEvent[];
  activeTaskCount: number;
  systemState: {
    isNight: boolean;  // 22:00 - 06:00
    isWorkHours: boolean; // 09:00 - 18:00
  };
  timeSinceLastAction: number;
  timeSinceLastThought: number;
}

interface ConsciousnessDecision {
  action: 'wait' | 'think_deeper' | 'check_tasks' | 'check_home' | 'alert_user' | 'research';
  reason: string;
  params?: Record<string, unknown>;
}

export class Consciousness {
  private config: ConsciousnessConfig;
  private brain: DarwinBrain;
  private monologue: Monologue;
  private eventBus: EventBus;
  private logger: Logger;

  private state: ConsciousnessState = 'stopped';
  private tickTimer: NodeJS.Timeout | null = null;
  private pendingEvents: DarwinEvent[] = [];
  private lastActionTime: Date = new Date();
  private lastIdleThoughtTime: Date = new Date(0); // Start with epoch so first idle thought happens
  private lastTickTime: Date = new Date();

  // Callbacks for actions (set by Darwin)
  private actionHandlers: Map<string, (params?: Record<string, unknown>) => Promise<void>> = new Map();

  constructor(
    brain: DarwinBrain,
    monologue: Monologue,
    eventBus: EventBus,
    config: Partial<ConsciousnessConfig> = {}
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.brain = brain;
    this.monologue = monologue;
    this.eventBus = eventBus;
    this.logger = new Logger('Consciousness');

    // Subscribe to all events to collect them for processing
    this.eventBus.subscribeToAll(this.collectEvent.bind(this));
  }

  /**
   * Register an action handler that consciousness can invoke
   */
  registerAction(name: string, handler: (params?: Record<string, unknown>) => Promise<void>): void {
    this.actionHandlers.set(name, handler);
  }

  /**
   * Start the consciousness loop
   */
  start(): void {
    if (this.state !== 'stopped') {
      this.logger.warn('Consciousness already running');
      return;
    }

    this.state = 'running';
    this.lastTickTime = new Date();
    this.monologue.observe('Consciousness online');

    // Start the tick loop
    this.tickTimer = setInterval(() => this.tick(), this.config.tickIntervalMs);

    // Do an initial tick
    this.tick();
  }

  /**
   * Stop the consciousness loop
   */
  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.state = 'stopped';
    this.monologue.observe('Consciousness offline');
  }

  /**
   * Get current state
   */
  getState(): ConsciousnessState {
    return this.state;
  }

  /**
   * Collect an event for processing in the next tick
   */
  private collectEvent(event: DarwinEvent): void {
    // Don't collect our own thoughts
    if (event.source === 'darwin' && event.type === 'thought') return;

    this.pendingEvents.push(event);

    // Limit queue size
    if (this.pendingEvents.length > this.config.maxEventsPerTick * 2) {
      this.pendingEvents = this.pendingEvents.slice(-this.config.maxEventsPerTick);
    }
  }

  /**
   * Main consciousness tick - the heartbeat of Darwin's awareness
   */
  private async tick(): Promise<void> {
    if (this.state === 'stopped') return;

    this.state = 'thinking';

    try {
      // Build context snapshot
      const context = this.buildContext();

      // If there are significant events, process them
      if (context.pendingEvents.length > 0) {
        await this.processEvents(context);
        this.pendingEvents = []; // Clear processed events
        this.lastActionTime = new Date();
        return;
      }

      // Otherwise, decide what to do
      const decision = await this.decide(context);

      if (decision.action === 'wait') {
        // Nothing to do - maybe emit idle thought
        await this.maybeEmitIdleThought(context);
      } else {
        // Execute the decided action
        await this.executeAction(decision);
        this.lastActionTime = new Date();
      }
    } catch (error) {
      this.logger.error('Tick failed:', error);
      this.monologue.alert(`Thinking interrupted: ${error}`);
    } finally {
      // Only reset to running if we haven't been stopped during the tick
      // (stop() can be called while tick() is running)
      if ((this.state as ConsciousnessState) !== 'stopped') {
        this.state = 'running';
      }
      this.lastTickTime = new Date();
    }
  }

  /**
   * Build a snapshot of current context
   */
  private buildContext(): ContextSnapshot {
    const now = new Date();
    const hour = now.getHours();

    return {
      timestamp: now,
      pendingEvents: this.pendingEvents.slice(0, this.config.maxEventsPerTick),
      activeTaskCount: 0, // TODO: Get from CodeAgent
      systemState: {
        isNight: hour >= 22 || hour < 6,
        isWorkHours: hour >= 9 && hour < 18,
      },
      timeSinceLastAction: now.getTime() - this.lastActionTime.getTime(),
      timeSinceLastThought: now.getTime() - this.lastIdleThoughtTime.getTime(),
    };
  }

  /**
   * Process accumulated events
   */
  private async processEvents(context: ContextSnapshot): Promise<void> {
    const events = context.pendingEvents;

    // Group events by type for summary
    const eventSummary = events.map(e => `${e.source}:${e.type}`).join(', ');
    this.monologue.observe(`Processing ${events.length} events: ${eventSummary}`);

    // Format events for the brain
    const eventDescriptions = events.map(e => {
      const data = JSON.stringify(e.data);
      return `[${e.source}:${e.type}] ${data.slice(0, 100)}`;
    }).join('\n');

    // Ask the brain what to do about these events
    const prompt = `Events have occurred that need your attention:

${eventDescriptions}

Current time: ${context.timestamp.toLocaleTimeString()}
Time of day: ${context.systemState.isNight ? 'Night' : context.systemState.isWorkHours ? 'Work hours' : 'Evening'}

What should we do about these events? Consider:
- Are any urgent and need immediate action?
- Should we notify the user?
- Can we handle them automatically?

Respond with a brief assessment and recommended action.`;

    try {
      const response = await this.brain.reason(prompt, { maxTokens: 200 });
      this.monologue.reason(response.slice(0, 150));

      // For now, let the brain's response inform via monologue
      // TODO: Parse response for actual actions
    } catch (error) {
      this.logger.warn('Failed to reason about events:', error);
    }
  }

  /**
   * Decide what action to take (when no events pending)
   */
  private async decide(context: ContextSnapshot): Promise<ConsciousnessDecision> {
    // Quick heuristics before asking the brain
    const minutesSinceAction = context.timeSinceLastAction / 60_000;

    // If we've been idle for a while, maybe check on things
    if (minutesSinceAction > 5) {
      // During night hours, focus on code tasks
      if (context.systemState.isNight) {
        return {
          action: 'check_tasks',
          reason: 'Night time - good for background work',
        };
      }
    }

    // Default: wait and observe
    return {
      action: 'wait',
      reason: 'Nothing requires attention',
    };
  }

  /**
   * Execute a decided action
   */
  private async executeAction(decision: ConsciousnessDecision): Promise<void> {
    this.state = 'acting';
    this.monologue.decide(`${decision.action}: ${decision.reason}`);

    const handler = this.actionHandlers.get(decision.action);
    if (handler) {
      try {
        await handler(decision.params);
      } catch (error) {
        this.logger.error(`Action ${decision.action} failed:`, error);
        this.monologue.alert(`Action failed: ${decision.action}`);
      }
    } else {
      this.logger.debug(`No handler for action: ${decision.action}`);
    }
  }

  /**
   * Maybe emit an idle thought (if enough time has passed)
   */
  private async maybeEmitIdleThought(context: ContextSnapshot): Promise<void> {
    if (!this.config.idleThinkingEnabled) return;

    const timeSinceLastIdle = Date.now() - this.lastIdleThoughtTime.getTime();
    if (timeSinceLastIdle < this.config.minIdleIntervalMs) return;

    // Generate a contextual idle thought
    const thought = this.generateIdleThought(context);
    this.monologue.idle(thought);
    this.lastIdleThoughtTime = new Date();
  }

  /**
   * Generate a contextual idle thought
   */
  private generateIdleThought(context: ContextSnapshot): string {
    const hour = context.timestamp.getHours();
    const minutesSinceAction = Math.floor(context.timeSinceLastAction / 60_000);

    // Time-based thoughts
    if (context.systemState.isNight) {
      const thoughts = [
        'Night watch active. Monitoring systems.',
        'Quiet hours. Good time for background tasks.',
        'All systems nominal. Watching for opportunities.',
      ];
      return thoughts[Math.floor(Math.random() * thoughts.length)];
    }

    if (hour >= 7 && hour < 9) {
      return 'Morning. Ready when you are.';
    }

    if (hour >= 12 && hour < 13) {
      return 'Midday check: systems running smoothly.';
    }

    if (hour >= 17 && hour < 19) {
      return 'Evening. Winding down or ramping up?';
    }

    // Activity-based thoughts
    if (minutesSinceAction > 10) {
      return 'Quiet period. Standing by.';
    }

    // Default
    const defaults = [
      'Nothing urgent. Monitoring.',
      'All clear. Watching for events.',
      'Systems nominal.',
    ];
    return defaults[Math.floor(Math.random() * defaults.length)];
  }

  /**
   * Force a consciousness tick (for testing or manual triggering)
   */
  async forceTick(): Promise<void> {
    await this.tick();
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<ConsciousnessConfig>): void {
    this.config = { ...this.config, ...config };

    // Restart timer if interval changed
    if (config.tickIntervalMs && this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = setInterval(() => this.tick(), this.config.tickIntervalMs);
    }
  }
}
