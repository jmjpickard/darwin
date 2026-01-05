/**
 * Web Search Integration - Internet access for Darwin
 *
 * Provides web search and page fetching capabilities using
 * DuckDuckGo (free, no API key required).
 *
 * Features:
 * - Search the web
 * - Fetch and parse web pages
 * - Summarize page content
 */

import { Logger } from '../core/logger.js';

export interface WebSearchConfig {
  /** Maximum results per search */
  maxResults: number;
  /** Request timeout in ms */
  timeout: number;
  /** User agent for requests */
  userAgent: string;
}

const DEFAULT_CONFIG: WebSearchConfig = {
  maxResults: 5,
  timeout: 30_000,
  userAgent: 'Darwin/1.0 (Home Intelligence)',
};

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export class WebSearch {
  private config: WebSearchConfig;
  private logger: Logger;

  constructor(config: Partial<WebSearchConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = new Logger('WebSearch');
  }

  /**
   * Search the web using DuckDuckGo
   */
  async search(query: string, numResults?: number): Promise<SearchResult[]> {
    const limit = Math.min(numResults || this.config.maxResults, 10);

    this.logger.debug(`Searching: ${query}`);

    try {
      // Use DuckDuckGo HTML search (no API key needed)
      const encodedQuery = encodeURIComponent(query);
      const url = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

      const response = await fetch(url, {
        headers: {
          'User-Agent': this.config.userAgent,
          'Accept': 'text/html',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Search failed: ${response.status}`);
      }

      const html = await response.text();
      return this.parseSearchResults(html, limit);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Search timed out');
      }
      throw error;
    }
  }

  /**
   * Parse DuckDuckGo HTML search results
   */
  private parseSearchResults(html: string, limit: number): SearchResult[] {
    const results: SearchResult[] = [];

    // Match result blocks - DuckDuckGo uses .result class
    const resultPattern = /<div class="result[^"]*"[^>]*>[\s\S]*?<a class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

    let match;
    while ((match = resultPattern.exec(html)) !== null && results.length < limit) {
      const url = this.decodeRedirectUrl(match[1]);
      const title = this.stripHtml(match[2]);
      const snippet = this.stripHtml(match[3]);

      if (url && title) {
        results.push({ url, title, snippet });
      }
    }

    // Fallback: simpler pattern if above doesn't match
    if (results.length === 0) {
      const simplePattern = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([^<]*)</gi;
      while ((match = simplePattern.exec(html)) !== null && results.length < limit) {
        const url = this.decodeRedirectUrl(match[1]);
        const title = match[2].trim();

        if (url && title) {
          results.push({ url, title, snippet: '' });
        }
      }
    }

    this.logger.debug(`Found ${results.length} results`);
    return results;
  }

  /**
   * Decode DuckDuckGo redirect URLs
   */
  private decodeRedirectUrl(url: string): string {
    // DuckDuckGo wraps URLs in redirects like //duckduckgo.com/l/?uddg=https%3A%2F%2F...
    if (url.includes('uddg=')) {
      const match = url.match(/uddg=([^&]*)/);
      if (match) {
        return decodeURIComponent(match[1]);
      }
    }
    // Remove leading // if present
    if (url.startsWith('//')) {
      return 'https:' + url;
    }
    return url;
  }

  /**
   * Strip HTML tags and decode entities
   */
  private stripHtml(html: string): string {
    return html
      .replace(/<[^>]*>/g, '') // Remove tags
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Fetch a web page and convert to plain text/markdown
   */
  async fetchPage(url: string): Promise<string> {
    this.logger.debug(`Fetching: ${url}`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': this.config.userAgent,
          'Accept': 'text/html,application/xhtml+xml',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Fetch failed: ${response.status}`);
      }

      const html = await response.text();
      return this.htmlToText(html);
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Fetch timed out');
      }
      throw error;
    }
  }

  /**
   * Convert HTML to readable plain text
   */
  private htmlToText(html: string): string {
    // Remove script and style content
    let text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, '');

    // Convert some elements to markdown-like format
    text = text
      .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n')
      .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n')
      .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n')
      .replace(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi, '\n#### $1\n')
      .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1')
      .replace(/<a[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/gi, '[$2]($1)')
      .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**')
      .replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**')
      .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*')
      .replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, '*$1*')
      .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');

    // Remove all remaining tags
    text = text.replace(/<[^>]*>/g, '');

    // Decode entities
    text = text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)));

    // Clean up whitespace
    text = text
      .replace(/\n\s*\n\s*\n/g, '\n\n') // Max 2 newlines
      .replace(/[ \t]+/g, ' ') // Collapse spaces
      .trim();

    // Truncate if too long
    const maxLength = 10000;
    if (text.length > maxLength) {
      text = text.slice(0, maxLength) + '\n\n[Content truncated...]';
    }

    return text;
  }

  /**
   * Search and return combined context from top results
   */
  async searchAndSummarize(query: string): Promise<{
    results: SearchResult[];
    combinedContent: string;
  }> {
    const results = await this.search(query, 3);

    let combinedContent = '';

    for (const result of results) {
      try {
        const content = await this.fetchPage(result.url);
        combinedContent += `\n\n--- ${result.title} (${result.url}) ---\n\n`;
        combinedContent += content.slice(0, 2000); // Limit per page
      } catch {
        // Skip pages that fail to fetch
        combinedContent += `\n\n--- ${result.title} ---\n[Failed to fetch]\n`;
      }
    }

    return { results, combinedContent };
  }
}

// Singleton instance
let searchInstance: WebSearch | null = null;

export function getWebSearch(config?: Partial<WebSearchConfig>): WebSearch {
  if (!searchInstance) {
    searchInstance = new WebSearch(config);
  }
  return searchInstance;
}

export function resetWebSearch(): void {
  searchInstance = null;
}
