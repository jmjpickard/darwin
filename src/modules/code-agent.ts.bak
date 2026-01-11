/**
 * Code Agent Module - Orchestrates Claude Code with PRD and Beads task management
 *
 * Supports two task sources:
 * - prd.json: Feature-based task management with hierarchical features/tasks
 * - Beads: CLI-based task management (bd command)
 *
 * PRD tasks drive scheduling/queueing; Beads support remains for legacy use.
 * Task completion is detected via the Darwin completion signal: <darwin:task-complete />
 *
 * Uses PTY-based TerminalController for true interactive Claude Code sessions.
 * Brain handles question answering when Claude asks for input.
 *
 * Registers tools:
 * - code_get_ready_tasks: Get tasks ready to work on across all repos (PRD)
 * - code_list_tasks: List/search PRD tasks across repos (optionally include closed)
 * - code_show_task: Show details for a task
 * - code_get_task_state: Get repo/branch state for a task (detect existing work)
 * - code_start_task: Start Claude working on a task
 * - code_get_status: Get current agent status
 * - code_stop_task: Stop current task
 * - code_add_task: Create a new legacy Beads task
 * - code_update_task: Update legacy Beads task status and/or notes
 * - code_close_task: Close a legacy Beads task with a reason
 * - code_list_repos: List configured repositories
 */

import { exec } from "child_process";
import { promisify } from "util";
import { readFile, writeFile, appendFile, mkdir } from "fs/promises";
import { join } from "path";
import { DarwinModule, ModuleConfig } from "../core/module.js";
import { DarwinBrain } from "../core/brain.js";
import { eventBus } from "../core/event-bus.js";
import { RepoConfig } from "../core/config.js";
import { TerminalController } from "../core/terminal-controller.js";
import {
  TerminalAction,
  TerminalObservation,
  TerminalState,
} from "../core/terminal-types.js";
import { PrdManager } from "../core/prd-manager.js";
import { StatusManager } from "../core/status-manager.js";
import {
  PrdFeature,
  PrdTask,
  PrdStatus,
  DarwinStatus,
  ValidationResult,
  COMPLETION_SIGNAL,
} from "../core/prd-types.js";

const execAsync = promisify(exec);

type CodeAgentBackend = "claude" | "codex";

interface AgentCommand {
  command: string;
  args?: string[];
}

interface CodeAgentConfig extends ModuleConfig {
  repos: RepoConfig[];
  defaults: {
    testCommand: string;
    typecheckCommand: string;
    checkIntervalMs: number;
    maxSessionMinutes: number;
    usageThreshold: number;
  };
  autoStart: boolean;
  agent: CodeAgentBackend;
  agentCommands: Record<CodeAgentBackend, AgentCommand>;
}

type BeadTask = PrdTask & {
  priority: number;
  type: string;
  issue_type?: string;
  created_at?: string;
  updated_at?: string;
  closed_at?: string;
  close_reason?: string;
};

/**
 * Unified task type that represents either a Beads task or a PRD task
 * This allows the code agent to work with both systems seamlessly
 */
type TaskSource = "beads" | "prd";

interface UnifiedTask {
  /** Task ID (e.g., "bd-abc123" for Beads, "task-01-001" for PRD) */
  id: string;
  /** Parent feature ID (only for PRD tasks) */
  featureId?: string;
  /** Task title */
  title: string;
  /** Task description */
  description?: string;
  /** Task status (normalized) */
  status: string;
  /** Priority (1 = highest) */
  priority: number;
  /** Task type (task, bug, feature) */
  type: string;
  /** Source system */
  source: TaskSource;
  /** Original BeadTask if from Beads */
  beadTask?: BeadTask;
  /** Original PrdTask if from PRD */
  prdTask?: PrdTask;
  /** Parent PrdFeature if from PRD */
  prdFeature?: PrdFeature;
}

interface QueuedTask {
  task: UnifiedTask;
  repo: RepoConfig;
}

interface TaskQuery {
  limit: number;
  repoFilter?: string;
  status?: string;
  query?: string;
  includeClosed?: boolean;
}

type TaskStartMode = "auto" | "continue" | "reset" | "inspect";

interface TaskRepoState {
  taskId: string;
  repo: string;
  beadsStatus: string;
  baseRef: string;
  currentBranch: string;
  taskBranch?: string;
  branchExists: boolean;
  candidateBranches: string[];
  dirty: boolean;
  modified: number;
  untracked: number;
  ahead: number;
  behind: number;
  lastCommit?: { hash: string; subject: string; date: string };
}

interface ClaudeSession {
  taskId: string;
  repo: RepoConfig;
  terminal: TerminalController;
  startedAt: Date;
  outputBuffer: string[];
  branchName: string;
  task: UnifiedTask;
  agent: CodeAgentBackend;
  prdManager?: PrdManager;
  validationResult?: ValidationResult;
  validationInProgress?: boolean;
}

interface TaskPlanningContext {
  repoName: string;
  repoPath: string;
  tasks: Array<{
    id: string;
    featureId?: string;
    title: string;
    description?: string;
    priority: number;
    status: string;
  }>;
}

type OutputHandler = (line: string) => void;
type SessionEndReason = "limit" | "stopped" | "timeout" | "start_error";

const DEFAULT_CONFIG: CodeAgentConfig = {
  enabled: true,
  repos: [],
  defaults: {
    testCommand: "npm test",
    typecheckCommand: "npm run build",
    checkIntervalMs: 5 * 60 * 1000,
    maxSessionMinutes: 30,
    usageThreshold: 80,
  },
  autoStart: false,
  agent: "claude",
  agentCommands: {
    claude: { command: "claude" },
    codex: { command: "codex" },
  },
};

function prdStatusToUnified(status: PrdStatus): string {
  const statusMap: Record<PrdStatus, string> = {
    pending: "open",
    in_progress: "in_progress",
    completed: "closed",
    failed: "blocked",
  };
  return statusMap[status];
}

/**
 * Convert a BeadTask to UnifiedTask
 */
function beadToUnified(bead: BeadTask): UnifiedTask {
  return {
    id: bead.id,
    title: bead.title,
    description: bead.description,
    status: prdStatusToUnified(bead.status),
    priority: bead.priority,
    type: bead.type,
    source: "beads",
    beadTask: bead,
  };
}

/**
 * Convert a PrdTask (with its parent feature) to UnifiedTask
 */
function prdToUnified(task: PrdTask, feature: PrdFeature): UnifiedTask {
  return {
    id: task.id,
    featureId: feature.id,
    title: task.title,
    description: task.description,
    status: prdStatusToUnified(task.status),
    priority: feature.priority,
    type: "task",
    source: "prd",
    prdTask: task,
    prdFeature: feature,
  };
}

/**
 * Map unified status back to PRD status
 */
function unifiedToPrdStatus(status: string): PrdStatus {
  const reverseMap: Record<string, PrdStatus> = {
    open: "pending",
    ready: "pending",
    in_progress: "in_progress",
    closed: "completed",
    blocked: "failed",
    failed: "failed",
  };
  return reverseMap[status.toLowerCase()] || "pending";
}

export class CodeAgentModule extends DarwinModule {
  readonly name = "CodeAgent";
  readonly description =
    "Orchestrates Claude Code with PRD and Beads task management";

  protected override config: CodeAgentConfig;
  private currentSession: ClaudeSession | null = null;
  private checkInterval: NodeJS.Timeout | null = null;
  private sessionTimeout: NodeJS.Timeout | null = null;
  private outputHandlers: Set<OutputHandler> = new Set();
  private pauseCheckFn: (() => boolean) | null = null;
  private limitUntil: Date | null = null;
  private limitTimer: NodeJS.Timeout | null = null;
  private limitResumeTask: { taskId: string; repoName?: string } | null = null;
  private sessionEndReason: SessionEndReason | null = null;
  private limitRecoveryAttempts = 0;
  private consecutiveLimitHits = 0;
  private lastOutputAt: Date | null = null;
  private statusManager: StatusManager;

  constructor(brain: DarwinBrain, config: ModuleConfig) {
    super(brain, config);
    this.config = { ...DEFAULT_CONFIG, ...config } as CodeAgentConfig;
    this.statusManager = new StatusManager();
  }

  async init(): Promise<void> {
    const repoNames = this.config.repos.map((r) => r.name).join(", ");
    this.logger.info(`Repositories: ${repoNames || "none"}`);

    // Register tools with Brain
    this.registerTools();

    this._healthy = true;
  }

  async start(): Promise<void> {
    this._enabled = true;

    if (this.config.autoStart && this.config.repos.length > 0) {
      this.startCheckLoop();
    }

    eventBus.subscribe("darwin", "git_sync_complete", () => {
      this.logger.info("Git sync complete, checking for tasks...");
      void this.checkAndExecute().catch((error) => {
        this.logger.error(`Task check after git sync failed: ${error}`);
      });
    });

    await this.updateDarwinStatus({ status: "idle" });

    eventBus.publish("code", "module_started", {
      repos: this.config.repos.map((r) => r.name),
    });
  }

  async stop(): Promise<void> {
    this._enabled = false;

    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }

    if (this.limitTimer) {
      clearTimeout(this.limitTimer);
      this.limitTimer = null;
    }

    if (this.currentSession) {
      await this.stopCurrentSession("Module stopping", "stopped");
    }

    await this.updateDarwinStatus({ status: "idle" });

