import { describe, it, expect, vi, beforeEach } from 'vitest';
import { program } from '../index';
import axios from 'axios';
import * as child_process from 'child_process';
import * as fs from 'fs';

vi.mock('axios');
vi.mock('child_process');
vi.mock('fs');

const mockedAxios = vi.mocked(axios, true);
const mockedChildProcess = vi.mocked(child_process, true);
const mockedFs = vi.mocked(fs, true);

describe('branch link command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue('{"items": []}');
  });

  it('should link an existing branch to an item', async () => {
    const itemId = 'a1b2c3d4-0000-0000-0000-000000000001';
    mockedAxios.get.mockResolvedValue({
      data: { id: itemId, title: 'Test', type: 'TASK', parentId: undefined },
    });
    mockedChildProcess.execSync.mockReturnValue(Buffer.from('feat/CGLAB-86_fix-bugs-to-fix\n'));
    mockedAxios.put.mockResolvedValue({ data: {} });

    await program.parseAsync([
      'node', 'agenfk', 'branch', 'link', itemId, 'feat/CGLAB-86_fix-bugs-to-fix',
    ]);

    expect(mockedChildProcess.execSync).toHaveBeenCalledWith(
      expect.stringContaining('git rev-parse --verify'),
      expect.any(Object)
    );
    expect(mockedAxios.put).toHaveBeenCalledWith(
      expect.stringContaining(`/items/${itemId}`),
      { branchName: 'feat/CGLAB-86_fix-bugs-to-fix' }
    );
  });

  it('should reject linking a branch that does not exist locally', async () => {
    const itemId = 'a1b2c3d4-0000-0000-0000-000000000002';
    mockedAxios.get.mockResolvedValue({
      data: { id: itemId, title: 'Test', type: 'TASK', parentId: undefined },
    });
    mockedChildProcess.execSync.mockImplementation((cmd: any) => {
      if (typeof cmd === 'string' && cmd.includes('git rev-parse')) {
        throw new Error('fatal: ambiguous argument');
      }
      return Buffer.from('');
    });

    const spy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await program.parseAsync([
      'node', 'agenfk', 'branch', 'link', itemId, 'nonexistent-branch',
    ]);
    expect(spy).toHaveBeenCalledWith(1);
    expect(mockedAxios.put).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('should reject linking for child items (only top-level allowed)', async () => {
    const itemId = 'a1b2c3d4-0000-0000-0000-000000000003';
    const parentId = 'e5f6a7b8-0000-0000-0000-000000000004';
    mockedAxios.get.mockResolvedValue({
      data: { id: itemId, title: 'Test', type: 'TASK', parentId },
    });

    const spy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await program.parseAsync([
      'node', 'agenfk', 'branch', 'link', itemId, 'some-branch',
    ]);
    expect(spy).toHaveBeenCalledWith(1);
    expect(mockedAxios.put).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('should reject branch names with invalid characters', async () => {
    const itemId = 'a1b2c3d4-0000-0000-0000-000000000005';
    mockedAxios.get.mockResolvedValue({
      data: { id: itemId, title: 'Test', type: 'TASK', parentId: undefined },
    });

    const spy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await program.parseAsync([
      'node', 'agenfk', 'branch', 'link', itemId, 'bad;branch-name',
    ]);
    expect(spy).toHaveBeenCalledWith(1);
    expect(mockedChildProcess.execSync).not.toHaveBeenCalled();
    expect(mockedAxios.put).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
