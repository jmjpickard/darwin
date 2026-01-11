/**
 * Workspace Manager
 *
 * Manages temporary workspace directories for SSH-based repos.
 * Clones repos to ~/.darwin/workspaces/ and cleans up after task completion.
 */

import { mkdir, rm, readdir, stat } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { RepoConfig } from './config.js';
import { Logger } from './logger.js';

const execAsync = promisify(exec);

export interface Workspace {
  id: string;
  workDir: string;
  repo: RepoConfig;
  createdAt: Date;
  status: 'creating' | 'ready' | 'error' | 'cleaning';
}

export class WorkspaceManager {
  private readonly workspacesDir: string;
  private readonly logger: Logger;
  private activeWorkspaces: Map<string, Workspace> = new Map();

  constructor(logger?: Logger) {
    this.workspacesDir = join(homedir(), '.darwin', 'workspaces');
    this.logger = logger || new Logger('WorkspaceManager');
  }

  /**
   * Ensure the workspaces directory exists
   */
  async ensureWorkspacesDir(): Promise<void> {
    await mkdir(this.workspacesDir, { recursive: true });
  }

  /**
   * Create a new workspace for a repo
   */
  async create(repo: RepoConfig): Promise<Workspace> {
    if (!repo.sshUrl) {
      throw new Error(`Cannot create workspace: repo ${repo.name} has no sshUrl`);
    }

    await this.ensureWorkspacesDir();

    const timestamp = Date.now();
    const id = `${repo.name}-${timestamp}`;
    const workDir = join(this.workspacesDir, id);

    const workspace: Workspace = {
      id,
      workDir,
      repo,
      createdAt: new Date(),
      status: 'creating',
    };

    this.activeWorkspaces.set(id, workspace);
    this.logger.info(`Creating workspace: ${id}`);

    try {
      await mkdir(workDir, { recursive: true });

      const branch = repo.defaultBranch || 'main';
      const cloneCmd = `git clone --depth 1 --branch ${branch} ${repo.sshUrl} .`;

      this.logger.debug(`Cloning: ${cloneCmd}`);
      await execAsync(cloneCmd, { cwd: workDir });

      workspace.status = 'ready';
      this.logger.info(`Workspace ready: ${workDir}`);

      return workspace;
    } catch (error) {
      workspace.status = 'error';
      this.logger.error(`Failed to create workspace: ${error}`);
      // Attempt cleanup on failure
      try {
        await rm(workDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
      this.activeWorkspaces.delete(id);
      throw error;
    }
  }

  /**
   * Get the effective path for a repo (workspace path or local path)
   */
  getEffectivePath(repo: RepoConfig): string | undefined {
    // Check if there's an active workspace for this repo
    for (const workspace of this.activeWorkspaces.values()) {
      if (workspace.repo.name === repo.name && workspace.status === 'ready') {
        return workspace.workDir;
      }
    }
    // Fall back to local path
    return repo.path;
  }

  /**
   * Cleanup a specific workspace
   */
  async cleanup(workspace: Workspace): Promise<void> {
    if (!this.activeWorkspaces.has(workspace.id)) {
      this.logger.warn(`Workspace ${workspace.id} not found in active workspaces`);
      return;
    }

    workspace.status = 'cleaning';
    this.logger.info(`Cleaning up workspace: ${workspace.id}`);

    try {
      await rm(workspace.workDir, { recursive: true, force: true });
      this.activeWorkspaces.delete(workspace.id);
      this.logger.info(`Workspace cleaned up: ${workspace.id}`);
    } catch (error) {
      this.logger.error(`Failed to cleanup workspace ${workspace.id}: ${error}`);
      throw error;
    }
  }

  /**
   * Cleanup all active workspaces
   */
  async cleanupAll(): Promise<void> {
    this.logger.info(`Cleaning up ${this.activeWorkspaces.size} active workspaces`);

    const cleanupPromises: Promise<void>[] = [];
    for (const workspace of this.activeWorkspaces.values()) {
      cleanupPromises.push(this.cleanup(workspace));
    }

    await Promise.allSettled(cleanupPromises);
  }

  /**
   * Get all active workspaces
   */
  getActive(): Workspace[] {
    return Array.from(this.activeWorkspaces.values());
  }

  /**
   * Cleanup stale workspaces from previous runs
   * (directories in workspaces dir that aren't tracked)
   */
  async cleanupStale(): Promise<void> {
    try {
      await this.ensureWorkspacesDir();
      const entries = await readdir(this.workspacesDir);

      for (const entry of entries) {
        const entryPath = join(this.workspacesDir, entry);
        const entryStat = await stat(entryPath);

        if (entryStat.isDirectory() && !this.activeWorkspaces.has(entry)) {
          this.logger.info(`Cleaning up stale workspace: ${entry}`);
          try {
            await rm(entryPath, { recursive: true, force: true });
          } catch (error) {
            this.logger.warn(`Failed to cleanup stale workspace ${entry}: ${error}`);
          }
        }
      }
    } catch (error) {
      this.logger.warn(`Failed to scan for stale workspaces: ${error}`);
    }
  }
}
