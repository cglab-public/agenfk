import { describe, it, expect, vi, beforeEach } from 'vitest';
import { program } from '../index';
import axios from 'axios';
import * as child_process from 'child_process';

vi.mock('axios');
vi.mock('child_process');
const mockedAxios = vi.mocked(axios);
const mockedChildProcess = vi.mocked(child_process);

describe('CLI Commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      
      // Simulate: agenfk list
      await program.parseAsync(['node', 'agenfk', 'list']);
      
      expect(mockedAxios.get).toHaveBeenCalledWith(expect.stringContaining('/items'), expect.any(Object));
    });
  });

  describe('create command', () => {
...
      expect(mockedAxios.post).toHaveBeenCalledWith(expect.stringContaining('/items'), expect.objectContaining({
        type: 'TASK',
        title: 'My Task'
      }));
    });
  });

  describe('update command', () => {
    it('should call the API to update an item', async () => {
      mockedAxios.put.mockResolvedValue({ data: { id: 'i1', status: 'DONE' } });
      
      await program.parseAsync(['node', 'agenfk', 'update', 'i1', '--status', 'DONE']);
      
      expect(mockedAxios.put).toHaveBeenCalledWith(expect.stringContaining('/items/i1'), expect.objectContaining({
        status: 'DONE'
      }));
    });
  });

  describe('delete command', () => {
    it('should call the API to delete an item', async () => {
      mockedAxios.delete.mockResolvedValue({ status: 204 });
      
      await program.parseAsync(['node', 'agenfk', 'delete', 'i1']);
      
      expect(mockedAxios.delete).toHaveBeenCalledWith(expect.stringContaining('/items/i1'));
    });
  });

  describe('down command', () => {
    it('should call fuser to kill processes', async () => {
      await program.parseAsync(['node', 'agenfk', 'down']);
      expect(mockedChildProcess.execSync).toHaveBeenCalledWith(expect.stringContaining('fuser -k 3000/tcp'), expect.any(Object));
    });
  });
});
