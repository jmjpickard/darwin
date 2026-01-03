/**
 * Darwin Brain - Dual-model AI coordinator
 *
 * FunctionGemma (270M): Fast dispatcher - decides WHAT to do
 * Gemma 3 1B: Reasoner - loaded on demand for complex decisions
 */

import { EventEmitter } from 'events';
import { Logger } from './logger.js';

export interface Tool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description?: string; enum?: string[] }>;
      required?: string[];
    };
  };
}

export interface ToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
}

interface ChatResponse {
  message: {
    role: string;
    content: string;
    tool_calls?: ToolCall[];
  };
}

interface GenerateResponse {
  response: string;
  eval_count?: number;
}

export interface BrainConfig {
  dispatcherModel: string;
  reasonerModel: string;
  ollamaUrl: string;
  reasonerTimeout: number; // Unload reasoner after this many ms of inactivity
}

const DEFAULT_CONFIG: BrainConfig = {
  dispatcherModel: 'functiongemma',
  reasonerModel: 'gemma3:1b',
  ollamaUrl: 'http://localhost:11434',
  reasonerTimeout: 5 * 60 * 1000, // 5 minutes
};

export class DarwinBrain extends EventEmitter {
  private config: BrainConfig;
  private logger: Logger;
  private tools: Tool[] = [];
  private toolHandlers: Map<string, (args: Record<string, unknown>) => Promise<unknown>> = new Map();
  private reasonerLoaded = false;
  private reasonerUnloadTimer: NodeJS.Timeout | null = null;
  private systemPrompt: string;

  constructor(config: Partial<BrainConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = new Logger('Brain');
    this.systemPrompt = this.buildSystemPrompt();
  }

  private buildSystemPrompt(): string {
    return `You are Darwin, a local home intelligence system. You coordinate:
- Home automation (lights, heating, sensors)
- Code agent tasks (Claude Code, Beads task management)
- Energy monitoring
- Security

When events occur, decide which tools to call. Be concise and action-oriented.
Only call tools that are relevant to the situation.
If no action is needed, return no tool calls.`;
  }

  /**
   * Register a tool that FunctionGemma can call
   */
  registerTool(
    name: string,
    description: string,
    parameters: Tool['function']['parameters'],
    handler: (args: Record<string, unknown>) => Promise<unknown>
  ): void {
    this.tools.push({
      type: 'function',
      function: { name, description, parameters },
    });
    this.toolHandlers.set(name, handler);
    this.logger.debug(`Registered tool: ${name}`);
  }

  /**
   * Remove a tool
   */
  unregisterTool(name: string): void {
    this.tools = this.tools.filter(t => t.function.name !== name);
    this.toolHandlers.delete(name);
  }

  /**
   * Check if Ollama is running and models are available
   */
  async checkHealth(): Promise<{ dispatcher: boolean; reasoner: boolean }> {
    try {
      const response = await fetch(`${this.config.ollamaUrl}/api/tags`);
      const data = await response.json() as { models: Array<{ name: string }> };
      const models = data.models?.map(m => m.name) || [];

      return {
        dispatcher: models.some(m => m.includes('functiongemma')),
        reasoner: models.some(m => m.includes('gemma3:1b')),
      };
    } catch {
      return { dispatcher: false, reasoner: false };
    }
  }

  /**
   * Fast path: Ask FunctionGemma what to do and execute the tools
   */
  async dispatch(event: string, context?: Record<string, unknown>): Promise<unknown[]> {
    const contextStr = context ? `\nContext: ${JSON.stringify(context)}` : '';
    const prompt = `${event}${contextStr}`;

    this.logger.debug(`Dispatching: ${prompt.slice(0, 100)}...`);

    const toolCalls = await this.getToolCalls(prompt);

    if (toolCalls.length === 0) {
      this.logger.debug('No tools called');
      return [];
    }

    // Execute each tool call
    const results: unknown[] = [];
    for (const call of toolCalls) {
      const handler = this.toolHandlers.get(call.function.name);
      if (handler) {
        this.logger.info(`Calling: ${call.function.name}(${JSON.stringify(call.function.arguments)})`);
        try {
          const result = await handler(call.function.arguments);
          results.push({ tool: call.function.name, result });
          this.emit('tool_called', { tool: call.function.name, args: call.function.arguments, result });
        } catch (error) {
          this.logger.error(`Tool ${call.function.name} failed:`, error);
          results.push({ tool: call.function.name, error: String(error) });
        }
      } else {
        this.logger.warn(`No handler for tool: ${call.function.name}`);
      }
    }

    return results;
  }

