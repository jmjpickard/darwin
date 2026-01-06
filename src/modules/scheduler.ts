/**
 * Scheduler Module - Schedules tool calls to run at specific times.
 *
 * Registers tools:
 * - schedule_task: Schedule a tool call
 * - schedule_list: List scheduled items
 * - schedule_cancel: Cancel a scheduled item
 */

import { DarwinModule, ModuleConfig } from '../core/module.js';
import { DarwinBrain } from '../core/brain.js';
import { eventBus } from '../core/event-bus.js';

interface SchedulerConfig extends ModuleConfig {
  maxEvents: number;
}

type ScheduleStatus = 'scheduled' | 'running' | 'completed' | 'failed' | 'cancelled';

interface ScheduledItem {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  runAt: Date;
  createdAt: Date;
  description?: string;
  status: ScheduleStatus;
  timer: NodeJS.Timeout | null;
  lastError?: string;
}

const DEFAULT_CONFIG: SchedulerConfig = {
  enabled: true,
  maxEvents: 50,
};

export class SchedulerModule extends DarwinModule {
  readonly name = 'Scheduler';
  readonly description = 'Schedules tool calls to run at specific times';

  protected override config: SchedulerConfig;
  private scheduled: Map<string, ScheduledItem> = new Map();
  private counter = 0;

  constructor(brain: DarwinBrain, config: ModuleConfig) {
    super(brain, config);
    this.config = { ...DEFAULT_CONFIG, ...config } as SchedulerConfig;
  }

  async init(): Promise<void> {
    this.registerTools();
    this._healthy = true;
  }

  async start(): Promise<void> {
    this._enabled = true;
    eventBus.publish('scheduler', 'module_started', {});
  }

  async stop(): Promise<void> {
    this._enabled = false;

    for (const item of this.scheduled.values()) {
      if (item.timer) {
        clearTimeout(item.timer);
        item.timer = null;
      }
    }

    eventBus.publish('scheduler', 'module_stopped', {});
  }

