import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist mock vars so they're available inside vi.mock factories
const { mockExistsSync, mockReadFileSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
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
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  default: {
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: vi.fn(),
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

// Mock inquirer
const mockInquirerPrompt = vi.fn();
vi.mock('inquirer', () => ({
  default: { prompt: mockInquirerPrompt },
}));

import { program } from '../index';
import axios from 'axios';

const mockedAxios = vi.mocked(axios, true);

const SAMPLE_FLOW = {
  id: 'flow-uuid-1234-5678',
  name: 'Standard Flow',
  description: 'A standard dev flow',
  projectId: 'proj-uuid-1234',
  steps: [
    { id: 'step-1', name: 'todo', label: 'To Do', order: 1, isSpecial: false },
    { id: 'step-2', name: 'in_progress', label: 'In Progress', order: 2, isSpecial: false },
    { id: 'step-3', name: 'done', label: 'Done', order: 3, isSpecial: true, exitCriteria: 'All tests pass' },
  ],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe('flow command', () => {
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
    // Reset commander option state including subcommands
    program.commands.forEach(resetCommanderOptions);
  });

  it('should have flow command registered', () => {
    const commands = program.commands.map(c => c.name());
    expect(commands).toContain('flow');
  });

  describe('flow list', () => {
    it('should call GET /flows and display results', async () => {
      mockedAxios.get.mockResolvedValue({ data: [SAMPLE_FLOW] });

      const consoleSpy = vi.spyOn(console, 'table').mockImplementation(() => {});
      await program.parseAsync(['node', 'agenfk', 'flow', 'list']);

      expect(mockedAxios.get).toHaveBeenCalledWith(expect.stringContaining('/flows'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.arrayContaining([
        expect.objectContaining({ Name: 'Standard Flow', Steps: 3 }),
      ]));
      consoleSpy.mockRestore();
    });

    it('should show yellow message when no flows', async () => {
      mockedAxios.get.mockResolvedValue({ data: [] });

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await program.parseAsync(['node', 'agenfk', 'flow', 'list']);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('No flows found'));
      consoleSpy.mockRestore();
    });

    it('should handle errors gracefully', async () => {
      mockedAxios.get.mockRejectedValue(new Error('Network error'));

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await program.parseAsync(['node', 'agenfk', 'flow', 'list']);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Error listing flows'), expect.any(String));
      consoleSpy.mockRestore();
    });
  });

  describe('flow show', () => {
    it('should call GET /flows/:id and display steps', async () => {
      mockedAxios.get.mockResolvedValue({ data: SAMPLE_FLOW });

      const tablespy = vi.spyOn(console, 'table').mockImplementation(() => {});
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await program.parseAsync(['node', 'agenfk', 'flow', 'show', 'flow-uuid-1234-5678']);

      expect(mockedAxios.get).toHaveBeenCalledWith(expect.stringContaining('/flows/flow-uuid-1234-5678'));
      expect(tablespy).toHaveBeenCalledWith(expect.arrayContaining([
        expect.objectContaining({ Name: 'todo', Label: 'To Do' }),
      ]));
      tablespy.mockRestore();
      logSpy.mockRestore();
    });

    it('should show message when flow has no steps', async () => {
      mockedAxios.get.mockResolvedValue({ data: { ...SAMPLE_FLOW, steps: [] } });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await program.parseAsync(['node', 'agenfk', 'flow', 'show', 'flow-uuid-1234-5678']);

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No steps defined'));
      logSpy.mockRestore();
    });

    it('should handle errors gracefully', async () => {
      mockedAxios.get.mockRejectedValue({ response: { data: { error: 'Not found' } } });

      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await program.parseAsync(['node', 'agenfk', 'flow', 'show', 'bad-id']);

      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Error showing flow'), 'Not found');
      errSpy.mockRestore();
    });
  });

  describe('flow create', () => {
    it('should prompt for description and steps, then POST /flows', async () => {
      mockInquirerPrompt
        .mockResolvedValueOnce({ description: 'My flow description' }) // description prompt
        .mockResolvedValueOnce({ stepName: 'todo' }) // first step name
        .mockResolvedValueOnce({ label: 'To Do', exitCriteria: '', isSpecial: false }) // step details
        .mockResolvedValueOnce({ stepName: '' }); // blank name to finish

      mockedAxios.post.mockResolvedValue({ data: { ...SAMPLE_FLOW, name: 'My Flow', steps: [{ id: 's1' }] } });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await program.parseAsync(['node', 'agenfk', 'flow', 'create', 'My Flow']);

      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.stringContaining('/flows'),
        expect.objectContaining({
          name: 'My Flow',
          description: 'My flow description',
        })
      );
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Created flow'));
      logSpy.mockRestore();
    });
  });

  describe('flow edit', () => {
    it('should load flow, show menu, and PUT /flows/:id when saving', async () => {
      mockedAxios.get.mockResolvedValue({ data: SAMPLE_FLOW });
      mockedAxios.put.mockResolvedValue({ data: { ...SAMPLE_FLOW, steps: SAMPLE_FLOW.steps } });

      // User picks 'Save and exit' immediately
      mockInquirerPrompt.mockResolvedValueOnce({ action: 'save' });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await program.parseAsync(['node', 'agenfk', 'flow', 'edit', 'flow-uuid-1234-5678']);

      expect(mockedAxios.get).toHaveBeenCalledWith(expect.stringContaining('/flows/flow-uuid-1234-5678'));
      expect(mockedAxios.put).toHaveBeenCalledWith(
        expect.stringContaining('/flows/flow-uuid-1234-5678'),
        expect.objectContaining({ name: 'Standard Flow' })
      );
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Saved flow'));
      logSpy.mockRestore();
    });

    it('should cancel without saving when user chooses cancel', async () => {
      mockedAxios.get.mockResolvedValue({ data: SAMPLE_FLOW });

      mockInquirerPrompt.mockResolvedValueOnce({ action: 'cancel' });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await program.parseAsync(['node', 'agenfk', 'flow', 'edit', 'flow-uuid-1234-5678']);

      expect(mockedAxios.put).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Edit cancelled'));
      logSpy.mockRestore();
    });

    it('should add a step when user selects add then save', async () => {
      mockedAxios.get.mockResolvedValue({ data: { ...SAMPLE_FLOW, steps: [] } });
      mockedAxios.put.mockResolvedValue({ data: { ...SAMPLE_FLOW, steps: [{ id: 'new-s' }] } });

      mockInquirerPrompt
        .mockResolvedValueOnce({ action: 'add' })
        .mockResolvedValueOnce({ name: 'review', label: 'Review', exitCriteria: '', isSpecial: false })
        .mockResolvedValueOnce({ action: 'save' });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await program.parseAsync(['node', 'agenfk', 'flow', 'edit', 'flow-uuid-1234-5678']);

      expect(mockedAxios.put).toHaveBeenCalledWith(
        expect.stringContaining('/flows/flow-uuid-1234-5678'),
        expect.objectContaining({
          steps: expect.arrayContaining([
            expect.objectContaining({ name: 'review' }),
          ]),
        })
      );
      logSpy.mockRestore();
    });
  });

  describe('flow use', () => {
    it('should POST /projects/:id/flow with flowId', async () => {
      mockedAxios.post.mockResolvedValue({ data: {} });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await program.parseAsync(['node', 'agenfk', 'flow', 'use', 'flow-uuid-1234-5678', '--project', 'proj-abc']);

      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.stringContaining('/projects/proj-abc/flow'),
        { flowId: 'flow-uuid-1234-5678' }
      );
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('activated'));
      logSpy.mockRestore();
    });

    it('should error when no project id available', async () => {
      mockExistsSync.mockReturnValue(false);

      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

      await program.parseAsync(['node', 'agenfk', 'flow', 'use', 'flow-uuid-1234-5678']);

      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Project ID is required'));
      exitSpy.mockRestore();
      errSpy.mockRestore();
    });

    it('should handle API errors gracefully', async () => {
      mockedAxios.post.mockRejectedValue({ response: { data: { error: 'Flow not found' } } });

      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await program.parseAsync(['node', 'agenfk', 'flow', 'use', 'bad-flow-id', '--project', 'proj-abc']);

      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Error activating flow'), 'Flow not found');
      errSpy.mockRestore();
    });
  });

  describe('flow reset', () => {
    it('should POST /projects/:id/flow with null flowId', async () => {
      mockedAxios.post.mockResolvedValue({ data: {} });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await program.parseAsync(['node', 'agenfk', 'flow', 'reset', '--project', 'proj-abc']);

      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.stringContaining('/projects/proj-abc/flow'),
        { flowId: null }
      );
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('reset to default'));
      logSpy.mockRestore();
    });

    it('should error when no project id available', async () => {
      mockExistsSync.mockReturnValue(false);

      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

      await program.parseAsync(['node', 'agenfk', 'flow', 'reset']);

      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Project ID is required'));
      exitSpy.mockRestore();
      errSpy.mockRestore();
    });

    it('should handle API errors gracefully', async () => {
      mockedAxios.post.mockRejectedValue(new Error('Connection refused'));

      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await program.parseAsync(['node', 'agenfk', 'flow', 'reset', '--project', 'proj-abc']);

      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Error resetting flow'), 'Connection refused');
      errSpy.mockRestore();
    });
  });
});
