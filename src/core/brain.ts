/**
 * Darwin Brain - Configurable AI coordinator
 *
 * Handles:
 * - Tool dispatch (function calling via Ollama or OpenRouter)
 * - Terminal observation (decides what to type in Claude sessions)
 * - Complex reasoning when needed
 */

import { EventEmitter } from 'events';
import { Logger } from './logger.js';

type BrainProvider = 'ollama' | 'openrouter';

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
  id?: string;
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
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

interface OpenRouterChatResponse {
  choices: Array<{
    message: {
      role: string;
      content?: string;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function: {
          name: string;
          arguments: string | Record<string, unknown>;
        };
      }>;
    };
  }>;
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
  /** Brain provider */
  provider: BrainProvider;
  /** Model to use for the selected provider */
  model: string;
  /** Ollama API URL */
  ollamaUrl: string;
  /** OpenRouter configuration (required when provider is openrouter) */
  openRouter?: {
    apiKey: string;
    baseUrl?: string;
    timeout?: number;
    maxTokens?: number;
    temperature?: number;
    defaultModel?: string;
  };
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
  provider: 'ollama',
  model: 'llama3.2:1b',
  ollamaUrl: 'http://localhost:11434',
  enableErrorRecovery: true,
  maxRecoveryAttempts: 2,
  timeout: 60_000, // 60 seconds
  pullTimeout: 30 * 60_000, // 30 minutes
};

const DEFAULT_OPENROUTER_CONFIG = {
  baseUrl: 'https://openrouter.ai/api/v1',
  timeout: 300_000, // 5 minutes for long responses
  maxTokens: 16384, // Allow much longer responses
  temperature: 0.7,
};

export interface RepoContext {
  name: string;
  description?: string;
  sshUrl?: string;
  enabled: boolean;
}

export class DarwinBrain extends EventEmitter {
  private config: BrainConfig;
  private logger: Logger;
  private tools: Tool[] = [];
  private toolHandlers: Map<string, (args: Record<string, unknown>) => Promise<unknown>> = new Map();
  private systemPrompt: string;
  private conversationHistory: ChatMessage[] = [];
  private maxHistoryLength = 20; // Keep last N messages for context
  private repoContext: RepoContext[] = [];

  /** Whether the brain is currently in an active chat session */
  private _isChatting = false;
  /** Timestamp when chatting started (for timeout detection) */
  private _chattingStartedAt: number | null = null;
  /** Max time a chat can be active before auto-releasing (5 minutes) */
  private static readonly CHAT_TIMEOUT_MS = 5 * 60 * 1000;

  constructor(config: Partial<BrainConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = new Logger('Brain');
    this.systemPrompt = this.buildSystemPrompt();
  }

  /**
   * Update the repo context - call this after loading config
   */
  setRepoContext(repos: RepoContext[]): void {
    this.repoContext = repos;
    this.systemPrompt = this.buildSystemPrompt();
    this.logger.debug(`Updated repo context: ${repos.map(r => r.name).join(', ')}`);
  }

