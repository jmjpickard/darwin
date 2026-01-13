import { spawn, ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { DarwinModule, ModuleConfig } from '../core/module.js';
import { DarwinBrain } from '../core/brain.js';
import { WorkspaceManager, Workspace, CloneProgress } from '../core/workspace-manager.js';
import { RepoConfig } from '../core/config.js';
import { getTaskTracker, TaskTracker, TaskInfo } from '../core/task-tracker.js';

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
  private taskTracker: TaskTracker;

  constructor(brain: DarwinBrain, config: ModuleConfig) {
    super(brain, config);
    this.config = config as CodeAgentConfig;
    this.workspaceManager = new WorkspaceManager();
    this.taskTracker = getTaskTracker();
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
      'Start ralph.sh in the FIRST local repo (legacy mode). For specific repos, use code_start_ssh_task instead.',
      { type: 'object', properties: { maxIterations: { type: 'number', description: 'Max iterations to run' } }, required: [] },
      async (args) => this.startRalph(args.maxIterations as number | undefined)
    );
    this.registerTool(
      'get_status',
      'Check if ralph.sh is running and get recent output',
      { type: 'object', properties: {}, required: [] },
      async () => this.getStatus()
    );
    this.registerTool(
      'stop_prd',
      'Stop the currently running ralph.sh process',
      { type: 'object', properties: {}, required: [] },
      async () => this.stopRalph()
    );
    this.registerTool(
      'list_repos',
      'List all configured repositories with their names and SSH URLs',
      { type: 'object', properties: {}, required: [] },
      async () => ({ repos: this.config.repos || [] })
    );
    this.registerTool(
      'code_start_ssh_task',
      'Start work on a specific repository. Clones via SSH to a temp workspace and runs ralph.sh. Use this when the user mentions a repo name.',
      {
        type: 'object',
        properties: {
          repo: {
            type: 'string',
            description: 'The repository name (e.g. "synapse", "darwin"). Must match a configured repo name.'
          }
        },
        required: ['repo']
      },
      async (args) => this.startSshTask(args.repo as string)
    );
    this.registerTool(
      'get_task_status',
      'Get detailed status of the current task including phase, elapsed time, and progress',
      { type: 'object', properties: {}, required: [] },
      async () => this.getTaskStatus()
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

    // Check if already running
    const currentTask = this.taskTracker.getCurrentTask();
    if (currentTask && (currentTask.phase === 'cloning' || currentTask.phase === 'running')) {
      return {
        success: false,
        message: `Task already in progress: ${currentTask.repoName} (${currentTask.phase})`,
      };
    }

    // Start tracking the task
    const taskInfo = this.taskTracker.startTask(repoName, repo.sshUrl);

    try {
      // Create workspace with progress reporting
      this.taskTracker.setCloning(this.workspaceManager.getWorkspacesDir() + `/${repoName}-...`);

      const onCloneProgress = (progress: CloneProgress) => {
        // Emit progress to output handlers so 'attach' can see it
        const progressLine = `[clone] ${progress.message}`;
        this.outputBuffer.push(progressLine);
        this.outputHandlers.forEach((h) => h(progressLine));
      };

      const workspace = await this.workspaceManager.create(
        repoName,
        repo.sshUrl,
        repo.defaultBranch,
        onCloneProgress
      );
      this.currentWorkspace = workspace;

      // Update tracker with actual workspace path
      this.taskTracker.setStarting();

      // Check if ralph.sh exists
      const ralphPath = join(workspace.workDir, 'ralph.sh');
      if (!existsSync(ralphPath)) {
        await this.workspaceManager.cleanup(workspace);
        this.currentWorkspace = null;
        this.taskTracker.fail('ralph.sh not found in repository');
        return { success: false, message: `ralph.sh not found in ${repoName}` };
      }

      // Run ralph.sh
      this.taskTracker.setRunning();
      this.outputBuffer = []; // Clear buffer for new task

      return new Promise((resolve) => {
        const proc = spawn('bash', ['ralph.sh'], { cwd: workspace.workDir, shell: true });
        this.ralphProcess = proc;

        proc.stdout?.on('data', (data: Buffer) => {
          const line = data.toString();
          this.outputBuffer.push(line);
          if (this.outputBuffer.length > 100) {
            this.outputBuffer.shift();
          }
          this.taskTracker.recordOutput(line);
          this.outputHandlers.forEach((h) => h(line));
        });

        proc.stderr?.on('data', (data: Buffer) => {
          const line = data.toString();
          this.outputBuffer.push(line);
          if (this.outputBuffer.length > 100) {
            this.outputBuffer.shift();
          }
          this.taskTracker.recordOutput(line);
          this.outputHandlers.forEach((h) => h(line));
        });

        proc.on('close', async (code) => {
          this.ralphProcess = null;

          // Mark task completion/failure
          if (code === 0) {
            this.taskTracker.complete(code);
            // Only cleanup workspace on SUCCESS - preserve on failure for investigation
            if (this.currentWorkspace) {
              await this.workspaceManager.cleanup(this.currentWorkspace);
              this.currentWorkspace = null;
            }
          } else {
            this.taskTracker.fail(`Process exited with code ${code}`, code ?? undefined);
            // DON'T cleanup on failure - keep workspace for Darwin to investigate
            // Workspace path is preserved in the task tracker
            this.currentWorkspace = null;
          }

          resolve({
            success: code === 0,
            message: code === 0 ? 'Task completed successfully' : `Task exited with code ${code}`,
            workDir: workspace.workDir,
          });
        });

        proc.on('error', async (err) => {
          this.ralphProcess = null;
          this.taskTracker.fail(`Process error: ${err.message}`);
          // DON'T cleanup on error - keep workspace for investigation
          this.currentWorkspace = null;

          resolve({
            success: false,
            message: `Failed to run ralph.sh: ${err.message}`,
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
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.taskTracker.fail(errorMsg);
      return { success: false, message: `Failed to start SSH task: ${errorMsg}` };
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
    const task = this.taskTracker.getCurrentTask();
    if (task && (task.phase === 'cloning' || task.phase === 'running' || task.phase === 'starting')) {
      return { taskId: task.id };
    }
    if (this.ralphProcess) {
      return { taskId: 'ralph' };
    }
    return null;
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

  /**
   * Get the task tracker for external access
   */
  getTaskTracker(): TaskTracker {
    return this.taskTracker;
  }

  /**
   * Get detailed task status
   */
  private getTaskStatus(): {
    hasTask: boolean;
    task?: ReturnType<TaskTracker['getSummary']>;
    formatted: string;
    compact: string;
  } {
    const task = this.taskTracker.getSummary();
    return {
      hasTask: !!task,
      task: task ?? undefined,
      formatted: this.taskTracker.formatStatus(),
      compact: this.taskTracker.formatCompact(),
    };
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

  private getStatus(): { running: boolean; buffer: string[]; task?: ReturnType<TaskTracker['getSummary']> } {
    return {
      running: !!this.ralphProcess || !!this.taskTracker.getCurrentTask(),
      buffer: this.outputBuffer.slice(-20),
      task: this.taskTracker.getSummary() ?? undefined,
    };
  }

  private stopRalph(): { stopped: boolean; reason?: string } {
    if (this.ralphProcess) {
      this.ralphProcess.kill();
      this.ralphProcess = null;
      const currentTask = this.taskTracker.getCurrentTask();
      if (currentTask) {
        this.taskTracker.fail('Stopped by user');
      }
      return { stopped: true };
    }
    return { stopped: false, reason: 'not running' };
  }
}
