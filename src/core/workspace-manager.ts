import { execSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface Workspace {
  id: string;
  workDir: string;
  repoName: string;
  sshUrl: string;
  createdAt: Date;
  status: 'creating' | 'ready' | 'in_use' | 'cleaning';
}

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

  async create(repoName: string, sshUrl: string, defaultBranch?: string): Promise<Workspace> {
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
      status: 'creating'
    };

    const branch = defaultBranch || 'main';
    const cloneCmd = `git clone --depth 1 --branch ${branch} ${sshUrl} ${workDir}`;

    execSync(cloneCmd, { stdio: 'pipe' });

    workspace.status = 'ready';
    this.activeWorkspace = workspace;

    return workspace;
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
}
