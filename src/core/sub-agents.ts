/**
 * Sub-Agent Manager - Spawns and manages specialized agents
 *
 * Darwin can spawn sub-agents to handle complex, isolated tasks:
 * - Research: Deep research using OpenRouter/DeepSeek R1
 * - Code: Claude Code task execution
 * - Home: Home automation checks and actions
 *
 * Sub-agents run concurrently (with limits) and report
 * progress back to Darwin's monologue.
 */

import { EventEmitter } from 'events';
import { Logger } from './logger.js';
import { Monologue } from './monologue.js';
import { eventBus } from './event-bus.js';

export type SubAgentType = 'research' | 'code' | 'home' | 'think';

export type SubAgentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface SubAgent {
  id: string;
  type: SubAgentType;
  task: string;
  status: SubAgentStatus;
  progress?: string;
  result?: unknown;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
}

export interface SubAgentConfig {
  /** Maximum concurrent sub-agents (Pi 4 constraint: keep low) */
  maxConcurrent: number;
  /** Default timeout for sub-agents in ms */
  defaultTimeout: number;
}

const DEFAULT_CONFIG: SubAgentConfig = {
  maxConcurrent: 2, // Pi 4 memory constraint
  defaultTimeout: 300_000, // 5 minutes
};

type SubAgentExecutor = (
  task: string,
  onProgress: (progress: string) => void
) => Promise<unknown>;

export class SubAgentManager extends EventEmitter {
  private config: SubAgentConfig;
  private logger: Logger;
  private monologue: Monologue;
  private agents: Map<string, SubAgent> = new Map();
  private executors: Map<SubAgentType, SubAgentExecutor> = new Map();
  private agentCounter = 0;

  constructor(monologue: Monologue, config: Partial<SubAgentConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = new Logger('SubAgents');
    this.monologue = monologue;
  }

  /**
   * Register an executor for a sub-agent type
   */
  registerExecutor(type: SubAgentType, executor: SubAgentExecutor): void {
    this.executors.set(type, executor);
    this.logger.debug(`Registered executor for: ${type}`);
  }

  /**
   * Spawn a new sub-agent
   */
  async spawn(
    type: SubAgentType,
    task: string,
    options: { timeout?: number } = {}
  ): Promise<SubAgent> {
    // Check capacity
    const running = this.getRunning();
    if (running.length >= this.config.maxConcurrent) {
      throw new Error(`At capacity (${running.length}/${this.config.maxConcurrent} agents running)`);
    }

    // Check executor exists
    const executor = this.executors.get(type);
    if (!executor) {
      throw new Error(`No executor registered for type: ${type}`);
    }

    // Create agent
    const agent: SubAgent = {
      id: `agent-${++this.agentCounter}-${Date.now()}`,
      type,
      task,
      status: 'pending',
    };

    this.agents.set(agent.id, agent);
    this.monologue.act(`Spawning ${type} agent: ${task.slice(0, 50)}...`);

    // Start execution (don't await - runs in background)
    this.executeAgent(agent, executor, options.timeout || this.config.defaultTimeout);

    return agent;
  }

  /**
   * Execute a sub-agent
   */
  private async executeAgent(
    agent: SubAgent,
    executor: SubAgentExecutor,
    timeout: number
  ): Promise<void> {
    agent.status = 'running';
    agent.startedAt = new Date();
    this.emit('started', agent);

    eventBus.publish('subagent', 'started', {
      id: agent.id,
      type: agent.type,
      task: agent.task,
    });

    // Progress callback
    const onProgress = (progress: string) => {
      agent.progress = progress;
      this.monologue.observe(`[${agent.type}] ${progress}`);
      this.emit('progress', agent, progress);
    };

    // Set up timeout
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Agent timed out')), timeout);
    });

    try {
      // Race execution against timeout
      const result = await Promise.race([
        executor(agent.task, onProgress),
        timeoutPromise,
      ]);

      agent.status = 'completed';
      agent.result = result;
      agent.completedAt = new Date();

      this.monologue.result(`[${agent.type}] Completed: ${agent.task.slice(0, 30)}...`);

      eventBus.publish('subagent', 'completed', {
        id: agent.id,
        type: agent.type,
        result: typeof result === 'string' ? result.slice(0, 200) : undefined,
      });

      this.emit('completed', agent);
    } catch (error) {
      agent.status = 'failed';
      agent.error = String(error);
      agent.completedAt = new Date();

      this.monologue.alert(`[${agent.type}] Failed: ${agent.error.slice(0, 50)}`);

      eventBus.publish('subagent', 'failed', {
        id: agent.id,
        type: agent.type,
        error: agent.error,
      });

      this.emit('failed', agent, error);
    }
  }

  /**
   * Cancel a running agent
   */
  cancel(id: string): boolean {
    const agent = this.agents.get(id);
    if (!agent) return false;

    if (agent.status === 'running' || agent.status === 'pending') {
      agent.status = 'cancelled';
      agent.completedAt = new Date();
      this.monologue.observe(`[${agent.type}] Cancelled`);
      this.emit('cancelled', agent);
      return true;
    }

    return false;
  }

  /**
   * Get all agents
   */
  getAll(): SubAgent[] {
    return Array.from(this.agents.values());
  }

  /**
   * Get running agents
   */
  getRunning(): SubAgent[] {
    return this.getAll().filter(a => a.status === 'running');
  }

  /**
   * Get agent by ID
   */
  get(id: string): SubAgent | undefined {
    return this.agents.get(id);
  }

  /**
   * Get capacity info
   */
  getCapacity(): { running: number; max: number; available: number } {
    const running = this.getRunning().length;
    return {
      running,
      max: this.config.maxConcurrent,
      available: this.config.maxConcurrent - running,
    };
  }

  /**
   * Clear completed/failed agents from memory
   */
  cleanup(): number {
    let count = 0;
    for (const [id, agent] of this.agents) {
      if (agent.status === 'completed' || agent.status === 'failed' || agent.status === 'cancelled') {
        this.agents.delete(id);
        count++;
      }
    }
    return count;
  }

  /**
   * Wait for an agent to complete
   */
  async waitFor(id: string, timeout?: number): Promise<SubAgent> {
    const agent = this.agents.get(id);
    if (!agent) throw new Error(`Agent not found: ${id}`);

    if (agent.status === 'completed' || agent.status === 'failed' || agent.status === 'cancelled') {
      return agent;
    }

    return new Promise((resolve, reject) => {
      const timeoutId = timeout
        ? setTimeout(() => reject(new Error('Wait timed out')), timeout)
        : null;

      const handler = (completedAgent: SubAgent) => {
        if (completedAgent.id === id) {
          if (timeoutId) clearTimeout(timeoutId);
          this.off('completed', handler);
          this.off('failed', handler);
          this.off('cancelled', handler);
          resolve(completedAgent);
        }
      };

      this.on('completed', handler);
      this.on('failed', handler);
      this.on('cancelled', handler);
    });
  }
}
