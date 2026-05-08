import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hoist mock vars so they're available inside vi.mock factories
const { mockExistsSync, mockReadFileSync, mockWriteFileSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
}));

const { mockCapture } = vi.hoisted(() => ({ mockCapture: vi.fn() }));
vi.mock('@agenfk/telemetry', () => ({
  TelemetryClient: vi.fn(function (this: any) {
    this.capture = mockCapture;
    this.shutdown = vi.fn().mockResolvedValue(undefined);
    this.isEnabled = true;
    this.id = 'test-install-id';
  }),
  getInstallationId: vi.fn().mockReturnValue('test-install-id'),
  isTelemetryEnabled: vi.fn().mockReturnValue(true),
  getApiUrl: vi.fn().mockReturnValue('http://localhost:3000'),
  readServerPort: vi.fn().mockReturnValue(null),
  DEFAULT_API_PORT: 3000,
}));

vi.mock('fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  mkdirSync: vi.fn(),
  default: {
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    mkdirSync: vi.fn(),
  },
}));

vi.mock('axios');
vi.mock('child_process', () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  default: { execSync: vi.fn(), spawn: vi.fn(), spawnSync: vi.fn() },
}));
vi.mock('figlet', () => ({
  default: { textSync: vi.fn().mockReturnValue('AgEnFK') },
}));

import { program } from '../index';
import axios from 'axios';

const mockedAxios = vi.mocked(axios, true);

