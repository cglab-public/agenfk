import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JSONStorageProvider } from '../index';
import { ItemType, Status, Project, AgEnFKItem, Flow, FlowStep } from '@agenfk/core';
import * as fs from 'fs';
import * as path from 'path';

const TEST_DB = path.resolve('./test-db-final.json');

describe('JSONStorageProvider', () => {
  let storage: JSONStorageProvider;

  beforeEach(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    storage = new JSONStorageProvider();
    await storage.init({ path: TEST_DB });
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  describe('Project CRUD', () => {
    it('should create and retrieve a project', async () => {
      const project: Project = {
        id: 'p1',
        name: 'Test Project',
        description: 'Desc',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await storage.createProject(project);
      const retrieved = await storage.getProject('p1');
      expect(retrieved).toMatchObject({ id: 'p1', name: 'Test Project' });
    });

    it('should list projects', async () => {
      await storage.createProject({ id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() });
      await storage.createProject({ id: 'p2', name: 'P2', createdAt: new Date(), updatedAt: new Date() });
      const projects = await storage.listProjects();
      expect(projects).toHaveLength(2);
    });

    it('should update a project', async () => {
      await storage.createProject({ id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() });
      const updated = await storage.updateProject('p1', { name: 'P1 Updated' });
      expect(updated.name).toBe('P1 Updated');
      const retrieved = await storage.getProject('p1');
      expect(retrieved?.name).toBe('P1 Updated');
    });

    it('should throw error when updating non-existent project', async () => {
      await expect(storage.updateProject('none', { name: 'X' })).rejects.toThrow('Project none not found');
    });

    it('should delete a project', async () => {
      await storage.createProject({ id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() });
      const deleted = await storage.deleteProject('p1');
      expect(deleted).toBe(true);
      const retrieved = await storage.getProject('p1');
      expect(retrieved).toBeNull();
    });

    it('should return false when deleting non-existent project', async () => {
      expect(await storage.deleteProject('none')).toBe(false);
    });
  });

  describe('Item CRUD', () => {
    it('should create and retrieve an item', async () => {
      const item: AgEnFKItem = {
        id: 'i1',
        projectId: 'p1',
        type: ItemType.TASK,
        title: 'Task 1',
        description: 'Desc',
        status: Status.TODO,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await storage.createItem(item);
      const retrieved = await storage.getItem('i1');
      expect(retrieved).toMatchObject({ id: 'i1', title: 'Task 1' });
    });

    it('should list items by query including parentId', async () => {
      await storage.createItem({ id: 'i1', projectId: 'p1', type: ItemType.TASK, title: 'T1', description: 'D', status: Status.TODO, createdAt: new Date(), updatedAt: new Date(), parentId: 'p1' });
      await storage.createItem({ id: 'i2', projectId: 'p1', type: ItemType.STORY, title: 'S1', description: 'D', status: Status.DONE, createdAt: new Date(), updatedAt: new Date() });
      
      const children = await storage.listChildren('p1');
      expect(children).toHaveLength(1);
      expect(children[0].id).toBe('i1');

      const itemsByType = await storage.listItems({ type: ItemType.STORY });
      expect(itemsByType).toHaveLength(1);

      const itemsByStatus = await storage.listItems({ status: Status.DONE });
      expect(itemsByStatus).toHaveLength(1);

      const itemsByProject = await storage.listItems({ projectId: 'p1' });
      expect(itemsByProject).toHaveLength(2);
    });

    it('should handle pagination', async () => {
      for (let i = 0; i < 5; i++) {
        await storage.createItem({ id: `i${i}`, projectId: 'p1', type: ItemType.TASK, title: `T${i}`, description: 'D', status: Status.TODO, createdAt: new Date(), updatedAt: new Date() });
      }

      const page1 = await storage.listItems({ limit: 2, offset: 0 });
      expect(page1).toHaveLength(2);
      expect(page1[0].id).toBe('i0');

      const page2 = await storage.listItems({ limit: 2, offset: 2 });
      expect(page2).toHaveLength(2);
      expect(page2[0].id).toBe('i2');
    });

    it('should update an item', async () => {
      await storage.createItem({ id: 'i1', projectId: 'p1', type: ItemType.TASK, title: 'T1', description: 'D', status: Status.TODO, createdAt: new Date(), updatedAt: new Date() });
      const updated = await storage.updateItem('i1', { status: Status.DONE });
      expect(updated.status).toBe(Status.DONE);
      const retrieved = await storage.getItem('i1');
      expect(retrieved?.status).toBe(Status.DONE);
    });

    it('should throw error when updating non-existent item', async () => {
      await expect(storage.updateItem('none', { status: Status.DONE })).rejects.toThrow('Item none not found');
    });

    it('should delete an item', async () => {
      await storage.createItem({ id: 'i1', projectId: 'p1', type: ItemType.TASK, title: 'T1', description: 'D', status: Status.TODO, createdAt: new Date(), updatedAt: new Date() });
      const deleted = await storage.deleteItem('i1');
      expect(deleted).toBe(true);
      const retrieved = await storage.getItem('i1');
      expect(retrieved).toBeNull();
    });

    it('should return false when deleting non-existent item', async () => {
      expect(await storage.deleteItem('none')).toBe(false);
    });
  });

  describe('File Handling', () => {
    it('should handle empty database file', async () => {
      fs.writeFileSync(TEST_DB, '   ');
      const newStorage = new JSONStorageProvider();
      await newStorage.init({ path: TEST_DB });
      expect(await newStorage.listProjects()).toHaveLength(0);
    });

    it('should handle corrupted database file', async () => {
      fs.writeFileSync(TEST_DB, '{ invalid json }');
      const newStorage = new JSONStorageProvider();
      await newStorage.init({ path: TEST_DB });
      expect(await newStorage.listProjects()).toHaveLength(0);
    });
  });

  describe('Lock Mechanism', () => {
    it('should handle concurrent operations sequentially', async () => {
      const ops = Array.from({ length: 10 }, (_, i) =>
        storage.createProject({ id: `p${i}`, name: `P${i}`, createdAt: new Date(), updatedAt: new Date() })
      );
      await Promise.all(ops);
      const projects = await storage.listProjects();
      expect(projects).toHaveLength(10);
    });
  });

  describe('Flow CRUD', () => {
    const makeFlow = (id: string): Flow => ({
      id,
      name: `Flow ${id}`,
      description: 'A test flow',
      steps: [
        { id: 's1', name: 'todo', label: 'To Do', order: 0 },
        { id: 's2', name: 'in_progress', label: 'In Progress', order: 1, exitCriteria: 'Code reviewed' },
        { id: 's3', name: 'done', label: 'Done', order: 2, isSpecial: true },
      ] as FlowStep[],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    it('should create and retrieve a flow', async () => {
      const flow = makeFlow('f1');
      await storage.createFlow(flow);
      const retrieved = await storage.getFlow('f1');
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe('f1');
      expect(retrieved!.name).toBe('Flow f1');
      expect(retrieved!.steps).toHaveLength(3);
    });

    it('should return null for non-existent flow', async () => {
      expect(await storage.getFlow('missing')).toBeNull();
    });

    it('should list all flows globally', async () => {
      await storage.createFlow(makeFlow('f1'));
      await storage.createFlow(makeFlow('f2'));
      await storage.createFlow(makeFlow('f3'));

      const allFlows = await storage.listFlows();
      expect(allFlows).toHaveLength(3);
      expect(allFlows.map(f => f.id)).toContain('f1');
      expect(allFlows.map(f => f.id)).toContain('f2');
      expect(allFlows.map(f => f.id)).toContain('f3');
    });

    it('should update a flow', async () => {
      await storage.createFlow(makeFlow('f1'));
      const updated = await storage.updateFlow('f1', { name: 'Renamed Flow' });
      expect(updated.name).toBe('Renamed Flow');
      const retrieved = await storage.getFlow('f1');
      expect(retrieved!.name).toBe('Renamed Flow');
    });

    it('should update flow steps', async () => {
      await storage.createFlow(makeFlow('f1'));
      const newSteps: FlowStep[] = [
        { id: 's1', name: 'backlog', label: 'Backlog', order: 0 },
        { id: 's2', name: 'done', label: 'Done', order: 1, isSpecial: true },
      ];
      const updated = await storage.updateFlow('f1', { steps: newSteps });
      expect(updated.steps).toHaveLength(2);
      expect(updated.steps[0].name).toBe('backlog');
    });

    it('should throw when updating non-existent flow', async () => {
      await expect(storage.updateFlow('missing', { name: 'X' })).rejects.toThrow('Flow missing not found');
    });

    it('should delete a flow', async () => {
      await storage.createFlow(makeFlow('f1'));
      const deleted = await storage.deleteFlow('f1');
      expect(deleted).toBe(true);
      expect(await storage.getFlow('f1')).toBeNull();
    });

    it('should return false when deleting non-existent flow', async () => {
      expect(await storage.deleteFlow('missing')).toBe(false);
    });

    it('should persist flows across re-init', async () => {
      await storage.createFlow(makeFlow('f1'));
      // Re-initialize from same file
      const storage2 = new JSONStorageProvider();
      await storage2.init({ path: TEST_DB });
      const retrieved = await storage2.getFlow('f1');
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe('f1');
      // Dates should be hydrated as Date objects
      expect(retrieved!.createdAt).toBeInstanceOf(Date);
      expect(retrieved!.updatedAt).toBeInstanceOf(Date);
    });

    it('should strip projectId from legacy flow entries on load', async () => {
      // Write a legacy db.json with projectId on flows
      const fs = await import('fs');
      const legacyDb = {
        projects: [], items: [], snapshots: [],
        flows: [{
          id: 'legacy-f1', name: 'Legacy Flow', projectId: 'old-project',
          steps: [], description: '',
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        }],
      };
      fs.writeFileSync(TEST_DB, JSON.stringify(legacyDb));
      const storage2 = new JSONStorageProvider();
      await storage2.init({ path: TEST_DB });
      const retrieved = await storage2.getFlow('legacy-f1');
      expect(retrieved).not.toBeNull();
      expect((retrieved as any).projectId).toBeUndefined();
      expect(retrieved!.name).toBe('Legacy Flow');
    });
  });
});
