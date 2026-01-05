/**
 * Darwin Configuration System
 *
 * Loads and validates configuration from ~/.darwin/config.json
 */

import { readFile, writeFile, mkdir, access } from 'fs/promises';
import { homedir } from 'os';
import { join, basename } from 'path';

export interface RepoConfig {
  path: string;
  name?: string; // Display name, defaults to directory name
  enabled: boolean;
  testCommand?: string; // Override default test command
}

export interface ConsciousnessUserConfig {
  /** How often to "think" in ms (default: 30000) */
  tickIntervalMs?: number;
  /** Emit idle thoughts when nothing happening */
  idleThinkingEnabled?: boolean;
}

export interface BrainUserConfig {
  /** Brain provider (ollama or openrouter) */
  provider?: 'ollama' | 'openrouter';
  /** Model name for the selected provider */
  model?: string;
  /** Timeout for brain requests in ms */
  timeoutMs?: number;
}

export interface OpenRouterUserConfig {
  /** OpenRouter API key */
  apiKey?: string;
  /** Default model (default: deepseek/deepseek-r1) */
  defaultModel?: string;
}

export interface WebSearchUserConfig {
  /** Enable web search (default: true) */
  enabled?: boolean;
  /** Maximum results per search (default: 5) */
  maxResults?: number;
}

export interface DarwinUserConfig {
  repos: RepoConfig[];
  defaults: {
    testCommand: string;
    checkIntervalMs: number;
    maxSessionMinutes: number;
    usageThreshold: number;
  };
  /** Brain model/provider configuration */
  brain?: BrainUserConfig;
  /** Consciousness loop configuration */
  consciousness?: ConsciousnessUserConfig;
  /** OpenRouter configuration for frontier model access */
  openrouter?: OpenRouterUserConfig;
  /** Web search configuration */
  webSearch?: WebSearchUserConfig;
}

const DEFAULT_USER_CONFIG: DarwinUserConfig = {
  repos: [],
  defaults: {
    testCommand: 'npm test',
    checkIntervalMs: 5 * 60 * 1000, // 5 minutes
    maxSessionMinutes: 30,
    usageThreshold: 80,
  },
  brain: {
    provider: 'ollama',
    model: 'llama3.2:1b',
    timeoutMs: 60_000,
  },
};

/**
 * Get the Darwin config directory path
 */
export function getConfigDir(): string {
  return process.env.DARWIN_CONFIG_DIR || join(homedir(), '.darwin');
}

/**
 * Get the config file path
 */
export function getConfigPath(): string {
  return join(getConfigDir(), 'config.json');
}

/**
 * Ensure the config directory exists
 */
export async function ensureConfigDir(): Promise<void> {
  const dir = getConfigDir();
  try {
    await access(dir);
  } catch {
    await mkdir(dir, { recursive: true });
  }
}

/**
 * Check if config file exists
 */
