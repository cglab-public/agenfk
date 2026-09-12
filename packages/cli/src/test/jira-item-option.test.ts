/**
 * `agenfk create --jira-item` and `agenfk update --jira-item` — attaching a JIRA
 * reference from the CLI.
 *
 * The JIRA importer has always produced cards carrying externalId/externalUrl,
 * but a card created any other way had no route to a JIRA reference at all: the
 * server's item write paths ignored the fields, and the CLI had no flag. These
 * tests pin the CLI half — the flag exists on both commands, forwards the raw
 * value as `jiraItem` for the server to validate, and stays absent from the
 * payload when unused so an ordinary `--title` edit cannot silently drop an
 * existing link.
 *
 * Resolution deliberately stays server-side: the CLI must not second-guess the
 * key format, because the server is the only place that can check it against a
 * live JIRA, and duplicating the rule in two languages of validation is how the
 * two drift apart.
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
import axios from 'axios';

const mockedAxios = vi.mocked(axios, true);
const API = 'http://localhost:3000';
const PROJECT = '33333333-3333-3333-3333-333333333333';
const ITEM = '11111111-1111-1111-1111-111111111111';

function resetCommanderOptions(cmd: any) {
  const options = (cmd as any).options || [];
  options.forEach((opt: any) => cmd.setOptionValue(opt.attributeName(), undefined));
  (cmd.commands || []).forEach(resetCommanderOptions);
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(false);
  mockReadFileSync.mockReturnValue('{}');
  program.commands.forEach(resetCommanderOptions);
  program.setOptionValue('toon', undefined);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
});

const outputText = () =>
  [...logSpy.mock.calls, ...errorSpy.mock.calls].map(c => c.join(' ')).join('\n');

describe('agenfk create --jira-item', () => {
  it('exposes a --jira-item option on create', () => {
    const create = program.commands.find(c => c.name() === 'create');
    expect(create).toBeDefined();
    const flags = (create as any).options.map((o: any) => o.long);
    expect(flags).toContain('--jira-item');
  });

  it('forwards the key as jiraItem on the create payload', async () => {
    mockedAxios.post.mockResolvedValue({ data: { id: ITEM, title: 'T', externalId: 'CGLAB-163' } });

    await program.parseAsync([
      'node', 'agenfk', 'create', 'TASK', 'Fix the picker', '--project', PROJECT, '--jira-item', 'CGLAB-163',
    ]);

    expect(mockedAxios.post).toHaveBeenCalledWith(
      `${API}/items`,
      expect.objectContaining({ jiraItem: 'CGLAB-163' }),
    );
  });

  it('forwards the value verbatim, leaving format validation to the server', async () => {
    mockedAxios.post.mockResolvedValue({ data: { id: ITEM, title: 'T' } });

    await program.parseAsync([
      'node', 'agenfk', 'create', 'TASK', 'T', '--project', PROJECT, '--jira-item', 'cglab-163',
    ]);

    expect(mockedAxios.post).toHaveBeenCalledWith(
      `${API}/items`,
      expect.objectContaining({ jiraItem: 'cglab-163' }),
    );
  });

  it('omits jiraItem from the payload entirely when the flag is not passed', async () => {
    mockedAxios.post.mockResolvedValue({ data: { id: ITEM, title: 'T' } });

    await program.parseAsync(['node', 'agenfk', 'create', 'TASK', 'T', '--project', PROJECT]);

    const body = mockedAxios.post.mock.calls[0][1] as any;
    expect(body).not.toHaveProperty('jiraItem');
  });

  it('reports the linked key on success, so the link is visible without a second lookup', async () => {
    mockedAxios.post.mockResolvedValue({
      data: { id: ITEM, title: 'T', externalId: 'CGLAB-163', externalUrl: 'https://x.atlassian.net/browse/CGLAB-163' },
    });

    await program.parseAsync([
      'node', 'agenfk', 'create', 'TASK', 'T', '--project', PROJECT, '--jira-item', 'CGLAB-163',
    ]);

    expect(outputText()).toContain('CGLAB-163');
  });

  it("surfaces the server's rejection of a bad key instead of claiming success", async () => {
    const err: any = new Error('Request failed with status code 400');
    err.response = { data: { error: "Invalid JIRA item 'nope'." }, status: 400 };
    mockedAxios.post.mockRejectedValue(err);

    await program.parseAsync([
      'node', 'agenfk', 'create', 'TASK', 'T', '--project', PROJECT, '--jira-item', 'nope',
    ]);

    expect(outputText()).toContain("Invalid JIRA item 'nope'.");
    expect(outputText()).not.toMatch(/Created TASK/);
  });

  it('surfaces an unverified-link warning returned by the server', async () => {
    mockedAxios.post.mockResolvedValue({
      data: { id: ITEM, title: 'T', externalId: 'CGLAB-163', jiraWarning: "Linked 'CGLAB-163' without verifying it — JIRA could not be reached." },
    });

    await program.parseAsync([
      'node', 'agenfk', 'create', 'TASK', 'T', '--project', PROJECT, '--jira-item', 'CGLAB-163',
    ]);

    expect(outputText()).toMatch(/without verifying/i);
  });
});

describe('agenfk update --jira-item', () => {
  it('exposes a --jira-item option on update', () => {
    const update = program.commands.find(c => c.name() === 'update');
    expect(update).toBeDefined();
    const flags = (update as any).options.map((o: any) => o.long);
    expect(flags).toContain('--jira-item');
  });

  it('PUTs jiraItem when linking an existing card', async () => {
    mockedAxios.put.mockResolvedValue({ data: { id: ITEM, title: 'T', type: 'TASK', status: 'TODO', externalId: 'CGLAB-163' } });

    await program.parseAsync(['node', 'agenfk', 'update', ITEM, '--jira-item', 'CGLAB-163']);

    expect(mockedAxios.put).toHaveBeenCalledWith(
      `${API}/items/${ITEM}`,
      expect.objectContaining({ jiraItem: 'CGLAB-163' }),
    );
  });

  it("forwards 'none' unchanged so the server performs the unlink", async () => {
    mockedAxios.put.mockResolvedValue({ data: { id: ITEM, title: 'T', type: 'TASK', status: 'TODO', externalId: null } });

    await program.parseAsync(['node', 'agenfk', 'update', ITEM, '--jira-item', 'none']);

    expect(mockedAxios.put).toHaveBeenCalledWith(
      `${API}/items/${ITEM}`,
      expect.objectContaining({ jiraItem: 'none' }),
    );
  });

  it('confirms the unlink, which is otherwise indistinguishable from the flag being ignored', async () => {
    mockedAxios.put.mockResolvedValue({ data: { id: ITEM, title: 'T', type: 'TASK', status: 'TODO', externalId: null } });

    await program.parseAsync(['node', 'agenfk', 'update', ITEM, '--jira-item', 'none']);

    expect(outputText()).toMatch(/unlinked/i);
  });

  it('does not claim an unlink when no jira flag was passed', async () => {
    mockedAxios.put.mockResolvedValue({ data: { id: ITEM, title: 'New', type: 'TASK', status: 'TODO' } });

    await program.parseAsync(['node', 'agenfk', 'update', ITEM, '--title', 'New']);

    expect(outputText()).not.toMatch(/unlinked/i);
  });

  it('says nothing about the tracker on an edit that never mentioned it', async () => {
    // A card linked by the GitHub importer used to make every --title edit print
    // 'JIRA: 4321' — wrong tracker, and noise on an unrelated change.
    mockedAxios.put.mockResolvedValue({
      data: { id: ITEM, title: 'New', type: 'TASK', status: 'TODO', externalId: '4321', externalUrl: 'https://github.com/o/r/issues/4321' },
    });

    await program.parseAsync(['node', 'agenfk', 'update', ITEM, '--title', 'New']);

    expect(outputText()).not.toMatch(/JIRA:/);
    expect(outputText()).not.toMatch(/GitHub:/);
  });

  it('names GitHub rather than JIRA when the reference is a GitHub issue', async () => {
    mockedAxios.put.mockResolvedValue({
      data: { id: ITEM, title: 'T', type: 'TASK', status: 'TODO', externalId: '4321', externalUrl: 'https://github.com/o/r/issues/4321' },
    });

    await program.parseAsync(['node', 'agenfk', 'update', ITEM, '--jira-item', 'CGLAB-163']);

    expect(outputText()).toMatch(/GitHub: 4321/);
  });

  it("labels a JIRA link as JIRA even when 'github.com' appears in its query string", async () => {
    // The label is taken from the HOST, not from a substring of the whole URL.
    mockedAxios.put.mockResolvedValue({
      data: { id: ITEM, title: 'T', type: 'TASK', status: 'TODO', externalId: 'CGLAB-163', externalUrl: 'https://cg-lab.atlassian.net/browse/CGLAB-163?ref=github.com' },
    });

    await program.parseAsync(['node', 'agenfk', 'update', ITEM, '--jira-item', 'CGLAB-163']);

    expect(outputText()).toMatch(/JIRA: CGLAB-163/);
    expect(outputText()).not.toMatch(/GitHub:/);
  });

  it('surfaces a jiraWarning on the UPDATE path too, not only on create', async () => {
    mockedAxios.put.mockResolvedValue({
      data: { id: ITEM, title: 'T', type: 'TASK', status: 'TODO', externalId: 'CGLAB-163', jiraWarning: "Linked 'CGLAB-163' without verifying it — JIRA could not be reached." },
    });

    await program.parseAsync(['node', 'agenfk', 'update', ITEM, '--jira-item', 'CGLAB-163']);

    expect(outputText()).toMatch(/without verifying/i);
  });

  it('does not send jiraItem when updating something else, so an existing link survives a rename', async () => {
    mockedAxios.put.mockResolvedValue({ data: { id: ITEM, title: 'New', type: 'TASK', status: 'TODO', externalId: 'CGLAB-163' } });

    await program.parseAsync(['node', 'agenfk', 'update', ITEM, '--title', 'New']);

    const body = mockedAxios.put.mock.calls[0][1] as any;
    expect(body).not.toHaveProperty('jiraItem');
  });

  it("surfaces the server's rejection rather than reporting an update that did not happen", async () => {
    const err: any = new Error('Request failed with status code 400');
    err.response = { data: { error: "JIRA item 'CGLAB-99999' could not be found" }, status: 400 };
    mockedAxios.put.mockRejectedValue(err);

    await program.parseAsync(['node', 'agenfk', 'update', ITEM, '--jira-item', 'CGLAB-99999']);

    expect(outputText()).toContain("could not be found");
  });

  it('resolves a short item id before sending the link', async () => {
    mockedAxios.get.mockResolvedValue({ data: [{ id: ITEM, title: 'T' }] });
    mockedAxios.put.mockResolvedValue({ data: { id: ITEM, title: 'T', type: 'TASK', status: 'TODO', externalId: 'CGLAB-163' } });

    await program.parseAsync(['node', 'agenfk', 'update', '11111111', '--jira-item', 'CGLAB-163']);

    expect(mockedAxios.put).toHaveBeenCalledWith(
      `${API}/items/${ITEM}`,
      expect.objectContaining({ jiraItem: 'CGLAB-163' }),
    );
  });
});
