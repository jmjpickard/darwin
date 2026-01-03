/**
 * Code Agent Module - Orchestrates Claude Code with Beads task management
 *
 * Registers tools:
 * - code_get_ready_tasks: Get tasks ready to work on
 * - code_start_task: Start Claude working on a task
 * - code_get_status: Get current agent status
 * - code_stop_task: Stop current task
 */

import { spawn, ChildProcess } from 'child_process';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as readline from 'readline';
import { DarwinModule, ModuleConfig } from '../core/module.js';
import { DarwinBrain } from '../core/brain.js';
import { eventBus } from '../core/event-bus.js';

const execAsync = promisify(exec);

interface CodeAgentConfig extends ModuleConfig {
  repoPath: string;
  checkIntervalMs: number;
  maxSessionMinutes: number;
  usageThreshold: number;
  testCommand: string;
  autoStart: boolean;
}

interface BeadTask {
  id: string;
  title: string;
  description?: string;
  status: string;
  priority: number;
  type: string;
}

interface ClaudeSession {
  taskId: string;
  claudeProcess: ChildProcess;
  startedAt: Date;
  outputBuffer: string[];
}

const DEFAULT_CONFIG: CodeAgentConfig = {
  enabled: true,
  repoPath: process.cwd(),
  checkIntervalMs: 5 * 60 * 1000,
  maxSessionMinutes: 30,
  usageThreshold: 80,
  testCommand: 'npm test',
  autoStart: false,
};

export class CodeAgentModule extends DarwinModule {
  readonly name = 'CodeAgent';
  readonly description = 'Orchestrates Claude Code with Beads task management';

  protected override config: CodeAgentConfig;
  private currentSession: ClaudeSession | null = null;
  private checkInterval: NodeJS.Timeout | null = null;
  private sessionTimeout: NodeJS.Timeout | null = null;

  constructor(brain: DarwinBrain, config: ModuleConfig) {
    super(brain, config);
    this.config = { ...DEFAULT_CONFIG, ...config } as CodeAgentConfig;
  }

  async init(): Promise<void> {
    this.logger.info(`Repository: ${this.config.repoPath}`);

    // Register tools with Brain
    this.registerTools();

    this._healthy = true;
  }

  async start(): Promise<void> {
    this._enabled = true;

    if (this.config.autoStart) {
      this.startCheckLoop();
    }

    eventBus.publish('code', 'module_started', { repoPath: this.config.repoPath });
  }

  async stop(): Promise<void> {
    this._enabled = false;

    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }

    if (this.currentSession) {
      await this.stopCurrentSession();
    }