  /**
   * Ask FunctionGemma which tools to call (without executing)
   */
  private async getToolCalls(prompt: string): Promise<ToolCall[]> {
    if (this.tools.length === 0) {
      this.logger.warn('No tools registered');
      return [];
    }

    try {
      const response = await fetch(`${this.config.ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.config.dispatcherModel,
          messages: [
            { role: 'system', content: this.systemPrompt },
            { role: 'user', content: prompt },
          ] as ChatMessage[],
          tools: this.tools,
          stream: false,
        }),
      });

      if (!response.ok) {
        throw new Error(`Ollama error: ${response.status}`);
      }

      const data = await response.json() as ChatResponse;
      return data.message.tool_calls || [];
    } catch (error) {
      this.logger.error('Dispatch failed:', error);
      return [];
    }
  }

  /**
   * Slow path: Use Gemma 1B for complex reasoning
   */
  async reason(prompt: string, options?: { maxTokens?: number; temperature?: number }): Promise<string> {
    await this.ensureReasonerLoaded();
    this.resetReasonerTimer();

    try {
      const response = await fetch(`${this.config.ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.config.reasonerModel,
          prompt,
          stream: false,
          options: {
            num_predict: options?.maxTokens ?? 200,
            temperature: options?.temperature ?? 0.7,
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`Ollama error: ${response.status}`);
      }

      const data = await response.json() as GenerateResponse;
      return data.response;
    } catch (error) {
      this.logger.error('Reasoning failed:', error);
      throw error;
    }
  }

  /**
   * Quick yes/no decision using dispatcher (fast)
   */
  async decide(question: string): Promise<boolean> {
    // For simple y/n, we can use FunctionGemma with a simple tool
    const response = await fetch(`${this.config.ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.config.dispatcherModel,
        prompt: `${question}\n\nAnswer with just 'yes' or 'no':`,
        stream: false,
        options: { num_predict: 5 },
      }),
    });

    const data = await response.json() as GenerateResponse;
    const answer = data.response.toLowerCase();
    return answer.includes('yes') || answer.includes('y');
  }

  /**
   * Ensure the reasoner model is loaded
   */
  private async ensureReasonerLoaded(): Promise<void> {
    if (this.reasonerLoaded) return;

    this.logger.info('Loading reasoner model...');

    // Warm up the model with a tiny request
    await fetch(`${this.config.ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.config.reasonerModel,
        prompt: 'Hi',
        stream: false,
        options: { num_predict: 1 },
      }),
    });

    this.reasonerLoaded = true;
    this.logger.info('Reasoner model loaded');
  }

  /**
   * Reset the timer to unload reasoner after inactivity
   */
  private resetReasonerTimer(): void {
    if (this.reasonerUnloadTimer) {
      clearTimeout(this.reasonerUnloadTimer);
    }

    this.reasonerUnloadTimer = setTimeout(() => {
      this.unloadReasoner();
    }, this.config.reasonerTimeout);
  }

  /**
   * Unload the reasoner to free RAM
   */
  async unloadReasoner(): Promise<void> {
    if (!this.reasonerLoaded) return;

    this.logger.info('Unloading reasoner model to free RAM...');

    try {
      await fetch(`${this.config.ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.config.reasonerModel,
          prompt: '',
          keep_alive: 0,
        }),
      });
    } catch {
      // Ignore errors
    }

    this.reasonerLoaded = false;

    if (this.reasonerUnloadTimer) {
      clearTimeout(this.reasonerUnloadTimer);
      this.reasonerUnloadTimer = null;
    }
  }

  /**
   * Get list of registered tools
   */
  getTools(): Tool[] {
    return [...this.tools];
  }

  /**
   * Cleanup
   */
  async shutdown(): Promise<void> {
    await this.unloadReasoner();
    this.removeAllListeners();
  }
}

// Keep old name as alias for backwards compatibility
export { DarwinBrain as HomebaseBrain };
