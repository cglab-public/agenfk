/**
 * CGLAB-427: `agenfk create` returns the card it created.
 *
 * An agent that created a card used to query agenfk again (get, list) to learn
 * its id and confirm its details: the CLI printed one confirmation line, and a
 * create that failed still exited 0. MCP's create_item has always returned the
 * item. These pin the CLI's side: the confirmation line stays (readers of it
 * keep working), the item's JSON follows it, --json prints the JSON alone (and
 * --toon its TOON form), and a failed create exits non-zero with nothing on
 * stdout to mistake for a card.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockExistsSync, mockReadFileSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
}));

vi.mock('@agenfk/telemetry', () => ({
  TelemetryClient: vi.fn(function (this: any) {
    this.capture = vi.fn();
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
vi.mock('figlet', () => ({ default: { textSync: vi.fn().mockReturnValue('AgEnFK') } }));
vi.mock('inquirer', () => ({ default: { prompt: vi.fn() } }));


import { program } from '../index';
import { toonEncode } from '../toon';
import axios from 'axios';

const mockedAxios = vi.mocked(axios, true);
const PROJECT = '33333333-3333-3333-3333-333333333333';
const CARD = {
  id: '11111111-1111-1111-1111-111111111111', type: 'TASK', title: 'Fix the picker', status: 'TODO',
  parentId: '22222222-2222-2222-2222-222222222222', projectId: PROJECT, description: 'the description',
};

function resetCommanderOptions(cmd: any) {
  const options = (cmd as any).options || [];
  options.forEach((opt: any) => cmd.setOptionValue(opt.attributeName(), undefined));
  (cmd.commands || []).forEach(resetCommanderOptions);
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(false);
  mockReadFileSync.mockReturnValue('{}');
  program.commands.forEach(resetCommanderOptions);
  program.setOptionValue('toon', undefined);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
});

const stdout = () => logSpy.mock.calls.map(c => c.join(' ')).join('\n');
const stderr = () => errorSpy.mock.calls.map(c => c.join(' ')).join('\n');
const create = (...extra: string[]) =>
  program.parseAsync(['node', 'agenfk', ...extra.filter(a => a === '--toon'), 'create', 'TASK', 'Fix the picker', '--project', PROJECT, ...extra.filter(a => a !== '--toon')]);

describe('agenfk create returns the card it created (CGLAB-427)', () => {
  it('prints the confirmation line and then the whole card as JSON', async () => {
    mockedAxios.post.mockResolvedValue({ data: CARD });
    await create();
    const out = stdout();
    expect(out).toContain(`Created TASK: Fix the picker (ID: ${CARD.id})`);
    const json = out.slice(out.indexOf('{'));
    expect(JSON.parse(json)).toEqual(CARD);
  });

  it('with --json prints the card alone, parseable as it stands', async () => {
    mockedAxios.post.mockResolvedValue({ data: CARD });
    await create('--json');
    expect(JSON.parse(stdout())).toEqual(CARD);
  });

  it('with --json keeps a JIRA warning off stdout, where it would break the JSON', async () => {
    const card = { ...CARD, externalId: 'CGLAB-163', jiraWarning: "Linked 'CGLAB-163' without verifying it - JIRA could not be reached." };
    mockedAxios.post.mockResolvedValue({ data: card });
    await create('--json', '--jira-item', 'CGLAB-163');
    expect(JSON.parse(stdout())).toEqual(card);
    expect(stderr()).toMatch(/without verifying/);
  });

  it('with --toon prints the card in TOON', async () => {
    mockedAxios.post.mockResolvedValue({ data: CARD });
    await create('--toon');
    expect(stdout()).toContain(toonEncode(CARD));
  });

  it('a create the server refuses exits non-zero', async () => {
    const err: any = new Error('Request failed with status code 400');
    err.response = { data: { error: 'Invalid type' }, status: 400 };
    mockedAxios.post.mockRejectedValue(err);
    await create();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderr()).toContain('Invalid type');
  });

  it('a refused create with --json leaves stdout empty, so nothing reads as a card', async () => {
    const err: any = new Error('connect ECONNREFUSED');
    mockedAxios.post.mockRejectedValue(err);
    await create('--json');
    // The create itself ran and failed - not commander refusing an unknown --json.
    expect(mockedAxios.post).toHaveBeenCalled();
    expect(stderr()).toMatch(/Error creating item/);
    expect(stdout()).toBe('');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
