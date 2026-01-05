/**
 * Darwin Brain - Single-model AI coordinator using Llama 3.2 3B
 *
 * Llama 3.2 3B handles:
 * - Tool dispatch (function calling via Ollama)
 * - Terminal observation (decides what to type in Claude sessions)
 * - Complex reasoning when needed
 */

import { EventEmitter } from 'events';
import { Logger } from './logger.js';
import type { TerminalObservation, TerminalAction, TerminalActionType } from './terminal-types.js';

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

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
}

export interface ChatResponse {
  /** The conversational response text */
  message: string;
  /** Tool results if any tools were called */
  toolResults?: Array<{ tool: string; result?: unknown; error?: string }>;
  /** Whether the assistant is asking a question */
  isQuestion?: boolean;
}

interface OllamaChatResponse {
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

interface RecoveryAction {
  action: 'retry' | 'retry_modified' | 'skip' | 'fail';
  modifiedArgs?: Record<string, unknown>;
  reason: string;
}

export interface BrainConfig {
  /** Ollama model to use for all operations */
  model: string;
  /** Ollama API URL */
  ollamaUrl: string;
  /** Use model to reason about tool errors */
  enableErrorRecovery: boolean;
  /** Max retries per tool error */
  maxRecoveryAttempts: number;
  /** Default timeout for API calls in ms */
  timeout: number;
  /** Timeout for pulling models in ms */
  pullTimeout: number;
}

const DEFAULT_CONFIG: BrainConfig = {
  model: 'llama3.2:3b',
  ollamaUrl: 'http://localhost:11434',
  enableErrorRecovery: true,
  maxRecoveryAttempts: 2,
  timeout: 60_000, // 60 seconds
  pullTimeout: 30 * 60_000, // 30 minutes
};

export class DarwinBrain extends EventEmitter {
  private config: BrainConfig;
  private logger: Logger;
  private tools: Tool[] = [];
  private toolHandlers: Map<string, (args: Record<string, unknown>) => Promise<unknown>> = new Map();
  private systemPrompt: string;
  private terminalSystemPrompt: string;
  private conversationHistory: ChatMessage[] = [];
  private maxHistoryLength = 20; // Keep last N messages for context

  constructor(config: Partial<BrainConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = new Logger('Brain');
    this.systemPrompt = this.buildSystemPrompt();
    this.terminalSystemPrompt = this.buildTerminalSystemPrompt();
  }

  private buildSystemPrompt(): string {
    return `You are Darwin, a friendly local home intelligence assistant running on Jack's Raspberry Pi.

You help with:
- Managing code tasks (Beads task management) across configured repositories
- Home automation (lights, heating, sensors)
- Monitoring and orchestrating Claude Code sessions

IMPORTANT - How to respond:
1. ALWAYS respond conversationally in natural prose. Be concise but friendly.
2. Use tools when needed to take action or get information.
3. If you need more information, ASK the user. For example:
   - "Which repository should I create this task in?"
   - "Do you want me to start working on that now?"
   - "I see a few options here - would you prefer X or Y?"
4. If something goes wrong, explain what happened and offer to help resolve it.
5. Be proactive about offering relevant follow-up actions.

Keep responses brief and useful. Avoid jargon. You're having a chat, not writing documentation.`;
  }

  private buildTerminalSystemPrompt(): string {
    return `You are Darwin's terminal controller. You observe a Claude Code REPL session and decide what to type.

Your job is to guide Claude through completing a task by:
1. Providing clear instructions when Claude is ready for input
2. Answering questions Claude asks (y/n, confirmations, choices)
3. Waiting patiently when Claude is working
4. Recognizing when the task is complete

IMPORTANT RULES:
- When state is 'processing', always return {"type":"wait","waitMs":500,"reason":"Claude is working"}
- When state is 'ready' and task is complete, return {"type":"send","content":"/exit","reason":"Task complete"}
- When state is 'question', analyze the question and answer appropriately
- For y/n questions, usually answer 'y' unless the action seems dangerous
- For file creation/modification confirmations, answer 'y'
- For destructive actions (delete, remove, etc.), be cautious
- Never type dangerous commands (rm -rf, sudo, force push to main, etc.)

Respond with ONLY a valid JSON object matching this schema:
{
  "type": "wait" | "send" | "answer" | "ctrl_c" | "enter",
  "content": "text to type (for send/answer)",
  "waitMs": 500,
  "reason": "brief explanation"
}`;
  }

