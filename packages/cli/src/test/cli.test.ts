import { describe, it, expect, vi, beforeEach } from 'vitest';
import { program } from '../index';
import axios from 'axios';

vi.mock('axios');
const mockedAxios = vi.mocked(axios);

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
    it('should call the API to create an item', async () => {
      mockedAxios.get.mockResolvedValue({ data: [{ id: 'p1', name: 'Proj' }] }); // project check
      mockedAxios.post.mockResolvedValue({ data: { id: 'i1', title: 'Task' } });
      
      // Simulate: agenfk create task "My Task"
      await program.parseAsync(['node', 'agenfk', 'create', 'task', 'My Task', '--project', 'p1']);
      
      expect(mockedAxios.post).toHaveBeenCalledWith(expect.stringContaining('/items'), expect.objectContaining({
        type: 'TASK',
        title: 'My Task'
      }));
    });
  });
});
