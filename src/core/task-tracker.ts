/**
 * TaskTracker - Provides visibility into Ralph task execution
 *
 * Tracks the full lifecycle of tasks:
 *   pending → cloning → running → completed/failed
 *
 * Emits events for UI updates and integrates with the monologue system.
 */

import { EventEmitter } from 'events';
import { eventBus } from './event-bus.js';
import { getMonologue } from './monologue.js';

export type TaskPhase =
  | 'pending'     // Task requested, not started
  | 'cloning'     // Git clone in progress
  | 'starting'    // Workspace ready, about to run ralph.sh
  | 'running'     // ralph.sh executing
  | 'completed'   // Finished successfully
  | 'failed';     // Error occurred

export interface TaskInfo {
  id: string;
  repoName: string;
  sshUrl: string;
  phase: TaskPhase;
  workDir?: string;
  startedAt: Date;
  cloneStartedAt?: Date;
  cloneCompletedAt?: Date;
  runStartedAt?: Date;
  completedAt?: Date;
  error?: string;
  exitCode?: number;
  outputLines: number;
  lastOutput?: string;
}

export interface TaskSummary {
  id: string;
  repoName: string;
  phase: TaskPhase;
  elapsed: string;
  workDir?: string;
  error?: string;
}

/**
 * Format duration in human-readable form
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainingSecs = secs % 60;
  if (mins < 60) return `${mins}m ${remainingSecs}s`;
  const hours = Math.floor(mins / 60);
  const remainingMins = mins % 60;
  return `${hours}h ${remainingMins}m`;
}

/**
 * ANSI formatting
 */
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const BLUE = '\x1b[34m';

const PHASE_DISPLAY: Record<TaskPhase, { icon: string; color: string; label: string }> = {
  pending: { icon: '\u{23F3}', color: DIM, label: 'Pending' },        // hourglass
  cloning: { icon: '\u{1F4E5}', color: CYAN, label: 'Cloning' },      // inbox tray
  starting: { icon: '\u{1F680}', color: BLUE, label: 'Starting' },    // rocket
  running: { icon: '\u{26A1}', color: YELLOW, label: 'Running' },     // lightning
  completed: { icon: '\u{2705}', color: GREEN, label: 'Completed' },  // check mark
  failed: { icon: '\u{274C}', color: RED, label: 'Failed' },          // cross mark
};

export class TaskTracker extends EventEmitter {
  private currentTask: TaskInfo | null = null;
  private taskHistory: TaskInfo[] = [];
  private monologue = getMonologue();

  /**
   * Start tracking a new task
   */
  startTask(repoName: string, sshUrl: string): TaskInfo {
    const task: TaskInfo = {
      id: `task-${repoName}-${Date.now()}`,
      repoName,
      sshUrl,
      phase: 'pending',
      startedAt: new Date(),
      outputLines: 0,
    };

    this.currentTask = task;
    this.emitUpdate('started', task);
    this.monologue.act(`Starting task for ${repoName}`, { taskId: task.id });

    return task;
  }

  /**
   * Update phase to cloning
   */
  setCloning(workDir: string): void {
    if (!this.currentTask) return;

    this.currentTask.phase = 'cloning';
    this.currentTask.workDir = workDir;
    this.currentTask.cloneStartedAt = new Date();

    this.emitUpdate('cloning', this.currentTask);
    this.monologue.act(`Cloning ${this.currentTask.repoName} via SSH...`, {
      taskId: this.currentTask.id,
      workDir,
    });
  }

  /**
   * Update phase to starting (clone complete)
   */
  setStarting(): void {
    if (!this.currentTask) return;

    this.currentTask.phase = 'starting';
    this.currentTask.cloneCompletedAt = new Date();

    const cloneDuration = this.currentTask.cloneStartedAt
      ? Date.now() - this.currentTask.cloneStartedAt.getTime()
      : 0;

    this.emitUpdate('starting', this.currentTask);
    this.monologue.result(`Clone complete (${formatDuration(cloneDuration)}), starting ralph.sh`, {
      taskId: this.currentTask.id,
    });
  }

  /**
   * Update phase to running
   */
  setRunning(): void {
    if (!this.currentTask) return;

    this.currentTask.phase = 'running';
    this.currentTask.runStartedAt = new Date();

    this.emitUpdate('running', this.currentTask);
    this.monologue.act(`ralph.sh is now running in ${this.currentTask.repoName}`, {
      taskId: this.currentTask.id,
    });
  }

  /**
   * Record output line (for counting/tracking)
   */
  recordOutput(line: string): void {
    if (!this.currentTask) return;

    this.currentTask.outputLines++;
    this.currentTask.lastOutput = line.trim().slice(0, 100);

    // Emit less frequently to avoid flooding
    if (this.currentTask.outputLines % 10 === 0) {
      this.emitUpdate('output', this.currentTask);
    }
  }