    eventBus.publish('code', 'module_stopped', {});
  }

  private registerTools(): void {
    // Get ready tasks from Beads
    this.registerTool(
      'code_get_ready_tasks',
      'Get list of tasks ready to work on from Beads',
      {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max tasks to return' },
        },
      },
      async (args) => {
        const limit = (args.limit as number) || 5;
        return this.getReadyTasks(limit);
      }
    );

    // Start working on a task
    this.registerTool(
      'code_start_task',
      'Start Claude Code working on a specific Beads task',
      {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'The Beads task ID (e.g., bd-a1b2)' },
        },
        required: ['taskId'],
      },
      async (args) => {
        const taskId = args.taskId as string;
        return this.startTask(taskId);
      }
    );

    // Get current status
    this.registerTool(
      'code_get_status',
      'Get current Code Agent status including Claude usage and active task',
      {
        type: 'object',
        properties: {},
      },
      async () => this.getAgentStatus()
    );

    // Stop current task
    this.registerTool(
      'code_stop_task',
      'Stop the currently running Claude Code session',
      {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Reason for stopping' },
        },
      },
      async (args) => {
        const reason = (args.reason as string) || 'Stopped by Brain';
        return this.stopCurrentSession(reason);
      }
    );

    // Check Claude usage
    this.registerTool(
      'code_check_capacity',
      'Check if Claude Code has available capacity',
      {
        type: 'object',
        properties: {},
      },
      async () => this.checkClaudeCapacity()
    );
  }

  /**
   * Start the automatic check loop
   */
  private startCheckLoop(): void {
    this.checkInterval = setInterval(async () => {
      await this.checkAndExecute();
    }, this.config.checkIntervalMs);

    // Also run immediately
    this.checkAndExecute();
  }

  /**
   * Check capacity and start a task if available
   */
  private async checkAndExecute(): Promise<void> {
    if (this.currentSession) {
      this.logger.debug('Session already active');
      return;
    }

    const capacity = await this.checkClaudeCapacity();
    if (!capacity.available) {
      this.logger.debug(`Claude at ${capacity.utilization}% - waiting`);
      return;
    }

    const tasks = await this.getReadyTasks(1);
    if (tasks.length === 0) {
      this.logger.debug('No ready tasks');
      return;
    }

    await this.startTask(tasks[0].id);
  }

  /**
   * Get ready tasks from Beads
   */
  private async getReadyTasks(limit: number): Promise<BeadTask[]> {
    try {
      const { stdout } = await execAsync('bd ready --json', {
        cwd: this.config.repoPath,
      });
      const result = JSON.parse(stdout);
      return (result.issues || []).slice(0, limit);
    } catch (error) {
      this.logger.error('Failed to get ready tasks:', error);
      return [];
    }
  }

  /**
   * Start Claude working on a task
   */
  private async startTask(taskId: string): Promise<{ success: boolean; message: string }> {
    if (this.currentSession) {
      return { success: false, message: 'Session already active' };
    }

    // Get task details
    let task: BeadTask;
    try {
      const { stdout } = await execAsync(`bd show ${taskId} --json`, {
        cwd: this.config.repoPath,
      });
      task = JSON.parse(stdout);
    } catch {
      return { success: false, message: `Task ${taskId} not found` };
    }

    this.logger.info(`Starting task: ${taskId} - ${task.title}`);

    // Create feature branch
    const branchName = await this.createBranch(taskId, task.title);

    // Update Beads status
    await this.updateTaskStatus(taskId, 'in_progress');

    // Generate prompt
    const prompt = await this.generatePrompt(task);

    // Spawn Claude (fixed: renamed from 'process' to 'claudeProcess')
    const claudeProcess = spawn('claude', ['--print', '-p', prompt], {
      cwd: this.config.repoPath,
      env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.currentSession = {
      taskId,
      claudeProcess,
      startedAt: new Date(),
      outputBuffer: [],
    };

    // Set session timeout
    this.sessionTimeout = setTimeout(() => {
      this.logger.warn(`Session timeout for ${taskId}`);
      this.stopCurrentSession('Timeout');
    }, this.config.maxSessionMinutes * 60 * 1000);

    // Handle output
    this.setupOutputHandlers(task);

    eventBus.publish('code', 'task_started', { taskId, title: task.title, branch: branchName });

    return { success: true, message: `Started ${taskId} on branch ${branchName}` };
  }

  /**
   * Set up stdout/stderr handlers for Claude process
   */
  private setupOutputHandlers(task: BeadTask): void {
    if (!this.currentSession) return;

    const { claudeProcess } = this.currentSession;

    if (claudeProcess.stdout) {
      const rl = readline.createInterface({ input: claudeProcess.stdout });
      rl.on('line', async (line) => {
        this.currentSession?.outputBuffer.push(line);
        this.touch();

        // Detect questions
        if (this.isQuestion(line)) {
          const answer = await this.handleQuestion(line, task);
          claudeProcess.stdin?.write(answer + '\n');
        }
      });
    }

    if (claudeProcess.stderr) {
      const rl = readline.createInterface({ input: claudeProcess.stderr });
      rl.on('line', (line) => {
        this.currentSession?.outputBuffer.push(`[stderr] ${line}`);
        if (line.toLowerCase().includes('error')) {
          this.logger.warn(`Claude error: ${line}`);
        }
      });
    }

    claudeProcess.on('exit', async (code) => {
      const session = this.currentSession;
      if (!session) return;

      if (this.sessionTimeout) {
        clearTimeout(this.sessionTimeout);
        this.sessionTimeout = null;
      }

      if (code === 0) {
        await this.handleTaskSuccess(task);
      } else {
        await this.handleTaskFailure(task, `Exit code: ${code}`);
      }

      this.currentSession = null;
    });
  }

  /**
   * Check if a line is a question from Claude
   */
  private isQuestion(line: string): boolean {
    const patterns = [
      /\?\s*\[y\/n\]/i,
      /proceed\?/i,
      /continue\?/i,
      /apply.*\?/i,
      /create.*\?/i,
      /should I/i,
    ];
    return patterns.some(p => p.test(line));
  }

  /**
   * Handle a question from Claude
   */
  private async handleQuestion(question: string, task: BeadTask): Promise<string> {
    // Safety checks first
    const safety = this.checkSafety(question);
    if (safety) {
      this.logger.info(`Safety rule: ${safety.reason}`);
      return safety.response;
    }

    // Simple patterns - don't need AI
    if (question.match(/run.*test/i)) return 'y';
    if (question.match(/create.*file/i)) return 'y';
    if (question.match(/apply.*changes/i)) return 'y';

    // Ask Brain (uses FunctionGemma's decide)
    const shouldApprove = await this.brain.decide(
      `Claude Code is working on "${task.title}" and asks: "${question}". Should we approve?`
    );

    const answer = shouldApprove ? 'y' : 'n';
    this.logger.info(`Brain decides: ${answer} for "${question.slice(0, 50)}..."`);
    return answer;
  }

  /**
   * Hardcoded safety rules
   */
  private checkSafety(question: string): { response: string; reason: string } | null {
    const lower = question.toLowerCase();

    if (lower.includes('rm -rf') || lower.includes('rmdir')) {
      return { response: 'n', reason: 'Dangerous delete' };
    }
    if (lower.includes('drop table') || lower.includes('delete from')) {
      return { response: 'n', reason: 'Dangerous database op' };
    }
    if (lower.includes('--force') && lower.includes('push')) {
      return { response: 'n', reason: 'Force push blocked' };
    }
    if (lower.includes('sudo')) {
      return { response: 'n', reason: 'Privilege escalation blocked' };
    }

    return null;
  }

  /**
   * Handle successful task completion
   */
  private async handleTaskSuccess(task: BeadTask): Promise<void> {
    this.logger.info(`Task ${task.id} completed`);

    // Run tests
    const testResult = await this.runTests();

    if (!testResult.passed) {
      await this.handleTaskFailure(task, `Tests failed: ${testResult.output.slice(0, 200)}`);
      return;
    }

    // Commit and push
    const commitMsg = await this.generateCommitMessage(task);
    await execAsync(`git add -A && git commit -m "${commitMsg}"`, { cwd: this.config.repoPath });

    const branch = await this.getCurrentBranch();
    await execAsync(`git push -u origin ${branch}`, { cwd: this.config.repoPath });

    // Create PR
    const prUrl = await this.createPR(task);

    // Close Beads task
    await execAsync(`bd close ${task.id} --reason "PR: ${prUrl}"`, { cwd: this.config.repoPath });

    eventBus.publish('code', 'task_completed', { taskId: task.id, prUrl });
  }

  /**
   * Handle task failure
   */
  private async handleTaskFailure(task: BeadTask, error: string): Promise<void> {
    this.logger.error(`Task ${task.id} failed: ${error}`);

    // Rollback changes
    await execAsync('git reset --hard HEAD && git clean -fd', { cwd: this.config.repoPath }).catch(() => {});

    // Update Beads
    await execAsync(
      `bd update ${task.id} --status blocked --notes "${error.replace(/"/g, '\\"').slice(0, 200)}"`,
      { cwd: this.config.repoPath }
    ).catch(() => {});

    eventBus.publish('code', 'task_failed', { taskId: task.id, error });
  }

  /**
   * Stop current session
   */
  private async stopCurrentSession(reason?: string): Promise<{ success: boolean }> {
    if (!this.currentSession) {
      return { success: false };
    }

    const { claudeProcess, taskId } = this.currentSession;

    claudeProcess.stdin?.write('/exit\n');
    claudeProcess.stdin?.end();

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (!claudeProcess.killed) claudeProcess.kill('SIGTERM');
        resolve();
      }, 3000);

      claudeProcess.on('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    if (this.sessionTimeout) {
      clearTimeout(this.sessionTimeout);
      this.sessionTimeout = null;
    }

    this.currentSession = null;

    eventBus.publish('code', 'task_stopped', { taskId, reason });
    return { success: true };
  }

  /**
   * Check Claude Code capacity
   */
  private async checkClaudeCapacity(): Promise<{ available: boolean; utilization: number; resetsAt?: string }> {
    try {
      // Get OAuth token from keychain
      const { stdout: tokenJson } = await execAsync(
        'security find-generic-password -s "Claude Code-credentials" -w'
      );
      const creds = JSON.parse(tokenJson.trim());
      const token = creds.claudeAiOauth?.accessToken;

      if (!token) {
        return { available: true, utilization: 0 }; // Assume available if can't check
      }

      const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
        },
      });

      if (!response.ok) {
        return { available: true, utilization: 0 };
      }

      const data = await response.json() as {
        five_hour?: { utilization: number; resets_at: string }
      };

      const utilization = data.five_hour?.utilization ?? 0;
      return {
        available: utilization < this.config.usageThreshold,
        utilization,
        resetsAt: data.five_hour?.resets_at,
      };
    } catch {
      return { available: true, utilization: 0 };
    }
  }

  /**
   * Get current agent status
   */
  private async getAgentStatus(): Promise<{
    activeTask: string | null;
    capacity: { available: boolean; utilization: number };
    readyTasks: number;
  }> {
    const capacity = await this.checkClaudeCapacity();
    const tasks = await this.getReadyTasks(100);

    return {
      activeTask: this.currentSession?.taskId ?? null,
      capacity,
      readyTasks: tasks.length,
    };
  }

  // Helper methods

  private async createBranch(taskId: string, title: string): Promise<string> {
    const safeName = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
    const branch = `${taskId}-${safeName}`;
    await execAsync(`git checkout -b ${branch}`, { cwd: this.config.repoPath });
    return branch;
  }

  private async getCurrentBranch(): Promise<string> {
    const { stdout } = await execAsync('git branch --show-current', { cwd: this.config.repoPath });
    return stdout.trim();
  }

  private async updateTaskStatus(taskId: string, status: string): Promise<void> {
    await execAsync(`bd update ${taskId} --status ${status}`, { cwd: this.config.repoPath });
  }

  private async runTests(): Promise<{ passed: boolean; output: string }> {
    try {
      const { stdout, stderr } = await execAsync(this.config.testCommand, {
        cwd: this.config.repoPath,
        timeout: 5 * 60 * 1000,
      });
      return { passed: true, output: stdout + stderr };
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string };
      return { passed: false, output: (e.stdout || '') + (e.stderr || '') };
    }
  }

  private async generatePrompt(task: BeadTask): Promise<string> {
    // Use Brain's reasoner for better prompts
    const guidance = await this.brain.reason(`
Write 2-3 sentences of guidance for a coding agent working on:
Task: ${task.title}
Type: ${task.type}
Description: ${task.description || 'N/A'}

Be specific about files to check and approach to take. Under 50 words:
    `).catch(() => 'Focus on the task, make minimal changes, run tests.');

    return `
# Task: ${task.id} - ${task.title}

## Type: ${task.type}

## Description
${task.description || 'See title.'}

## Guidance
${guidance}

## Instructions
1. Focus ONLY on this task
2. Make minimal, targeted changes
3. Write/update tests
4. Run: ${this.config.testCommand}
5. Summarise what you changed

Begin.
`.trim();
  }

  private async generateCommitMessage(task: BeadTask): Promise<string> {
    const type = task.type === 'bug' ? 'fix' : 'feat';
    return `${type}(${task.id}): ${task.title.toLowerCase().slice(0, 50)}`;
  }

  private async createPR(task: BeadTask): Promise<string> {
    const branch = await this.getCurrentBranch();
    const description = await this.brain.reason(`
Write a brief PR description for:
Task: ${task.id} - ${task.title}
Type: ${task.type}

Include what was changed and how it was tested. Under 100 words:
    `).catch(() => `Closes ${task.id}`);

    const { stdout } = await execAsync(
      `gh pr create --title "${task.id}: ${task.title}" --body "${description.replace(/"/g, '\\"')}" --base main --head ${branch}`,
      { cwd: this.config.repoPath }
    );

    return stdout.trim();
  }
}

// Keep old class name as alias
export { CodeAgentModule as HomebaseCodeAgentModule };
