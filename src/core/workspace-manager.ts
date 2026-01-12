/**
 * WorkspaceManager - Manages temporary workspaces for SSH-based tasks
 *
 * Provides:
 * - Isolated git clone into temp directories
 * - Progress callbacks during clone
 * - Automatic cleanup on completion
 */

import { spawn } from 'child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface Workspace {
  id: string;
  workDir: string;
  repoName: string;
  sshUrl: string;
  createdAt: Date;
  status: 'creating' | 'cloning' | 'ready' | 'in_use' | 'cleaning';
}

export interface CloneProgress {
  phase: 'starting' | 'receiving' | 'resolving' | 'done';
  percent?: number;
  message: string;
}

export type ProgressCallback = (progress: CloneProgress) => void;

export class WorkspaceManager {
  private workspacesDir: string;
  private activeWorkspace: Workspace | null = null;

  constructor() {
    this.workspacesDir = join(homedir(), '.darwin', 'workspaces');
  }

  ensureWorkspacesDir(): void {
    if (!existsSync(this.workspacesDir)) {
      mkdirSync(this.workspacesDir, { recursive: true });
    }
  }

  /**
   * Create a workspace by cloning the repo
   * Now uses spawn for non-blocking clone with progress
   */
  async create(
    repoName: string,
    sshUrl: string,
    defaultBranch?: string,
    onProgress?: ProgressCallback
  ): Promise<Workspace> {
    this.ensureWorkspacesDir();

    const timestamp = Date.now();
    const id = `${repoName}-${timestamp}`;
    const workDir = join(this.workspacesDir, id);

    const workspace: Workspace = {
      id,
      workDir,
      repoName,
      sshUrl,
      createdAt: new Date(),
      status: 'creating',
    };

    const branch = defaultBranch || 'main';

    // Emit starting progress
    onProgress?.({ phase: 'starting', message: `Cloning ${repoName}...` });
    workspace.status = 'cloning';

    // Use spawn instead of execSync for progress visibility
    await this.cloneWithProgress(sshUrl, workDir, branch, onProgress);

    workspace.status = 'ready';
    this.activeWorkspace = workspace;

    onProgress?.({ phase: 'done', percent: 100, message: 'Clone complete' });

    return workspace;
  }

  /**
   * Clone repository with progress reporting
   */
  private cloneWithProgress(
    sshUrl: string,
    workDir: string,
    branch: string,
    onProgress?: ProgressCallback
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // Use --progress to get clone progress output
      const args = ['clone', '--depth', '1', '--branch', branch, '--progress', sshUrl, workDir];
      const proc = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });

      let lastPercent = 0;

      // Git outputs progress to stderr
      proc.stderr?.on('data', (data: Buffer) => {
        const output = data.toString();

        // Parse git progress output
        // Examples:
        //   "Cloning into '/path'..."
        //   "Receiving objects:  42% (123/456)"
        //   "Resolving deltas:  50% (10/20)"

        if (output.includes('Receiving objects')) {
          const match = output.match(/Receiving objects:\s*(\d+)%/);
          if (match) {
            const percent = parseInt(match[1], 10);
            if (percent > lastPercent) {
              lastPercent = percent;
              onProgress?.({
                phase: 'receiving',
                percent,
                message: `Receiving objects: ${percent}%`,
              });
            }
          }
        } else if (output.includes('Resolving deltas')) {
          const match = output.match(/Resolving deltas:\s*(\d+)%/);
          if (match) {
            const percent = parseInt(match[1], 10);
            onProgress?.({
              phase: 'resolving',
              percent,
              message: `Resolving deltas: ${percent}%`,
            });
          }
        } else if (output.includes('Cloning into')) {
          onProgress?.({
            phase: 'starting',
            message: 'Connecting to remote...',
          });
        }
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`git clone exited with code ${code}`));
        }
      });

      proc.on('error', (err) => {
        reject(err);
      });
    });
  }

  async cleanup(workspace: Workspace): Promise<void> {
    workspace.status = 'cleaning';
    if (existsSync(workspace.workDir)) {
      rmSync(workspace.workDir, { recursive: true, force: true });
    }
    if (this.activeWorkspace?.id === workspace.id) {
      this.activeWorkspace = null;
    }
  }

  async cleanupAll(): Promise<void> {
    this.ensureWorkspacesDir();
    const entries = readdirSync(this.workspacesDir);
    for (const entry of entries) {
      const entryPath = join(this.workspacesDir, entry);
      rmSync(entryPath, { recursive: true, force: true });
    }
    this.activeWorkspace = null;
  }

  async cleanupStale(): Promise<void> {
    this.ensureWorkspacesDir();
    const entries = readdirSync(this.workspacesDir);
    for (const entry of entries) {
      const entryPath = join(this.workspacesDir, entry);
      rmSync(entryPath, { recursive: true, force: true });
    }
  }

  getActive(): Workspace | null {
    return this.activeWorkspace;
  }

  getWorkspacesDir(): string {
    return this.workspacesDir;
  }
}
