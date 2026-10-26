/**
 * @file GH-286 — `agenfk flow create` and `flow edit` only ask for prompt types
 * the installed inquirer registers. inquirer 10+ dropped `list` (it is
 * `select` now), and an unknown type rejects the prompt: the command catches
 * that, prints an error and saves nothing.
 *
 * The questions go through the REAL inquirer's prompt registry, so a type the
 * installed version lacks fails here; only the answers are scripted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

vi.mock('axios');
vi.mock('child_process', () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  default: { execSync: vi.fn(), spawn: vi.fn(), spawnSync: vi.fn() },
}));

// The scripted answers, in order, one per prompt() call: an answers object, or
// { keys } to run the real prompt and type each chunk into it once it has drawn
// (inquirer discards keys typed before it is ready, and ignores keys while it
// validates an answer).
const { answers, asked } = vi.hoisted(() => ({ answers: [] as Record<string, unknown>[], asked: [] as string[] }));
vi.mock('inquirer', async (importOriginal) => {
  const real: any = ((await importOriginal()) as any).default;
  const { PassThrough } = await import('stream');
  const registered = Object.keys(real.createPromptModule().prompts);
  const typeInto = async (questions: unknown[], keys: string[]) => {
    const input = new PassThrough();
    const output = new PassThrough();
    const pending = [...keys];
    // A redraw is the prompt saying it is idle again: type the next chunk then.
    output.on('data', () => {
      const next = pending.shift();
      if (next !== undefined) setImmediate(() => input.write(next));
    });
    return real.createPromptModule({ input, output })(questions);
  };
  return {
    default: {
      prompt: vi.fn(async (questions: { type: string; name: string }[]) => {
        for (const q of questions) {
          asked.push(q.type);
          if (!registered.includes(q.type)) throw new Error(`Prompt type "${q.type}" is not registered in the installed inquirer`);
        }
        const next = answers.shift();
        if (!next) throw new Error('No scripted answer left');
        return Array.isArray(next.keys) ? typeInto(questions, next.keys) : next;
      }),
    },
  };
});

import { program } from '../index';
import axios from 'axios';

const mockedAxios = vi.mocked(axios, true);
const run = (...args: string[]) => program.parseAsync(['node', 'agenfk', ...args]);

const FLOW = {
  id: 'flow-1', name: 'Mine', description: '', steps: [
    { id: 'a', name: 'TODO', label: 'To do', order: 1 },
    { id: 'b', name: 'WORK', label: 'Work', order: 2 },
    { id: 'c', name: 'DONE', label: 'Done', order: 3 },
  ],
};

describe('flow create / edit prompts on the installed inquirer (GH-286)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    answers.length = 0;
    asked.length = 0;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('flow create asks only registered types and saves the steps answered', async () => {
    mockedAxios.post.mockResolvedValue({ data: { id: 'f', name: 'New', steps: [{}] } });
    answers.push(
      { description: 'd' },
      { stepName: 'BUILD' },
      { label: 'Build', exitCriteria: '', isSpecial: false },
      { stepName: '' },
    );
    await run('flow', 'create', 'New');
    expect(console.error).not.toHaveBeenCalled();
    expect(mockedAxios.post).toHaveBeenCalledWith(expect.stringMatching(/\/flows$/), expect.objectContaining({
      name: 'New', description: 'd', steps: [expect.objectContaining({ name: 'BUILD', label: 'Build', order: 1 })],
    }));
  });

  it('flow edit can remove, reorder and edit a step, then save', async () => {
    mockedAxios.get.mockResolvedValue({ data: FLOW });
    mockedAxios.put.mockResolvedValue({ data: { name: 'Mine', steps: [{}, {}] } });
    answers.push(
      { action: 'remove' }, { stepToRemove: 'b' },
      { action: 'reorder' }, { stepToMove: 'a' }, { newOrder: 9 },
      { action: 'edit' }, { stepToEdit: 'c' }, { name: 'SHIPPED', label: 'Shipped', exitCriteria: '', isSpecial: true },
      { action: 'save' },
    );
    await run('flow', 'edit', 'flow-1');
    expect(console.error).not.toHaveBeenCalled();
    expect(asked).toContain('number');
    expect(mockedAxios.put).toHaveBeenCalledWith(expect.stringMatching(/\/flows\/flow-1$/), expect.objectContaining({
      steps: [
        expect.objectContaining({ id: 'c', name: 'SHIPPED', label: 'Shipped', order: 3, isSpecial: true }),
        expect.objectContaining({ id: 'a', name: 'TODO', order: 9 }),
      ],
    }));
  });

  // Review of GH-286 (Codex): on inquirer 14, Enter alone on a number prompt
  // answered undefined, and the server refused the whole edit.
  it('reorder: Enter alone in the real prompt keeps the step where it was', async () => {
    mockedAxios.get.mockResolvedValue({ data: FLOW });
    mockedAxios.put.mockResolvedValue({ data: { name: 'Mine', steps: [{}, {}, {}] } });
    answers.push({ action: 'reorder' }, { stepToMove: 'b' }, { keys: ['\r'] }, { action: 'save' });
    await run('flow', 'edit', 'flow-1');
    expect(console.error).not.toHaveBeenCalled();
    const saved = mockedAxios.put.mock.calls[0][1] as typeof FLOW;
    expect(saved.steps.map((s) => [s.id, s.order])).toEqual([['a', 1], ['b', 2], ['c', 3]]);
  });

  it('reorder: a number typed into the real prompt moves the step', async () => {
    mockedAxios.get.mockResolvedValue({ data: FLOW });
    mockedAxios.put.mockResolvedValue({ data: { name: 'Mine', steps: [{}, {}, {}] } });
    answers.push({ action: 'reorder' }, { stepToMove: 'a' }, { keys: ['7\r'] }, { action: 'save' });
    await run('flow', 'edit', 'flow-1');
    const saved = mockedAxios.put.mock.calls[0][1] as typeof FLOW;
    expect(saved.steps.map((s) => [s.id, s.order])).toEqual([['b', 2], ['c', 3], ['a', 7]]);
  });

  it('reorder: a step with no order cannot be given an empty one', async () => {
    const unordered = { ...FLOW, steps: [FLOW.steps[0], { id: 'x', name: 'LOOSE', label: 'Loose' }] };
    mockedAxios.get.mockResolvedValue({ data: unordered });
    mockedAxios.put.mockResolvedValue({ data: { name: 'Mine', steps: [{}, {}] } });
    // Enter alone is refused (there is no order to keep); the number typed next is saved.
    answers.push({ action: 'reorder' }, { stepToMove: 'x' }, { keys: ['\r', '4\r'] }, { action: 'save' });
    await run('flow', 'edit', 'flow-1');
    const saved = mockedAxios.put.mock.calls[0][1] as typeof FLOW;
    expect(saved.steps.map((s) => [s.id, s.order])).toEqual([['a', 1], ['x', 4]]);
  });
});