  /**
   * Mark task as completed successfully
   */
  complete(exitCode: number = 0): void {
    if (!this.currentTask) return;

    this.currentTask.phase = 'completed';
    this.currentTask.completedAt = new Date();
    this.currentTask.exitCode = exitCode;

    const duration = Date.now() - this.currentTask.startedAt.getTime();

    this.emitUpdate('completed', this.currentTask);
    this.monologue.result(
      `Task ${this.currentTask.repoName} completed successfully (${formatDuration(duration)})`,
      { taskId: this.currentTask.id, exitCode, outputLines: this.currentTask.outputLines }
    );

    this.archiveTask();
  }

  /**
   * Mark task as failed
   */
  fail(error: string, exitCode?: number): void {
    if (!this.currentTask) return;

    this.currentTask.phase = 'failed';
    this.currentTask.completedAt = new Date();
    this.currentTask.error = error;
    this.currentTask.exitCode = exitCode;

    const duration = Date.now() - this.currentTask.startedAt.getTime();

    this.emitUpdate('failed', this.currentTask);
    this.monologue.alert(
      `Task ${this.currentTask.repoName} failed: ${error} (after ${formatDuration(duration)})`,
      { taskId: this.currentTask.id, error, exitCode }
    );

    this.archiveTask();
  }

  /**
   * Get current task info
   */
  getCurrentTask(): TaskInfo | null {
    return this.currentTask;
  }

  /**
   * Get task history
   */
  getHistory(limit: number = 10): TaskInfo[] {
    return this.taskHistory.slice(-limit);
  }

  /**
   * Get a summary of the current task for display
   */
  getSummary(): TaskSummary | null {
    if (!this.currentTask) return null;

    const elapsed = Date.now() - this.currentTask.startedAt.getTime();

    return {
      id: this.currentTask.id,
      repoName: this.currentTask.repoName,
      phase: this.currentTask.phase,
      elapsed: formatDuration(elapsed),
      workDir: this.currentTask.workDir,
      error: this.currentTask.error,
    };
  }

  /**
   * Format task status for terminal display
   */
  formatStatus(): string {
    if (!this.currentTask) {
      return `${DIM}No active task${RESET}`;
    }

    const task = this.currentTask;
    const display = PHASE_DISPLAY[task.phase];
    const elapsed = formatDuration(Date.now() - task.startedAt.getTime());

    const lines: string[] = [];

    // Header
    lines.push('');
    lines.push(`${BOLD}Task Status${RESET}`);
    lines.push(`${'─'.repeat(50)}`);

    // Main status line
    lines.push(`${display.icon} ${display.color}${display.label}${RESET} ${BOLD}${task.repoName}${RESET}`);

    // Details based on phase
    lines.push(`   ${DIM}Elapsed:${RESET} ${elapsed}`);

    if (task.workDir) {
      lines.push(`   ${DIM}Workspace:${RESET} ${task.workDir}`);
    }

    if (task.phase === 'cloning' && task.cloneStartedAt) {
      const cloneElapsed = formatDuration(Date.now() - task.cloneStartedAt.getTime());
      lines.push(`   ${DIM}Clone time:${RESET} ${cloneElapsed}`);
    }

    if (task.phase === 'running') {
      lines.push(`   ${DIM}Output lines:${RESET} ${task.outputLines}`);
      if (task.lastOutput) {
        lines.push(`   ${DIM}Last output:${RESET} ${task.lastOutput.slice(0, 60)}...`);
      }
    }

    if (task.error) {
      lines.push(`   ${RED}Error:${RESET} ${task.error}`);
    }

    lines.push(`${'─'.repeat(50)}`);
    lines.push('');

    return lines.join('\n');
  }

  /**
   * Format a compact one-line status
   */
  formatCompact(): string {
    if (!this.currentTask) {
      return `${DIM}No active task${RESET}`;
    }

    const task = this.currentTask;
    const display = PHASE_DISPLAY[task.phase];
    const elapsed = formatDuration(Date.now() - task.startedAt.getTime());

    return `${display.icon} ${display.color}${display.label}${RESET}: ${task.repoName} (${elapsed})`;
  }

  /**
   * Archive current task to history
   */
  private archiveTask(): void {
    if (this.currentTask) {
      this.taskHistory.push({ ...this.currentTask });
      // Keep last 50 tasks
      if (this.taskHistory.length > 50) {
        this.taskHistory.shift();
      }
    }
    this.currentTask = null;
  }

  /**
   * Emit update event
   */
  private emitUpdate(event: string, task: TaskInfo): void {
    this.emit(event, task);
    this.emit('update', { event, task });

    eventBus.publish('task', event, {
      taskId: task.id,
      repoName: task.repoName,
      phase: task.phase,
      workDir: task.workDir,
      error: task.error,
    });
  }
}

// Singleton instance
let trackerInstance: TaskTracker | null = null;

export function getTaskTracker(): TaskTracker {
  if (!trackerInstance) {
    trackerInstance = new TaskTracker();
  }
  return trackerInstance;
}

export function resetTaskTracker(): void {
  trackerInstance = null;
}