  private registerTools(): void {
    this.registerTool(
      'schedule_task',
      'Schedule a tool call to run at a specific time (e.g., code_start_task)',
      {
        type: 'object',
        properties: {
          tool: { type: 'string', description: 'Tool name to call (e.g., code_start_task)' },
          args: { type: 'object', description: 'Arguments for the tool' },
          runAt: { type: 'string', description: 'When to run (ISO 8601 timestamp)' },
          delayMs: { type: 'number', description: 'Delay in milliseconds' },
          delayMinutes: { type: 'number', description: 'Delay in minutes' },
          delaySeconds: { type: 'number', description: 'Delay in seconds' },
          description: { type: 'string', description: 'Optional description' },
          id: { type: 'string', description: 'Optional custom schedule ID' },
        },
        required: ['tool'],
      },
      async (args) =>
        this.scheduleTask({
          tool: args.tool as string,
          args: (args.args as Record<string, unknown>) || {},
          runAt: args.runAt as string | undefined,
          delayMs: args.delayMs as number | undefined,
          delayMinutes: args.delayMinutes as number | undefined,
          delaySeconds: args.delaySeconds as number | undefined,
          description: args.description as string | undefined,
          id: args.id as string | undefined,
        })
    );

    this.registerTool(
      'schedule_list',
      'List scheduled tool calls',
      {
        type: 'object',
        properties: {},
      },
      async () => this.listSchedules()
    );

    this.registerTool(
      'schedule_cancel',
      'Cancel a scheduled tool call',
      {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Schedule ID' },
        },
        required: ['id'],
      },
      async (args) => this.cancelSchedule(args.id as string)
    );
  }

  private async scheduleTask(args: {
    tool: string;
    args: Record<string, unknown>;
    runAt?: string;
    delayMs?: number;
    delayMinutes?: number;
    delaySeconds?: number;
    description?: string;
    id?: string;
  }): Promise<{ success: boolean; message: string; id?: string; runAt?: string }> {
    if (!args.tool) {
      return { success: false, message: 'Tool name is required' };
    }

    const toolExists = this.brain.getTools().some((tool) => tool.function.name === args.tool);
    if (!toolExists) {
      return { success: false, message: `Unknown tool: ${args.tool}` };
    }

    if (this.scheduled.size >= this.config.maxEvents) {
      return { success: false, message: `Scheduler is at capacity (${this.config.maxEvents})` };
    }

    const parsed = this.parseRunAt(args);
    if (!parsed.runAt) {
      return { success: false, message: parsed.error || 'Invalid schedule time' };
    }

    const id = args.id || this.createScheduleId();
    if (this.scheduled.has(id)) {
      return { success: false, message: `Schedule ID already exists: ${id}` };
    }

    const item: ScheduledItem = {
      id,
      tool: args.tool,
      args: args.args || {},
      runAt: parsed.runAt,
      createdAt: new Date(),
      description: args.description,
      status: 'scheduled',
      timer: null,
    };

    this.scheduled.set(id, item);
    this.scheduleTimer(item);

    eventBus.publish('scheduler', 'scheduled', {
      id,
      tool: item.tool,
      runAt: item.runAt.toISOString(),
      description: item.description,
    });

    const note = parsed.note ? ` ${parsed.note}` : '';
    return {
      success: true,
      id,
      runAt: item.runAt.toISOString(),
      message: `Scheduled ${item.tool} for ${item.runAt.toISOString()}.${note}`,
    };
  }

  private listSchedules(): Array<{
    id: string;
    tool: string;
    runAt: string;
    createdAt: string;
    description?: string;
    status: ScheduleStatus;
  }> {
    return Array.from(this.scheduled.values()).map((item) => ({
      id: item.id,
      tool: item.tool,
      runAt: item.runAt.toISOString(),
      createdAt: item.createdAt.toISOString(),
      description: item.description,
      status: item.status,
    }));
  }

  private cancelSchedule(id: string): { success: boolean; message: string } {
    const item = this.scheduled.get(id);
    if (!item) {
      return { success: false, message: `No schedule found for ${id}` };
    }

    if (item.timer) {
      clearTimeout(item.timer);
      item.timer = null;
    }

    item.status = 'cancelled';
    this.scheduled.delete(id);

    eventBus.publish('scheduler', 'cancelled', { id, tool: item.tool });
    return { success: true, message: `Cancelled schedule ${id}` };
  }

  private parseRunAt(args: {
    runAt?: string;
    delayMs?: number;
    delayMinutes?: number;
    delaySeconds?: number;
  }): { runAt?: Date; error?: string; note?: string } {
    let runAt: Date | null = null;

    if (args.runAt) {
      const parsed = new Date(args.runAt);
      if (!Number.isFinite(parsed.getTime())) {
        return { error: `Invalid runAt timestamp: ${args.runAt}` };
      }
      runAt = parsed;
    } else {
      const delayMs = this.resolveDelayMs(args);
      if (!delayMs) {
        return { error: 'Provide runAt or a delay (delayMs, delayMinutes, delaySeconds)' };
      }
      runAt = new Date(Date.now() + delayMs);
    }

    const now = Date.now();
    if (runAt.getTime() <= now) {
      return { runAt: new Date(now + 1000), note: 'Run time was in the past; scheduling immediately.' };
    }

    return { runAt };
  }

  private resolveDelayMs(args: {
    delayMs?: number;
    delayMinutes?: number;
    delaySeconds?: number;
  }): number | null {
    if (typeof args.delayMs === 'number' && args.delayMs > 0) {
      return args.delayMs;
    }
    if (typeof args.delayMinutes === 'number' && args.delayMinutes > 0) {
      return args.delayMinutes * 60 * 1000;
    }
    if (typeof args.delaySeconds === 'number' && args.delaySeconds > 0) {
      return args.delaySeconds * 1000;
    }
    return null;
  }

  private scheduleTimer(item: ScheduledItem): void {
    const delay = item.runAt.getTime() - Date.now();
    if (delay <= 0) {
      void this.executeScheduled(item);
      return;
    }

    const maxDelay = 2_147_483_647;
    const waitMs = Math.min(delay, maxDelay);
    item.timer = setTimeout(() => {
      item.timer = null;
      if (item.runAt.getTime() > Date.now()) {
        this.scheduleTimer(item);
        return;
      }
      void this.executeScheduled(item);
    }, waitMs);
  }

  private async executeScheduled(item: ScheduledItem): Promise<void> {
    if (!this.scheduled.has(item.id)) {
      return;
    }

    item.status = 'running';
    eventBus.publish('scheduler', 'running', {
      id: item.id,
      tool: item.tool,
      runAt: item.runAt.toISOString(),
    });

    try {
      const result = await this.brain.callTool(item.tool, item.args, `Scheduled ${item.tool}`);
      if (result.error) {
        item.status = 'failed';
        item.lastError = result.error;
        eventBus.publish('scheduler', 'failed', { id: item.id, tool: item.tool, error: result.error });
      } else {
        item.status = 'completed';
        eventBus.publish('scheduler', 'completed', { id: item.id, tool: item.tool });
      }
    } catch (error) {
      item.status = 'failed';
      item.lastError = String(error);
      eventBus.publish('scheduler', 'failed', { id: item.id, tool: item.tool, error: String(error) });
    } finally {
      this.scheduled.delete(item.id);
    }
  }

  private createScheduleId(): string {
    this.counter += 1;
    return `sched-${Date.now()}-${this.counter}`;
  }
}