  private buildSystemPrompt(): string {
    const repoSection = this.repoContext.length > 0
      ? `\n\nCONFIGURED REPOSITORIES:\n${this.repoContext.map(r => {
          const parts = [`- "${r.name}"`];
          if (r.description) parts.push(`(${r.description})`);
          if (r.sshUrl) parts.push('[SSH workspace enabled]');
          if (!r.enabled) parts.push('[disabled]');
          return parts.join(' ');
        }).join('\n')}`
      : '';

    return `You are Darwin, Jack's local home intelligence system.

You're a capable AI assistant powered by Claude. You help Jack with:
- Code tasks: Starting work on repositories, managing PRD items, orchestrating Claude Code sessions
- Home automation: Lights, heating, sensors (when configured)
- General assistance: Answering questions, making decisions, taking action
${repoSection}

TOOL SELECTION:
- To start work on a repository, use "code_start_ssh_task" with the repo name
- To run ralph.sh in the first local repo, use "start_prd" (legacy local mode)
- To check what's running, use "get_status"
- To list repos, use "list_repos"

When the user mentions a repo name (like "synapse" or "darwin"), recognize it and use the appropriate tool with that name as the argument.

Be conversational, concise, and helpful. Ask clarifying questions when needed. Take action when the intent is clear.`;
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
   * Check if the selected provider is healthy and the model is available
   */
  async checkHealth(): Promise<{ healthy: boolean; model: string; available: boolean; error?: string }> {
    if (this.config.provider === 'openrouter') {
      try {
        const model = this.getOpenRouterModel();
        const models = await this.listOpenRouterModels();
        const available = models.some(m => m === model || m.includes(model));

        return {
          healthy: available,
          model,
          available,
          error: available ? undefined : `Model ${model} not found in OpenRouter`,
        };
      } catch (err) {
        return {
          healthy: false,
          model: this.config.model,
          available: false,
          error: `OpenRouter check failed: ${err}`,
        };
      }
    }

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
    if (this.config.provider === 'openrouter') {
      if (!this.config.openRouter?.apiKey) {
        throw new Error('OpenRouter API key not configured');
      }
      return { model: this.getOpenRouterModel(), pulled: false };
    }

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
    this.startChatting();

    try {
      // Add user message to history
      this.conversationHistory.push({
        role: 'user',
        content: userMessage,
      });

      this.trimHistory();

      this.logger.debug(`Chat: ${userMessage.slice(0, 100)}...`);

      const messages: ChatMessage[] = [
        { role: 'system', content: this.systemPrompt },
        ...this.conversationHistory,
      ];

      const toolResults: Array<{ tool: string; result?: unknown; error?: string }> = [];
      const maxToolRounds = 3;

      for (let round = 0; round < maxToolRounds; round++) {
        const data = await this.requestChatCompletion(messages, {
          tools: this.tools.length > 0 ? this.tools : undefined,
        });
        const assistantMessage = data.message;
        const toolCalls = assistantMessage.tool_calls || [];

        const assistantEntry: ChatMessage = {
          role: 'assistant',
          content: assistantMessage.content || '',
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        };

        this.conversationHistory.push(assistantEntry);
        messages.push(assistantEntry);
        this.trimHistory();

        if (toolCalls.length === 0) {
          const responseText = assistantMessage.content || "I'm not sure how to help with that.";
          return {
            message: responseText,
            toolResults: toolResults.length > 0 ? toolResults : undefined,
            isQuestion: this.detectQuestion(responseText),
          };
        }

        const toolResultMessages: ChatMessage[] = [];
        for (const call of toolCalls) {
          const result = await this.executeToolWithRecovery(
            call.function.name,
            call.function.arguments,
            userMessage
          );
          toolResults.push(result);

          const toolContent = result.error
            ? `Tool ${result.tool} failed: ${result.error}`
            : `Tool ${result.tool} returned: ${JSON.stringify(result.result, null, 2)}`;

          const toolMessage: ChatMessage = {
            role: 'tool',
            content: toolContent,
          };
          if (call.id) {
            toolMessage.tool_call_id = call.id;
          }
          toolResultMessages.push(toolMessage);
        }

        this.conversationHistory.push(...toolResultMessages);
        messages.push(...toolResultMessages);
        this.trimHistory();
      }

      return {
        message: 'I hit the tool call limit while working on that. Try again or rephrase?',
        toolResults: toolResults.length > 0 ? toolResults : undefined,
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        this.logger.error('Chat timed out');
        return { message: "Sorry, I took too long to respond. Could you try again?" };
      }
      this.logger.error('Chat failed:', error);
      return { message: `Sorry, something went wrong: ${error}` };
    } finally {
      this.stopChatting();
    }
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
   * Chat with streaming - streams tokens to the callback as they arrive
   *
   * Returns the full response when complete. The onToken callback receives
   * each chunk of text as it streams in.
   */
  async chatStreaming(
    userMessage: string,
    onToken: (token: string) => void
  ): Promise<ChatResponse> {
    this.startChatting();

    try {
      // Add user message to history
      this.conversationHistory.push({
        role: 'user',
        content: userMessage,
      });

      this.trimHistory();
      this.logger.debug(`Chat (streaming): ${userMessage.slice(0, 100)}...`);

      const messages: ChatMessage[] = [
        { role: 'system', content: this.systemPrompt },
        ...this.conversationHistory,
      ];

      const toolResults: Array<{ tool: string; result?: unknown; error?: string }> = [];
      const maxToolRounds = 3;

      for (let round = 0; round < maxToolRounds; round++) {
        // First, check for tool calls (non-streaming)
        const checkData = await this.requestChatCompletion(messages, {
          tools: this.tools.length > 0 ? this.tools : undefined,
        });

        const toolCalls = checkData.message.tool_calls || [];

        // If there are tool calls, handle them
        if (toolCalls.length > 0) {
          const assistantEntry: ChatMessage = {
            role: 'assistant',
            content: checkData.message.content || '',
            tool_calls: toolCalls,
          };

          this.conversationHistory.push(assistantEntry);
          messages.push(assistantEntry);
          this.trimHistory();

          // Execute tools
          const toolResultMessages: ChatMessage[] = [];
          for (const call of toolCalls) {
            const result = await this.executeToolWithRecovery(
              call.function.name,
              call.function.arguments,
              userMessage
            );
            toolResults.push(result);

            const toolContent = result.error
              ? `Tool ${result.tool} failed: ${result.error}`
              : `Tool ${result.tool} returned: ${JSON.stringify(result.result, null, 2)}`;

            const toolMessage: ChatMessage = {
              role: 'tool',
              content: toolContent,
            };
            if (call.id) {
              toolMessage.tool_call_id = call.id;
            }
            toolResultMessages.push(toolMessage);
          }

          this.conversationHistory.push(...toolResultMessages);
          messages.push(...toolResultMessages);
          this.trimHistory();

          // Continue loop to get final response
          continue;
        }

        // No tool calls - stream the response
        const fullResponse = await this.streamChatCompletion(messages, onToken);

        const assistantEntry: ChatMessage = {
          role: 'assistant',
          content: fullResponse,
        };
        this.conversationHistory.push(assistantEntry);
        this.trimHistory();

        return {
          message: fullResponse,
          toolResults: toolResults.length > 0 ? toolResults : undefined,
          isQuestion: this.detectQuestion(fullResponse),
        };
      }

      return {
        message: 'I hit the tool call limit while working on that. Try again or rephrase?',
        toolResults: toolResults.length > 0 ? toolResults : undefined,
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        this.logger.error('Chat timed out');
        return { message: "Sorry, I took too long to respond. Could you try again?" };
      }
      this.logger.error('Chat failed:', error);
      return { message: `Sorry, something went wrong: ${error}` };
    } finally {
      this.stopChatting();
    }
  }

  /**
   * Stream a chat completion from OpenRouter
   */
  private async streamChatCompletion(
    messages: ChatMessage[],
    onToken: (token: string) => void
  ): Promise<string> {
    if (this.config.provider !== 'openrouter') {
      // Fallback to non-streaming for Ollama
      const data = await this.requestChatCompletion(messages, {});
      const content = data.message.content || '';
      onToken(content);
      return content;
    }

    const config = this.getOpenRouterConfig();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeout);

    const outboundMessages = messages.map((message) => {
      if (!message.tool_calls) {
        return message;
      }
      const toolCalls = message.tool_calls.map((call) => ({
        id: call.id,
        type: 'function',
        function: {
          name: call.function.name,
          arguments: JSON.stringify(call.function.arguments ?? {}),
        },
      }));
      return { ...message, tool_calls: toolCalls };
    });

    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
        'HTTP-Referer': 'https://darwin.local',
        'X-Title': 'Darwin Home Intelligence',
      },
      body: JSON.stringify({
        model: this.getOpenRouterModel(),
        messages: outboundMessages,
        stream: true,
        max_tokens: config.maxTokens,
        temperature: config.temperature,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenRouter error ${response.status}: ${errorText}`);
    }

    if (!response.body) {
      throw new Error('No response body for streaming');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE lines
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;

            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) {
                fullContent += delta;
                onToken(delta);
              }
            } catch {
              // Skip malformed JSON
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return fullContent || "I'm not sure how to help with that.";
  }

  /**
   * Clear conversation history (e.g., for a fresh start)
   */
  clearHistory(): void {
    this.conversationHistory = [];
  }

  /**
   * Trim conversation history to max length
   */
  private trimHistory(): void {
    while (this.conversationHistory.length > this.maxHistoryLength) {
      this.conversationHistory.shift();
    }
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
      const data = await this.requestChatCompletion(
        [
          { role: 'system', content: this.systemPrompt },
          { role: 'user', content: prompt },
        ],
        { tools: this.tools }
      );
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
   * Normalize tool call arguments across providers
   */
  private normalizeToolCalls(rawCalls?: Array<{ id?: string; function: { name: string; arguments: unknown } }>): ToolCall[] {
    if (!rawCalls || rawCalls.length === 0) return [];

    return rawCalls.map((call) => {
      let args = call.function.arguments;

      if (typeof args === 'string') {
        try {
          args = JSON.parse(args);
        } catch {
          this.logger.warn(`Failed to parse tool args for ${call.function.name}`);
          args = {};
        }
      }

      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        args = {};
      }

      return {
        id: call.id,
        function: {
          name: call.function.name,
          arguments: args as Record<string, unknown>,
        },
      };
    });
  }

  /**
   * Request a chat completion from the configured provider
   */
  private async requestChatCompletion(
    messages: ChatMessage[],
    options: { tools?: Tool[]; maxTokens?: number; temperature?: number } = {}
  ): Promise<OllamaChatResponse> {
    if (this.config.provider === 'openrouter') {
      const config = this.getOpenRouterConfig();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), config.timeout);
      const outboundMessages = messages.map((message) => {
        if (!message.tool_calls) {
          return message;
        }
        const toolCalls = message.tool_calls.map((call) => ({
          id: call.id,
          type: 'function',
          function: {
            name: call.function.name,
            arguments: JSON.stringify(call.function.arguments ?? {}),
          },
        }));
        return { ...message, tool_calls: toolCalls };
      });

      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
          'HTTP-Referer': 'https://darwin.local',
          'X-Title': 'Darwin Home Intelligence',
        },
        body: JSON.stringify({
          model: this.getOpenRouterModel(),
          messages: outboundMessages,
          tools: options.tools && options.tools.length > 0 ? options.tools : undefined,
          tool_choice: options.tools && options.tools.length > 0 ? 'auto' : undefined,
          max_tokens: options.maxTokens ?? config.maxTokens,
          temperature: options.temperature ?? config.temperature,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenRouter error ${response.status}: ${errorText}`);
      }

      const data = await response.json() as OpenRouterChatResponse;
      const choice = data.choices?.[0]?.message;
      if (!choice) {
        throw new Error('No response from OpenRouter');
      }

      const toolCalls = this.normalizeToolCalls(choice.tool_calls);
      return {
        message: {
          role: choice.role || 'assistant',
          content: choice.content || '',
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        },
      };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);
    const toolOptions = options.tools && options.tools.length > 0 ? options.tools : undefined;
    const hasOptions = options.maxTokens !== undefined || options.temperature !== undefined;

