/**
 * PRD Manager
 *
 * Manages reading and writing prd.json files for feature-based task management.
 * Replaces the Beads CLI system with a file-based approach.
 */

import { readFile, writeFile, access } from 'fs/promises';
import { join } from 'path';
import { Logger } from './logger.js';
import {
  PrdDocument,
  PrdFeature,
  PrdTask,
  PrdStatus,
  createPrdDocument,
} from './prd-types.js';

const logger = new Logger('PrdManager');

/**
 * Manages prd.json files for a repository
 */
export class PrdManager {
  private prdPath: string;
  private document: PrdDocument | null = null;

  /**
   * Create a PrdManager for a repository
   * @param repoPath - Path to the repository root
   */
  constructor(repoPath: string) {
    this.prdPath = join(repoPath, 'prd.json');
  }

  /**
   * Get the path to the prd.json file
   */
  getPath(): string {
    return this.prdPath;
  }

  /**
   * Check if prd.json exists
   */
  async exists(): Promise<boolean> {
    try {
      await access(this.prdPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Load prd.json from disk
   * Creates an empty document if file doesn't exist
   */
  async load(): Promise<PrdDocument> {
    try {
      const content = await readFile(this.prdPath, 'utf-8');
      this.document = JSON.parse(content) as PrdDocument;
      logger.debug(`Loaded prd.json with ${this.document.features.length} features`);
      return this.document;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.info('No prd.json found, creating empty document');
        this.document = createPrdDocument('unknown');
        return this.document;
      }
      throw error;
    }
  }

  /**
   * Save current document to disk
   */
  async save(): Promise<void> {
    if (!this.document) {
      throw new Error('No document loaded. Call load() first.');
    }
    const content = JSON.stringify(this.document, null, 2);
    await writeFile(this.prdPath, content, 'utf-8');
    logger.debug('Saved prd.json');
  }

  /**
   * Get the current document (must call load() first)
   */
  getDocument(): PrdDocument {
    if (!this.document) {
      throw new Error('No document loaded. Call load() first.');
    }
    return this.document;
  }

  /**
   * Get all features
   */
  getFeatures(): PrdFeature[] {
    return this.getDocument().features;
  }

  /**
   * Get a feature by ID
   */
  getFeature(featureId: string): PrdFeature | undefined {
    return this.getDocument().features.find((f) => f.id === featureId);
  }

  /**
   * Get the next feature to work on (highest priority, first pending)
   */
  getNextFeature(): PrdFeature | undefined {
    const features = this.getDocument().features
      .filter((f) => f.status === 'pending' || f.status === 'in_progress')
      .sort((a, b) => a.priority - b.priority);
    return features[0];
  }

  /**
   * Get all features with a specific status
   */
  getFeaturesByStatus(status: PrdStatus): PrdFeature[] {
    return this.getDocument().features.filter((f) => f.status === status);
  }

  /**
   * Get the next task to work on for a feature
   */
  getNextTask(featureId: string): PrdTask | undefined {
    const feature = this.getFeature(featureId);
    if (!feature) return undefined;

    const tasks = feature.tasks.filter(
      (t) => t.status === 'pending' || t.status === 'in_progress'
    );
    return tasks[0];
  }

  /**
   * Get a specific task from a feature
   */
  getTask(featureId: string, taskId: string): PrdTask | undefined {
    const feature = this.getFeature(featureId);
    return feature?.tasks.find((t) => t.id === taskId);
  }

  /**
   * Update a feature's status
   */
  updateFeatureStatus(featureId: string, status: PrdStatus): void {
    const feature = this.getFeature(featureId);
    if (!feature) {
      throw new Error(`Feature not found: ${featureId}`);
    }
    feature.status = status;
    feature.updated_at = new Date().toISOString();
    logger.info(`Updated feature ${featureId} status to ${status}`);
  }

  /**
   * Update a feature's branch
   */
  setFeatureBranch(featureId: string, branch: string): void {
    const feature = this.getFeature(featureId);
    if (!feature) {
      throw new Error(`Feature not found: ${featureId}`);
    }
    feature.branch = branch;
    feature.updated_at = new Date().toISOString();
    logger.debug(`Set feature ${featureId} branch to ${branch}`);
  }

  /**
   * Update a feature's PR URL
   */
  setFeaturePr(featureId: string, prUrl: string): void {
    const feature = this.getFeature(featureId);
    if (!feature) {
      throw new Error(`Feature not found: ${featureId}`);
    }
    feature.pr_url = prUrl;
    feature.updated_at = new Date().toISOString();
    logger.info(`Set feature ${featureId} PR URL to ${prUrl}`);
  }

  /**
   * Mark a feature as passing or failing validation
   */
  markFeaturePasses(featureId: string, passes: boolean): void {
    const feature = this.getFeature(featureId);
    if (!feature) {
      throw new Error(`Feature not found: ${featureId}`);
    }
    feature.passes = passes;
    feature.updated_at = new Date().toISOString();
    logger.info(`Marked feature ${featureId} passes=${passes}`);
  }

  /**
   * Update a task's status
   */
  updateTaskStatus(featureId: string, taskId: string, status: PrdStatus): void {
    const feature = this.getFeature(featureId);
    if (!feature) {
      throw new Error(`Feature not found: ${featureId}`);
    }
    const task = feature.tasks.find((t) => t.id === taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    task.status = status;
    feature.updated_at = new Date().toISOString();
    logger.info(`Updated task ${taskId} status to ${status}`);
  }

  /**
   * Mark a task as completed with commit SHA
   */
  markTaskCompleted(
    featureId: string,
    taskId: string,
    commitSha: string,
    passes: boolean
  ): void {
    const feature = this.getFeature(featureId);
    if (!feature) {
      throw new Error(`Feature not found: ${featureId}`);
    }
    const task = feature.tasks.find((t) => t.id === taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    task.status = 'completed';
    task.commit_sha = commitSha;
    task.passes = passes;
    feature.updated_at = new Date().toISOString();
    logger.info(`Completed task ${taskId} with commit ${commitSha.slice(0, 7)}`);
  }

  /**
   * Mark a task as failed
   */
  markTaskFailed(featureId: string, taskId: string, passes: boolean = false): void {
    const feature = this.getFeature(featureId);
    if (!feature) {
      throw new Error(`Feature not found: ${featureId}`);
    }
    const task = feature.tasks.find((t) => t.id === taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    task.status = 'failed';
    task.passes = passes;
    feature.updated_at = new Date().toISOString();
    logger.warn(`Marked task ${taskId} as failed`);
  }

  /**
   * Add a new feature to the document
   */
  addFeature(feature: PrdFeature): void {
    const doc = this.getDocument();
    if (doc.features.some((f) => f.id === feature.id)) {
      throw new Error(`Feature already exists: ${feature.id}`);
    }
    doc.features.push(feature);
    logger.info(`Added feature ${feature.id}: ${feature.title}`);
  }

  /**
   * Add a task to a feature
   */
  addTask(featureId: string, task: PrdTask): void {
    const feature = this.getFeature(featureId);
    if (!feature) {
      throw new Error(`Feature not found: ${featureId}`);
    }
    if (feature.tasks.some((t) => t.id === task.id)) {
      throw new Error(`Task already exists: ${task.id}`);
    }
    feature.tasks.push(task);
    feature.updated_at = new Date().toISOString();
    logger.info(`Added task ${task.id} to feature ${featureId}`);
  }

  /**
   * Check if all tasks in a feature are completed
   */
  isFeatureComplete(featureId: string): boolean {
    const feature = this.getFeature(featureId);
    if (!feature || feature.tasks.length === 0) return false;
    return feature.tasks.every((t) => t.status === 'completed');
  }

  /**
   * Check if all tasks in a feature pass validation
   */
  doAllTasksPass(featureId: string): boolean {
    const feature = this.getFeature(featureId);
    if (!feature || feature.tasks.length === 0) return false;
    return feature.tasks.every((t) => t.passes === true);
  }

  /**
   * Get progress summary for a feature
   */
  getFeatureProgress(featureId: string): string {
    const feature = this.getFeature(featureId);
    if (!feature) return '0/0 tasks';
    const completed = feature.tasks.filter((t) => t.status === 'completed').length;
    return `${completed}/${feature.tasks.length} tasks`;
  }

  /**
   * Get overall progress summary
   */
  getOverallProgress(): {
    totalFeatures: number;
    completedFeatures: number;
    pendingFeatures: number;
    inProgressFeatures: number;
  } {
    const features = this.getFeatures();
    return {
      totalFeatures: features.length,
      completedFeatures: features.filter((f) => f.status === 'completed').length,
      pendingFeatures: features.filter((f) => f.status === 'pending').length,
      inProgressFeatures: features.filter((f) => f.status === 'in_progress').length,
    };
  }
}
