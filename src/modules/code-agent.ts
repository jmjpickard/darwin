import { spawn, ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { DarwinModule, ModuleConfig } from '../core/module.js';
import { DarwinBrain } from '../core/brain.js';
import { WorkspaceManager, Workspace } from '../core/workspace-manager.js';
import { RepoConfig } from '../core/config.js';

interface CodeAgentConfig extends ModuleConfig {
  repos?: RepoConfig[];
}

export class CodeAgentModule extends DarwinModule {
  readonly name = 'code-agent';
  readonly description = 'Spawns ralph.sh for PRD execution';

  private ralphProcess: ChildProcess | null = null;
  private outputBuffer: string[] = [];
  private outputHandlers = new Set<(line: string) => void>();
  private pauseCheck: (() => boolean) | null = null;
  protected config: CodeAgentConfig;
  public workspaceManager: WorkspaceManager;
  private currentWorkspace: Workspace | null = null;

  constructor(brain: DarwinBrain, config: ModuleConfig) {
    super(brain, config);
    this.config = config as CodeAgentConfig;
    this.workspaceManager = new WorkspaceManager();
  }

  private getRepoPath(repo: RepoConfig): string {
    if (this.currentWorkspace && this.currentWorkspace.repoName === repo.name) {
      return this.currentWorkspace.workDir;
    }
    return repo.path;
  }

  async init(): Promise<void> {
    this.registerTool(
      'start_prd',
      'Start ralph.sh to work through PRD items',
      { type: 'object', properties: { maxIterations: { type: 'number' } }, required: [] },
      async (args) => this.startRalph(args.maxIterations as number | undefined)
    );
    this.registerTool(
      'get_status',
      'Get ralph.sh status and recent output',
      { type: 'object', properties: {}, required: [] },
      async () => this.getStatus()
    );
    this.registerTool(
      'stop_prd',
      'Stop ralph.sh process',
      { type: 'object', properties: {}, required: [] },
      async () => this.stopRalph()
    );
    this.registerTool(
      'list_repos',
      'List configured repositories',
      { type: 'object', properties: {}, required: [] },
      async () => ({ repos: this.config.repos || [] })
    );
    this.registerTool(
      'code_start_ssh_task',
      'Clone a repo via SSH and run ralph.sh in it',
      { type: 'object', properties: { repo: { type: 'string' } }, required: ['repo'] },
      async (args) => this.startSshTask(args.repo as string)
    );
    this._healthy = true;
  }

  private async startSshTask(repoName: string): Promise<{ success: boolean; message: string; workDir?: string }> {
    // Find repo by name
    const repo = this.config.repos?.find((r) => r.name === repoName);
    if (!repo) {
      return { success: false, message: `Repo '${repoName}' not found in configuration` };
    }

    // Validate it has sshUrl
    if (!repo.sshUrl) {
      return { success: false, message: `Repo '${repoName}' does not have sshUrl configured` };
    }

    try {
      // Create workspace
      const workspace = await this.workspaceManager.create(repoName, repo.sshUrl, repo.defaultBranch);
      this.currentWorkspace = workspace;

      // Check if ralph.sh exists
      const ralphPath = join(workspace.workDir, 'ralph.sh');
      if (!existsSync(ralphPath)) {
        await this.workspaceManager.cleanup(workspace);
        this.currentWorkspace = null;
        return { success: false, message: `ralph.sh not found in ${repoName}` };
      }

      // Run ralph.sh
      return new Promise((resolve) => {
        const proc = spawn('bash', ['ralph.sh'], { cwd: workspace.workDir, shell: true });

        proc.stdout?.on('data', (data: Buffer) => {
          const line = data.toString();
          this.outputBuffer.push(line);
          this.outputHandlers.forEach((h) => h(line));
        });

        proc.stderr?.on('data', (data: Buffer) => {
          const line = data.toString();
          this.outputBuffer.push(line);
          this.outputHandlers.forEach((h) => h(line));
        });

        proc.on('close', async (code) => {
          // Cleanup workspace on completion
          if (this.currentWorkspace) {
            await this.workspaceManager.cleanup(this.currentWorkspace);
            this.currentWorkspace = null;
          }
          resolve({
            success: code === 0,
            message: code === 0 ? 'Task completed successfully' : `Task exited with code ${code}`,
            workDir: workspace.workDir,
          });
        });
      });
    } catch (err) {
      // Cleanup on error
      if (this.currentWorkspace) {
        await this.workspaceManager.cleanup(this.currentWorkspace);
        this.currentWorkspace = null;
      }
      return { success: false, message: `Failed to start SSH task: ${err}` };
    }
  }

  async start(): Promise<void> {
    this._status = 'running';
  }

  async stop(): Promise<void> {
    this.stopRalph();
    this._status = 'stopped';
  }

  // Methods required by repl.ts
  setPauseCheck(fn: () => boolean): void {
    this.pauseCheck = fn;
  }

  getCurrentSession(): { taskId: string } | null {
    return this.ralphProcess ? { taskId: 'ralph' } : null;
  }

  getOutputBuffer(): string[] {
    return [...this.outputBuffer];
  }

  onOutput(handler: (line: string) => void): void {
    this.outputHandlers.add(handler);
  }

  offOutput(handler: (line: string) => void): void {
    this.outputHandlers.delete(handler);
  }

  private startRalph(maxIterations?: number): { started: boolean; cwd: string } | { error: string } {
    if (this.ralphProcess) {
      return { error: 'Ralph is already running' };
    }

    const cwd = this.config.repos?.[0]?.path || process.cwd();
    const args = maxIterations ? [String(maxIterations)] : [];

    this.ralphProcess = spawn('./ralph.sh', args, { cwd, shell: true });
    this.outputBuffer = [];

    this.ralphProcess.stdout?.on('data', (data: Buffer) => {
      const line = data.toString();
      this.outputBuffer.push(line);
      this.outputHandlers.forEach((h) => h(line));
    });

    this.ralphProcess.stderr?.on('data', (data: Buffer) => {
      const line = data.toString();
      this.outputBuffer.push(line);
      this.outputHandlers.forEach((h) => h(line));
    });

    this.ralphProcess.on('close', () => {
      this.ralphProcess = null;
    });

    return { started: true, cwd };
  }

  private getStatus(): { running: boolean; buffer: string[] } {
    return {
      running: !!this.ralphProcess,
      buffer: this.outputBuffer.slice(-20),
    };
  }

  private stopRalph(): { stopped: boolean; reason?: string } {
    if (this.ralphProcess) {
      this.ralphProcess.kill();
      this.ralphProcess = null;
      return { stopped: true };
    }
    return { stopped: false, reason: 'not running' };
  }
}