    eventBus.publish("code", "module_stopped", {});
  }

  /**
   * Set pause check function (called by Darwin)
   */
  setPauseCheck(fn: () => boolean): void {
    this.pauseCheckFn = fn;
  }

  /**
   * Subscribe to live output from Claude session
   */
  onOutput(handler: OutputHandler): void {
    this.outputHandlers.add(handler);
  }

  /**
   * Unsubscribe from output
   */
  offOutput(handler: OutputHandler): void {
    this.outputHandlers.delete(handler);
  }

  /**
   * Get current session info (for attach)
   */
  getCurrentSession(): ClaudeSession | null {
    return this.currentSession;
  }

  /**
   * Get recent output buffer
   */
  getOutputBuffer(): string[] {
    return this.currentSession?.outputBuffer.slice(-100) || [];
  }

  private getOutputSnapshot(args: { limit?: number; since?: number } = {}): {
    active: boolean;
    taskId?: string;
    repo?: string;
    state?: TerminalState;
    lines?: string[];
    totalLines?: number;
    nextCursor?: number;
    truncated?: boolean;
    lastOutputAt?: string | null;
    secondsSinceOutput?: number | null;
    message?: string;
  } {
    const session = this.currentSession;
    if (!session) {
      return { active: false, message: "No active Claude session" };
    }

    const total = session.outputBuffer.length;
    const limitRaw =
      typeof args.limit === "number" && Number.isFinite(args.limit)
        ? Math.floor(args.limit)
        : 50;
    const limit = Math.max(1, limitRaw);
    const since =
      typeof args.since === "number" && Number.isFinite(args.since)
        ? Math.max(0, Math.floor(args.since))
        : null;
    const start = since ?? Math.max(0, total - limit);
    const safeStart = Math.min(start, total);
    const end = since !== null ? Math.min(total, safeStart + limit) : total;
    const lines = session.outputBuffer.slice(safeStart, end);
    const lastOutputAt = this.lastOutputAt
      ? this.lastOutputAt.toISOString()
      : null;
    const secondsSinceOutput = this.lastOutputAt
      ? Math.round((Date.now() - this.lastOutputAt.getTime()) / 1000)
      : null;

    return {
      active: true,
      taskId: session.taskId,
      repo: session.repo.name || session.repo.path,
      state: session.terminal.getState(),
      lines,
      totalLines: total,
      nextCursor: end,
      truncated: safeStart > 0,
      lastOutputAt,
      secondsSinceOutput,
    };
  }

  private registerTools(): void {
    // Get ready tasks from all repos
    this.registerTool(
      "code_get_ready_tasks",
      "Get list of PRD tasks ready to work on from all configured repos",
      {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max tasks to return" },
          repo: {
            type: "string",
            description: "Filter by repo name (optional)",
          },
        },
      },
      async (args) => {
        const limit = (args.limit as number) || 10;
        const repoFilter = args.repo as string | undefined;
        return this.getReadyTasks(limit, repoFilter);
      }
    );

    // List/search tasks from all repos (includes closed if requested)
    this.registerTool(
      "code_list_tasks",
      "List or search PRD tasks across repos (optionally include closed)",
      {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max tasks to return" },
          repo: {
            type: "string",
            description: "Filter by repo name (optional)",
          },
          status: {
            type: "string",
            description:
              "Filter by status (e.g., open, in_progress, blocked, closed)",
          },
          query: {
            type: "string",
            description: "Search text for title/description",
          },
          includeClosed: {
            type: "boolean",
            description: "Include closed tasks when no status filter provided",
          },
        },
      },
      async (args) => {
        const limit = (args.limit as number) || 20;
        return this.listTasks({
          limit,
          repoFilter: args.repo as string | undefined,
          status: args.status as string | undefined,
          query: args.query as string | undefined,
          includeClosed: args.includeClosed as boolean | undefined,
        });
      }
    );

    // Show task details
    this.registerTool(
      "code_show_task",
      "Show details for a PRD task",
      {
        type: "object",
        properties: {
          taskId: {
            type: "string",
            description:
              "The PRD task ID (e.g., task-01-001). Legacy Beads IDs (bd-*) also supported.",
          },
          repo: {
            type: "string",
            description: "Repo name (optional if taskId is unique)",
          },
        },
        required: ["taskId"],
      },
      async (args) => {
        const taskId = args.taskId as string;
        const repoName = args.repo as string | undefined;
        return this.showTask(taskId, repoName);
      }
    );

    // Get task repo state
    this.registerTool(
      "code_get_task_state",
      "Get repo/branch state for a PRD task (detect existing work)",
      {
        type: "object",
        properties: {
          taskId: {
            type: "string",
            description:
              "The PRD task ID (e.g., task-01-001). Legacy Beads IDs (bd-*) also supported.",
          },
          repo: {
            type: "string",
            description: "Repo name (optional if taskId is unique)",
          },
        },
        required: ["taskId"],
      },
      async (args) => {
        const taskId = args.taskId as string;
        const repoName = args.repo as string | undefined;
        return this.getTaskState(taskId, repoName);
      }
    );

    // Start working on a task
    this.registerTool(
      "code_start_task",
      "Start Claude Code working on a specific PRD task",
      {
        type: "object",
        properties: {
          taskId: {
            type: "string",
            description:
              "The PRD task ID (e.g., task-01-001). Legacy Beads IDs (bd-*) also supported.",
          },
          repo: {
            type: "string",
            description: "Repo name (optional if taskId is unique)",
          },
          mode: {
            type: "string",
            enum: ["auto", "continue", "reset", "inspect"],
            description:
              "Auto = prompt if existing work; continue = resume; reset = hard reset branch; inspect = status only",
          },
          agent: {
            type: "string",
            enum: ["claude", "codex"],
            description: "Which CLI backend to use (default from config)",
          },
        },
        required: ["taskId"],
      },
      async (args) => {
        const taskId = args.taskId as string;
        const repoName = args.repo as string | undefined;
        const mode = (args.mode as TaskStartMode | undefined) || "auto";
        const agent = args.agent as CodeAgentBackend | undefined;
        return this.startTask(taskId, repoName, mode, agent);
      }
    );

    // Get current status
    this.registerTool(
      "code_get_status",
      "Get current Code Agent status including Claude usage and active task",
      {
        type: "object",
        properties: {},
      },
      async () => this.getAgentStatus()
    );

    // Get recent Claude output
    this.registerTool(
      "code_get_output",
      "Get recent output from the active Claude session",
      {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Max output chunks to return (default 50)",
          },
          since: {
            type: "number",
            description: "Return chunks after this index (0-based cursor)",
          },
        },
      },
      async (args) =>
        this.getOutputSnapshot(args as { limit?: number; since?: number })
    );

    // Stop current task
    this.registerTool(
      "code_stop_task",
      "Stop the currently running Claude Code session",
      {
        type: "object",
        properties: {
          reason: { type: "string", description: "Reason for stopping" },
        },
      },
      async (args) => {
        const reason = (args.reason as string) || "Stopped by Brain";
        return this.stopCurrentSession(reason);
      }
    );

    // Check Claude usage
    this.registerTool(
      "code_check_capacity",
      "Check if Claude Code has available capacity",
      {
        type: "object",
        properties: {
          agent: {
            type: "string",
            enum: ["claude", "codex"],
            description: "Agent backend (optional)",
          },
        },
      },
      async (args) => {
        const agent =
          (args.agent as CodeAgentBackend | undefined) || this.config.agent;
        return this.checkAgentCapacity(agent);
      }
    );

    // Add a task to a repo
    this.registerTool(
      "code_add_task",
      "Create a new legacy Beads task in a repository",
      {
        type: "object",
        properties: {
          repo: { type: "string", description: "Repo name" },
          title: { type: "string", description: "Task title" },
          type: {
            type: "string",
            enum: ["task", "bug", "epic"],
            description: "Task type",
          },
          priority: {
            type: "number",
            description: "Priority (1-5, lower is higher)",
          },
        },
        required: ["repo", "title"],
      },
      async (args) =>
        this.addTask(
          args as {
            repo: string;
            title: string;
            type?: string;
            priority?: number;
          }
        )
    );

    // Update task status/notes
    this.registerTool(
      "code_update_task",
      'Update a legacy Beads task status and/or notes (use status "open" to reopen)',
      {
        type: "object",
        properties: {
          taskId: {
            type: "string",
            description: "The Beads task ID (e.g., bd-a1b2)",
          },
          repo: {
            type: "string",
            description: "Repo name (optional if taskId is unique)",
          },
          status: {
            type: "string",
            description: "New status (e.g., open, in_progress, blocked)",
          },
          notes: { type: "string", description: "Notes to append to the task" },
        },
        required: ["taskId"],
      },
      async (args) => {
        return this.updateTask({
          taskId: args.taskId as string,
          repo: args.repo as string | undefined,
          status: args.status as string | undefined,
          notes: args.notes as string | undefined,
        });
      }
    );

    // Close a task
    this.registerTool(
      "code_close_task",
      "Close a legacy Beads task with a reason",
      {
        type: "object",
        properties: {
          taskId: {
            type: "string",
            description: "The Beads task ID (e.g., bd-a1b2)",
          },
          repo: {
            type: "string",
            description: "Repo name (optional if taskId is unique)",
          },
          reason: {
            type: "string",
            description: "Reason for closing the task",
          },
        },
        required: ["taskId"],
      },
      async (args) => {
        return this.closeTask(
          args.taskId as string,
          args.repo as string | undefined,
          (args.reason as string | undefined) || "Closed via Darwin"
        );
      }
    );

    // List repos
    this.registerTool(
      "code_list_repos",
      "List configured repositories",
      {
        type: "object",
        properties: {},
      },
      async () => this.listRepos()
    );

    // Setup Claude Code permissions for a repo
    this.registerTool(
      "code_setup_permissions",
      "Configure Claude Code permissions for autonomous operation in a repo",
      {
        type: "object",
        properties: {
          repo: {
            type: "string",
            description: "Repo name to configure",
          },
          extraCommands: {
            type: "string",
            description:
              "Comma-separated additional Bash commands to allow (e.g., 'pytest *,cargo test')",
          },
        },
        required: ["repo"],
      },
      async (args) => {
        const repoName = args.repo as string;
        const extraStr = (args.extraCommands as string | undefined) || "";
        const extraCommands = extraStr
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        return this.setupClaudePermissions(repoName, extraCommands);
      }
    );
  }

  /**
   * Start the automatic check loop
   */
  private startCheckLoop(): void {
    this.checkInterval = setInterval(async () => {
      await this.checkAndExecute();
    }, this.config.defaults.checkIntervalMs);

    // Also run immediately
    this.checkAndExecute();
  }

  /**
   * Check capacity and start a task if available
   * Uses the brain to thoughtfully prioritise tasks
   */
  private async checkAndExecute(): Promise<void> {
    if (this.pauseCheckFn?.()) {
      this.logger.debug("Darwin paused - skipping task check");
      return;
    }

    if (this.currentSession) {
      this.logger.debug("Session already active");
      return;
    }

    if (this.isLimitActive()) {
      this.logger.info(
        `Claude limit active until ${this.limitUntil?.toISOString()} - waiting`
      );
      return;
    }

    const capacity = await this.checkAgentCapacity(this.config.agent);
    if (!capacity.available) {
      if (capacity.resetsAt) {
        const parsed = new Date(capacity.resetsAt);
        this.applyLimitCooldown(
          Number.isFinite(parsed.getTime()) ? parsed : undefined,
          "api"
        );
      }
      this.logger.info(
        `Claude at ${capacity.utilization}% - waiting for capacity`
      );
      return;
    }

    const allTasks = await this.getReadyTasks(50);
    if (allTasks.length === 0) {
      this.logger.info("No ready tasks found in prd.json");
      return;
    }

    const selectedTask = await this.selectNextTask(allTasks);
    if (!selectedTask) {
      this.logger.info("Brain could not select a task to work on");
      return;
    }

    const { task, repo } = selectedTask;
    this.logger.info(
      `Starting task: ${task.id} "${task.title}" in ${repo.name}`
    );
    await this.startTask(task.id, repo.name, "continue");
  }

  /**
   * Use the brain to thoughtfully select the next task to work on
   * Groups tasks by repo and asks the brain to prioritise
   */
  private async selectNextTask(
    tasks: QueuedTask[]
  ): Promise<QueuedTask | null> {
    if (tasks.length === 0) return null;
    if (tasks.length === 1) return tasks[0];

    const repoGroups = new Map<string, TaskPlanningContext>();
    for (const { task, repo } of tasks) {
      const repoName = repo.name || repo.path;
      if (!repoGroups.has(repoName)) {
        repoGroups.set(repoName, {
          repoName,
          repoPath: repo.path,
          tasks: [],
        });
      }
      repoGroups.get(repoName)!.tasks.push({
        id: task.id,
        featureId: task.featureId,
        title: task.title,
        description: task.description,
        priority: task.priority,
        status: task.status,
      });
    }

    const prompt = this.buildTaskPlanningPrompt(
      Array.from(repoGroups.values())
    );

    try {
      const response = await this.brain.chat(prompt);
      const selectedId = this.parseTaskSelection(response.message);

      if (selectedId) {
        const found = tasks.find((t) => t.task.id === selectedId);
        if (found) {
          this.logger.info(
            `Brain selected task: ${selectedId} - ${response.message.slice(
              0,
              100
            )}`
          );
          return found;
        }
      }
    } catch (error) {
      this.logger.warn(`Brain task selection failed: ${error}`);
    }

    return tasks[0];
  }

  /**
   * Build a prompt for the brain to select the next task
   */
  private buildTaskPlanningPrompt(repos: TaskPlanningContext[]): string {
    const sections: string[] = [
      "I need to decide which task to work on next. Here are the available tasks:\n",
    ];

    for (const repo of repos) {
      sections.push(`## Repository: ${repo.repoName}`);
      sections.push(`Path: ${repo.repoPath}\n`);

      for (const task of repo.tasks) {
        const featureInfo = task.featureId
          ? ` (feature: ${task.featureId})`
          : "";
        sections.push(`- **${task.id}**${featureInfo}: ${task.title}`);
        sections.push(`  Priority: ${task.priority}, Status: ${task.status}`);
        if (task.description) {
          sections.push(`  ${task.description.slice(0, 200)}`);
        }
      }
      sections.push("");
    }

    sections.push(`Consider:
1. Task priority (lower number = higher priority)
2. Logical order - some tasks may depend on others
3. In-progress tasks should usually be continued
4. Tasks within the same feature should be completed together

Respond with the task ID you recommend starting, and briefly explain why.
Format: "Selected: <task-id> - <reason>"`);

    return sections.join("\n");
  }

  /**
   * Parse the brain's response to extract the selected task ID
   */
  private parseTaskSelection(response: string): string | null {
    const patterns = [
      /Selected:\s*(\S+)/i,
      /recommend(?:ing)?\s+(\S+)/i,
      /start(?:ing)?\s+with\s+(\S+)/i,
      /^(\S+-\S+)/m,
    ];

    for (const pattern of patterns) {
      const match = response.match(pattern);
      if (match) {
        return match[1].replace(/[.,;:'"]+$/, "");
      }
    }

    return null;
  }

  /**
   * Get ready tasks from all repos, sorted by priority
   * Fetches from prd.json features
   */
  private async getReadyTasks(
    limit: number,
    repoFilter?: string
  ): Promise<QueuedTask[]> {
    const allTasks: QueuedTask[] = [];
    const readyStatuses = new Set(["open", "ready", "in_progress"]);

    const repos = repoFilter
      ? this.config.repos.filter((r) => r.name === repoFilter)
      : this.config.repos;

    for (const repo of repos) {
      if (!repo.enabled) continue;

      try {
        // Fetch from PRD source
        const tasks = await this.fetchAllTasks(repo, "ready");
        const filtered = tasks.filter((task) =>
          readyStatuses.has(task.status.toLowerCase())
        );
        allTasks.push(...filtered.map((task) => ({ task, repo })));
      } catch (error) {
        this.logger.debug(`No tasks from ${repo.name}: ${error}`);
      }
    }

    // Sort by priority (lower number = higher priority)
    // PRD tasks naturally come first since they're added first to the array
    allTasks.sort((a, b) => a.task.priority - b.task.priority);

    return allTasks.slice(0, limit);
  }

  /**
   * List tasks across repos with optional filters
   * Fetches from prd.json features
   */
  private async listTasks(options: TaskQuery): Promise<QueuedTask[]> {
    const allTasks: QueuedTask[] = [];
    const query = options.query?.toLowerCase();
    const statusFilter = options.status?.toLowerCase();
    const includeClosed = options.includeClosed === true;

    const repos = options.repoFilter
      ? this.config.repos.filter((r) => r.name === options.repoFilter)
      : this.config.repos;

    for (const repo of repos) {
      if (!repo.enabled) continue;

      try {
        // Fetch from PRD source
        const tasks = await this.fetchAllTasks(repo, "list");

        for (const task of tasks) {
          const taskStatus = task.status.toLowerCase();
          if (
            statusFilter &&
            statusFilter !== "all" &&
            taskStatus !== statusFilter
          ) {
            continue;
          }

          if (!statusFilter && !includeClosed && taskStatus === "closed") {
            continue;
          }

          if (query) {
            const haystack = `${task.title} ${
              task.description || ""
            }`.toLowerCase();
            if (!haystack.includes(query)) {
              continue;
            }
          }

          allTasks.push({ task, repo });
        }
      } catch (error) {
        this.logger.debug(`No tasks from ${repo.name}: ${error}`);
      }
    }

    allTasks.sort((a, b) => {
      if (a.task.priority !== b.task.priority) {
        return a.task.priority - b.task.priority;
      }
      // For PRD tasks, use the feature's updated_at; for Beads use task updated_at
      const getUpdated = (t: UnifiedTask): number => {
        if (t.source === "prd" && t.prdFeature) {
          return Date.parse(t.prdFeature.updated_at);
        }
        return t.beadTask?.updated_at ? Date.parse(t.beadTask.updated_at) : 0;
      };
      return getUpdated(b.task) - getUpdated(a.task);
    });

    return allTasks.slice(0, options.limit);
  }

  /**
   * Show details for a specific task
   */
  private async showTask(
    taskId: string,
    repoName?: string
  ): Promise<{ success: boolean; task?: UnifiedTask; message: string }> {
    const repo = await this.findRepo(taskId, repoName);
    if (!repo) {
      return {
        success: false,
        message: `Could not find repo for task ${taskId}`,
      };
    }

    try {
      const task = await this.loadTaskById(repo, taskId);
      if (!task) {
        return {
          success: false,
          message: `Task ${taskId} not found in ${repo.name}`,
        };
      }

      return {
        success: true,
        task,
        message: `Found ${task.id} (${task.source}) in ${repo.name}`,
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to load task ${taskId}: ${error}`,
      };
    }
  }

  /**
   * Get repo/branch state for a task
   */
  private async getTaskState(
    taskId: string,
    repoName?: string
  ): Promise<{ success: boolean; message: string; state?: TaskRepoState }> {
    const repo = await this.findRepo(taskId, repoName);
    if (!repo) {
      return {
        success: false,
        message: `Could not find repo for task ${taskId}`,
      };
    }

    const task = await this.loadTaskById(repo, taskId);
    if (!task) {
      return {
        success: false,
        message: `Task ${taskId} not found in ${repo.name}`,
      };
    }

    const state = await this.getTaskRepoState(repo, task);
    return {
      success: true,
      message: `Found state for ${taskId} in ${repo.name}`,
      state,
    };
  }

  /**
   * Update a task status and/or notes
   */
  private async updateTask(args: {
    taskId: string;
    repo?: string;
    status?: string;
    notes?: string;
  }): Promise<{ success: boolean; message: string }> {
    if (!args.status && !args.notes) {
      return { success: false, message: "No status or notes provided" };
    }

    const repo = await this.findRepo(args.taskId, args.repo);
    if (!repo) {
      return {
        success: false,
        message: `Could not find repo for task ${args.taskId}`,
      };
    }

    if (args.status?.toLowerCase() === "closed") {
      return this.closeTask(args.taskId, repo.name, "Closed via Darwin");
    }

    const parts: string[] = [`update ${args.taskId}`];
    if (args.status) {
      parts.push(`--status ${args.status}`);
    }
    if (args.notes) {
      parts.push(`--notes "${this.escapeShellArg(args.notes)}"`);
    }

    try {
      await this.execBeads(repo, parts.join(" "), { timeoutMs: 10_000 });

      eventBus.publish("code", "task_updated", {
        taskId: args.taskId,
        repo: repo.name,
        status: args.status,
      });

      return {
        success: true,
        message: `Updated ${args.taskId} in ${repo.name}`,
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to update task ${args.taskId}: ${error}`,
      };
    }
  }

  /**
   * Close a task with a reason
   */
  private async closeTask(
    taskId: string,
    repoName?: string,
    reason = "Closed via Darwin"
  ): Promise<{ success: boolean; message: string }> {
    const repo = await this.findRepo(taskId, repoName);
    if (!repo) {
      return {
        success: false,
        message: `Could not find repo for task ${taskId}`,
      };
    }

    try {
      await this.execBeads(
        repo,
        `close ${taskId} --reason "${this.escapeShellArg(reason)}"`,
        { timeoutMs: 10_000 }
      );

      eventBus.publish("code", "task_closed", {
        taskId,
        repo: repo.name,
        reason,
      });

      return { success: true, message: `Closed ${taskId} in ${repo.name}` };
    } catch (error) {
      return {
        success: false,
        message: `Failed to close task ${taskId}: ${error}`,
      };
    }
  }

  /**
   * Fetch features from prd.json
   */
  private async fetchPrdFeatures(
    repo: RepoConfig,
    mode: "ready" | "list"
  ): Promise<PrdFeature[]> {
    const prdManager = new PrdManager(repo.path);

    if (!(await prdManager.exists())) {
      return [];
    }

    try {
      await prdManager.load();
      const features = prdManager.getFeatures();
      const filtered =
        mode === "ready"
          ? features.filter(
              (feature) =>
                feature.status === "pending" || feature.status === "in_progress"
            )
          : features;

      this.logger.debug(
        `Found ${filtered.length} PRD features in ${repo.name}`
      );
      return filtered;
    } catch (error) {
      this.logger.warn(`Failed to load prd.json in ${repo.name}: ${error}`);
      return [];
    }
  }

  /**
   * Fetch tasks from PRD features
   */
  private async fetchAllTasks(
    repo: RepoConfig,
    mode: "ready" | "list"
  ): Promise<UnifiedTask[]> {
    const features = await this.fetchPrdFeatures(repo, mode);
    const tasks: UnifiedTask[] = [];

    for (const feature of features) {
      for (const task of feature.tasks) {
        if (mode === "ready") {
          if (task.status !== "pending" && task.status !== "in_progress") {
            continue;
          }
        }

        tasks.push(prdToUnified(task, feature));
      }
    }

    this.logger.debug(`Found ${tasks.length} PRD tasks in ${repo.name}`);
    return tasks;
  }

  /**
   * Load a task by id with file fallback
   * Tries PRD first (if prd.json exists), then falls back to Beads
   */
  private async loadTaskById(
    repo: RepoConfig,
    taskId: string
  ): Promise<UnifiedTask | null> {
    const prdTask = await this.loadPrdTaskById(repo, taskId);
    if (prdTask) {
      return prdTask;
    }

    const beadTask = await this.loadBeadTaskById(repo, taskId);
    return beadTask ? beadToUnified(beadTask) : null;
  }

  /**
   * Load a PRD task by ID
   */
  private async loadPrdTaskById(
    repo: RepoConfig,
    taskId: string
  ): Promise<UnifiedTask | null> {
    const prdManager = new PrdManager(repo.path);

    if (!(await prdManager.exists())) {
      return null;
    }

    try {
      await prdManager.load();

      for (const feature of prdManager.getFeatures()) {
        const task = feature.tasks.find((t) => t.id === taskId);
        if (task) {
          return prdToUnified(task, feature);
        }
      }

      return null;
    } catch (error) {
      this.logger.warn(`Failed to load PRD task ${taskId}: ${error}`);
      return null;
    }
  }

  /**
   * Load a Beads task by id with file fallback
   */
  private async loadBeadTaskById(
    repo: RepoConfig,
    taskId: string
  ): Promise<BeadTask | null> {
    try {
      const { stdout } = await this.execBeads(repo, `show ${taskId} --json`, {
        timeoutMs: 10_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      const result = JSON.parse(stdout);
      const raw = Array.isArray(result) ? result[0] : result;
      return raw ? this.normalizeTask(raw) : null;
    } catch {
      const tasks = await this.readTasksFromFile(repo);
      return tasks.find((task) => task.id === taskId) || null;
    }
  }

  /**
   * Read Beads issues.jsonl directly
   */
  private async readTasksFromFile(repo: RepoConfig): Promise<BeadTask[]> {
    try {
      const filePath = join(repo.path, ".beads", "issues.jsonl");
      const content = await readFile(filePath, "utf-8");
      return content
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return this.normalizeTask(JSON.parse(line));
          } catch {
            return null;
          }
        })
        .filter((task): task is BeadTask => !!task);
    } catch (error) {
      this.logger.debug(
        `Failed to read issues.jsonl for ${repo.name}: ${error}`
      );
      return [];
    }
  }

  /**
   * Normalize Beads task shape
   */
  private normalizeTask(raw: Record<string, unknown>): BeadTask | null {
    const id = raw.id;
    const title = raw.title;
    const status = raw.status;
    const priority = raw.priority;
    const type = raw.type || raw.issue_type;

    if (
      typeof id !== "string" ||
      typeof title !== "string" ||
      typeof status !== "string"
    ) {
      return null;
    }

    return {
      id,
      title,
      description: typeof raw.description === "string" ? raw.description : "",
      status: unifiedToPrdStatus(status),
      passes: null,
      commit_sha: null,
      priority: typeof priority === "number" ? priority : 0,
      type: typeof type === "string" ? type : "task",
      issue_type:
        typeof raw.issue_type === "string" ? raw.issue_type : undefined,
      created_at:
        typeof raw.created_at === "string" ? raw.created_at : undefined,
      updated_at:
        typeof raw.updated_at === "string" ? raw.updated_at : undefined,
      closed_at: typeof raw.closed_at === "string" ? raw.closed_at : undefined,
      close_reason:
        typeof raw.close_reason === "string" ? raw.close_reason : undefined,
    };
  }

  /**
   * Find repo by name or find the repo containing a task
   */
  private async findRepo(
    taskId: string,
    repoName?: string
  ): Promise<RepoConfig | null> {
    // If repoName provided and matches a configured repo, use it
    if (repoName) {
      const exactMatch = this.config.repos.find((r) => r.name === repoName);
      if (exactMatch) return exactMatch;
      // repoName didn't match - fall through to search (model may have passed wrong value)
    }

    // Search all repos for this task
    for (const repo of this.config.repos) {
      const exists = await this.taskExistsInRepo(repo, taskId);
      if (exists) {
        return repo;
      }
    }

    return null;
  }

  /**
   * Start Claude working on a task using PTY-based TerminalController
   */
  private async startTask(
    taskId: string,
    repoName?: string,
    mode: TaskStartMode = "auto",
    agent?: CodeAgentBackend
  ): Promise<{
    success: boolean;
    message: string;
    state?: TaskRepoState;
    actions?: {
      continue: { tool: string; args: Record<string, unknown> };
      reset: { tool: string; args: Record<string, unknown> };
    };
  }> {
    if (this.currentSession) {
      return { success: false, message: "Session already active" };
    }

    if (this.isLimitActive()) {
      return {
        success: false,
        message: `Claude usage limit active until ${this.limitUntil?.toISOString()}`,
      };
    }

    // Find the repo
    const repo = await this.findRepo(taskId, repoName);
    if (!repo) {
      return {
        success: false,
        message: `Could not find repo for task ${taskId}`,
      };
    }

    // Get task details
    const task = await this.loadTaskById(repo, taskId);
    if (!task) {
      return {
        success: false,
        message: `Task ${taskId} not found in ${repo.name}`,
      };
    }

    const selectedAgent = agent || this.config.agent;
    let state = await this.getTaskRepoState(repo, task);

    if (mode === "inspect") {
      return {
        success: true,
        message: `Task state for ${taskId} in ${repo.name}`,
        state,
      };
    }

    const needsDecision = this.shouldRequireResumeDecision(task, state);
    if (mode === "auto" && needsDecision) {
      return {
        success: false,
        message: `Existing work detected for ${taskId} in ${repo.name}. Choose continue or reset.`,
        state,
        actions: {
          continue: {
            tool: "code_start_task",
            args: {
              taskId,
              repo: repo.name,
              mode: "continue",
              agent: selectedAgent,
            },
          },
          reset: {
            tool: "code_start_task",
            args: {
              taskId,
              repo: repo.name,
              mode: "reset",
              agent: selectedAgent,
            },
          },
        },
      };
    }

    if (mode === "reset") {
      try {
        await this.resetTaskBranch(repo, task, state);
        state = await this.getTaskRepoState(repo, task);
      } catch (error) {
        return {
          success: false,
          message: `Failed to reset ${taskId} in ${repo.name}: ${error}`,
          state,
        };
      }
    }

    this.logger.info(
      `Starting task: ${taskId} - ${task.title} (${repo.name}, ${selectedAgent})`
    );
    this.sessionEndReason = null;
    this.limitRecoveryAttempts = 0;

    // Create feature branch
    const branchName = await this.createBranch(repo, taskId, task.title);
    state = await this.getTaskRepoState(repo, task);

    // Update task status (handles both PRD and Beads)
    await this.updateTaskStatus(repo, taskId, "in_progress", task.featureId);
    await this.updateDarwinStatus({ status: "working", task, repo });

    // Create TerminalController for PTY-based interaction
    const terminal = new TerminalController({
      cwd: repo.path,
      cols: 120,
      rows: 40,
      env: {
        NO_COLOR: "1",
        TERM: "xterm-256color",
      },
    });

    // Initialize session
    this.currentSession = {
      taskId,
      repo,
      terminal,
      startedAt: new Date(),
      outputBuffer: [],
      branchName,
      task,
      agent: selectedAgent,
    };
    this.lastOutputAt = null;

    // Set up event handlers
    this.setupTerminalHandlers(terminal, task, repo);

    // Set session timeout
    this.sessionTimeout = setTimeout(() => {
      this.logger.warn(`Session timeout for ${taskId}`);
      this.stopCurrentSession("Timeout", "timeout");
    }, this.config.defaults.maxSessionMinutes * 60 * 1000);

    try {
      const { command, args } = this.getAgentCommand(selectedAgent);
      const agentArgs = args ? [...args] : [];

      // Determine if this is a resume (existing work) or fresh start
      const isResume = state.branchExists && (state.ahead > 0 || state.dirty);

      // For Claude, use inline prompt mode with --permission-mode acceptEdits
      if (selectedAgent === "claude") {
        const inlinePrompt = this.generateInlinePrompt(task, isResume);
        agentArgs.push("--permission-mode", "acceptEdits", "-p", inlinePrompt);
        this.logger.info(
          `Starting Claude with inline prompt: "${inlinePrompt.slice(
            0,
            60
          )}..."`
        );
      }

      // Start agent CLI
      await terminal.start(command, agentArgs);

      // For inline prompt mode, Claude starts working immediately
      if (selectedAgent === "claude") {
        // Wait briefly for any startup errors
        await new Promise((resolve) => setTimeout(resolve, 2000));

        const startError = this.detectStartupError(terminal.getFullBuffer());
        if (startError) {
          await this.stopCurrentSession("Startup error", "start_error");
          return { success: false, message: startError };
        }

        // Check for immediate limit hit
        const observation = terminal.getObservation();
        if (observation.state === "limit_reached") {
          const recovered = await this.tryRecoverFromLimit(
            terminal,
            selectedAgent
          );
          if (!recovered) {
            return {
              success: false,
              message: "Claude usage limit reached, waiting for reset",
            };
          }
        }

        this.logger.info("Claude started with inline prompt");
        eventBus.publish("code", "task_started", {
          taskId,
          title: task.title,
          repo: repo.name,
          branch: branchName,
          agent: selectedAgent,
        });

        return {
          success: true,
          message: `Started ${taskId} on branch ${branchName} (${repo.name})`,
          state,
        };
      }

      // For other agents (codex), use interactive mode
      let promptCache: string | null = null;
      const ensurePrompt = async (): Promise<string> => {
        if (!promptCache) {
          promptCache = await this.generatePrompt(repo, task, branchName);
        }
        return promptCache;
      };

      const outputSeen = await terminal.waitForOutput(/[\s\S]/, 5000);
      if (!outputSeen.found) {
        this.logger.warn("No output from agent after start, sending newline");
        await terminal.executeAction({ type: "enter", reason: "Kick prompt" });
      }

      const sendPrompt = async (reason: string, clearBuffer = true) => {
        if (clearBuffer) {
          terminal.clearBuffer();
        }
        const prompt = await ensurePrompt();
        this.logger.info(reason);
        await terminal.executeAction({
          type: "paste_submit",
          content: prompt,
          reason: `${reason} (paste + submit)`,
        });

        const progressed = await terminal.waitForState(
          ["processing", "question", "limit_reached", "error"],
          2000
        );
        if (!progressed.reached) {
          const observation = terminal.getObservation();
          const pasted = /pasted text/i.test(observation.recentOutput);
          const stuckAfterPaste =
            (observation.state === "waiting_response" ||
              observation.state === "ready") &&
            pasted;
          if (stuckAfterPaste) {
            this.logger.warn(
              "Agent still idle after paste, pressing enter again"
            );
            await terminal.executeAction({
              type: "enter",
              reason: "Submit pasted prompt (retry CR)",
            });
            const retryResult = await terminal.waitForState(
              ["processing", "question", "limit_reached", "error"],
              3000
            );
            if (!retryResult.reached) {
              this.logger.warn("Still stuck, trying LF");
              await terminal.executeAction({
                type: "type",
                content: "\n",
                reason: "Submit pasted prompt (LF fallback)",
              });
              await terminal.waitForState(
                ["processing", "question", "limit_reached", "error"],
                2000
              );
            }
          }
        }

        eventBus.publish("code", "task_started", {
          taskId,
          title: task.title,
          repo: repo.name,
          branch: branchName,
          agent: selectedAgent,
        });

        return {
          success: true,
          message: `Started ${taskId} on branch ${branchName} (${repo.name})`,
          state,
        };
      };

      const startError = this.detectStartupError(terminal.getFullBuffer());
      if (startError) {
        await this.stopCurrentSession("Startup error", "start_error");
        return { success: false, message: startError };
      }

      // Wait for agent to be ready
      this.logger.info("Waiting for agent prompt...");
      const ready = await terminal.waitForState(
        ["ready", "question", "limit_reached", "error"],
        30000
      );

      if (!ready.reached) {
        const observation = terminal.getObservation();
        const startError = this.detectStartupError(terminal.getFullBuffer());
        const tail = observation.recentOutput.trim().slice(-400);
        this.logger.error("Agent did not reach ready state");
        if (startError) {
          await this.stopCurrentSession("Failed to start", "start_error");
          return {
            success: false,
            message:
              startError ||
              `Agent failed to start. Last output: ${tail || "(none)"}`,
          };
        }

        this.logger.warn(
          "Agent prompt not detected, sending task prompt anyway"
        );
        return await sendPrompt(
          "Sending task prompt without detected prompt",
          false
        );
      }

      let startState = ready.state;

      if (startState === "question") {
        const followup = await terminal.waitForState(
          ["ready", "limit_reached", "error"],
          30000
        );
        if (!followup.reached) {
          const observation = terminal.getObservation();
          const tail = observation.recentOutput.trim().slice(-400);
          const startError = this.detectStartupError(terminal.getFullBuffer());
          if (startError) {
            await this.stopCurrentSession("Failed to start", "start_error");
            return {
              success: false,
              message:
                startError ||
                `Agent failed to start. Last output: ${tail || "(none)"}`,
            };
          }

          this.logger.warn(
            "Agent prompt still not detected after question, sending task prompt"
          );
          return await sendPrompt(
            "Sending task prompt after unanswered startup prompt",
            false
          );
        }
        startState = followup.state;
      }

      if (startState === "limit_reached") {
        const recovered = await this.tryRecoverFromLimit(
          terminal,
          selectedAgent
        );
        if (!recovered) {
          return {
            success: false,
            message: "Usage limit reached, waiting for reset",
          };
        }
      }

      if (startState === "error") {
        const startError = this.detectStartupError(terminal.getFullBuffer());
        await this.stopCurrentSession("Terminal error", "start_error");
        return {
          success: false,
          message: startError || "Agent failed to start",
        };
      }

      const startErrorAfterReady = this.detectStartupError(
        terminal.getFullBuffer()
      );
      if (startErrorAfterReady) {
        await this.stopCurrentSession("Startup error", "start_error");
        return { success: false, message: startErrorAfterReady };
      }

      return await sendPrompt("Agent is ready, sending task prompt...");
    } catch (error) {
      this.logger.error(`Failed to start Claude: ${error}`);
      await this.stopCurrentSession("Start error", "start_error");
      return { success: false, message: `Failed to start Claude: ${error}` };
    }
  }

  /**
   * Set up event handlers for the TerminalController
   */
  private setupTerminalHandlers(
    terminal: TerminalController,
    task: UnifiedTask,
    repo: RepoConfig
  ): void {
    // Handle all output
    terminal.on("output", (data) => {
      this.currentSession?.outputBuffer.push(data);
      this.lastOutputAt = new Date();
      this.touch();

      // Notify subscribers
      for (const handler of this.outputHandlers) {
        handler(data);
      }
    });

    // Handle state changes
    terminal.on("stateChange", (from, to) => {
      this.logger.debug(`Claude state: ${from} -> ${to}`);

      if (to === "ready" && from === "processing") {
        // Claude finished processing and is waiting for input
        // This could mean the task is done or Claude is waiting for more input
        this.checkTaskCompletion(task, repo);
      }
    });

    // Handle questions from Claude
    terminal.on("question", async (question) => {
      this.logger.info(`Claude asks: ${question}`);

      eventBus.publish("code", "question", {
        taskId: this.currentSession?.taskId,
        question,
      });

      // Use Brain to decide how to answer
      const observation = terminal.getObservation();
      const action = await this.handleQuestion(question, task, observation);
      const actions = Array.isArray(action) ? action : [action];

      for (const step of actions) {
        const reason = step.reason || "Brain decision";
        this.logger.info(
          `Answering with ${step.type}${
            step.content ? `: ${step.content.slice(0, 50)}` : ""
          }`
        );
        await terminal.executeAction({
          ...step,
          reason,
        });
      }
    });

    // Handle limit reached
    terminal.on("limitReached", (resetTime) => {
      if (this.sessionEndReason === "limit") {
        return;
      }

      this.logger.warn(
        `Usage limit reached, resets at ${resetTime?.toISOString()}`
      );

      eventBus.publish("code", "limit_reached", {
        taskId: this.currentSession?.taskId,
        resetTime: resetTime?.toISOString(),
      });

      // Stop the session and mark for retry later
      void this.handleLimitReached(task, repo, resetTime);
    });

    terminal.on("exit", async (code, signal) => {
      this.logger.info(`Claude exited: code=${code}, signal=${signal}`);

      if (this.sessionTimeout) {
        clearTimeout(this.sessionTimeout);
        this.sessionTimeout = null;
      }

      const endReason = this.sessionEndReason;
      this.sessionEndReason = null;

      if (endReason) {
        this.logger.info(`Session ended intentionally (${endReason})`);
        this.currentSession = null;
        return;
      }

      if (code === 0) {
        await this.handleTaskSuccess(task, repo);
      } else if (signal) {
        this.logger.info(`Session ended by signal: ${signal}`);
      } else if (code === 1) {
        const likelyRateLimit = await this.detectRateLimitExit(task, repo);
        if (likelyRateLimit) {
          this.logger.warn(
            `Exit code 1 detected as likely rate limit for ${task.id}`
          );
          await this.handleLimitReached(task, repo, undefined);
        } else {
          await this.handleTaskFailure(task, repo, `Exit code: ${code}`);
        }
      } else {
        await this.handleTaskFailure(task, repo, `Exit code: ${code}`);
      }

      this.currentSession = null;
    });

    // Handle errors
    terminal.on("error", (error) => {
      this.logger.error(`Terminal error: ${error.message}`);

      eventBus.publish("code", "error", {
        taskId: this.currentSession?.taskId,
        error: error.message,
      });
    });
  }

  /**
   * Check if the task is completed by examining recent output
   * Detects completion signal (<darwin:task-complete />) in output
   */
  private async checkTaskCompletion(
    task: UnifiedTask,
    repo: RepoConfig
  ): Promise<void> {
    if (!this.currentSession) return;

    const observation = this.currentSession.terminal.getObservation();
    const recentOutput = observation.recentOutput;

    // Check for explicit Darwin completion signal first
    if (recentOutput.includes(COMPLETION_SIGNAL)) {
      this.logger.info("Completion signal detected, marking task complete...");
      await this.validateTaskCompletion(task, repo, "signal");
      return;
    }

    // Fall back to heuristic completion indicators
    const completionIndicators = [
      /completed.*task/i,
      /finished.*implementation/i,
      /changes.*committed/i,
      /tests.*pass/i,
      /ready.*for.*review/i,
    ];

    const isComplete = completionIndicators.some((pattern) =>
      pattern.test(recentOutput)
    );

    if (isComplete) {
      this.logger.info("Task appears complete, initiating validation...");
      await this.validateTaskCompletion(task, repo, "heuristic");
    }
  }

  private async validateTaskCompletion(
    task: UnifiedTask,
    repo: RepoConfig,
    reason: "signal" | "heuristic"
  ): Promise<void> {
    if (!this.currentSession) return;
    if (this.currentSession.validationInProgress) {
      this.logger.debug("Validation already in progress, skipping.");
      return;
    }

    this.currentSession.validationInProgress = true;
    let validation: ValidationResult | null = null;

    try {
      this.logger.info(
        `Running validation (${reason}) for ${task.id} in ${repo.name}...`
      );
      validation = await this.runValidation(repo);
    } finally {
      if (this.currentSession) {
        this.currentSession.validationInProgress = false;
      }
    }

    if (!validation) {
      return;
    }

    if (this.currentSession) {
      this.currentSession.validationResult = validation;
    }

    if (validation.passed) {
      eventBus.publish("code", "validation_passed", {
        taskId: task.id,
        featureId: task.featureId,
        repo: repo.name,
        source: task.source,
      });
      await this.handleTaskCompletion(task, repo);
      return;
    }

    eventBus.publish("code", "validation_failed", {
      taskId: task.id,
      featureId: task.featureId,
      repo: repo.name,
      source: task.source,
      typecheckPassed: validation.typecheckPassed,
      testsPassed: validation.testsPassed,
    });

    await this.sendValidationFeedback(task, repo, validation);
  }

  private async sendValidationFeedback(
    task: UnifiedTask,
    repo: RepoConfig,
    validation: ValidationResult
  ): Promise<void> {
    if (!this.currentSession) return;

    const typecheckCommand = this.getTypecheckCommand(repo);
    const testCommand = this.getTestCommand(repo);
    const message = this.formatValidationMessage(
      validation,
      typecheckCommand,
      testCommand
    );

    this.logger.warn(
      `Validation failed for ${task.id} (${repo.name}), sending feedback`
    );

    await this.currentSession.terminal.executeAction({
      type: "paste_submit",
      content: message,
      reason: "Validation failed",
    });
  }

  private formatValidationMessage(
    validation: ValidationResult,
    typecheckCommand: string,
    testCommand: string
  ): string {
    const sections: string[] = [
      "Validation failed after completion.",
      `Typecheck (${typecheckCommand}): ${
        validation.typecheckPassed ? "passed" : "failed"
      }`,
    ];

    if (!validation.typecheckPassed && validation.typecheckError) {
      sections.push(
        `Typecheck output (truncated):\n${this.truncateOutput(
          validation.typecheckError
        )}`
      );
    }

    sections.push(
      `Tests (${testCommand}): ${validation.testsPassed ? "passed" : "failed"}`
    );

    if (!validation.testsPassed && validation.testsError) {
      sections.push(
        `Tests output (truncated):\n${this.truncateOutput(
          validation.testsError
        )}`
      );
    }

    sections.push(
      `Please fix the issues, re-run ${typecheckCommand} and ${testCommand}, then output ${COMPLETION_SIGNAL}.`
    );

    return sections.join("\n\n");
  }

  /**
   * Handle task completion: update PRD/Beads status, mark as complete
   */
  private async handleTaskCompletion(
    task: UnifiedTask,
    repo: RepoConfig
  ): Promise<void> {
    this.logger.info(`Task ${task.id} completed`);

    if (task.source === "prd" && task.featureId) {
      // Update PRD task status
      await this.completePrdTask(repo, task);
    } else if (task.source === "beads") {
      // Update Beads task status (existing flow)
      await this.updateTaskStatus(repo, task.id, "closed");
    }

    // Send exit command to Claude
    if (this.currentSession) {
      await this.currentSession.terminal.executeAction({
        type: "send",
        content: "/exit",
      });
    }

    eventBus.publish("code", "task_completed", {
      taskId: task.id,
      featureId: task.featureId,
      repo: repo.name,
      source: task.source,
    });
  }

  /**
   * Complete a PRD task and check if feature is done
   */
  private async completePrdTask(
    repo: RepoConfig,
    task: UnifiedTask
  ): Promise<void> {
    if (!task.featureId || !task.prdTask) return;

    const prdManager = new PrdManager(repo.path);
    await prdManager.load();

    // Get the current commit SHA
    const commitSha = await this.getCurrentCommitSha(repo);

    // Mark task as completed
    prdManager.markTaskCompleted(task.featureId, task.id, commitSha, true);

    // Check if feature is now complete
    if (prdManager.isFeatureComplete(task.featureId)) {
      const allPass = prdManager.doAllTasksPass(task.featureId);
      prdManager.updateFeatureStatus(task.featureId, "completed");
      prdManager.markFeaturePasses(task.featureId, allPass);
      this.logger.info(
        `Feature ${task.featureId} completed (passes: ${allPass})`
      );

      eventBus.publish("code", "feature_completed", {
        featureId: task.featureId,
        repo: repo.name,
        passes: allPass,
      });
    } else {
      const feature = prdManager.getFeature(task.featureId);
      if (feature && feature.status === "pending") {
        prdManager.updateFeatureStatus(task.featureId, "in_progress");
      }
    }

    await prdManager.save();
  }

  /**
   * Get the current commit SHA
   */
  private async getCurrentCommitSha(repo: RepoConfig): Promise<string> {
    try {
      const { stdout } = await execAsync("git rev-parse HEAD", {
        cwd: repo.path,
      });
      return stdout.trim();
    } catch {
      return "unknown";
    }
  }

  private async updateDarwinStatus(args: {
    status: DarwinStatus["status"];
    task?: UnifiedTask;
    repo?: RepoConfig;
    lastError?: string;
    clearTask?: boolean;
  }): Promise<void> {
    const clearTask = args.clearTask ?? args.status === "idle";
    let currentFeature: string | null = null;
    let currentTask: string | null = null;
    let progress = "0/0 tasks";

    if (!clearTask && args.task) {
      currentTask = args.task.id;
      if (args.task.source === "prd" && args.task.featureId) {
        currentFeature = args.task.featureId;
        if (args.repo) {
          try {
            const prdManager = new PrdManager(args.repo.path);
            await prdManager.load();
            progress = prdManager.getFeatureProgress(args.task.featureId);
          } catch (error) {
            this.logger.warn(
              `Failed to load PRD progress for status: ${error}`
            );
            progress = "unknown";
          }
        } else if (args.task.prdFeature) {
          const total = args.task.prdFeature.tasks.length;
          const completed = args.task.prdFeature.tasks.filter(
            (t) => t.status === "completed"
          ).length;
          progress = `${completed}/${total} tasks`;
        } else {
          progress = "unknown";
        }
      } else {
        progress = "1/1 tasks";
      }
    }

    const status: DarwinStatus = {
      current_feature: currentFeature,
      current_task: currentTask,
      progress,
      status: args.status,
      updated_at: new Date().toISOString(),
      ...(args.lastError ? { last_error: args.lastError } : {}),
    };

    try {
      await this.statusManager.writeStatus(status);
    } catch (error) {
      this.logger.warn(`Failed to write status: ${error}`);
    }
  }

  /**
   * Handle a question from Claude using Brain
   */
  private async handleQuestion(
    question: string,
    task: UnifiedTask,
    observation: TerminalObservation
  ): Promise<TerminalAction | TerminalAction[]> {
    // Safety checks first
    const safety = this.checkSafety(question);
    if (safety) {
      this.logger.info(`Safety rule: ${safety.reason}`);
      return {
        type: "answer",
        content: safety.response,
        reason: safety.reason,
      };
    }

    // Simple patterns - don't need AI
    if (question.match(/run.*test/i))
      return { type: "answer", content: "y", reason: "Allow tests" };
    if (question.match(/create.*file/i))
      return { type: "answer", content: "y", reason: "Allow file creation" };
    if (question.match(/apply.*changes/i))
      return { type: "answer", content: "y", reason: "Allow changes" };
    if (
      question.match(/\[y\/n\]/i) &&
      question.match(/proceed|continue|apply|create/i)
    ) {
      return {
        type: "answer",
        content: "y",
        reason: "Proceed with safe action",
      };
    }
    if (question.match(/press\s+enter|hit\s+enter|press\s+return/i)) {
      return { type: "enter", reason: "Acknowledge prompt" };
    }

    // Menu-style prompts (arrow-key selection)
    if (this.isMenuPrompt(question, observation)) {
      const menu = this.parseMenuOptions(observation.recentOutput);
      if (menu.options.length > 0) {
        const targetIndex = await this.chooseMenuOptionIndex(
          question,
          task,
          menu.options
        );
        return this.buildMenuActions(menu.selectedIndex ?? 0, targetIndex);
      }
      return { type: "enter", reason: "Accept default menu selection" };
    }

    // Check for multi-choice questions (numbered options)
    const multiChoice = question.match(/^\s*([1-9])\.\s+(.+)/m);
    if (multiChoice) {
      // Ask Brain to choose the best option
      const choice = await this.brain.reason(
        `Claude Code is working on "${task.title}" and presents options:\n${question}\n\nWhich option number (1-9) is best? Reply with just the number.`
      );
      const choiceNum = choice.match(/\d/)?.[0] || "1";
      return {
        type: "answer",
        content: choiceNum,
        reason: "Select numbered option",
      };
    }

    // Ask Brain for y/n decision
    const shouldApprove = await this.brain.decide(
      `Claude Code is working on "${task.title}" and asks: "${question}". Should we approve?`
    );

    const answer = shouldApprove ? "y" : "n";
    this.logger.info(
      `Brain decides: ${answer} for "${question.slice(0, 50)}..."`
    );
    return { type: "answer", content: answer, reason: "Brain decision" };
  }

  private isMenuPrompt(
    question: string,
    observation: TerminalObservation
  ): boolean {
    const lower = question.toLowerCase();
    const output = observation.recentOutput.toLowerCase();
    const hasMenuHint =
      /(?:arrow keys|select (?:an|a) option|select one|choose (?:an|a) option|choose one)/i.test(
        `${lower}\n${output}`
      );

    if (!hasMenuHint) {
      return false;
    }

    const menu = this.parseMenuOptions(observation.recentOutput);
    return menu.options.length >= 2;
  }

  private parseMenuOptions(output: string): {
    options: string[];
    selectedIndex: number | null;
  } {
    const lines = output.split("\n").slice(-30);
    const matches: Array<{ index: number; text: string; selected: boolean }> =
      [];

    lines.forEach((line, index) => {
      const parsed = this.parseOptionLine(line);
      if (parsed) {
        matches.push({ index, text: parsed.text, selected: parsed.selected });
      }
    });

    if (matches.length === 0) {
      return { options: [], selectedIndex: null };
    }

    const groups: Array<
      Array<{ index: number; text: string; selected: boolean }>
    > = [];
    let current: Array<{ index: number; text: string; selected: boolean }> = [];
    let lastIndex = -2;

    for (const match of matches) {
      if (match.index === lastIndex + 1 || current.length === 0) {
        current.push(match);
      } else {
        groups.push(current);
        current = [match];
      }
      lastIndex = match.index;
    }
    if (current.length > 0) {
      groups.push(current);
    }

    const group =
      groups
        .slice()
        .reverse()
        .find((g) => g.length >= 2) || groups[groups.length - 1];

    const options = group.map((g) => g.text);
    const selectedIndex = group.findIndex((g) => g.selected);

    return {
      options,
      selectedIndex: selectedIndex >= 0 ? selectedIndex : null,
    };
  }

  private parseOptionLine(
    line: string
  ): { text: string; selected: boolean } | null {
    const arrowMatch = line.match(/^\s*[>\u276F]\s+(.+)$/);
    if (arrowMatch) {
      return { text: arrowMatch[1].trim(), selected: true };
    }

    const radioMatch = line.match(/^\s*\((x|X| )\)\s+(.+)$/);
    if (radioMatch) {
      return {
        text: radioMatch[2].trim(),
        selected: radioMatch[1].toLowerCase() === "x",
      };
    }

    const checkboxMatch = line.match(/^\s*\[(x|X| )\]\s+(.+)$/);
    if (checkboxMatch) {
      return {
        text: checkboxMatch[2].trim(),
        selected: checkboxMatch[1].toLowerCase() === "x",
      };
    }

    const numericMatch = line.match(/^\s*\d+[\.\)]\s+(.+)$/);
    if (numericMatch) {
      return { text: numericMatch[1].trim(), selected: false };
    }

    const bulletMatch = line.match(/^\s*[-*\u2022]\s+(.+)$/);
    if (bulletMatch) {
      return { text: bulletMatch[1].trim(), selected: false };
    }

    return null;
  }

  private async chooseMenuOptionIndex(
    question: string,
    task: UnifiedTask,
    options: string[]
  ): Promise<number> {
    const normalized = options.map((opt) => opt.toLowerCase());
    const yesIndex = normalized.findIndex((opt) =>
      /^(y|yes|continue|proceed|apply|run|allow|ok|approve|accept)/i.test(opt)
    );
    const noIndex = normalized.findIndex((opt) =>
      /^(n|no|cancel|stop|abort|deny|reject|skip)/i.test(opt)
    );

    if (yesIndex >= 0 && noIndex >= 0) {
      const shouldApprove = await this.brain.decide(
        `Claude Code is working on "${task.title}" and asks: "${question}". Should we approve?`
      );
      return shouldApprove ? yesIndex : noIndex;
    }

    if (options.length === 1) {
      return 0;
    }

    const numbered = options.map((opt, idx) => `${idx + 1}. ${opt}`).join("\n");
    const choice = await this.brain.reason(
      `Claude Code is working on "${task.title}" and presents a menu:\n${question}\n\nOptions:\n${numbered}\n\nWhich option number (1-${options.length}) is best? Reply with just the number.`
    );
    const parsed = choice.match(/\d+/)?.[0];
    const index = parsed ? Number(parsed) - 1 : 0;
    return Math.min(Math.max(index, 0), options.length - 1);
  }

  private buildMenuActions(
    currentIndex: number,
    targetIndex: number
  ): TerminalAction[] {
    const actions: TerminalAction[] = [];
    const delta = targetIndex - currentIndex;
    const key = delta >= 0 ? "\x1b[B" : "\x1b[A";
    const steps = Math.abs(delta);

    for (let i = 0; i < steps; i += 1) {
      actions.push({
        type: "type",
        content: key,
        reason: "Move menu selection",
      });
    }

    actions.push({ type: "enter", reason: "Select menu option" });
    return actions;
  }

  /**
   * Hardcoded safety rules
   */
  private checkSafety(
    question: string
  ): { response: string; reason: string } | null {
    const lower = question.toLowerCase();

    if (lower.includes("rm -rf") || lower.includes("rmdir")) {
      return { response: "n", reason: "Dangerous delete" };
    }
    if (lower.includes("drop table") || lower.includes("delete from")) {
      return { response: "n", reason: "Dangerous database op" };
    }
    if (lower.includes("--force") && lower.includes("push")) {
      return { response: "n", reason: "Force push blocked" };
    }
    if (lower.includes("sudo")) {
      return { response: "n", reason: "Privilege escalation blocked" };
    }

    return null;
  }

  /**
   * Handle limit reached - pause and schedule retry
   */
  private async handleLimitReached(
    task: UnifiedTask,
    repo: RepoConfig,
    resetTime?: Date
  ): Promise<void> {
    if (this.sessionEndReason === "limit") {
      return;
    }

    if (this.currentSession?.terminal) {
      const recovered = await this.tryRecoverFromLimit(
        this.currentSession.terminal,
        this.currentSession.agent
      );
      if (recovered) {
        this.logger.warn(
          `Limit message cleared for ${task.id} (${repo.name}), continuing session`
        );
        return;
      }
    }

    this.sessionEndReason = "limit";
    this.limitResumeTask = { taskId: task.id, repoName: repo.name };
    this.applyLimitCooldown(resetTime, "cli");

    // Stop the current session gracefully
    await this.stopCurrentSession("Limit reached", "limit");

    // Update task with note about limit
    const resetAt = resetTime || this.limitUntil || undefined;
    const note = resetAt
      ? `Usage limit reached, will retry after ${resetAt.toISOString()}`
      : "Usage limit reached";

    await this.execBeads(
      repo,
      `update ${task.id} --notes "${note.replace(/"/g, '\\"')}"`,
      { timeoutMs: 10_000 }
    ).catch(() => {});

    eventBus.publish("code", "limit_reached", {
      taskId: task.id,
      repo: repo.name,
      resetTime: resetTime?.toISOString(),
    });
  }

  /**
   * Handle successful task completion
   */
  private async handleTaskSuccess(
    task: UnifiedTask,
    repo: RepoConfig
  ): Promise<void> {
    this.logger.info(`Task ${task.id} completed (${repo.name})`);
    this.consecutiveLimitHits = 0;

    const existingValidation = this.currentSession?.validationResult;
    const validation = existingValidation ?? (await this.runValidation(repo));

    if (!validation.passed) {
      await this.handleTaskFailure(
        task,
        repo,
        this.formatValidationSummary(validation)
      );
      return;
    }

    // Commit and push
    const commitMsg = await this.generateCommitMessage(task);
    await execAsync(`git add -A && git commit -m "${commitMsg}"`, {
      cwd: repo.path,
    });

    const branch = await this.getCurrentBranch(repo);
    await execAsync(`git push -u origin ${branch}`, { cwd: repo.path });

    // Create PR
    const prUrl = await this.createPR(repo, task);

    // Close task based on source
    if (task.source === "prd" && task.featureId) {
      await this.completePrdTask(repo, task);
      // Set PR URL on feature
      const prdManager = new PrdManager(repo.path);
      await prdManager.load();
      prdManager.setFeaturePr(task.featureId, prUrl);
      await prdManager.save();
    } else {
      // Close Beads task
      await this.execBeads(repo, `close ${task.id} --reason "PR: ${prUrl}"`, {
        timeoutMs: 10_000,
      });
    }

    eventBus.publish("code", "task_completed", {
      taskId: task.id,
      featureId: task.featureId,
      repo: repo.name,
      prUrl,
      source: task.source,
    });

    await this.updateDarwinStatus({ status: "idle" });
  }

  /**
   * Handle task failure
   */
  private async handleTaskFailure(
    task: UnifiedTask,
    repo: RepoConfig,
    error: string
  ): Promise<void> {
    this.logger.error(`Task ${task.id} failed (${repo.name}): ${error}`);

    // Rollback changes
    await execAsync("git reset --hard HEAD && git clean -fd", {
      cwd: repo.path,
    }).catch(() => {});

    // Update task status based on source
    if (task.source === "prd" && task.featureId) {
      const prdManager = new PrdManager(repo.path);
      await prdManager.load();
      prdManager.markTaskFailed(task.featureId, task.id, false);
      await prdManager.save();
    } else {
      // Update Beads
      await this.execBeads(
        repo,
        `update ${task.id} --status blocked --notes "${error
          .replace(/"/g, '\\"')
          .slice(0, 200)}"`,
        { timeoutMs: 10_000 }
      ).catch(() => {});
    }

    eventBus.publish("code", "task_failed", {
      taskId: task.id,
      featureId: task.featureId,
      repo: repo.name,
      error,
      source: task.source,
    });

    await this.updateDarwinStatus({
      status: "error",
      task,
      repo,
      lastError: error,
    });
  }

  /**
   * Stop current session
   */
  private async stopCurrentSession(
    reason?: string,
    endReason: SessionEndReason = "stopped"
  ): Promise<{ success: boolean }> {
    if (!this.currentSession) {
      return { success: false };
    }

    const { terminal, taskId, repo, task } = this.currentSession;

    this.logger.info(`Stopping session: ${reason || "user request"}`);
    if (!this.sessionEndReason) {
      this.sessionEndReason = endReason;
    }

    // Stop the terminal (sends /exit, then force kills if needed)
    await terminal.stop(false);

    if (this.sessionTimeout) {
      clearTimeout(this.sessionTimeout);
      this.sessionTimeout = null;
    }

    this.currentSession = null;
    this.lastOutputAt = null;

    eventBus.publish("code", "task_stopped", {
      taskId,
      repo: repo.name,
      reason,
    });

    const status =
      endReason === "limit"
        ? "waiting"
        : endReason === "timeout" || endReason === "start_error"
        ? "error"
        : "idle";
    const lastError =
      status === "error" ? reason || `Session ended (${endReason})` : undefined;
    await this.updateDarwinStatus({
      status,
      task,
      repo,
      lastError,
      clearTask: status === "idle",
    });

    return { success: true };
  }

  /**
   * Check Claude Code capacity
   */
  private async checkClaudeCapacity(): Promise<{
    available: boolean;
    utilization: number;
    resetsAt?: string;
  }> {
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

      const response = await fetch(
        "https://api.anthropic.com/api/oauth/usage",
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "anthropic-beta": "oauth-2025-04-20",
          },
        }
      );

      if (!response.ok) {
        return { available: true, utilization: 0 };
      }

      const data = (await response.json()) as {
        five_hour?: { utilization: number; resets_at: string };
      };

      const utilization = data.five_hour?.utilization ?? 0;
      return {
        available: utilization < this.config.defaults.usageThreshold,
        utilization,
        resetsAt: data.five_hour?.resets_at,
      };
    } catch {
      return { available: true, utilization: 0 };
    }
  }

  private async checkAgentCapacity(agent: CodeAgentBackend): Promise<{
    available: boolean;
    utilization: number;
    resetsAt?: string;
  }> {
    if (agent === "claude") {
      return this.checkClaudeCapacity();
    }

    return { available: true, utilization: 0 };
  }

  /**
   * Get current agent status
   */
  private async getAgentStatus(): Promise<{
    activeTask: {
      taskId: string;
      repo: string;
      startedAt: Date;
      state: TerminalState;
      outputLines: number;
      lastOutputAt: string | null;
      secondsSinceOutput: number | null;
      agent: CodeAgentBackend;
    } | null;
    capacity: { available: boolean; utilization: number };
    queue: Array<{
      taskId: string;
      title: string;
      repo: string;
      priority: number;
    }>;
    repos: Array<{ name: string; enabled: boolean; taskCount: number }>;
    agent: {
      default: CodeAgentBackend;
      active?: CodeAgentBackend;
      available: CodeAgentBackend[];
    };
  }> {
    const now = Date.now();
    const capacity = await this.checkAgentCapacity(this.config.agent);
    const tasks = await this.getReadyTasks(20);

    // Get task counts per repo
    const repoStats: Record<string, number> = {};
    for (const { repo } of tasks) {
      const name = repo.name || repo.path;
      repoStats[name] = (repoStats[name] || 0) + 1;
    }

    return {
      activeTask: this.currentSession
        ? {
            taskId: this.currentSession.taskId,
            repo:
              this.currentSession.repo.name || this.currentSession.repo.path,
            startedAt: this.currentSession.startedAt,
            state: this.currentSession.terminal.getState(),
            outputLines: this.currentSession.outputBuffer.length,
            lastOutputAt: this.lastOutputAt
              ? this.lastOutputAt.toISOString()
              : null,
            secondsSinceOutput: this.lastOutputAt
              ? Math.round((now - this.lastOutputAt.getTime()) / 1000)
              : null,
            agent: this.currentSession.agent,
          }
        : null,
      capacity,
      queue: tasks.map(({ task, repo }) => ({
        taskId: task.id,
        title: task.title,
        repo: repo.name || repo.path,
        priority: task.priority,
      })),
      repos: this.config.repos.map((r) => ({
        name: r.name || r.path,
        enabled: r.enabled,
        taskCount: repoStats[r.name || r.path] || 0,
      })),
      agent: {
        default: this.config.agent,
        active: this.currentSession?.agent,
        available: Object.keys(this.config.agentCommands) as CodeAgentBackend[],
      },
    };
  }

  /**
   * Add a task to a repo
   */
  private async addTask(args: {
    repo: string;
    title: string;
    type?: string;
    priority?: number;
  }): Promise<{ success: boolean; taskId?: string; message: string }> {
    const repo = this.config.repos.find((r) => r.name === args.repo);
    if (!repo) {
      return { success: false, message: `Unknown repo: ${args.repo}` };
    }

    const type = args.type || "task";
    const priority = args.priority || 2;

    try {
      const { stdout } = await this.execBeads(
        repo,
        `create "${args.title}" -t ${type} -p ${priority} --json`,
        { timeoutMs: 10_000 }
      );
      const result = JSON.parse(stdout);
      const taskId = result.id || result.issue?.id;

      eventBus.publish("code", "task_created", {
        taskId,
        repo: repo.name,
        title: args.title,
      });

      return {
        success: true,
        taskId,
        message: `Created ${taskId} in ${repo.name}`,
      };
    } catch (error) {
      return { success: false, message: `Failed to create task: ${error}` };
    }
  }

  /**
   * List repos
   */
  private listRepos(): Array<{ name: string; path: string; enabled: boolean }> {
    return this.config.repos.map((r) => ({
      name: r.name!,
      path: r.path,
      enabled: r.enabled,
    }));
  }

  /**
   * Setup Claude Code permissions for autonomous operation
   */
  private async setupClaudePermissions(
    repoName: string,
    extraCommands: string[] = []
  ): Promise<{ success: boolean; message: string; path?: string }> {
    const repo = this.config.repos.find((r) => r.name === repoName);
    if (!repo) {
      return { success: false, message: `Unknown repo: ${repoName}` };
    }

    const claudeDir = join(repo.path, ".claude");
    const settingsPath = join(claudeDir, "settings.local.json");

    // Base permissions for autonomous operation
    // Note: Use ":*" for prefix matching in Claude Code settings
    const basePermissions = [
      // Beads commands
      "Bash(bd:*)",
      // Git commands
      "Bash(git status)",
      "Bash(git status:*)",
      "Bash(git diff)",
      "Bash(git diff:*)",
      "Bash(git add:*)",
      "Bash(git commit:*)",
      "Bash(git push:*)",
      "Bash(git pull:*)",
      "Bash(git checkout:*)",
      "Bash(git branch:*)",
      "Bash(git log:*)",
      "Bash(git fetch:*)",
      "Bash(git stash:*)",
      "Bash(git reset:*)",
      "Bash(git clean:*)",
      // npm commands
      "Bash(npm run:*)",
      "Bash(npm test)",
      "Bash(npm test:*)",
      "Bash(npm install)",
      "Bash(npm install:*)",
      // Common tools
      "Bash(npx tsc)",
      "Bash(npx tsc:*)",
      "Bash(npx vitest:*)",
      "Bash(npx jest:*)",
      "Bash(npx prettier:*)",
      "Bash(npx eslint:*)",
      // Reading/inspecting files
      "Bash(cat:*)",
      "Bash(head:*)",
      "Bash(tail:*)",
      "Bash(ls)",
      "Bash(ls:*)",
      "Bash(find:*)",
      "Bash(wc:*)",
      "Bash(which:*)",
      // Common utilities
      "Bash(echo:*)",
      "Bash(grep:*)",
      "Bash(node:*)",
      "Bash(mkdir:*)",
      "Bash(cp:*)",
      "Bash(mv:*)",
    ];

    // Add extra commands
    const allPermissions = [
      ...basePermissions,
      ...extraCommands.map((cmd) => `Bash(${cmd})`),
    ];

    const settings = {
      permissions: {
        allow: allPermissions,
      },
    };

    try {
      // Create .claude directory (recursive: true acts like mkdir -p)
      await mkdir(claudeDir, { recursive: true });
      this.logger.debug(`Created directory: ${claudeDir}`);

      // Write settings file
      await writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
      this.logger.debug(`Wrote settings to: ${settingsPath}`);

      // Add to .gitignore if not already there
      const gitignorePath = join(repo.path, ".gitignore");
      try {
        const gitignore = await readFile(gitignorePath, "utf-8");
        if (!gitignore.includes(".claude/settings.local.json")) {
          await appendFile(
            gitignorePath,
            "\n# Claude Code local settings (machine-specific permissions)\n.claude/settings.local.json\n"
          );
          this.logger.debug(`Updated .gitignore`);
        }
      } catch {
        // .gitignore doesn't exist or can't be read - create it
        await writeFile(
          gitignorePath,
          "# Claude Code local settings (machine-specific permissions)\n.claude/settings.local.json\n",
          "utf-8"
        );
        this.logger.debug(`Created .gitignore`);
      }

      this.logger.info(`Configured Claude permissions for ${repoName}`);

      eventBus.publish("code", "permissions_configured", {
        repo: repoName,
        path: settingsPath,
        permissions: allPermissions.length,
      });

      return {
        success: true,
        message: `Configured ${allPermissions.length} permissions for ${repoName}`,
        path: settingsPath,
      };
    } catch (error) {
      this.logger.error(`Failed to configure permissions: ${error}`);
      return {
        success: false,
        message: `Failed to configure permissions: ${error}`,
      };
    }
  }

  private escapeShellArg(value: string): string {
    return value.replace(/"/g, '\\"');
  }

  private getAgentCommand(agent: CodeAgentBackend): AgentCommand {
    return this.config.agentCommands[agent] || this.config.agentCommands.claude;
  }

  private detectStartupError(buffer: string): string | null {
    const lower = buffer.toLowerCase();
    if (
      lower.includes("command not found") ||
      lower.includes("not recognized as an internal")
    ) {
      return "Agent CLI not found. Ensure the CLI is installed and on PATH.";
    }
    if (
      lower.includes("not logged in") ||
      lower.includes("not authenticated")
    ) {
      return "Agent CLI not authenticated. Run the login command for the CLI.";
    }
    if (lower.includes("api key") && lower.includes("missing")) {
      return "Agent CLI missing API key. Configure credentials and try again.";
    }
    if (lower.includes("permission denied")) {
      return "Agent CLI failed to start due to permission denied.";
    }
    return null;
  }

  private shouldRetryNoDb(error: unknown): boolean {
    const message = String(error).toLowerCase();
    if (message.includes("no beads database found")) {
      return true;
    }
    if (message.includes("beads database") && message.includes("not found")) {
      return true;
    }
    if (message.includes("timed out") || message.includes("timeout")) {
      return true;
    }
    if (typeof error === "object" && error !== null) {
      const maybe = error as { killed?: boolean; signal?: string };
      if (maybe.killed && maybe.signal) {
        return true;
      }
    }
    return false;
  }

  private async execBeads(
    repo: RepoConfig,
    args: string,
    options?: { timeoutMs?: number; maxBuffer?: number; allowNoDb?: boolean }
  ): Promise<{ stdout: string; stderr: string }> {
    const timeout = options?.timeoutMs ?? 10_000;
    const allowNoDb = options?.allowNoDb ?? true;
    const maxBuffer = options?.maxBuffer;
    const run = (command: string) =>
      execAsync(command, {
        cwd: repo.path,
        timeout,
        maxBuffer,
      });

    try {
      return await run(`bd ${args}`);
    } catch (error) {
      if (!allowNoDb || !this.shouldRetryNoDb(error)) {
        throw error;
      }

      this.logger.warn(
        `Beads command failed in ${repo.name}, retrying with --no-db: bd ${args}`
      );
      return run(`bd --no-db ${args}`);
    }
  }

  /**
   * Check if a task exists in a repo (checks both PRD and Beads)
   */
  private async taskExistsInRepo(
    repo: RepoConfig,
    taskId: string
  ): Promise<boolean> {
    const prdManager = new PrdManager(repo.path);
    if (await prdManager.exists()) {
      try {
        await prdManager.load();
        for (const feature of prdManager.getFeatures()) {
          if (feature.tasks.some((t) => t.id === taskId)) {
            return true;
          }
        }
      } catch {
        this.logger.debug(
          `Failed to check PRD for task ${taskId} in ${repo.name}`
        );
      }
    }

    const beadTasks = await this.readTasksFromFile(repo);
    return beadTasks.some((task) => task.id === taskId);
  }

  /**
   * Detect if an exit code 1 was likely due to rate limiting
   * Checks session duration and recent output for indicators
   */
  private async detectRateLimitExit(
    task: UnifiedTask,
    repo: RepoConfig
  ): Promise<boolean> {
    if (!this.currentSession) return false;

    const sessionDuration =
      Date.now() - this.currentSession.startedAt.getTime();
    const recentOutput = this.currentSession.outputBuffer.slice(-50).join("\n");
    const lower = recentOutput.toLowerCase();

    const rateLimitIndicators = [
      "usage limit",
      "rate limit",
      "quota",
      "limit reached",
      "limit exceeded",
      "try again later",
      "too many requests",
      "resets at",
    ];

    const hasLimitIndicator = rateLimitIndicators.some((indicator) =>
      lower.includes(indicator)
    );

    if (hasLimitIndicator) {
      this.logger.debug(`Rate limit detected via output for ${task.id}`);
      return true;
    }

    const veryQuickExit = sessionDuration < 30_000;
    if (veryQuickExit && this.currentSession.outputBuffer.length < 20) {
      this.logger.debug(
        `Quick exit (${sessionDuration}ms) with minimal output - likely rate limit`
      );
      const capacity = await this.checkAgentCapacity(this.config.agent);
      if (!capacity.available || capacity.utilization > 80) {
        return true;
      }
    }

    return false;
  }

  private async tryRecoverFromLimit(
    terminal: TerminalController,
    agent: CodeAgentBackend = "claude"
  ): Promise<boolean> {
    if (this.limitRecoveryAttempts >= 1) {
      return false;
    }

    this.limitRecoveryAttempts += 1;
    const capacity = await this.checkAgentCapacity(agent);

    if (!capacity.available) {
      return false;
    }

    this.logger.warn(
      "Limit reached message detected, but capacity looks available. Probing CLI..."
    );

    await terminal.executeAction({
      type: "enter",
      reason: "Probe after limit message",
    });
    const probe = await terminal.waitForState(
      ["ready", "question", "limit_reached", "error"],
      10_000
    );

    if (
      probe.reached &&
      (probe.state === "ready" || probe.state === "question")
    ) {
      return true;
    }

    return false;
  }

  // Helper methods
  private isLimitActive(): boolean {
    if (!this.limitUntil) {
      return false;
    }

    if (this.limitUntil.getTime() <= Date.now()) {
      this.limitUntil = null;
      return false;
    }

    return true;
  }

  private applyLimitCooldown(
    resetTime: Date | undefined,
    source: "cli" | "api"
  ): void {
    const now = Date.now();
    this.consecutiveLimitHits += 1;

    const baseWaitMs = 60 * 60 * 1000;
    const backoffMultiplier = Math.min(
      Math.pow(1.5, this.consecutiveLimitHits - 1),
      4
    );
    const backoffWaitMs = Math.floor(baseWaitMs * backoffMultiplier);

    const resetMs = resetTime?.getTime();
    const fallback = now + backoffWaitMs;
    const target = Number.isFinite(resetMs) ? resetMs! : fallback;
    const untilMs = Math.max(target, now + 10_000);
    const nextMs = this.limitUntil
      ? Math.max(this.limitUntil.getTime(), untilMs)
      : untilMs;

    if (this.limitUntil && this.limitUntil.getTime() >= nextMs) {
      return;
    }

    this.limitUntil = new Date(nextMs);
    const waitMins = Math.round((nextMs - now) / 60_000);
    this.logger.warn(
      `Claude usage limit active for ${waitMins}min (hit #${this.consecutiveLimitHits}, ${source})`
    );

    if (this.limitTimer) {
      clearTimeout(this.limitTimer);
    }

    const waitMs = Math.max(0, nextMs - Date.now());
    this.limitTimer = setTimeout(() => {
      this.limitTimer = null;
      this.limitUntil = null;
      this.resumeAfterLimit();
    }, waitMs);
  }

  private resumeAfterLimit(): void {
    if (this.pauseCheckFn?.()) {
      this.logger.debug("Darwin paused - deferring limit resume");
      return;
    }

    const resume = this.limitResumeTask;
    this.limitResumeTask = null;

    if (resume) {
      void this.startTask(resume.taskId, resume.repoName, "continue").catch(
        (error) => {
          this.logger.error(`Failed to resume task ${resume.taskId}: ${error}`);
        }
      );
      return;
    }

    void this.checkAndExecute().catch((error) => {
      this.logger.error(`Failed to resume check loop after limit: ${error}`);
    });
  }

  private buildBranchName(taskId: string, title: string): string {
    const safeName = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 40);
    return `${taskId}-${safeName}`;
  }

  private shouldRequireResumeDecision(
    task: UnifiedTask,
    state: TaskRepoState
  ): boolean {
    const status = task.status.toLowerCase();
    const hasWork =
      state.branchExists &&
      (state.dirty || state.untracked > 0 || state.ahead > 0);
    return hasWork || status === "in_progress";
  }

  private async getTaskRepoState(
    repo: RepoConfig,
    task: UnifiedTask
  ): Promise<TaskRepoState> {
    const baseRef = await this.getDefaultBranchRef(repo);
    const currentBranch = await this.getCurrentBranchLabel(repo);
    const branchInfo = await this.resolveTaskBranch(repo, task);
    const status = await this.getRepoStatus(repo);
    const { ahead, behind } = branchInfo.branch
      ? await this.getAheadBehind(repo, baseRef, branchInfo.branch)
      : { ahead: 0, behind: 0 };
    const lastCommit = branchInfo.branch
      ? await this.getLastCommit(repo, branchInfo.branch)
      : undefined;

    return {
      taskId: task.id,
      repo: repo.name || repo.path,
      beadsStatus: task.status,
      baseRef,
      currentBranch,
      taskBranch: branchInfo.branch,
      branchExists: Boolean(branchInfo.branch),
      candidateBranches: branchInfo.candidates,
      dirty: status.dirty,
      modified: status.modified,
      untracked: status.untracked,
      ahead,
      behind,
      lastCommit,
    };
  }

  private async resolveTaskBranch(
    repo: RepoConfig,
    task: UnifiedTask
  ): Promise<{ branch?: string; candidates: string[] }> {
    const expected = this.buildBranchName(task.id, task.title);
    const branches = await this.listTaskBranches(repo, task.id);
    const normalized = new Set(branches);

    if (normalized.has(expected)) {
      return { branch: expected, candidates: branches };
    }

    if (branches.length > 0) {
      return { branch: branches[0], candidates: branches };
    }

    if (await this.branchExists(repo, expected)) {
      return { branch: expected, candidates: [expected] };
    }

    return { branch: undefined, candidates: [] };
  }

  private async listTaskBranches(
    repo: RepoConfig,
    taskId: string
  ): Promise<string[]> {
    try {
      const { stdout } = await execAsync(
        `git branch --list "${this.escapeShellArg(taskId)}-*"`,
        { cwd: repo.path }
      );
      return stdout
        .split("\n")
        .map((line) => line.replace(/^\* /, "").trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  private async branchExists(
    repo: RepoConfig,
    branch: string
  ): Promise<boolean> {
    try {
      await execAsync(
        `git show-ref --verify --quiet "refs/heads/${this.escapeShellArg(
          branch
        )}"`,
        { cwd: repo.path }
      );
      return true;
    } catch {
      return false;
    }
  }

  private async getDefaultBranchRef(repo: RepoConfig): Promise<string> {
    try {
      const { stdout } = await execAsync(
        "git symbolic-ref --short refs/remotes/origin/HEAD",
        {
          cwd: repo.path,
        }
      );
      const ref = stdout.trim();
      if (ref) return ref;
    } catch {
      // Ignore and fall back.
    }

    const candidates = ["main", "master"];
    for (const candidate of candidates) {
      if (await this.branchExists(repo, candidate)) {
        return candidate;
      }
    }

    const current = await this.getCurrentBranchLabel(repo);
    return current !== "(unknown)" ? current : "main";
  }

  private async getCurrentBranchLabel(repo: RepoConfig): Promise<string> {
    try {
      const { stdout } = await execAsync("git branch --show-current", {
        cwd: repo.path,
      });
      const branch = stdout.trim();
      if (branch) return branch;
    } catch {
      // Ignore and fall back.
    }

    try {
      const { stdout } = await execAsync("git rev-parse --short HEAD", {
        cwd: repo.path,
      });
      const hash = stdout.trim();
      if (hash) return `(detached ${hash})`;
    } catch {
      // Ignore and fall back.
    }

    return "(unknown)";
  }

  private async getRepoStatus(
    repo: RepoConfig
  ): Promise<{ dirty: boolean; modified: number; untracked: number }> {
    try {
      const { stdout } = await execAsync("git status --porcelain", {
        cwd: repo.path,
      });
      const lines = stdout.split("\n").filter(Boolean);
      const untracked = lines.filter((line) => line.startsWith("??")).length;
      const modified = lines.length - untracked;
      return { dirty: lines.length > 0, modified, untracked };
    } catch {
      return { dirty: false, modified: 0, untracked: 0 };
    }
  }

  private async getAheadBehind(
    repo: RepoConfig,
    baseRef: string,
    branch: string
  ): Promise<{ ahead: number; behind: number }> {
    try {
      const range = `${baseRef}...${branch}`;
      const { stdout } = await execAsync(
        `git rev-list --left-right --count "${this.escapeShellArg(range)}"`,
        { cwd: repo.path }
      );
      const [behindRaw, aheadRaw] = stdout.trim().split(/\s+/);
      return {
        ahead: Number(aheadRaw) || 0,
        behind: Number(behindRaw) || 0,
      };
    } catch {
      return { ahead: 0, behind: 0 };
    }
  }

  private async getLastCommit(
    repo: RepoConfig,
    ref: string
  ): Promise<{ hash: string; subject: string; date: string } | undefined> {
    try {
      const { stdout } = await execAsync(
        `git log -1 --pretty=format:%H|%s|%cI "${this.escapeShellArg(ref)}"`,
        { cwd: repo.path }
      );
      const [hash, subject, date] = stdout.trim().split("|");
      if (!hash) return undefined;
      return { hash, subject, date };
    } catch {
      return undefined;
    }
  }

  private async resetTaskBranch(
    repo: RepoConfig,
    task: UnifiedTask,
    state: TaskRepoState
  ): Promise<void> {
    const branch =
      state.taskBranch || this.buildBranchName(task.id, task.title);
    const baseRef = state.baseRef || (await this.getDefaultBranchRef(repo));
    const safeBranch = this.escapeShellArg(branch);
    const safeBase = this.escapeShellArg(baseRef);

    if (await this.branchExists(repo, branch)) {
      await execAsync(`git checkout "${safeBranch}"`, { cwd: repo.path });
    } else {
      await execAsync(`git checkout -b "${safeBranch}" "${safeBase}"`, {
        cwd: repo.path,
      });
    }

    await execAsync(`git reset --hard "${safeBase}"`, { cwd: repo.path });
    await execAsync("git clean -fd", { cwd: repo.path });
  }

  private async createBranch(
    repo: RepoConfig,
    taskId: string,
    title: string
  ): Promise<string> {
    const branch = this.buildBranchName(taskId, title);

    try {
      // Try creating a new branch
      await execAsync(`git checkout -b ${branch}`, { cwd: repo.path });
    } catch (error) {
      const errorStr = String(error);

      if (errorStr.includes("already exists")) {
        // Branch exists - check it out instead
        this.logger.info(`Branch ${branch} exists, checking out`);
        await execAsync(`git checkout ${branch}`, { cwd: repo.path });

        // Pull latest if remote exists
        try {
          await execAsync(`git pull origin ${branch} --rebase`, {
            cwd: repo.path,
          });
        } catch {
          // No remote branch or pull failed - that's fine, continue with local
        }
      } else {
        // Unknown error - rethrow
        throw error;
      }
    }

    return branch;
  }

  private async getCurrentBranch(repo: RepoConfig): Promise<string> {
    const { stdout } = await execAsync("git branch --show-current", {
      cwd: repo.path,
    });
    return stdout.trim();
  }

  /**
   * Update task status - handles both PRD and Beads tasks
   */
  private async updateTaskStatus(
    repo: RepoConfig,
    taskId: string,
    status: string,
    featureId?: string
  ): Promise<void> {
    try {
      // Check if this is a PRD task
      if (taskId.startsWith("task-") && featureId) {
        const prdManager = new PrdManager(repo.path);
        if (await prdManager.exists()) {
          await prdManager.load();
          const prdStatus = unifiedToPrdStatus(status);
          prdManager.updateTaskStatus(featureId, taskId, prdStatus);
          const feature = prdManager.getFeature(featureId);
          if (
            feature &&
            prdStatus === "in_progress" &&
            feature.status === "pending"
          ) {
            prdManager.updateFeatureStatus(featureId, "in_progress");
          }
          await prdManager.save();
          return;
        }
      }

      // Fall back to Beads
      await this.execBeads(repo, `update ${taskId} --status ${status}`, {
        timeoutMs: 10_000,
      });
    } catch (error) {
      this.logger.warn(`Failed to update ${taskId} in ${repo.name}: ${error}`);
    }
  }

  private getTestCommand(repo: RepoConfig): string {
    return repo.testCommand || this.config.defaults.testCommand;
  }

  private getTypecheckCommand(repo: RepoConfig): string {
    return repo.typecheckCommand || this.config.defaults.typecheckCommand;
  }

  private async runCommand(
    repo: RepoConfig,
    command: string
  ): Promise<{ passed: boolean; output: string }> {
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: repo.path,
        timeout: 5 * 60 * 1000,
        maxBuffer: 5 * 1024 * 1024,
      });
      return { passed: true, output: stdout + stderr };
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string };
      return { passed: false, output: (e.stdout || "") + (e.stderr || "") };
    }
  }

  private async runValidation(repo: RepoConfig): Promise<ValidationResult> {
    const typecheckCommand = this.getTypecheckCommand(repo);
    const testCommand = this.getTestCommand(repo);
    const sameCommand =
      typecheckCommand.trim().toLowerCase() ===
      testCommand.trim().toLowerCase();

    const typecheckResult = await this.runCommand(repo, typecheckCommand);
    const testResult = sameCommand
      ? typecheckResult
      : await this.runCommand(repo, testCommand);

    return {
      typecheckPassed: typecheckResult.passed,
      typecheckError: typecheckResult.passed
        ? undefined
        : typecheckResult.output,
      testsPassed: testResult.passed,
      testsError: testResult.passed ? undefined : testResult.output,
      passed: typecheckResult.passed && testResult.passed,
    };
  }

  private formatValidationSummary(validation: ValidationResult): string {
    const parts: string[] = [];
    if (!validation.typecheckPassed) parts.push("typecheck failed");
    if (!validation.testsPassed) parts.push("tests failed");
    if (parts.length === 0) return "Validation failed";
    return `Validation failed: ${parts.join(", ")}`;
  }

  private truncateOutput(output: string, limit = 1200): string {
    const stripped = output
      .replace(/\x1b\[[0-9;]*m/g, "")
      .replace(/\r/g, "")
      .trim();
    if (stripped.length <= limit) {
      return stripped;
    }
    return `${stripped.slice(0, limit).trimEnd()}\n...truncated`;
  }

  private async generatePrompt(
    repo: RepoConfig,
    task: UnifiedTask,
    branchName: string
  ): Promise<string> {
    // Use Brain's reasoner for better prompts
    const guidance = await this.brain
      .reason(
        `
Write 2-3 sentences of guidance for a coding agent working on:
Task: ${task.title}
Type: ${task.type}
Description: ${task.description || "N/A"}

Be specific about files to check and approach to take. Under 50 words:
    `
      )
      .catch(() => "Focus on the task, make minimal changes, run tests.");

    const testCommand = this.getTestCommand(repo);
    const typecheckCommand = this.getTypecheckCommand(repo);
    const sameCommand =
      typecheckCommand.trim().toLowerCase() ===
      testCommand.trim().toLowerCase();

    // Include feature context for PRD tasks
    const featureContext =
      task.source === "prd" && task.prdFeature
        ? `\n## Feature: ${task.prdFeature.title}\n${task.prdFeature.description}\n`
        : "";

    return `
# Task: ${task.id} - ${task.title}

## Type: ${task.type}
${featureContext}
## Repo
Path: ${repo.path}
Branch: ${branchName}

## Description
${task.description || "See title."}

## Guidance
${guidance}

## Instructions
${(() => {
  const steps: string[] = [];
  const add = (text: string) => steps.push(`${steps.length + 1}. ${text}`);

  add("Focus ONLY on this task");
  add("Make minimal, targeted changes");
  add("Write/update tests");
  if (sameCommand) {
    add(`Run: ${testCommand}`);
  } else {
    add(`Run: ${typecheckCommand}`);
    add(`Run: ${testCommand}`);
  }
  add("Summarise what you changed");
  add("When asking for confirmation, prefer [y/n] or numbered options");
  add(`When task is complete, output: ${COMPLETION_SIGNAL}`);

  return steps.join("\n");
})()}

Begin.
`.trim();
  }

  /**
   * Generate a concise CLI prompt for inline mode (-p flag)
   * Includes completion signal instruction for Darwin to detect task completion
   */
  private generateInlinePrompt(task: UnifiedTask, isResume: boolean): string {
    const action = isResume ? "continue implementing" : "implement";
    const statusNote =
      task.status.toLowerCase() === "in_progress"
        ? " It has already been marked as in progress so just needs implementing."
        : "";

    // Use appropriate task description based on source
    const taskRef =
      task.source === "prd"
        ? `PRD task ${task.id} (feature: ${task.featureId})`
        : `beads task ${task.id}`;

    return `${action} ${taskRef}.${statusNote} When finished please commit and push to branch. Signal completion with: ${COMPLETION_SIGNAL}`;
  }

  private async generateCommitMessage(task: UnifiedTask): Promise<string> {
    const type = task.type === "bug" ? "fix" : "feat";
    return `${type}(${task.id}): ${task.title.toLowerCase().slice(0, 50)}`;
  }

  private async createPR(repo: RepoConfig, task: UnifiedTask): Promise<string> {
    const branch = await this.getCurrentBranch(repo);
    const description = await this.brain
      .reason(
        `
Write a brief PR description for:
Task: ${task.id} - ${task.title}
Type: ${task.type}

Include what was changed and how it was tested. Under 100 words:
    `
      )
      .catch(() => `Closes ${task.id}`);

    const { stdout } = await execAsync(
      `gh pr create --title "${task.id}: ${
        task.title
      }" --body "${description.replace(
        /"/g,
        '\\"'
      )}" --base main --head ${branch}`,
      { cwd: repo.path }
    );

    return stdout.trim();
  }
}

// Keep old class name as alias
export { CodeAgentModule as HomebaseCodeAgentModule };
