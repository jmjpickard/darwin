/**
 * Unit tests for PrdManager
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, rm, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { PrdManager } from '../core/prd-manager.js';
import {
  PrdDocument,
  PrdFeature,
  PrdTask,
  createFeature,
  createTask,
  createPrdDocument,
} from '../core/prd-types.js';

describe('PrdManager', () => {
  let testDir: string;
  let manager: PrdManager;

  beforeEach(async () => {
    testDir = join(tmpdir(), `darwin-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    manager = new PrdManager(testDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('exists()', () => {
    it('returns false when prd.json does not exist', async () => {
      expect(await manager.exists()).toBe(false);
    });

    it('returns true when prd.json exists', async () => {
      await writeFile(join(testDir, 'prd.json'), '{}');
      expect(await manager.exists()).toBe(true);
    });
  });

  describe('load()', () => {
    it('creates empty document when file does not exist', async () => {
      const doc = await manager.load();
      expect(doc.features).toEqual([]);
      expect(doc.project).toBe('unknown');
    });

    it('loads existing prd.json', async () => {
      const prd: PrdDocument = {
        version: '1.0.0',
        project: 'test-project',
        features: [createFeature('f1', 'Feature 1', 'desc')],
      };
      await writeFile(join(testDir, 'prd.json'), JSON.stringify(prd));

      const doc = await manager.load();
      expect(doc.project).toBe('test-project');
      expect(doc.features).toHaveLength(1);
      expect(doc.features[0].id).toBe('f1');
    });
  });

  describe('save()', () => {
    it('throws if no document loaded', async () => {
      await expect(manager.save()).rejects.toThrow('No document loaded');
    });

    it('saves document to file', async () => {
      await manager.load();
      const doc = manager.getDocument();
      doc.project = 'saved-project';

      await manager.save();

      const newManager = new PrdManager(testDir);
      const loaded = await newManager.load();
      expect(loaded.project).toBe('saved-project');
    });
  });

  describe('getNextFeature()', () => {
    it('returns undefined when no features', async () => {
      await manager.load();
      expect(manager.getNextFeature()).toBeUndefined();
    });

    it('returns highest priority pending feature', async () => {
      const prd: PrdDocument = {
        version: '1.0.0',
        project: 'test',
        features: [
          { ...createFeature('f1', 'Low Priority', 'desc'), priority: 3 },
          { ...createFeature('f2', 'High Priority', 'desc'), priority: 1 },
          { ...createFeature('f3', 'Medium Priority', 'desc'), priority: 2 },
        ],
      };
      await writeFile(join(testDir, 'prd.json'), JSON.stringify(prd));
      await manager.load();

      const next = manager.getNextFeature();
      expect(next?.id).toBe('f2');
      expect(next?.priority).toBe(1);
    });

    it('returns in_progress feature over pending', async () => {
      const prd: PrdDocument = {
        version: '1.0.0',
        project: 'test',
        features: [
          { ...createFeature('f1', 'Pending', 'desc'), priority: 1, status: 'pending' },
          { ...createFeature('f2', 'In Progress', 'desc'), priority: 2, status: 'in_progress' },
        ],
      };
      await writeFile(join(testDir, 'prd.json'), JSON.stringify(prd));
      await manager.load();

      const next = manager.getNextFeature();
      // Both are returned, sorted by priority
      expect(next?.id).toBe('f1');
    });

    it('skips completed features', async () => {
      const prd: PrdDocument = {
        version: '1.0.0',
        project: 'test',
        features: [
          { ...createFeature('f1', 'Completed', 'desc'), priority: 1, status: 'completed' },
          { ...createFeature('f2', 'Pending', 'desc'), priority: 2, status: 'pending' },
        ],
      };
      await writeFile(join(testDir, 'prd.json'), JSON.stringify(prd));
      await manager.load();

      const next = manager.getNextFeature();
      expect(next?.id).toBe('f2');
    });
  });

  describe('getNextTask()', () => {
    it('returns undefined for unknown feature', async () => {
      await manager.load();
      expect(manager.getNextTask('unknown')).toBeUndefined();
    });

    it('returns first pending task', async () => {
      const feature = createFeature('f1', 'Feature', 'desc');
      feature.tasks = [
        { ...createTask('t1', 'Task 1', 'desc'), status: 'completed' },
        { ...createTask('t2', 'Task 2', 'desc'), status: 'pending' },
        { ...createTask('t3', 'Task 3', 'desc'), status: 'pending' },
      ];

      const prd: PrdDocument = {
        version: '1.0.0',
        project: 'test',
        features: [feature],
      };
      await writeFile(join(testDir, 'prd.json'), JSON.stringify(prd));
      await manager.load();

      const next = manager.getNextTask('f1');
      expect(next?.id).toBe('t2');
    });

    it('returns in_progress task over pending', async () => {
      const feature = createFeature('f1', 'Feature', 'desc');
      feature.tasks = [
        { ...createTask('t1', 'Task 1', 'desc'), status: 'pending' },
        { ...createTask('t2', 'Task 2', 'desc'), status: 'in_progress' },
      ];

      const prd: PrdDocument = {
        version: '1.0.0',
        project: 'test',
        features: [feature],
      };
      await writeFile(join(testDir, 'prd.json'), JSON.stringify(prd));
      await manager.load();

      const next = manager.getNextTask('f1');
      // Returns first pending/in_progress in order
      expect(next?.id).toBe('t1');
    });
  });

  describe('updateFeatureStatus()', () => {
    it('throws for unknown feature', async () => {
      await manager.load();
      expect(() => manager.updateFeatureStatus('unknown', 'in_progress')).toThrow(
        'Feature not found'
      );
    });

    it('updates feature status', async () => {
      const prd: PrdDocument = {
        version: '1.0.0',
        project: 'test',
        features: [createFeature('f1', 'Feature', 'desc')],
      };
      await writeFile(join(testDir, 'prd.json'), JSON.stringify(prd));
      await manager.load();

      manager.updateFeatureStatus('f1', 'in_progress');

      const feature = manager.getFeature('f1');
      expect(feature?.status).toBe('in_progress');
    });
  });

  describe('markTaskCompleted()', () => {
    it('marks task as completed with commit SHA', async () => {
      const feature = createFeature('f1', 'Feature', 'desc');
      feature.tasks = [createTask('t1', 'Task 1', 'desc')];

      const prd: PrdDocument = {
        version: '1.0.0',
        project: 'test',
        features: [feature],
      };
      await writeFile(join(testDir, 'prd.json'), JSON.stringify(prd));
      await manager.load();

      manager.markTaskCompleted('f1', 't1', 'abc123', true);

      const task = manager.getTask('f1', 't1');
      expect(task?.status).toBe('completed');
      expect(task?.commit_sha).toBe('abc123');
      expect(task?.passes).toBe(true);
    });
  });

  describe('setFeatureBranch()', () => {
    it('sets branch name', async () => {
      const prd: PrdDocument = {
        version: '1.0.0',
        project: 'test',
        features: [createFeature('f1', 'Feature', 'desc')],
      };
      await writeFile(join(testDir, 'prd.json'), JSON.stringify(prd));
      await manager.load();

      manager.setFeatureBranch('f1', 'feature/auth');

      const feature = manager.getFeature('f1');
      expect(feature?.branch).toBe('feature/auth');
    });
  });

  describe('setFeaturePr()', () => {
    it('sets PR URL', async () => {
      const prd: PrdDocument = {
        version: '1.0.0',
        project: 'test',
        features: [createFeature('f1', 'Feature', 'desc')],
      };
      await writeFile(join(testDir, 'prd.json'), JSON.stringify(prd));
      await manager.load();

      manager.setFeaturePr('f1', 'https://github.com/owner/repo/pull/1');

      const feature = manager.getFeature('f1');
      expect(feature?.pr_url).toBe('https://github.com/owner/repo/pull/1');
    });
  });

  describe('isFeatureComplete()', () => {
    it('returns false for unknown feature', async () => {
      await manager.load();
      expect(manager.isFeatureComplete('unknown')).toBe(false);
    });

    it('returns false if any task is not completed', async () => {
      const feature = createFeature('f1', 'Feature', 'desc');
      feature.tasks = [
        { ...createTask('t1', 'Task 1', 'desc'), status: 'completed' },
        { ...createTask('t2', 'Task 2', 'desc'), status: 'pending' },
      ];

      const prd: PrdDocument = {
        version: '1.0.0',
        project: 'test',
        features: [feature],
      };
      await writeFile(join(testDir, 'prd.json'), JSON.stringify(prd));
      await manager.load();

      expect(manager.isFeatureComplete('f1')).toBe(false);
    });

    it('returns true if all tasks completed', async () => {
      const feature = createFeature('f1', 'Feature', 'desc');
      feature.tasks = [
        { ...createTask('t1', 'Task 1', 'desc'), status: 'completed' },
        { ...createTask('t2', 'Task 2', 'desc'), status: 'completed' },
      ];

      const prd: PrdDocument = {
        version: '1.0.0',
        project: 'test',
        features: [feature],
      };
      await writeFile(join(testDir, 'prd.json'), JSON.stringify(prd));
      await manager.load();

      expect(manager.isFeatureComplete('f1')).toBe(true);
    });
  });

  describe('doAllTasksPass()', () => {
    it('returns true when all tasks pass', async () => {
      const feature = createFeature('f1', 'Feature', 'desc');
      feature.tasks = [
        { ...createTask('t1', 'Task 1', 'desc'), status: 'completed', passes: true },
        { ...createTask('t2', 'Task 2', 'desc'), status: 'completed', passes: true },
      ];

      const prd: PrdDocument = {
        version: '1.0.0',
        project: 'test',
        features: [feature],
      };
      await writeFile(join(testDir, 'prd.json'), JSON.stringify(prd));
      await manager.load();

      expect(manager.doAllTasksPass('f1')).toBe(true);
    });

    it('returns false when any task fails', async () => {
      const feature = createFeature('f1', 'Feature', 'desc');
      feature.tasks = [
        { ...createTask('t1', 'Task 1', 'desc'), status: 'completed', passes: true },
        { ...createTask('t2', 'Task 2', 'desc'), status: 'completed', passes: false },
      ];

      const prd: PrdDocument = {
        version: '1.0.0',
        project: 'test',
        features: [feature],
      };
      await writeFile(join(testDir, 'prd.json'), JSON.stringify(prd));
      await manager.load();

      expect(manager.doAllTasksPass('f1')).toBe(false);
    });
  });

  describe('getFeatureProgress()', () => {
    it('returns progress string', async () => {
      const feature = createFeature('f1', 'Feature', 'desc');
      feature.tasks = [
        { ...createTask('t1', 'Task 1', 'desc'), status: 'completed' },
        { ...createTask('t2', 'Task 2', 'desc'), status: 'pending' },
        { ...createTask('t3', 'Task 3', 'desc'), status: 'pending' },
      ];

      const prd: PrdDocument = {
        version: '1.0.0',
        project: 'test',
        features: [feature],
      };
      await writeFile(join(testDir, 'prd.json'), JSON.stringify(prd));
      await manager.load();

      expect(manager.getFeatureProgress('f1')).toBe('1/3 tasks');
    });
  });

  describe('addFeature()', () => {
    it('adds a new feature', async () => {
      await manager.load();
      const feature = createFeature('f1', 'New Feature', 'Description');

      manager.addFeature(feature);

      expect(manager.getFeatures()).toHaveLength(1);
      expect(manager.getFeature('f1')?.title).toBe('New Feature');
    });

    it('throws if feature already exists', async () => {
      const prd: PrdDocument = {
        version: '1.0.0',
        project: 'test',
        features: [createFeature('f1', 'Feature', 'desc')],
      };
      await writeFile(join(testDir, 'prd.json'), JSON.stringify(prd));
      await manager.load();

      expect(() => manager.addFeature(createFeature('f1', 'Dup', 'desc'))).toThrow(
        'Feature already exists'
      );
    });
  });

  describe('addTask()', () => {
    it('adds a task to a feature', async () => {
      const prd: PrdDocument = {
        version: '1.0.0',
        project: 'test',
        features: [createFeature('f1', 'Feature', 'desc')],
      };
      await writeFile(join(testDir, 'prd.json'), JSON.stringify(prd));
      await manager.load();

      manager.addTask('f1', createTask('t1', 'New Task', 'desc'));

      const feature = manager.getFeature('f1');
      expect(feature?.tasks).toHaveLength(1);
      expect(feature?.tasks[0].id).toBe('t1');
    });

    it('throws for unknown feature', async () => {
      await manager.load();
      expect(() => manager.addTask('unknown', createTask('t1', 'Task', 'desc'))).toThrow(
        'Feature not found'
      );
    });
  });

  describe('getOverallProgress()', () => {
    it('returns correct counts', async () => {
      const prd: PrdDocument = {
        version: '1.0.0',
        project: 'test',
        features: [
          { ...createFeature('f1', 'Completed', 'desc'), status: 'completed' },
          { ...createFeature('f2', 'In Progress', 'desc'), status: 'in_progress' },
          { ...createFeature('f3', 'Pending 1', 'desc'), status: 'pending' },
          { ...createFeature('f4', 'Pending 2', 'desc'), status: 'pending' },
        ],
      };
      await writeFile(join(testDir, 'prd.json'), JSON.stringify(prd));
      await manager.load();

      const progress = manager.getOverallProgress();
      expect(progress.totalFeatures).toBe(4);
      expect(progress.completedFeatures).toBe(1);
      expect(progress.inProgressFeatures).toBe(1);
      expect(progress.pendingFeatures).toBe(2);
    });
  });
});