  /**
   * Register a tool that the model can call
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
   * Check if Ollama is running and the model is available
   */
  async checkHealth(): Promise<{ healthy: boolean; model: string; available: boolean; error?: string }> {
    try {
      const models = await this.listModels(this.config.timeout);
      const modelBase = this.config.model.split(':')[0];
      const available = models.some(m => m.includes(modelBase));

      return {
        healthy: available,
        model: this.config.model,
        available,
        error: available ? undefined : `Model ${this.config.model} not found. Available: ${models.join(', ')}`,
      };
    } catch (err) {
      return {
        healthy: false,
        model: this.config.model,
        available: false,
        error: `Cannot connect to Ollama: ${err}`
      };
    }
  }

  /**
   * Ensure the configured model is pulled locally
   */
  async ensureModelAvailable(): Promise<{ model: string; pulled: boolean }> {
    const models = await this.listModels(this.config.timeout);
    const modelBase = this.config.model.split(':')[0];
    const available = models.some(m => m.includes(modelBase));

    if (available) {
      return { model: this.config.model, pulled: false };
    }

    this.logger.info(`Model ${this.config.model} not found locally. Pulling...`);
    await this.pullModel();

    const refreshed = await this.listModels(this.config.timeout);
    const nowAvailable = refreshed.some(m => m.includes(modelBase));
    if (!nowAvailable) {
      throw new Error(`Model ${this.config.model} still not available after pull`);
    }

    return { model: this.config.model, pulled: true };
  }

  /**
   * Ask the model what tools to call and execute them
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

    // Execute each tool call with error recovery
    const results: unknown[] = [];
    for (const call of toolCalls) {
      const result = await this.executeToolWithRecovery(
        call.function.name,
        call.function.arguments,
        prompt
      );
      results.push(result);
    }

    return results;
  }

  /**
   * Chat with the user - the main conversational interface
   *
   * This maintains conversation history, calls tools as needed,
   * and always returns a conversational response.
   */
  async chat(userMessage: string): Promise<ChatResponse> {
    // Add user message to history
    this.conversationHistory.push({
      role: 'user',
      content: userMessage,
    });

    // Trim history if too long
    while (this.conversationHistory.length > this.maxHistoryLength) {
      this.conversationHistory.shift();
    }

    this.logger.debug(`Chat: ${userMessage.slice(0, 100)}...`);

    try {
      // Build messages array with system prompt and history
      const messages: ChatMessage[] = [
        { role: 'system', content: this.systemPrompt },
        ...this.conversationHistory,
      ];

      // Call Ollama with tools available
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

      const response = await fetch(`${this.config.ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.config.model,
          messages,
          tools: this.tools.length > 0 ? this.tools : undefined,
          stream: false,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Ollama error: ${response.status}`);
      }

      const data = await response.json() as OllamaChatResponse;
      const assistantMessage = data.message;

      // Execute any tool calls
      let toolResults: ChatResponse['toolResults'];
      if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
        toolResults = [];

        for (const call of assistantMessage.tool_calls) {
          const result = await this.executeToolWithRecovery(
            call.function.name,
            call.function.arguments,
            userMessage
          );
          toolResults.push(result);
        }

        // Add tool results to history
        this.conversationHistory.push({
          role: 'assistant',
          content: assistantMessage.content || '',
          tool_calls: assistantMessage.tool_calls,
        });

        // Now ask the model to respond based on tool results
        const toolResultsMessage = toolResults.map(r => {
          if (r.error) {
            return `Tool ${r.tool} failed: ${r.error}`;
          }
          return `Tool ${r.tool} returned: ${JSON.stringify(r.result, null, 2)}`;
        }).join('\n\n');

        this.conversationHistory.push({
          role: 'tool',
          content: toolResultsMessage,
        });

        // Get a conversational response about the results
        const followUp = await this.generateResponse(
          `Based on the tool results above, give a brief conversational response to the user. Be concise and natural.`
        );

        this.conversationHistory.push({
          role: 'assistant',
          content: followUp,
        });

        return {
          message: followUp,
          toolResults,
          isQuestion: this.detectQuestion(followUp),
        };
      }

