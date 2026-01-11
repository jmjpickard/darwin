/**
 * Darwin Configuration System
 *
 * Loads and validates configuration from ~/.darwin/config.json
 */

import { readFile, writeFile, mkdir, access } from 'fs/promises';
import { homedir } from 'os';
import { join, basename } from 'path';

export interface RepoConfig {
  path?: string; // Local filesystem path (optional if sshUrl is provided)
  name: string; // Display name (required)
  enabled: boolean;
  testCommand?: string; // Override default test command
  typecheckCommand?: string; // Override default typecheck command
  sshUrl?: string; // SSH clone URL (e.g. 'git@github.com:user/repo.git')
  defaultBranch?: string; // Default branch to clone/checkout (default: 'main')
  description?: string; // Context for Brain/prompts about this repo
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

export interface CodeAgentUserConfig {
  /** Default agent backend (claude or codex) */
  agent?: 'claude' | 'codex';
  /** Override CLI commands */
  agentCommands?: {
    claude?: { command: string; args?: string[] };
    codex?: { command: string; args?: string[] };
  };
}

export interface GitSyncUserConfig {
  /** Enable automatic git pull for repos (default: false) */
  enabled?: boolean;
  /** Interval between git pulls in ms (default: 300000 = 5 minutes) */
  intervalMs?: number;
  /** Only sync repos that have prd.json (default: true) */
  prdReposOnly?: boolean;
  /** Auto-stash local changes before pull (default: false) */
  autoStash?: boolean;
}

export interface DarwinUserConfig {
  repos: RepoConfig[];
  defaults: {
    testCommand: string;
    typecheckCommand: string;
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
  /** Code agent configuration */
  codeAgent?: CodeAgentUserConfig;
  /** Git sync configuration */
  gitSync?: GitSyncUserConfig;
}

const DEFAULT_USER_CONFIG: DarwinUserConfig = {
  repos: [],
  defaults: {
    testCommand: 'npm test',
    typecheckCommand: 'npm run build',
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
      typecheckCommand: 'npm run build',
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
    codeAgent: {
      agent: 'claude',
      agentCommands: {
        claude: { command: 'claude' },
        codex: { command: 'codex' },
      },
    },
    gitSync: {
      enabled: false,
      intervalMs: 300000, // 5 minutes
      prdReposOnly: true,
      autoStash: false,
    },
  };

  const content = JSON.stringify(template, null, 2);
  await writeFile(getConfigPath(), content, 'utf-8');
}

/**
 * Extract repo name from SSH URL
 * e.g. 'git@github.com:user/synapse.git' -> 'synapse'
 */
function extractRepoNameFromSshUrl(sshUrl: string): string {
  // Match patterns like git@github.com:user/repo.git or ssh://git@host/user/repo.git
  const match = sshUrl.match(/\/([^/]+?)(?:\.git)?$/);
  return match ? match[1] : sshUrl;
}

/**
 * Validate and normalize a repo config
 */
function normalizeRepoConfig(repo: Partial<RepoConfig>, index: number): RepoConfig {
  // Require at least one of path or sshUrl
  const hasPath = repo.path && typeof repo.path === 'string';
  const hasSshUrl = repo.sshUrl && typeof repo.sshUrl === 'string';

  if (!hasPath && !hasSshUrl) {
    throw new Error(`repos[${index}] must have either 'path' or 'sshUrl' set`);
  }

  // Derive name: explicit name > extract from sshUrl > basename of path
  let name: string;
  if (repo.name && typeof repo.name === 'string') {
    name = repo.name;
  } else if (hasSshUrl) {
    name = extractRepoNameFromSshUrl(repo.sshUrl!);
  } else if (hasPath) {
    name = basename(repo.path!);
  } else {
    throw new Error(`repos[${index}].name could not be determined`);
  }

  return {
    path: hasPath ? repo.path : undefined,
    name,
    enabled: repo.enabled !== false,
    testCommand: repo.testCommand,
    typecheckCommand: repo.typecheckCommand,
    sshUrl: hasSshUrl ? repo.sshUrl : undefined,
    defaultBranch: repo.defaultBranch || 'main',
    description: repo.description,
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
    if (typeof d.typecheckCommand === 'string') defaults.typecheckCommand = d.typecheckCommand;
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

  // Validate code agent config
  let codeAgent: CodeAgentUserConfig | undefined;
  if (cfg.codeAgent && typeof cfg.codeAgent === 'object') {
    const c = cfg.codeAgent as Record<string, unknown>;
    const agent = c.agent === 'codex' ? 'codex' : c.agent === 'claude' ? 'claude' : undefined;
    const commands = c.agentCommands && typeof c.agentCommands === 'object'
      ? (c.agentCommands as Record<string, unknown>)
      : undefined;

    const claudeCommand = commands?.claude && typeof commands.claude === 'object'
      ? (commands.claude as Record<string, unknown>)
      : undefined;
    const codexCommand = commands?.codex && typeof commands.codex === 'object'
      ? (commands.codex as Record<string, unknown>)
      : undefined;

    codeAgent = {
      agent,
      agentCommands: {
        claude: {
          command: typeof claudeCommand?.command === 'string' ? claudeCommand.command : 'claude',
          args: Array.isArray(claudeCommand?.args) ? (claudeCommand!.args as string[]) : undefined,
        },
        codex: {
          command: typeof codexCommand?.command === 'string' ? codexCommand.command : 'codex',
          args: Array.isArray(codexCommand?.args) ? (codexCommand!.args as string[]) : undefined,
        },
      },
    };
  }

  // Validate gitSync config
  let gitSync: GitSyncUserConfig | undefined;
  if (cfg.gitSync && typeof cfg.gitSync === 'object') {
    const g = cfg.gitSync as Record<string, unknown>;
    gitSync = {
      enabled: typeof g.enabled === 'boolean' ? g.enabled : undefined,
      intervalMs: typeof g.intervalMs === 'number' ? g.intervalMs : undefined,
      prdReposOnly: typeof g.prdReposOnly === 'boolean' ? g.prdReposOnly : undefined,
      autoStash: typeof g.autoStash === 'boolean' ? g.autoStash : undefined,
    };
  }

  return { repos, defaults, brain, consciousness, openrouter, webSearch, codeAgent, gitSync };
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
