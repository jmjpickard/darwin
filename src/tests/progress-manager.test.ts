/**
 * Unit tests for ProgressManager
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, rm, mkdir, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { ProgressManager } from '../core/progress-manager.js';

describe('ProgressManager', () => {
  let testDir: string;
  let manager: ProgressManager;

  beforeEach(async () => {
    testDir = join(tmpdir(), `darwin-progress-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    manager = new ProgressManager(testDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('exists()', () => {
    it('returns false when progress file does not exist', async () => {
      expect(await manager.exists('feature-001')).toBe(false);
    });

    it('returns true when progress file exists', async () => {
      await manager.ensureDir();
      await writeFile(manager.getProgressPath('feature-001'), 'test');
      expect(await manager.exists('feature-001')).toBe(true);
    });
  });

  describe('ensureDir()', () => {
    it('creates .darwin directory', async () => {
      await manager.ensureDir();
      const path = manager.getProgressDir();
      expect(path).toContain('.darwin');
    });
  });

  describe('getOrCreate()', () => {
    it('creates new progress document', async () => {
      const doc = await manager.getOrCreate('feature-001', 'Test Feature');

      expect(doc.featureId).toBe('feature-001');
      expect(doc.featureTitle).toBe('Test Feature');
      expect(doc.entries).toEqual([]);
    });

    it('returns existing document', async () => {
      const content = `# Progress: feature-001 (Test Feature)

## Task 1: First Task (task-001)
- Did something
- Did something else
`;
      await manager.ensureDir();
      await writeFile(manager.getProgressPath('feature-001'), content);

      const doc = await manager.getOrCreate('feature-001', 'Test Feature');

      expect(doc.entries).toHaveLength(1);
      expect(doc.entries[0].taskId).toBe('task-001');
      expect(doc.entries[0].notes).toEqual(['Did something', 'Did something else']);
    });
  });

  describe('addTaskEntry()', () => {
    it('adds new task entry', async () => {
      await manager.addTaskEntry('feature-001', 'Test Feature', 'task-001', 'First Task', [
        'Note 1',
        'Note 2',
      ]);

      const doc = await manager.load('feature-001');
      expect(doc?.entries).toHaveLength(1);
      expect(doc?.entries[0].taskId).toBe('task-001');
      expect(doc?.entries[0].notes).toEqual(['Note 1', 'Note 2']);
    });

    it('updates existing task entry', async () => {
      await manager.addTaskEntry('feature-001', 'Test Feature', 'task-001', 'First Task', [
        'Original note',
      ]);
      await manager.addTaskEntry('feature-001', 'Test Feature', 'task-001', 'First Task', [
        'Updated note',
      ]);

      const doc = await manager.load('feature-001');
      expect(doc?.entries).toHaveLength(1);
      expect(doc?.entries[0].notes).toEqual(['Updated note']);
    });

    it('adds multiple task entries', async () => {
      await manager.addTaskEntry('feature-001', 'Test Feature', 'task-001', 'First Task', [
        'Note 1',
      ]);
      await manager.addTaskEntry('feature-001', 'Test Feature', 'task-002', 'Second Task', [
        'Note 2',
      ]);

      const doc = await manager.load('feature-001');
      expect(doc?.entries).toHaveLength(2);
    });
  });

  describe('appendNotes()', () => {
    it('appends notes to existing entry', async () => {
      await manager.addTaskEntry('feature-001', 'Test Feature', 'task-001', 'First Task', [
        'Original note',
      ]);
      const result = await manager.appendNotes('feature-001', 'task-001', ['New note']);

      expect(result).toBe(true);

      const doc = await manager.load('feature-001');
      expect(doc?.entries[0].notes).toEqual(['Original note', 'New note']);
    });

    it('returns false for non-existent feature', async () => {
      const result = await manager.appendNotes('unknown', 'task-001', ['Note']);
      expect(result).toBe(false);
    });

    it('returns false for non-existent task', async () => {
      await manager.addTaskEntry('feature-001', 'Test Feature', 'task-001', 'First Task', ['Note']);
      const result = await manager.appendNotes('feature-001', 'unknown', ['Note']);
      expect(result).toBe(false);
    });
  });

  describe('getSummary()', () => {
    it('returns null for non-existent feature', async () => {
      const summary = await manager.getSummary('unknown');
      expect(summary).toBeNull();
    });

    it('returns summary for existing feature', async () => {
      await manager.addTaskEntry('feature-001', 'Test Feature', 'task-001', 'First Task', [
        'Note 1',
        'Note 2',
      ]);
      await manager.addTaskEntry('feature-001', 'Test Feature', 'task-002', 'Second Task', [
        'Note 3',
      ]);

      const summary = await manager.getSummary('feature-001');

      expect(summary).toContain('Feature: Test Feature');
      expect(summary).toContain('Tasks completed: 2');
      expect(summary).toContain('First Task: 2 notes');
      expect(summary).toContain('Second Task: 1 notes');
    });
  });

  describe('listAll()', () => {
    it('returns empty array when no progress files', async () => {
      const files = await manager.listAll();
      expect(files).toEqual([]);
    });

    it('lists all feature IDs with progress files', async () => {
      await manager.addTaskEntry('feature-001', 'Feature 1', 'task-001', 'Task', ['Note']);
      await manager.addTaskEntry('feature-002', 'Feature 2', 'task-001', 'Task', ['Note']);
      await manager.addTaskEntry('feature-003', 'Feature 3', 'task-001', 'Task', ['Note']);

      const files = await manager.listAll();

      expect(files).toContain('feature-001');
      expect(files).toContain('feature-002');
      expect(files).toContain('feature-003');
      expect(files).toHaveLength(3);
    });
  });

  describe('getRawContent()', () => {
    it('returns null for non-existent file', async () => {
      const content = await manager.getRawContent('unknown');
      expect(content).toBeNull();
    });

    it('returns raw file content', async () => {
      await manager.addTaskEntry('feature-001', 'Test Feature', 'task-001', 'First Task', [
        'Note 1',
      ]);

      const content = await manager.getRawContent('feature-001');

      expect(content).toContain('# Progress: feature-001 (Test Feature)');
      expect(content).toContain('## Task 1: First Task (task-001)');
      expect(content).toContain('- Note 1');
    });
  });

  describe('file format', () => {
    it('produces correct markdown format', async () => {
      await manager.addTaskEntry('feature-001', 'Add Authentication', 'task-001', 'Create auth service', [
        'Created src/services/auth.ts with OAuth2 client',
        'Used passport.js pattern from existing middleware',
        'Note: Google OAuth requires callback URL in .env',
      ]);

      const content = await manager.getRawContent('feature-001');

      expect(content).toBe(`# Progress: feature-001 (Add Authentication)

## Task 1: Create auth service (task-001)
- Created src/services/auth.ts with OAuth2 client
- Used passport.js pattern from existing middleware
- Note: Google OAuth requires callback URL in .env
`);
    });
  });
});