    const response = await fetch(`${this.config.ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        tools: toolOptions,
        stream: false,
        options: hasOptions
          ? {
            num_predict: options.maxTokens,
            temperature: options.temperature,
          }
          : undefined,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Ollama error: ${response.status}`);
    }

    const data = await response.json() as OllamaChatResponse;
    data.message.tool_calls = this.normalizeToolCalls(data.message.tool_calls as ToolCall[]);
    return data;
  }

  /**
   * Use the model for complex reasoning or text generation
   */
  async reason(prompt: string, options?: { maxTokens?: number; temperature?: number }): Promise<string> {
    try {
      if (this.config.provider === 'openrouter') {
        const data = await this.requestChatCompletion(
          [
            { role: 'system', content: this.systemPrompt },
            { role: 'user', content: prompt },
          ],
          {
            maxTokens: options?.maxTokens,
            temperature: options?.temperature,
          }
        );
        return data.message.content || '';
      }

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
      if (this.config.provider === 'openrouter') {
        const data = await this.requestChatCompletion(
          [
            { role: 'system', content: 'Answer yes/no questions with a single word.' },
            { role: 'user', content: `${question}\n\nAnswer with just 'yes' or 'no':` },
          ],
          {
            maxTokens: 5,
            temperature: 0,
          }
        );
        const answer = (data.message.content || '').toLowerCase();
        return answer.includes('yes') || answer.includes('y');
      }

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
   * Resolve OpenRouter configuration with defaults
   */
  private getOpenRouterConfig(): {
    apiKey: string;
    baseUrl: string;
    timeout: number;
    maxTokens: number;
    temperature: number;
    defaultModel?: string;
  } {
    if (!this.config.openRouter?.apiKey) {
      throw new Error('OpenRouter API key not configured');
    }

    return {
      apiKey: this.config.openRouter.apiKey,
      baseUrl: this.config.openRouter.baseUrl || DEFAULT_OPENROUTER_CONFIG.baseUrl,
      timeout: this.config.openRouter.timeout ?? DEFAULT_OPENROUTER_CONFIG.timeout,
      maxTokens: this.config.openRouter.maxTokens ?? DEFAULT_OPENROUTER_CONFIG.maxTokens,
      temperature: this.config.openRouter.temperature ?? DEFAULT_OPENROUTER_CONFIG.temperature,
      defaultModel: this.config.openRouter.defaultModel,
    };
  }

  /**
   * Resolve OpenRouter model name
   */
  private getOpenRouterModel(): string {
    const config = this.getOpenRouterConfig();
    return this.config.model || config.defaultModel || 'deepseek/deepseek-r1';
  }

  /**
   * List available OpenRouter models
   */
  private async listOpenRouterModels(): Promise<string[]> {
    const config = this.getOpenRouterConfig();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeout);

    const response = await fetch(`${config.baseUrl}/models`, {
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`OpenRouter returned ${response.status}`);
    }

    const data = await response.json() as { data: Array<{ id: string }> };
    return data.data?.map(m => m.id) || [];
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
    return this.config.provider === 'openrouter' ? this.getOpenRouterModel() : this.config.model;
  }

  /**
   * Unload the model to free RAM (useful for Pi with limited memory)
   */
  async unloadModel(): Promise<void> {
    if (this.config.provider === 'openrouter') {
      return;
    }

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
   * Execute a tool directly (for scheduled or internal calls)
   */
  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    context = 'Scheduled tool'
  ): Promise<{ tool: string; result?: unknown; error?: string; recovery?: string }> {
    return this.executeToolWithRecovery(toolName, args, context);
  }

  /**
   * Get current provider
   */
  getProvider(): BrainProvider {
    return this.config.provider;
  }

  /**
   * Get current configuration
   */
  getConfig(): Readonly<BrainConfig> {
    return { ...this.config };
  }

  /**
   * Check if the brain is currently in an active chat session.
   * Used by Consciousness to avoid interfering with user conversations.
   */
  isChatting(): boolean {
    // Check for timeout - auto-release if chat has been active too long
    if (this._isChatting && this._chattingStartedAt) {
      const elapsed = Date.now() - this._chattingStartedAt;
      if (elapsed > DarwinBrain.CHAT_TIMEOUT_MS) {
        this.logger.warn(`Chat timeout after ${elapsed}ms, auto-releasing chatting state`);
        this._isChatting = false;
        this._chattingStartedAt = null;
      }
    }
    return this._isChatting;
  }

  /**
   * Mark the brain as entering a chat session.
   * Called internally by chat() and chatStreaming().
   */
  private startChatting(): void {
    this._isChatting = true;
    this._chattingStartedAt = Date.now();
    this.logger.debug('Started chatting');
  }

  /**
   * Mark the brain as exiting a chat session.
   * Called internally by chat() and chatStreaming().
   */
  private stopChatting(): void {
    this._isChatting = false;
    this._chattingStartedAt = null;
    this.logger.debug('Stopped chatting');
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
