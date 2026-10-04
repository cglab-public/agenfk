/**
 * BUG 022b229a: with the local server down, the CLI reads GitHub itself to
 * decide the upgrade tier - and read /releases/latest, picked by DATE. It now
 * applies the server's rule (core releaseChannel): the newest framework stable
 * by version, with the strongest tier among stables newer than this install.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const homedir = vi.fn(() => actual.homedir());
  return { ...actual, homedir, default: { ...actual, homedir } };
});
vi.mock('@agenfk/telemetry', () => ({
  TelemetryClient: vi.fn(function (this: any) { this.capture = vi.fn(); this.shutdown = vi.fn().mockResolvedValue(undefined); this.isEnabled = false; }),
  getInstallationId: vi.fn().mockReturnValue('test-install-id'),
  isTelemetryEnabled: vi.fn().mockReturnValue(false),
  getApiUrl: vi.fn().mockReturnValue('http://localhost:3000'),
  readServerPort: vi.fn().mockReturnValue(null),
  DEFAULT_API_PORT: 3000,
}));
vi.mock('axios');
vi.mock('child_process', () => ({ execSync: vi.fn(), execFileSync: vi.fn(), spawn: vi.fn(), spawnSync: vi.fn(), default: { execSync: vi.fn(), execFileSync: vi.fn(), spawn: vi.fn(), spawnSync: vi.fn() } }));
vi.mock('inquirer', () => ({ default: { prompt: vi.fn() } }));

import * as os from 'os';
import axios from 'axios';
import { checkUpgradeTier } from '../index';

const mockedAxios = vi.mocked(axios, true);
let home: string;
const cache = () => JSON.parse(fs.readFileSync(path.join(home, '.agenfk', 'upgrade-tier-cache.json'), 'utf8'));

function github(latest: string, list: Array<{ tag: string; pre?: boolean; draft?: boolean }>, tiers: Record<string, string>) {
  mockedAxios.get.mockImplementation(async (url: string) => {
    if (url.includes('localhost')) throw new Error('server down');
    if (url.endsWith('/releases/latest')) return { data: { tag_name: latest } };
    if (url.includes('/releases?')) return { data: list.map(r => ({ tag_name: r.tag, prerelease: !!r.pre, draft: !!r.draft })) };
    const raw = url.match(/agenfk\/([^/]+)\/packages\/cli\/package\.json/);
    if (raw) return { data: tiers[raw[1]] ? { agenfkUpgradeTier: tiers[raw[1]] } : {} };
    throw new Error(`unexpected GET ${url}`);
  });
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(require('os').tmpdir(), 'agenfk-tier-'));
  vi.mocked(os.homedir).mockReturnValue(home);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
});
afterEach(() => { vi.restoreAllMocks(); mockedAxios.get.mockReset(); fs.rmSync(home, { recursive: true, force: true }); });

describe('the CLI tier check, server down (BUG 022b229a)', () => {
  it('names the newest stable by version, not the older-line hotfix published last', async () => {
    github('v8.1.1', [{ tag: 'v8.1.1' }, { tag: 'v9.0.0' }], {});
    await checkUpgradeTier();
    expect(cache().version).toBe('9.0.0');
  });

  it('takes the strongest tier among stables newer than this install', async () => {
    github('v8.1.1', [{ tag: 'v8.1.1' }, { tag: 'v9.0.0' }, { tag: 'v1.1.21' }], { 'v8.1.1': 'mandatory', 'v1.1.21': 'mandatory' });
    await checkUpgradeTier();
    expect(cache()).toMatchObject({ version: '9.0.0', tier: 'mandatory' });
  });

  it('a mandatory release older than this install does not count, nor a draft', async () => {
    github('v9.0.0', [{ tag: 'v9.0.0' }, { tag: 'v1.1.21' }, { tag: 'v9.5.0', draft: true }], { 'v1.1.21': 'mandatory', 'v9.5.0': 'mandatory' });
    await checkUpgradeTier();
    expect(cache()).toMatchObject({ version: '9.0.0', tier: 'optional' });
  });
});
