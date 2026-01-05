/**
 * OpenRouter Integration - Access to frontier models
 *
 * Provides access to DeepSeek R1 and other models via OpenRouter API.
 * Used for complex reasoning, research, and tasks that exceed
 * local model's capabilities.
 *
 * Default model: DeepSeek R1 (deepseek/deepseek-r1)
 * - Excellent reasoning capability
 * - Good value for money
 * - Performs well on complex tasks
 */

import { Logger } from '../core/logger.js';

export interface OpenRouterConfig {
  /** OpenRouter API key */
  apiKey: string;
  /** Default model to use */
  defaultModel: string;
  /** Base URL for API */
  baseUrl: string;
  /** Default max tokens */
  maxTokens: number;
  /** Default temperature */
  temperature: number;
  /** Request timeout in ms */
  timeout: number;
}

const DEFAULT_CONFIG: Partial<OpenRouterConfig> = {
  defaultModel: 'deepseek/deepseek-r1',
  baseUrl: 'https://openrouter.ai/api/v1',
  maxTokens: 4096,
  temperature: 0.7,
  timeout: 120_000, // 2 minutes - R1 can be slow
};

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatCompletionResponse {
  id: string;
  choices: Array<{
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ResearchResult {
  summary: string;
  keyPoints: string[];
  sources?: string[];
  confidence: 'low' | 'medium' | 'high';
}

export class OpenRouterClient {
  private config: OpenRouterConfig;
  private logger: Logger;

  constructor(config: Partial<OpenRouterConfig> & { apiKey: string }) {
    this.config = { ...DEFAULT_CONFIG, ...config } as OpenRouterConfig;
    this.logger = new Logger('OpenRouter');
  }

  /**
   * Check if the client is configured (has API key)
   */
  isConfigured(): boolean {
    return !!this.config.apiKey;
  }

  /**
   * Send a chat completion request
   */
  async complete(
    prompt: string,
    options: {
      model?: string;
      maxTokens?: number;
      temperature?: number;
      systemPrompt?: string;
    } = {}
  ): Promise<string> {
    if (!this.config.apiKey) {
      throw new Error('OpenRouter API key not configured');
    }

    const messages: ChatMessage[] = [];

    if (options.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }

    messages.push({ role: 'user', content: prompt });

    const model = options.model || this.config.defaultModel;
    this.logger.debug(`Calling ${model}...`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
          'HTTP-Referer': 'https://darwin.local', // Required by OpenRouter
          'X-Title': 'Darwin Home Intelligence',
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: options.maxTokens || this.config.maxTokens,
          temperature: options.temperature ?? this.config.temperature,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenRouter error ${response.status}: ${errorText}`);
      }

      const data = await response.json() as ChatCompletionResponse;

      if (!data.choices || data.choices.length === 0) {
        throw new Error('No response from model');
      }

      const content = data.choices[0].message.content;

      if (data.usage) {
        this.logger.debug(
          `Tokens: ${data.usage.prompt_tokens} in, ${data.usage.completion_tokens} out`
        );
      }

      return content;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Request timed out');
      }
      throw error;
    }
  }

  /**
   * Think deeply about a question using DeepSeek R1
   *
   * This is for complex reasoning tasks that benefit from
   * a more capable model.
   */
  async thinkDeep(
    question: string,
    context?: string
  ): Promise<string> {
    const systemPrompt = `You are a thoughtful AI assistant helping with complex reasoning.
Take your time to think through the problem step by step.
Be thorough but concise in your final answer.`;

    const prompt = context
      ? `Context:\n${context}\n\nQuestion:\n${question}`
      : question;

    return this.complete(prompt, {
      systemPrompt,
      temperature: 0.5, // Lower temperature for reasoning
      maxTokens: 2048,
    });
  }

  /**
   * Research a topic and return structured findings
   *
   * Uses DeepSeek R1's reasoning capabilities to analyze
   * and synthesize information about a topic.
   */
  async research(
    topic: string,
    depth: 'quick' | 'thorough' = 'quick'
  ): Promise<ResearchResult> {
    const systemPrompt = `You are a research assistant. Analyze the given topic and provide:
1. A clear summary (2-3 sentences)
2. Key points (3-5 bullet points)
3. Your confidence level (low/medium/high) based on your knowledge

Format your response as JSON:
{
  "summary": "...",
  "keyPoints": ["...", "..."],
  "confidence": "medium"
}`;

    const maxTokens = depth === 'quick' ? 1024 : 2048;

    const prompt = depth === 'quick'
      ? `Briefly research: ${topic}`
      : `Thoroughly analyze and research: ${topic}\n\nProvide comprehensive findings.`;

    const response = await this.complete(prompt, {
      systemPrompt,
      temperature: 0.3,
      maxTokens,
    });

    // Parse JSON response
    try {
      // Extract JSON from response (may have markdown code blocks)
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }

      const parsed = JSON.parse(jsonMatch[0]) as ResearchResult;

      return {
        summary: parsed.summary || 'No summary provided',
        keyPoints: parsed.keyPoints || [],
        confidence: parsed.confidence || 'medium',
      };
    } catch {
      // If parsing fails, return raw response as summary
      return {
        summary: response.slice(0, 500),
        keyPoints: [],
        confidence: 'low',
      };
    }
  }

  /**
   * Summarize content
   */
  async summarize(
    content: string,
    style: 'brief' | 'detailed' = 'brief'
  ): Promise<string> {
    const prompt = style === 'brief'
      ? `Summarize the following in 2-3 sentences:\n\n${content}`
      : `Provide a detailed summary of the following:\n\n${content}`;

    return this.complete(prompt, {
      temperature: 0.3,
      maxTokens: style === 'brief' ? 256 : 1024,
    });
  }

  /**
   * Get available models from OpenRouter
   */
  async getModels(): Promise<Array<{ id: string; name: string }>> {
    if (!this.config.apiKey) {
      throw new Error('OpenRouter API key not configured');
    }

    const response = await fetch(`${this.config.baseUrl}/models`, {
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.status}`);
    }

    const data = await response.json() as { data: Array<{ id: string; name: string }> };
    return data.data || [];
  }
}

// Singleton instance (configured lazily)
let clientInstance: OpenRouterClient | null = null;

export function getOpenRouterClient(config?: Partial<OpenRouterConfig> & { apiKey: string }): OpenRouterClient {
  if (!clientInstance && config) {
    clientInstance = new OpenRouterClient(config);
  }
  if (!clientInstance) {
    throw new Error('OpenRouter client not initialized. Provide config on first call.');
  }
  return clientInstance;
}

export function resetOpenRouterClient(): void {
  clientInstance = null;
}
