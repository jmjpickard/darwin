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

export interface DarwinUserConfig {
  repos: RepoConfig[];
  defaults: {
    testCommand: string;
    checkIntervalMs: number;
    maxSessionMinutes: number;
    usageThreshold: number;
  };
}

const DEFAULT_USER_CONFIG: DarwinUserConfig = {
  repos: [],
  defaults: {
    testCommand: 'npm test',
    checkIntervalMs: 5 * 60 * 1000, // 5 minutes
    maxSessionMinutes: 30,
    usageThreshold: 80,
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

  return { repos, defaults };
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