export async function configExists(): Promise<boolean> {
  try {
    await access(getConfigPath());
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a template config file
 */
export async function createTemplateConfig(): Promise<void> {
  await ensureConfigDir();

  const template: DarwinUserConfig = {
    repos: [
      {
        path: '/path/to/your/project',
        name: 'my-project',
        enabled: true,
      },
    ],
    defaults: {
      testCommand: 'npm test',
      checkIntervalMs: 300000,
      maxSessionMinutes: 30,
      usageThreshold: 80,
    },
    brain: {
      provider: 'ollama',
      model: 'llama3.2:1b',
      timeoutMs: 60_000,
    },
    consciousness: {
      tickIntervalMs: 30000,
      idleThinkingEnabled: true,
    },
    openrouter: {
      apiKey: '', // Set your OpenRouter API key here
      defaultModel: 'deepseek/deepseek-r1',
    },
    webSearch: {
      enabled: true,
      maxResults: 5,
    },
  };

  const content = JSON.stringify(template, null, 2);
  await writeFile(getConfigPath(), content, 'utf-8');
}

/**
 * Validate and normalize a repo config
 */
function normalizeRepoConfig(repo: Partial<RepoConfig>, index: number): RepoConfig {
  if (!repo.path || typeof repo.path !== 'string') {
    throw new Error(`repos[${index}].path is required and must be a string`);
  }

  return {
    path: repo.path,
    name: repo.name || basename(repo.path),
    enabled: repo.enabled !== false,
    testCommand: repo.testCommand,
  };
}

/**
 * Validate the config structure
 */
function validateConfig(config: unknown): DarwinUserConfig {
  if (!config || typeof config !== 'object') {
    throw new Error('Config must be an object');
  }

  const cfg = config as Record<string, unknown>;

  // Validate repos
  if (!Array.isArray(cfg.repos)) {
    throw new Error('repos must be an array');
  }

  const repos = cfg.repos.map((repo, i) => normalizeRepoConfig(repo as Partial<RepoConfig>, i));

  // Validate defaults
  const defaults = { ...DEFAULT_USER_CONFIG.defaults };
  if (cfg.defaults && typeof cfg.defaults === 'object') {
    const d = cfg.defaults as Record<string, unknown>;
    if (typeof d.testCommand === 'string') defaults.testCommand = d.testCommand;
    if (typeof d.checkIntervalMs === 'number') defaults.checkIntervalMs = d.checkIntervalMs;
    if (typeof d.maxSessionMinutes === 'number') defaults.maxSessionMinutes = d.maxSessionMinutes;
    if (typeof d.usageThreshold === 'number') defaults.usageThreshold = d.usageThreshold;
  }

  // Validate consciousness config
  let consciousness: ConsciousnessUserConfig | undefined;
  if (cfg.consciousness && typeof cfg.consciousness === 'object') {
    const c = cfg.consciousness as Record<string, unknown>;
    consciousness = {
      tickIntervalMs: typeof c.tickIntervalMs === 'number' ? c.tickIntervalMs : undefined,
      idleThinkingEnabled: typeof c.idleThinkingEnabled === 'boolean' ? c.idleThinkingEnabled : undefined,
    };
  }

  // Validate brain config
  let brain: BrainUserConfig | undefined;
  if (cfg.brain && typeof cfg.brain === 'object') {
    const b = cfg.brain as Record<string, unknown>;
    const provider = b.provider === 'openrouter' ? 'openrouter' : b.provider === 'ollama' ? 'ollama' : undefined;
    brain = {
      provider,
      model: typeof b.model === 'string' ? b.model : undefined,
      timeoutMs: typeof b.timeoutMs === 'number' ? b.timeoutMs : undefined,
    };
  }

  // Validate openrouter config
  let openrouter: OpenRouterUserConfig | undefined;
  if (cfg.openrouter && typeof cfg.openrouter === 'object') {
    const o = cfg.openrouter as Record<string, unknown>;
    openrouter = {
      apiKey: typeof o.apiKey === 'string' ? o.apiKey : undefined,
      defaultModel: typeof o.defaultModel === 'string' ? o.defaultModel : undefined,
    };
  }

  // Validate webSearch config
  let webSearch: WebSearchUserConfig | undefined;
  if (cfg.webSearch && typeof cfg.webSearch === 'object') {
    const w = cfg.webSearch as Record<string, unknown>;
    webSearch = {
      enabled: typeof w.enabled === 'boolean' ? w.enabled : undefined,
      maxResults: typeof w.maxResults === 'number' ? w.maxResults : undefined,
    };
  }

  return { repos, defaults, brain, consciousness, openrouter, webSearch };
}

/**
 * Load configuration from file
 *
 * If config doesn't exist, creates a template and returns empty repos
 */
export async function loadConfig(configPath?: string): Promise<DarwinUserConfig> {
  const path = configPath || getConfigPath();

  try {
    await access(path);
  } catch {
    // Config doesn't exist, create template
    await createTemplateConfig();
    console.log(`Created config template at ${getConfigPath()}`);
    console.log('Edit this file to add your repositories, then restart Darwin.\n');
    return { ...DEFAULT_USER_CONFIG };
  }

  try {
    const content = await readFile(path, 'utf-8');
    const parsed = JSON.parse(content);
    return validateConfig(parsed);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in config file: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Get enabled repos from config
 */
export function getEnabledRepos(config: DarwinUserConfig): RepoConfig[] {
  return config.repos.filter((r) => r.enabled);
}
