import { describe, it, expect, vi, beforeEach } from 'vitest';
import { program } from '../index';
import axios from 'axios';
import * as child_process from 'child_process';
import * as fs from 'fs';
import inquirer from 'inquirer';

vi.mock('axios');
vi.mock('child_process');
vi.mock('fs');
vi.mock('inquirer');
const mockedAxios = vi.mocked(axios, true);
const mockedChildProcess = vi.mocked(child_process, true);
const mockedFs = vi.mocked(fs, true);
const mockedInquirer = vi.mocked(inquirer, true);

describe('CLI Commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue('{"items": []}');
  });

  it('should have basic commands registered', () => {
    const commands = program.commands.map(c => c.name());
    expect(commands).toContain('up');
    expect(commands).toContain('down');
    expect(commands).toContain('list');
    expect(commands).toContain('create');
  });

  describe('list command', () => {
    it('should call the API to list items', async () => {
      mockedAxios.get.mockResolvedValue({ data: [] });
      await program.parseAsync(['node', 'agenfk', 'list']);
      expect(mockedAxios.get).toHaveBeenCalledWith(expect.stringContaining('/items'), expect.any(Object));
    });
  });

  describe('create command', () => {
    it('should call the API to create an item with all arguments', async () => {
      mockedAxios.get.mockResolvedValue({ data: [{ id: 'p1', name: 'Proj' }] });
      mockedAxios.post.mockResolvedValue({ data: { id: 'i1', title: 'Task' } });
      
      await program.parseAsync(['node', 'agenfk', 'create', 'task', 'My Task', '--project', 'p1']);
      
      expect(mockedAxios.post).toHaveBeenCalledWith(expect.stringContaining('/items'), expect.objectContaining({
        type: 'TASK',
        title: 'My Task'
      }));
    });
  });

  describe('update command', () => {
    it('should call the API to update an item', async () => {
      mockedAxios.get.mockResolvedValue({ data: [{ id: 'i1-full-id', title: 'Test' }] });
      mockedAxios.put.mockResolvedValue({ data: { id: 'i1-full-id', status: 'DONE' } });
      
      await program.parseAsync(['node', 'agenfk', 'update', 'i1', '--status', 'DONE']);
      
      expect(mockedAxios.put).toHaveBeenCalledWith(expect.stringContaining('/items/i1-full-id'), expect.objectContaining({
        status: 'DONE'
      }));
    });
  });

  describe('delete command', () => {
    it('should call the API to delete an item', async () => {
      mockedAxios.get.mockResolvedValue({ data: [{ id: 'i1-full-id', title: 'Test' }] });
      mockedAxios.delete.mockResolvedValue({ status: 204 });
      
      await program.parseAsync(['node', 'agenfk', 'delete', 'i1']);
      
      expect(mockedAxios.delete).toHaveBeenCalledWith(expect.stringContaining('/items/i1-full-id'));
    });

    it('should handle item not found for delete', async () => {
      mockedAxios.get.mockResolvedValue({ data: [] });
      await program.parseAsync(['node', 'agenfk', 'delete', 'missing']);
      expect(mockedAxios.delete).not.toHaveBeenCalled();
    });
  });

  describe('list command', () => {
    it('should call the API with filters', async () => {
      mockedAxios.get.mockResolvedValue({ data: [{ id: 'i1', title: 'T', type: 'TASK', status: 'TODO' }] });
      await program.parseAsync(['node', 'agenfk', 'list', '--type', 'task', '--status', 'todo']);
      expect(mockedAxios.get).toHaveBeenCalledWith(expect.stringContaining('/items'), expect.objectContaining({
        params: { type: 'TASK', status: 'TODO' }
      }));
    });
  });

  describe('update command', () => {
    it('should handle ambiguous ID', async () => {
      mockedAxios.get.mockResolvedValue({ data: [{ id: 'i1-a', title: 'A' }, { id: 'i1-b', title: 'B' }] });
      await program.parseAsync(['node', 'agenfk', 'update', 'i1', '--status', 'DONE']);
      expect(mockedAxios.put).not.toHaveBeenCalled();
    });
  });

  describe('upgrade command', () => {
    it('should check for updates and run installer', async () => {
      mockedAxios.get.mockRejectedValue(new Error('Down')); // services not running
      mockedChildProcess.execSync.mockReturnValue(Buffer.from('v1.0.0')); // gh output
      
      // We need to mock fs.existsSync for the install script check
      mockedFs.existsSync.mockImplementation((p) => {
        return true;
      });
      mockedFs.readFileSync.mockReturnValue('{"version":"0.0.1"}');

      await program.parseAsync(['node', 'agenfk', 'upgrade', '--force']);
      
      expect(mockedChildProcess.execSync).toHaveBeenCalledWith(expect.stringContaining('gh release view'), expect.any(Object));
      expect(mockedChildProcess.execSync).toHaveBeenCalledWith(expect.stringContaining('install.mjs'), expect.any(Object));
    });
  });

  describe('ui command', () => {
    it('should show dashboard information', async () => {
      mockedFs.existsSync.mockReturnValue(false);
      await program.parseAsync(['node', 'agenfk', 'ui']);
      // No specific expectation other than it doesn't crash
    });
  });

  describe('list-projects command', () => {
    it('should call the API to list projects', async () => {
      mockedAxios.get.mockResolvedValue({ data: [{ id: 'p1', name: 'Proj', createdAt: new Date().toISOString() }] });
      await program.parseAsync(['node', 'agenfk', 'list-projects']);
      expect(mockedAxios.get).toHaveBeenCalledWith(expect.stringContaining('/projects'));
    });
  });

  describe('create-project command', () => {
    it('should call the API to create a project', async () => {
      mockedAxios.post.mockResolvedValue({ data: { id: 'p1', name: 'New Proj' } });
      await program.parseAsync(['node', 'agenfk', 'create-project', 'New Proj']);
      expect(mockedAxios.post).toHaveBeenCalledWith(expect.stringContaining('/projects'), expect.objectContaining({ name: 'New Proj' }));
    });
  });

  describe('init command', () => {
    it('should check connection to API', async () => {
      mockedAxios.get.mockResolvedValue({ data: { message: 'OK' } });
      await program.parseAsync(['node', 'agenfk', 'init']);
      expect(mockedAxios.get).toHaveBeenCalledWith(expect.stringMatching(/\/$/));
    });
  });

  describe('down command', () => {
    it('should call pkill or fuser', async () => {
      await program.parseAsync(['node', 'agenfk', 'down']);
      expect(mockedChildProcess.execSync).toHaveBeenCalled();
    });
  });

  describe('restart command', () => {
    it('should call down and up', async () => {
      await program.parseAsync(['node', 'agenfk', 'restart']);
      // Should call down (execSync) and up (spawn)
      expect(mockedChildProcess.execSync).toHaveBeenCalledWith(expect.stringContaining('down'), expect.any(Object));
      expect(mockedChildProcess.spawn).toHaveBeenCalledWith('node', expect.arrayContaining(['up']), expect.any(Object));
    });
  });

  describe('health command', () => {
    it('should check system paths and API', async () => {
      mockedAxios.get.mockResolvedValue({ data: { message: 'OK' } });
      await program.parseAsync(['node', 'agenfk', 'health']);
      expect(mockedAxios.get).toHaveBeenCalledWith(expect.stringMatching(/\/$/));
    });
  });

  describe('up command', () => {
    it('should bootstrap services if missing', async () => {
      mockedFs.existsSync.mockReturnValue(false);
      mockedChildProcess.execSync.mockReturnValue(Buffer.from('ok'));
      
      await program.parseAsync(['node', 'agenfk', 'up']);
      
      expect(mockedChildProcess.execSync).toHaveBeenCalledWith(expect.stringContaining('install.mjs'), expect.any(Object));
    });
  });
});
