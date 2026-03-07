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
import * as childProcess from 'child_process';

const mockedAxios = vi.mocked(axios, true);

const SAMPLE_FLOW = {
  id: 'flow-uuid-registry-1',
  name: 'Standard Dev Flow',
  description: 'A standard development flow',
  author: 'testuser',
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

  let originalEnv: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue('{}');
    originalEnv = process.env.AGENFK_REGISTRY_TOKEN;
    program.commands.forEach(resetCommanderOptions);
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.AGENFK_REGISTRY_TOKEN;
    } else {
      process.env.AGENFK_REGISTRY_TOKEN = originalEnv;
    }
  });

  // ── flow publish ──────────────────────────────────────────────────────────────

  describe('flow publish', () => {
    it('should error when AGENFK_REGISTRY_TOKEN is missing', async () => {
      delete process.env.AGENFK_REGISTRY_TOKEN;

      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

      await program.parseAsync(['node', 'agenfk', 'flow', 'publish', 'flow-uuid-registry-1']);

      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('AGENFK_REGISTRY_TOKEN')
      );
      errSpy.mockRestore();
      exitSpy.mockRestore();
    });

    it('should GET local flow and PUT to GitHub when creating a new file', async () => {
      process.env.AGENFK_REGISTRY_TOKEN = 'ghp_testtoken';

      // GET /flows/:id returns the flow
      mockedAxios.get.mockImplementation(async (url: string) => {
        if (url.includes('localhost')) {
          return { data: SAMPLE_FLOW };
        }
        // GitHub check for existing file → 404 means new file
        throw { response: { status: 404 } };
      });

      // PUT to GitHub succeeds
      mockedAxios.put.mockResolvedValue({
        data: {
          content: {
            html_url: 'https://github.com/cglab-public/agenfk-flows/blob/main/flows/standard-dev-flow.json',
          },
        },
      });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await program.parseAsync(['node', 'agenfk', 'flow', 'publish', 'flow-uuid-registry-1']);

      // Verify local API was called
      expect(mockedAxios.get).toHaveBeenCalledWith(
        expect.stringContaining('/flows/flow-uuid-registry-1')
      );

      // Verify GitHub PUT was called with correct structure
      expect(mockedAxios.put).toHaveBeenCalledWith(
        expect.stringContaining('api.github.com/repos/cglab-public/agenfk-flows/contents/flows/'),
        expect.objectContaining({
          message: expect.stringContaining('Standard Dev Flow'),
          content: expect.any(String),
        }),
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer ghp_testtoken' }),
        })
      );

      // Verify the content is valid base64 encoded flow JSON
      const putCall = mockedAxios.put.mock.calls[0];
      const body = putCall[1] as any;
      const decoded = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
      expect(decoded.schemaVersion).toBe('1');
      expect(decoded.name).toBe('Standard Dev Flow');
      expect(decoded.steps).toHaveLength(3);
      expect(decoded.steps[0]).toEqual(expect.objectContaining({ name: 'todo', order: 1 }));

      // No sha field for new file
      expect(body.sha).toBeUndefined();

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('published successfully'));
      logSpy.mockRestore();
    });

    it('should include sha when updating an existing file', async () => {
      process.env.AGENFK_REGISTRY_TOKEN = 'ghp_testtoken';

      mockedAxios.get.mockImplementation(async (url: string) => {
        if (url.includes('localhost')) {
          return { data: SAMPLE_FLOW };
        }
        // GitHub check for existing file → returns sha
        return { data: { sha: 'existing-sha-abc123', name: 'standard-dev-flow.json' } };
      });

      mockedAxios.put.mockResolvedValue({
        data: {
          content: {
            html_url: 'https://github.com/cglab-public/agenfk-flows/blob/main/flows/standard-dev-flow.json',
          },
        },
      });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await program.parseAsync(['node', 'agenfk', 'flow', 'publish', 'flow-uuid-registry-1']);

      const putCall = mockedAxios.put.mock.calls[0];
      const body = putCall[1] as any;
      expect(body.sha).toBe('existing-sha-abc123');

      logSpy.mockRestore();
    });

    it('should use custom registry from --registry flag', async () => {
      process.env.AGENFK_REGISTRY_TOKEN = 'ghp_testtoken';

      mockedAxios.get.mockImplementation(async (url: string) => {
        if (url.includes('localhost')) return { data: SAMPLE_FLOW };
        throw { response: { status: 404 } };
      });
      mockedAxios.put.mockResolvedValue({ data: { content: { html_url: 'https://github.com/my-org/my-flows/blob/main/flows/standard-dev-flow.json' } } });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await program.parseAsync(['node', 'agenfk', 'flow', 'publish', 'flow-uuid-registry-1', '--registry', 'my-org/my-flows']);

      expect(mockedAxios.put).toHaveBeenCalledWith(
        expect.stringContaining('api.github.com/repos/my-org/my-flows/contents/flows/'),
        expect.any(Object),
        expect.any(Object)
      );
      logSpy.mockRestore();
    });

    it('should handle errors from local API', async () => {
      process.env.AGENFK_REGISTRY_TOKEN = 'ghp_testtoken';
      mockedAxios.get.mockRejectedValue(new Error('Network error'));

      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await program.parseAsync(['node', 'agenfk', 'flow', 'publish', 'bad-flow-id']);

      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error publishing flow'),
        expect.stringContaining('Network error')
      );
      errSpy.mockRestore();
    });

    it('should auto-detect author from gh api user when flow has no author', async () => {
      process.env.AGENFK_REGISTRY_TOKEN = 'ghp_testtoken';
      const flowWithoutAuthor = { ...SAMPLE_FLOW, author: undefined };

      vi.mocked(childProcess.execSync).mockReturnValue('gh-user\n' as any);

      mockedAxios.get.mockImplementation(async (url: string) => {
        if (url.includes('localhost')) return { data: flowWithoutAuthor };
        throw { response: { status: 404 } };
      });
      mockedAxios.put.mockResolvedValue({ data: { content: { html_url: 'https://github.com/cglab-public/agenfk-flows/blob/main/flows/standard-dev-flow.json' } } });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await program.parseAsync(['node', 'agenfk', 'flow', 'publish', 'flow-uuid-registry-1']);

      const putCall = mockedAxios.put.mock.calls[0];
      const decoded = JSON.parse(Buffer.from((putCall[1] as any).content, 'base64').toString('utf8'));
      expect(decoded.author).toBe('gh-user');

      logSpy.mockRestore();
    });

    it('should leave author undefined when gh is not available and flow has no author', async () => {
      process.env.AGENFK_REGISTRY_TOKEN = 'ghp_testtoken';
      const flowWithoutAuthor = { ...SAMPLE_FLOW, author: undefined };

      vi.mocked(childProcess.execSync).mockImplementation(() => { throw new Error('gh not found'); });

      mockedAxios.get.mockImplementation(async (url: string) => {
        if (url.includes('localhost')) return { data: flowWithoutAuthor };
        throw { response: { status: 404 } };
      });
      mockedAxios.put.mockResolvedValue({ data: { content: { html_url: 'https://github.com/cglab-public/agenfk-flows/blob/main/flows/standard-dev-flow.json' } } });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await program.parseAsync(['node', 'agenfk', 'flow', 'publish', 'flow-uuid-registry-1']);

      const putCall = mockedAxios.put.mock.calls[0];
      const decoded = JSON.parse(Buffer.from((putCall[1] as any).content, 'base64').toString('utf8'));
      expect(decoded.author).toBeUndefined();

      logSpy.mockRestore();
    });

    it('should prefer existing flow author over gh api detection', async () => {
      process.env.AGENFK_REGISTRY_TOKEN = 'ghp_testtoken';

      vi.mocked(childProcess.execSync).mockReturnValue('gh-user\n' as any);

      mockedAxios.get.mockImplementation(async (url: string) => {
        if (url.includes('localhost')) return { data: SAMPLE_FLOW }; // has author: 'testuser'
        throw { response: { status: 404 } };
      });
      mockedAxios.put.mockResolvedValue({ data: { content: { html_url: 'https://github.com/cglab-public/agenfk-flows/blob/main/flows/standard-dev-flow.json' } } });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await program.parseAsync(['node', 'agenfk', 'flow', 'publish', 'flow-uuid-registry-1']);

      const putCall = mockedAxios.put.mock.calls[0];
      const decoded = JSON.parse(Buffer.from((putCall[1] as any).content, 'base64').toString('utf8'));
      expect(decoded.author).toBe('testuser');

      logSpy.mockRestore();
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

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No flows found'));
      logSpy.mockRestore();
    });

    it('should use custom registry from --registry flag', async () => {
      mockedAxios.get.mockImplementation(async (url: string) => {
        if (url.includes('my-org/my-flows')) return { data: [{ name: 'myflow.json', type: 'file' }] };
        return { data: { schemaVersion: '1', name: 'My Flow', steps: [] } };
      });

      const tableSpy = vi.spyOn(console, 'table').mockImplementation(() => {});
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await program.parseAsync(['node', 'agenfk', 'flow', 'browse', '--registry', 'my-org/my-flows']);

      expect(mockedAxios.get).toHaveBeenCalledWith(
        expect.stringContaining('api.github.com/repos/my-org/my-flows/contents/flows'),
        expect.any(Object)
      );

      tableSpy.mockRestore();
      logSpy.mockRestore();
    });

    it('should skip non-json files', async () => {
      const files = [
        { name: 'README.md', type: 'file' },
        { name: 'valid-flow.json', type: 'file' },
      ];

      mockedAxios.get.mockImplementation(async (url: string) => {
        if (url.includes('api.github.com')) return { data: files };
        return { data: REGISTRY_FLOW_JSON };
      });

      const tableSpy = vi.spyOn(console, 'table').mockImplementation(() => {});
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await program.parseAsync(['node', 'agenfk', 'flow', 'browse']);

      const tableArg = tableSpy.mock.calls[0]?.[0] as any[];
      expect(tableArg).toHaveLength(1);
      expect(tableArg[0].File).toBe('valid-flow.json');

      tableSpy.mockRestore();
      logSpy.mockRestore();
    });

    it('should handle errors gracefully', async () => {
      mockedAxios.get.mockRejectedValue(new Error('Network error'));

      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await program.parseAsync(['node', 'agenfk', 'flow', 'browse']);

      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Error browsing registry'), expect.any(String));
      errSpy.mockRestore();
    });
  });

  // ── flow install ──────────────────────────────────────────────────────────────

  describe('flow install', () => {
    it('should download flow JSON and POST to local server', async () => {
      mockedAxios.get.mockResolvedValue({ data: REGISTRY_FLOW_JSON });
      mockedAxios.post.mockResolvedValue({ data: { id: 'new-flow-id-xyz', name: 'Standard Dev Flow' } });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await program.parseAsync(['node', 'agenfk', 'flow', 'install', 'standard-dev-flow.json']);

      expect(mockedAxios.get).toHaveBeenCalledWith(
        expect.stringContaining('raw.githubusercontent.com/cglab-public/agenfk-flows/main/flows/standard-dev-flow.json')
      );

      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.stringContaining('/flows'),
        expect.objectContaining({
          name: 'Standard Dev Flow',
          description: 'A standard development flow',
          steps: expect.arrayContaining([
            expect.objectContaining({ name: 'todo', label: 'To Do', order: 1 }),
            expect.objectContaining({ name: 'done', label: 'Done', order: 3, isSpecial: true }),
          ]),
        })
      );

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Flow installed'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('new-flow-id-xyz'));
      logSpy.mockRestore();
    });

    it('should append .json extension when not provided', async () => {
      mockedAxios.get.mockResolvedValue({ data: REGISTRY_FLOW_JSON });
      mockedAxios.post.mockResolvedValue({ data: { id: 'new-flow-id-xyz', name: 'Standard Dev Flow' } });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await program.parseAsync(['node', 'agenfk', 'flow', 'install', 'standard-dev-flow']);

      expect(mockedAxios.get).toHaveBeenCalledWith(
        expect.stringContaining('standard-dev-flow.json')
      );
      logSpy.mockRestore();
    });

    it('should error when flow JSON is invalid (missing required fields)', async () => {
      mockedAxios.get.mockResolvedValue({ data: { name: 'Incomplete Flow' } }); // missing schemaVersion and steps

      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

      await program.parseAsync(['node', 'agenfk', 'flow', 'install', 'incomplete.json']);

      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid flow file'));
      errSpy.mockRestore();
      exitSpy.mockRestore();
    });

    it('should use custom registry from --registry flag', async () => {
      mockedAxios.get.mockResolvedValue({ data: REGISTRY_FLOW_JSON });
      mockedAxios.post.mockResolvedValue({ data: { id: 'new-id', name: 'Standard Dev Flow' } });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await program.parseAsync(['node', 'agenfk', 'flow', 'install', 'standard-dev-flow.json', '--registry', 'my-org/my-flows']);

      expect(mockedAxios.get).toHaveBeenCalledWith(
        expect.stringContaining('raw.githubusercontent.com/my-org/my-flows/main/flows/standard-dev-flow.json')
      );
      logSpy.mockRestore();
    });

    it('should handle errors from local API', async () => {
      mockedAxios.get.mockResolvedValue({ data: REGISTRY_FLOW_JSON });
      mockedAxios.post.mockRejectedValue({ response: { data: { error: 'Server error' } } });

      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await program.parseAsync(['node', 'agenfk', 'flow', 'install', 'standard-dev-flow.json']);

      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Error installing flow'), expect.any(String));
      errSpy.mockRestore();
    });

    it('should handle errors from registry download', async () => {
      mockedAxios.get.mockRejectedValue(new Error('Not found'));

      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await program.parseAsync(['node', 'agenfk', 'flow', 'install', 'nonexistent.json']);

      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Error installing flow'), expect.any(String));
      errSpy.mockRestore();
    });
  });

  // ── config set flowRegistry ───────────────────────────────────────────────────

  describe('config set flowRegistry', () => {
    it('should write flowRegistry to config.json', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('{}');

      await program.parseAsync(['node', 'agenfk', 'config', 'set', 'flowRegistry', 'my-org/my-registry']);

      expect(mockWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining('config.json'),
        expect.stringContaining('"flowRegistry": "my-org/my-registry"'),
        'utf8'
      );
      const written = JSON.parse((mockWriteFileSync.mock.calls[0] as any[])[1] as string);
      expect(written.flowRegistry).toBe('my-org/my-registry');
    });

    it('should error when value is not in owner/repo format', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

      await program.parseAsync(['node', 'agenfk', 'config', 'set', 'flowRegistry', 'notavalidrepo']);

      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('"owner/repo" format'));
      errSpy.mockRestore();
      exitSpy.mockRestore();
    });
  });
});