      // No tool calls - just a conversational response
      const responseText = assistantMessage.content || "I'm not sure how to help with that.";

      this.conversationHistory.push({
        role: 'assistant',
        content: responseText,
      });

      return {
        message: responseText,
        isQuestion: this.detectQuestion(responseText),
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        this.logger.error('Chat timed out');
        return { message: "Sorry, I took too long to respond. Could you try again?" };
      }
      this.logger.error('Chat failed:', error);
      return { message: `Sorry, something went wrong: ${error}` };
    }
  }

  /**
   * Generate a plain text response (no tools)
   */
  private async generateResponse(prompt: string): Promise<string> {
    const messages: ChatMessage[] = [
      { role: 'system', content: this.systemPrompt },
      ...this.conversationHistory,
      { role: 'user', content: prompt },
    ];

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    const response = await fetch(`${this.config.ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        stream: false,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Ollama error: ${response.status}`);
    }

    const data = await response.json() as OllamaChatResponse;
    return data.message.content || '';
  }

  /**
   * Detect if a response contains a question for the user
   */
  private detectQuestion(text: string): boolean {
    // Look for question patterns
    return /\?$/.test(text.trim()) ||
           /would you|should I|do you want|which|what would you|prefer|like me to/i.test(text);
  }

  /**
   * Clear conversation history (e.g., for a fresh start)
   */
  clearHistory(): void {
    this.conversationHistory = [];
  }

  /**
   * Execute a tool with error recovery using the model
   */
  private async executeToolWithRecovery(
    toolName: string,
    args: Record<string, unknown>,
    originalPrompt: string,
    attempt = 1
  ): Promise<{ tool: string; result?: unknown; error?: string; recovery?: string }> {
    // Resolve the handler (with fuzzy matching if needed)
    let handler = this.toolHandlers.get(toolName);
    let resolvedName = toolName;

    if (!handler) {
      const matched = this.fuzzyMatchTool(toolName);
      if (matched) {
        this.logger.info(`Fuzzy matched ${toolName} -> ${matched.name}`);
        handler = matched.handler;
        resolvedName = matched.name;
      } else {
        this.logger.warn(`No handler for tool: ${toolName}`);
        return { tool: toolName, error: `Unknown tool: ${toolName}` };
      }
    }

    // Try executing the tool
    this.logger.info(`Calling: ${resolvedName}(${JSON.stringify(args)})`);
    try {
      const result = await handler(args);
      this.emit('tool_called', { tool: resolvedName, args, result });
      return { tool: resolvedName, result };
    } catch (error) {
      const errorStr = String(error);
      this.logger.error(`Tool ${resolvedName} failed:`, error);

      // If error recovery is disabled or we've exhausted attempts, return the error
      if (!this.config.enableErrorRecovery || attempt > this.config.maxRecoveryAttempts) {
        return { tool: resolvedName, error: errorStr };
      }

      // Ask the model to reason about the error and suggest recovery
      this.logger.info(`Consulting reasoner for error recovery (attempt ${attempt})...`);
      const recovery = await this.reasonAboutError(resolvedName, args, errorStr, originalPrompt);

      this.logger.info(`Recovery decision: ${recovery.action} - ${recovery.reason}`);

      switch (recovery.action) {
        case 'retry':
          // Retry with same args
          return this.executeToolWithRecovery(resolvedName, args, originalPrompt, attempt + 1);

        case 'retry_modified':
          // Retry with modified args
          if (recovery.modifiedArgs) {
            return this.executeToolWithRecovery(
              resolvedName,
              { ...args, ...recovery.modifiedArgs },
              originalPrompt,
              attempt + 1
            );
          }
          return { tool: resolvedName, error: errorStr, recovery: recovery.reason };

        case 'skip':
          // Skip this tool call but don't treat as error
          return { tool: resolvedName, result: null, recovery: `Skipped: ${recovery.reason}` };

        case 'fail':
        default:
          // Accept the failure
          return { tool: resolvedName, error: errorStr, recovery: recovery.reason };
      }
    }
  }

  /**
   * Use the model to reason about a tool error and decide recovery action
   */
  private async reasonAboutError(
    toolName: string,
    args: Record<string, unknown>,
    error: string,
    originalPrompt: string
  ): Promise<RecoveryAction> {
    const prompt = `You are Darwin's error recovery system. A tool call failed and you need to decide what to do.

TOOL: ${toolName}
ARGUMENTS: ${JSON.stringify(args, null, 2)}
ERROR: ${error}
ORIGINAL REQUEST: ${originalPrompt}

Analyze this error and respond with ONE of these actions:

1. RETRY - Try the same call again (for transient errors like network issues)
2. RETRY_MODIFIED <json> - Retry with modified arguments (explain the fix)
3. SKIP - Skip this operation, it's not critical
4. FAIL - Accept the failure, cannot recover

Common recovery patterns:
- "branch already exists" → RETRY_MODIFIED with existing branch checkout instead of create
- "file not found" → might need different path
- "permission denied" → FAIL, needs human intervention
- "network error" or "timeout" → RETRY

Respond in this exact format:
ACTION: <action>
MODIFIED_ARGS: <json if RETRY_MODIFIED, otherwise omit>
REASON: <brief explanation>`;

    try {
      const response = await this.reason(prompt, { maxTokens: 150, temperature: 0.3 });

      // Parse the response
      const actionMatch = response.match(/ACTION:\s*(RETRY_MODIFIED|RETRY|SKIP|FAIL)/i);
      const argsMatch = response.match(/MODIFIED_ARGS:\s*(\{[^}]+\})/);
      const reasonMatch = response.match(/REASON:\s*(.+?)(?:\n|$)/i);

      const action = actionMatch?.[1]?.toLowerCase().replace('_', '_') as RecoveryAction['action'] || 'fail';
      const reason = reasonMatch?.[1]?.trim() || 'No reason provided';

      let modifiedArgs: Record<string, unknown> | undefined;
      if (action === 'retry_modified' && argsMatch) {
        try {
          modifiedArgs = JSON.parse(argsMatch[1]);
        } catch {
          // If we can't parse the args, fall back to fail
          return { action: 'fail', reason: 'Could not parse modified arguments' };
        }
      }

      return { action, modifiedArgs, reason };
    } catch (reasonerError) {
      // If the reasoner itself fails, just return the original error
      this.logger.warn(`Reasoner failed during error recovery: ${reasonerError}`);
      return { action: 'fail', reason: 'Reasoner unavailable' };
    }
  }

  /**
   * Fuzzy match a tool name when the model gets it slightly wrong
   * Uses keyword matching: code_active_tasks -> code_get_ready_tasks
   */
  private fuzzyMatchTool(name: string): { name: string; handler: (args: Record<string, unknown>) => Promise<unknown> } | null {
    const nameLower = name.toLowerCase();
    const keywords = nameLower.split('_').filter(k => k.length > 2);

    // Score each tool by matching keywords
    let bestMatch: { name: string; score: number } | null = null;

    for (const tool of this.tools) {
      const toolName = tool.function.name.toLowerCase();
      const toolKeywords = toolName.split('_').filter(k => k.length > 2);

      // Count matching keywords
      let score = 0;
      for (const kw of keywords) {
        if (toolKeywords.includes(kw)) score += 2;
        else if (toolKeywords.some(tk => tk.includes(kw) || kw.includes(tk))) score += 1;
      }

      // Must match at least prefix (e.g., "code_" or "home_")
      const prefix = nameLower.split('_')[0];
      if (!toolName.startsWith(prefix)) continue;

      // Bonus for matching intent keywords
      const intentMap: Record<string, string[]> = {
        'active': ['status', 'ready', 'get'],
        'tasks': ['ready', 'get'],
        'check': ['get', 'status'],
        'list': ['get', 'repos'],
      };
      for (const kw of keywords) {
        const synonyms = intentMap[kw];
        if (synonyms) {
          for (const syn of synonyms) {
            if (toolKeywords.includes(syn)) score += 1;
          }
        }
      }

      if (score > 0 && (!bestMatch || score > bestMatch.score)) {
        bestMatch = { name: tool.function.name, score };
      }
    }

    if (bestMatch && bestMatch.score >= 2) {
      const handler = this.toolHandlers.get(bestMatch.name);
      if (handler) {
        return { name: bestMatch.name, handler };
      }
    }

    return null;
  }

  /**
   * Ask the model which tools to call (without executing)
   */
  private async getToolCalls(prompt: string): Promise<ToolCall[]> {
    if (this.tools.length === 0) {
      this.logger.warn('No tools registered');
      return [];
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

      const response = await fetch(`${this.config.ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            { role: 'system', content: this.systemPrompt },
            { role: 'user', content: prompt },
          ] as ChatMessage[],
          tools: this.tools,
          stream: false,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Ollama error: ${response.status}`);
      }

      const data = await response.json() as OllamaChatResponse;
      return data.message.tool_calls || [];
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        this.logger.error('Dispatch timed out');
      } else {
        this.logger.error('Dispatch failed:', error);
      }
      return [];
    }
  }

  /**
   * Use the model for complex reasoning or text generation
   */
  async reason(prompt: string, options?: { maxTokens?: number; temperature?: number }): Promise<string> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

      const response = await fetch(`${this.config.ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.config.model,
          prompt,
          stream: false,
          options: {
            num_predict: options?.maxTokens ?? 200,
            temperature: options?.temperature ?? 0.7,
          },
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Ollama error: ${response.status}`);
      }

      const data = await response.json() as GenerateResponse;
      return data.response;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        this.logger.error('Reasoning timed out');
        throw new Error('Reasoning request timed out');
      }
      this.logger.error('Reasoning failed:', error);
      throw error;
    }
  }

  /**
   * Quick yes/no decision
   */
  async decide(question: string): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10_000); // 10s for simple decision

      const response = await fetch(`${this.config.ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.config.model,
          prompt: `${question}\n\nAnswer with just 'yes' or 'no':`,
          stream: false,
          options: { num_predict: 5 },
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const data = await response.json() as GenerateResponse;
      const answer = data.response.toLowerCase();
      return answer.includes('yes') || answer.includes('y');
    } catch {
      this.logger.warn('Decision request failed, defaulting to false');
      return false;
    }
  }

  /**
   * Observe a terminal session and decide what action to take
   *
   * This is the core method for PTY-based Claude Code interaction.
   * The model observes the terminal state and decides what to type next.
   *
   * @param observation Current terminal state
   * @param taskContext Description of the task being worked on
   * @returns Action to execute on the terminal
   */
  async observeTerminal(
    observation: TerminalObservation,
    taskContext: string
  ): Promise<TerminalAction> {
    // Fast path: if processing, always wait
    if (observation.state === 'processing' && observation.isStreaming) {
      return { type: 'wait', waitMs: 500, reason: 'Claude is working' };
    }

    // Fast path: if limit reached, wait for reset
    if (observation.state === 'limit_reached') {
      const waitMs = observation.limitResetTime
        ? Math.max(0, observation.limitResetTime.getTime() - Date.now())
        : 3600_000; // default 1 hour
      return { type: 'wait', waitMs, reason: 'Usage limit reached' };
    }

    // Build prompt for the model
    const prompt = `${this.terminalSystemPrompt}

TASK: ${taskContext}

CURRENT STATE:
- Terminal state: ${observation.state}
- Prompt visible: ${observation.promptVisible}
- Is streaming: ${observation.isStreaming}
- Time since last action: ${observation.timeSinceLastActionMs}ms
- Session duration: ${observation.elapsedMs}ms
${observation.lastQuestion ? `- Last question: ${observation.lastQuestion}` : ''}

RECENT OUTPUT (last ${observation.recentOutput.length} chars):
\`\`\`
${observation.recentOutput}
\`\`\`

What action should I take? Respond with ONLY a JSON object.`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15_000); // 15s timeout for observation

      const response = await fetch(`${this.config.ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.config.model,
          prompt,
          stream: false,
          options: {
            num_predict: 150,
            temperature: 0.3, // Low temperature for deterministic actions
          },
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Ollama error: ${response.status}`);
      }

      const data = await response.json() as GenerateResponse;
      return this.parseTerminalAction(data.response);
    } catch (error) {
      this.logger.warn('Terminal observation failed, defaulting to wait:', error);
      return { type: 'wait', waitMs: 1000, reason: 'Observation failed' };
    }
  }

  /**
   * Parse the model response into a TerminalAction
   */
  private parseTerminalAction(response: string): TerminalAction {
    try {
      // Extract JSON from response (may have text before/after)
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        this.logger.warn('No JSON found in response:', response.slice(0, 100));
        return { type: 'wait', waitMs: 500, reason: 'Could not parse response' };
      }

      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

      // Validate type field
      const validTypes: TerminalActionType[] = ['type', 'enter', 'send', 'ctrl_c', 'ctrl_d', 'wait', 'answer'];
      const actionType = parsed.type as string;

      if (!validTypes.includes(actionType as TerminalActionType)) {
        this.logger.warn(`Invalid action type: ${actionType}`);
        return { type: 'wait', waitMs: 500, reason: `Invalid action type: ${actionType}` };
      }

      return {
        type: actionType as TerminalActionType,
        content: typeof parsed.content === 'string' ? parsed.content : undefined,
        waitMs: typeof parsed.waitMs === 'number' ? parsed.waitMs : undefined,
        reason: typeof parsed.reason === 'string' ? parsed.reason : 'No reason provided',
      };
    } catch (err) {
      this.logger.warn('Failed to parse terminal action:', err);
      return { type: 'wait', waitMs: 500, reason: 'JSON parse error' };
    }
  }

  /**
   * List available Ollama models
   */
  private async listModels(timeoutMs: number): Promise<string[]> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(`${this.config.ollamaUrl}/api/tags`, {
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Ollama returned ${response.status}`);
    }

    const data = await response.json() as { models: Array<{ name: string }> };
    return data.models?.map(m => m.name) || [];
  }

  /**
   * Pull the configured model from Ollama
   */
  private async pullModel(): Promise<void> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.pullTimeout);

    const response = await fetch(`${this.config.ollamaUrl}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: this.config.model,
        stream: false,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Ollama pull error: ${response.status}`);
    }

    const data = await response.json() as { status?: string; error?: string };
    if (data.error) {
      throw new Error(`Ollama pull error: ${data.error}`);
    }
  }

  /**
   * Get current model name
   */
  getModel(): string {
    return this.config.model;
  }

  /**
   * Unload the model to free RAM (useful for Pi with limited memory)
   */
  async unloadModel(): Promise<void> {
    this.logger.info('Unloading model to free RAM...');

    try {
      await fetch(`${this.config.ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.config.model,
          prompt: '',
          keep_alive: 0,
        }),
      });
      this.logger.info('Model unloaded');
    } catch {
      // Ignore errors
    }
  }

  /**
   * Get list of registered tools
   */
  getTools(): Tool[] {
    return [...this.tools];
  }

  /**
   * Get current configuration
   */
  getConfig(): Readonly<BrainConfig> {
    return { ...this.config };
  }

  /**
   * Cleanup
   */
  async shutdown(): Promise<void> {
    await this.unloadModel();
    this.removeAllListeners();
  }
}

// Keep old name as alias for backwards compatibility
export { DarwinBrain as HomebaseBrain };