const SAMPLE_FLOW = {
  id: 'flow-uuid-registry-1',
  name: 'Standard Dev Flow',
  description: 'A standard development flow',
  version: '1.0.0',
  steps: [
    { id: 'step-1', name: 'todo', label: 'To Do', order: 1, isSpecial: false },
    { id: 'step-2', name: 'in_progress', label: 'In Progress', order: 2, isSpecial: false },
    { id: 'step-3', name: 'done', label: 'Done', order: 3, isSpecial: true, exitCriteria: 'All tests pass' },
  ],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const REGISTRY_FLOW_JSON = {
  schemaVersion: '1',
  name: 'Standard Dev Flow',
  description: 'A standard development flow',
  author: 'testuser',
  version: '1.0.0',
  steps: [
    { name: 'todo', label: 'To Do', order: 1, isSpecial: false },
    { name: 'in_progress', label: 'In Progress', order: 2, isSpecial: false },
    { name: 'done', label: 'Done', order: 3, isSpecial: true, exitCriteria: 'All tests pass' },
  ],
};

describe('flow registry commands', () => {
  function resetCommanderOptions(cmd: any) {
    const options = (cmd as any).options || [];
    options.forEach((opt: any) => {
      cmd.setOptionValue(opt.attributeName(), undefined);
    });
    (cmd.commands || []).forEach(resetCommanderOptions);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue('{}');
    program.commands.forEach(resetCommanderOptions);
  });

  // ── flow publish ──────────────────────────────────────────────────────────────

  describe('flow publish', () => {
    it('should POST to server /registry/flows/publish with flowId', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { url: 'https://github.com/cglab-public/agenfk-flows/blob/main/flows/standard-dev-flow.json', kind: 'direct', version: '1.0.0' },
      });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await program.parseAsync(['node', 'agenfk', 'flow', 'publish', 'flow-uuid-registry-1']);

      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.stringContaining('/registry/flows/publish'),
        expect.objectContaining({ flowId: 'flow-uuid-registry-1' })
      );
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('published successfully'));
      logSpy.mockRestore();
    });

    it('should include registry option when --registry flag is used', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { url: 'https://github.com/my-org/my-flows/blob/main/flows/standard-dev-flow.json', kind: 'direct', version: '1.0.0' },
      });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await program.parseAsync(['node', 'agenfk', 'flow', 'publish', 'flow-uuid-registry-1', '--registry', 'my-org/my-flows']);

      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.stringContaining('/registry/flows/publish'),
        expect.objectContaining({ flowId: 'flow-uuid-registry-1', registry: 'my-org/my-flows' })
      );
      logSpy.mockRestore();
    });

    it('should show PR message when server returns kind=pr', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { url: 'https://github.com/cglab-public/agenfk-flows/pull/42', kind: 'pr', version: '1.0.1' },
      });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await program.parseAsync(['node', 'agenfk', 'flow', 'publish', 'flow-uuid-registry-1']);

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Pull request'));
      logSpy.mockRestore();
    });

    it('should handle server errors gracefully', async () => {
      mockedAxios.post.mockRejectedValue({ response: { data: { error: 'gh CLI is not authenticated. Run `gh auth login` on the server.' } } });

      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await program.parseAsync(['node', 'agenfk', 'flow', 'publish', 'flow-uuid-registry-1']);

      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error publishing flow'),
        expect.stringContaining('gh auth login')
      );
      errSpy.mockRestore();
    });
  });

  // ── flow browse ───────────────────────────────────────────────────────────────

  describe('flow browse', () => {
    it('should fetch registry contents and display table', async () => {
      const files = [
        { name: 'standard-dev-flow.json', type: 'file' },
        { name: 'kanban-flow.json', type: 'file' },
      ];

      mockedAxios.get.mockImplementation(async (url: string) => {
        if (url.includes('api.github.com')) {
          return { data: files };
        }
        if (url.includes('standard-dev-flow')) {
          return { data: REGISTRY_FLOW_JSON };
        }
        if (url.includes('kanban-flow')) {
          return {
            data: {
              schemaVersion: '1',
              name: 'Kanban Flow',
              author: 'alice',
              version: '2.0.0',
              steps: [{ name: 'backlog', label: 'Backlog', order: 1, isSpecial: false }],
            },
          };
        }
        throw new Error('unexpected url');
      });

      const tableSpy = vi.spyOn(console, 'table').mockImplementation(() => {});
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await program.parseAsync(['node', 'agenfk', 'flow', 'browse']);

      expect(mockedAxios.get).toHaveBeenCalledWith(
        expect.stringContaining('api.github.com/repos/cglab-public/agenfk-flows/contents/flows'),
        expect.any(Object)
      );

      expect(tableSpy).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            File: 'standard-dev-flow.json',
            Name: 'Standard Dev Flow',
            Author: 'testuser',
            Version: '1.0.0',
            Steps: 3,
          }),
          expect.objectContaining({
            File: 'kanban-flow.json',
            Name: 'Kanban Flow',
            Author: 'alice',
            Version: '2.0.0',
            Steps: 1,
          }),
        ])
      );

      tableSpy.mockRestore();
      logSpy.mockRestore();
    });

    it('should show yellow message when no flows in registry', async () => {
      mockedAxios.get.mockResolvedValue({ data: [] });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await program.parseAsync(['node', 'agenfk', 'flow', 'browse']);

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No flows'));
      logSpy.mockRestore();
    });

    it('should use custom registry from --registry flag', async () => {
      mockedAxios.get.mockResolvedValue({ data: [] });
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await program.parseAsync(['node', 'agenfk', 'flow', 'browse', '--registry', 'my-org/my-flows']);

      expect(mockedAxios.get).toHaveBeenCalledWith(
        expect.stringContaining('api.github.com/repos/my-org/my-flows/contents/flows'),
        expect.any(Object)
      );
      logSpy.mockRestore();
    });

    it('should skip non-json files', async () => {
      mockedAxios.get.mockResolvedValue({
        data: [{ name: 'README.md', type: 'file' }, { name: 'valid.json', type: 'file' }],
      });
      mockedAxios.get.mockImplementation(async (url: string) => {
        if (url.includes('contents/flows?') || url.includes('contents/flows ')) return { data: [{ name: 'README.md', type: 'file' }] };
        if (url.includes('api.github.com')) return { data: [{ name: 'README.md', type: 'file' }] };
        return { data: [] };
      });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await program.parseAsync(['node', 'agenfk', 'flow', 'browse']);
      logSpy.mockRestore();
    });

    it('should handle errors gracefully', async () => {
      mockedAxios.get.mockRejectedValue(new Error('Network error'));
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await program.parseAsync(['node', 'agenfk', 'flow', 'browse']);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Error'), expect.anything());
      errSpy.mockRestore();
    });
  });

  // ── flow install ──────────────────────────────────────────────────────────────

  describe('flow install', () => {
    it('should download flow JSON and POST to local server', async () => {
      mockedAxios.get.mockResolvedValue({ data: REGISTRY_FLOW_JSON });
      mockedAxios.post.mockResolvedValue({ data: { id: 'new-flow-id', name: 'Standard Dev Flow' } });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await program.parseAsync(['node', 'agenfk', 'flow', 'install', 'standard-dev-flow.json']);

      expect(mockedAxios.get).toHaveBeenCalledWith(expect.stringContaining('standard-dev-flow.json'));
      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.stringContaining('/flows'),
        expect.objectContaining({ name: 'Standard Dev Flow' })
      );
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('installed'));
      logSpy.mockRestore();
    });

    it('should append .json extension when not provided', async () => {
      mockedAxios.get.mockResolvedValue({ data: REGISTRY_FLOW_JSON });
      mockedAxios.post.mockResolvedValue({ data: { id: 'new-flow-id', name: 'Standard Dev Flow' } });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await program.parseAsync(['node', 'agenfk', 'flow', 'install', 'standard-dev-flow']);

      expect(mockedAxios.get).toHaveBeenCalledWith(expect.stringContaining('standard-dev-flow.json'));
      logSpy.mockRestore();
    });

    it('should error when flow JSON is invalid (missing required fields)', async () => {
      mockedAxios.get.mockResolvedValue({ data: { description: 'No name here' } });

      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await program.parseAsync(['node', 'agenfk', 'flow', 'install', 'bad-flow.json']);

      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('name'));
      errSpy.mockRestore();
    });
  });

  // ── config set flowRegistry ──────────────────────────────────────────────────

  describe('config set flowRegistry', () => {
    it('should write flowRegistry to config.json', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('{}');

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await program.parseAsync(['node', 'agenfk', 'config', 'set', 'flowRegistry', 'my-org/my-registry']);

      expect(mockWriteFileSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('my-org/my-registry'),
        expect.any(String)
      );
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('my-org/my-registry'));
      logSpy.mockRestore();
    });

    it('should error when value is not in owner/repo format', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await program.parseAsync(['node', 'agenfk', 'config', 'set', 'flowRegistry', 'invalid-value']);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('owner/repo'));
      errSpy.mockRestore();
      exitSpy.mockRestore();
    });
  });
});
