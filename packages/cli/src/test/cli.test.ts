import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { program } from '../index';
import axios from 'axios';
import * as child_process from 'child_process';
import * as fs from 'fs';
import inquirer from 'inquirer';

vi.mock('axios');
vi.mock('child_process');
vi.mock('fs');
vi.mock('inquirer');
const mockedAxios = vi.mocked(axios);
const mockedChildProcess = vi.mocked(child_process);
const mockedFs = vi.mocked(fs);
const mockedInquirer = vi.mocked(inquirer);

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
    it('should handle interactive input if title missing', async () => {
      mockedAxios.get.mockResolvedValue({ data: [{ id: 'p1', name: 'Proj' }] });
      mockedInquirer.prompt.mockResolvedValue({ title: 'Interactive Task' });
      mockedAxios.post.mockResolvedValue({ data: { id: 'i2', title: 'Interactive Task' } });

      // type is required by commander, so we provide it
      await program.parseAsync(['node', 'agenfk', 'create', 'task', '--project', 'p1']);

      expect(mockedInquirer.prompt).toHaveBeenCalled();
      expect(mockedAxios.post).toHaveBeenCalled();
    });

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
  });

  describe('down command', () => {
    it('should call pkill or fuser', async () => {
      await program.parseAsync(['node', 'agenfk', 'down']);
      expect(mockedChildProcess.execSync).toHaveBeenCalled();
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
      
      expect(mockedChildProcess.execSync).toHaveBeenCalledWith(expect.stringContaining('install.sh'), expect.any(Object));
    });
  });
});
