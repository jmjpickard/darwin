/**
 * Progress Manager
 *
 * Manages progress.txt files for features to create "memory" between Claude sessions.
 * Each feature gets a progress file at .darwin/progress-{feature-id}.txt
 */

import { readFile, writeFile, mkdir, access, readdir } from 'fs/promises';
import { join, basename } from 'path';
import { Logger } from './logger.js';

const logger = new Logger('ProgressManager');

/**
 * A single progress entry for a task
 */
export interface ProgressEntry {
  taskId: string;
  taskTitle: string;
  notes: string[];
  timestamp: string;
}

/**
 * Progress document for a feature
 */
export interface ProgressDocument {
  featureId: string;
  featureTitle: string;
  entries: ProgressEntry[];
}

/**
 * Manages progress files for features
 */
export class ProgressManager {
  private progressDir: string;

  /**
   * Create a ProgressManager
   * @param repoPath - Path to the repository root
   */
  constructor(repoPath: string) {
    this.progressDir = join(repoPath, '.darwin');
  }

  /**
   * Get the path to the progress directory
   */
  getProgressDir(): string {
    return this.progressDir;
  }

  /**
   * Get the path to a feature's progress file
   */
  getProgressPath(featureId: string): string {
    return join(this.progressDir, `progress-${featureId}.txt`);
  }

  /**
   * Ensure the .darwin directory exists
   */
  async ensureDir(): Promise<void> {
    try {
      await access(this.progressDir);
    } catch {
      await mkdir(this.progressDir, { recursive: true });
      logger.debug(`Created progress directory: ${this.progressDir}`);
    }
  }

  /**
   * Check if a progress file exists for a feature
   */
  async exists(featureId: string): Promise<boolean> {
    try {
      await access(this.getProgressPath(featureId));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Parse a progress file into a structured document
   */
  private parseProgressFile(content: string, featureId: string): ProgressDocument {
    const lines = content.split('\n');
    const doc: ProgressDocument = {
      featureId,
      featureTitle: '',
      entries: [],
    };

    let currentEntry: ProgressEntry | null = null;

    for (const line of lines) {
      // Parse header: # Progress: feature-001 (Feature Title)
      const headerMatch = line.match(/^# Progress: ([^\s]+)\s*\(([^)]+)\)/);
      if (headerMatch) {
        doc.featureTitle = headerMatch[2];
        continue;
      }

      // Parse task header: ## Task 1: Task Title (task-001)
      const taskMatch = line.match(/^## Task \d+: ([^(]+)\(([^)]+)\)/);
      if (taskMatch) {
        if (currentEntry) {
          doc.entries.push(currentEntry);
        }
        currentEntry = {
          taskId: taskMatch[2].trim(),
          taskTitle: taskMatch[1].trim(),
          notes: [],
          timestamp: new Date().toISOString(),
        };
        continue;
      }

      // Parse note line: - Note content
      if (currentEntry && line.startsWith('- ')) {
        currentEntry.notes.push(line.slice(2));
      }
    }

    if (currentEntry) {
      doc.entries.push(currentEntry);
    }

    return doc;
  }

  /**
   * Format a progress document as text
   */
  private formatProgressFile(doc: ProgressDocument): string {
    const lines: string[] = [];

    lines.push(`# Progress: ${doc.featureId} (${doc.featureTitle})`);
    lines.push('');

    doc.entries.forEach((entry, index) => {
      lines.push(`## Task ${index + 1}: ${entry.taskTitle} (${entry.taskId})`);
      for (const note of entry.notes) {
        lines.push(`- ${note}`);
      }
      lines.push('');
    });

    return lines.join('\n');
  }

  /**
   * Load progress for a feature
   */
  async load(featureId: string): Promise<ProgressDocument | null> {
    try {
      const content = await readFile(this.getProgressPath(featureId), 'utf-8');
      return this.parseProgressFile(content, featureId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Save progress for a feature
   */
  async save(doc: ProgressDocument): Promise<void> {
    await this.ensureDir();
    const content = this.formatProgressFile(doc);
    await writeFile(this.getProgressPath(doc.featureId), content, 'utf-8');
    logger.debug(`Saved progress for feature ${doc.featureId}`);
  }

  /**
   * Initialize or get progress for a feature
   */
  async getOrCreate(featureId: string, featureTitle: string): Promise<ProgressDocument> {
    const existing = await this.load(featureId);
    if (existing) {
      return existing;
    }

    const doc: ProgressDocument = {
      featureId,
      featureTitle,
      entries: [],
    };
    await this.save(doc);
    return doc;
  }

  /**
   * Add a task entry to a feature's progress
   */
  async addTaskEntry(
    featureId: string,
    featureTitle: string,
    taskId: string,
    taskTitle: string,
    notes: string[]
  ): Promise<void> {
    const doc = await this.getOrCreate(featureId, featureTitle);

    // Check if entry already exists for this task
    const existingIndex = doc.entries.findIndex((e) => e.taskId === taskId);

    const entry: ProgressEntry = {
      taskId,
      taskTitle,
      notes,
      timestamp: new Date().toISOString(),
    };

    if (existingIndex >= 0) {
      // Update existing entry
      doc.entries[existingIndex] = entry;
      logger.debug(`Updated progress entry for task ${taskId}`);
    } else {
      // Add new entry
      doc.entries.push(entry);
      logger.info(`Added progress entry for task ${taskId}`);
    }

    await this.save(doc);
  }

  /**
   * Append notes to an existing task entry
   */
  async appendNotes(featureId: string, taskId: string, notes: string[]): Promise<boolean> {
    const doc = await this.load(featureId);
    if (!doc) {
      logger.warn(`No progress file for feature ${featureId}`);
      return false;
    }

    const entry = doc.entries.find((e) => e.taskId === taskId);
    if (!entry) {
      logger.warn(`No entry for task ${taskId} in feature ${featureId}`);
      return false;
    }

    entry.notes.push(...notes);
    entry.timestamp = new Date().toISOString();
    await this.save(doc);

    logger.debug(`Appended ${notes.length} notes to task ${taskId}`);
    return true;
  }

  /**
   * Get progress summary for a feature
   */
  async getSummary(featureId: string): Promise<string | null> {
    const doc = await this.load(featureId);
    if (!doc) {
      return null;
    }

    const lines: string[] = [];
    lines.push(`Feature: ${doc.featureTitle}`);
    lines.push(`Tasks completed: ${doc.entries.length}`);
    lines.push('');

    for (const entry of doc.entries) {
      lines.push(`- ${entry.taskTitle}: ${entry.notes.length} notes`);
    }

    return lines.join('\n');
  }

  /**
   * Get all progress files for a repository
   */
  async listAll(): Promise<string[]> {
    try {
      const files = await readdir(this.progressDir);
      return files
        .filter((f) => f.startsWith('progress-') && f.endsWith('.txt'))
        .map((f) => f.replace('progress-', '').replace('.txt', ''));
    } catch {
      return [];
    }
  }

  /**
   * Get the raw content of a progress file (useful for Claude context)
   */
  async getRawContent(featureId: string): Promise<string | null> {
    try {
      return await readFile(this.getProgressPath(featureId), 'utf-8');
    } catch {
      return null;
    }
  }
}
