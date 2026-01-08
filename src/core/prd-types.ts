/**
 * PRD (Product Requirements Document) Types
 *
 * TypeScript interfaces for the prd.json schema.
 * This file defines the structure for feature-based task management
 * that replaces the Beads CLI system.
 */

/**
 * Status for both features and tasks
 */
export type PrdStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/**
 * A single task within a feature
 */
export interface PrdTask {
  /** Unique task identifier (e.g., "task-001") */
  id: string;
  /** Short title describing the task */
  title: string;
  /** Detailed description of what needs to be done */
  description: string;
  /** Current status of the task */
  status: PrdStatus;
  /** Whether the task passes typecheck and tests (null = not yet run) */
  passes: boolean | null;
  /** Git commit SHA after task completion */
  commit_sha: string | null;
}

/**
 * A feature containing one or more tasks
 */
export interface PrdFeature {
  /** Unique feature identifier (e.g., "feature-001") */
  id: string;
  /** Short title for the feature */
  title: string;
  /** Detailed description of the feature */
  description: string;
  /** Priority level (1 = highest) */
  priority: number;
  /** Current status of the feature */
  status: PrdStatus;
  /** Whether all tasks pass typecheck and tests */
  passes: boolean;
  /** Git branch name for this feature */
  branch: string | null;
  /** Pull request URL once created */
  pr_url: string | null;
  /** Tasks that make up this feature */
  tasks: PrdTask[];
  /** Acceptance criteria for the feature */
  acceptance_criteria: string[];
  /** ISO timestamp when feature was created */
  created_at: string;
  /** ISO timestamp when feature was last updated */
  updated_at: string;
}

/**
 * The root prd.json structure
 */
export interface PrdDocument {
  /** Schema version */
  version: string;
  /** Project name */
  project: string;
  /** List of features to implement */
  features: PrdFeature[];
}

/**
 * Status tracking written to ~/.darwin/status.json
 */
export interface DarwinStatus {
  /** Currently active feature ID */
  current_feature: string | null;
  /** Currently active task ID */
  current_task: string | null;
  /** Human-readable progress (e.g., "2/5 tasks") */
  progress: string;
  /** Overall Darwin status */
  status: 'idle' | 'working' | 'waiting' | 'error';
  /** Last error message if status is 'error' */
  last_error?: string;
  /** ISO timestamp of last update */
  updated_at: string;
}

/**
 * Result of running typecheck and tests
 */
export interface ValidationResult {
  /** Whether typecheck passed */
  typecheckPassed: boolean;
  /** Typecheck error output if failed */
  typecheckError?: string;
  /** Whether tests passed */
  testsPassed: boolean;
  /** Test error output if failed */
  testsError?: string;
  /** Overall pass (both typecheck and tests passed) */
  passed: boolean;
}

/**
 * Completion signal patterns
 */
export const COMPLETION_SIGNAL = '<darwin:task-complete />';

/**
 * Helper to create a new task with defaults
 */
export function createTask(id: string, title: string, description: string): PrdTask {
  return {
    id,
    title,
    description,
    status: 'pending',
    passes: null,
    commit_sha: null,
  };
}

/**
 * Helper to create a new feature with defaults
 */
export function createFeature(
  id: string,
  title: string,
  description: string,
  priority: number = 1,
  tasks: PrdTask[] = [],
  acceptanceCriteria: string[] = []
): PrdFeature {
  const now = new Date().toISOString();
  return {
    id,
    title,
    description,
    priority,
    status: 'pending',
    passes: false,
    branch: null,
    pr_url: null,
    tasks,
    acceptance_criteria: acceptanceCriteria,
    created_at: now,
    updated_at: now,
  };
}

/**
 * Helper to create an empty PRD document
 */
export function createPrdDocument(project: string, version: string = '1.0.0'): PrdDocument {
  return {
    version,
    project,
    features: [],
  };
}

/**
 * Helper to generate a feature ID
 */
export function generateFeatureId(index: number): string {
  return `feature-${String(index + 1).padStart(3, '0')}`;
}

/**
 * Helper to generate a task ID
 */
export function generateTaskId(featureIndex: number, taskIndex: number): string {
  return `task-${String(featureIndex + 1).padStart(2, '0')}-${String(taskIndex + 1).padStart(3, '0')}`;
}
