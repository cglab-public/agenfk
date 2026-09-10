/**
 * Tests for the upgrade tier feature (Stories 1 & 3).
 *
 * Story 1: upgradeTier field in packages/cli/package.json + server enrichment
 * Story 3: MCP response augmentation for pending mandatory/recommended upgrades
 *
 * All tests are intentionally failing until the feature is implemented.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import { app, initStorage, clearReleaseCache } from '../server';
import { buildUpgradeNotice } from '../mcpUpgradeNotice';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  mockAxios.create = vi.fn(() => mockAxios);
  return { default: mockAxios };
});

const TEST_DB = path.resolve('./upgrade-tier-test-db.sqlite');
const CLI_PKG_PATH = path.resolve(__dirname, '../../../cli/package.json');
const SERVER_PATH = path.resolve(__dirname, '../server.ts');

beforeAll(async () => {
  process.env.AGENFK_DB_PATH = TEST_DB;
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  await initStorage();
});

afterAll(() => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});

afterEach(() => {
  vi.clearAllMocks();
  clearReleaseCache();
});

// ── Story 1: upgradeTier field in packages/cli/package.json ──────────────────

describe('packages/cli/package.json — upgradeTier field', () => {
  it('should have an "agenfkUpgradeTier" field', () => {
    const pkg = JSON.parse(fs.readFileSync(CLI_PKG_PATH, 'utf8'));
    expect(pkg).toHaveProperty('agenfkUpgradeTier');
  });

  it('agenfkUpgradeTier value should be "mandatory" or "recommended" (not optional — that is the default)', () => {
    // A published package.json with the field set should be "mandatory" or "recommended"
    // "optional" is the default (field absent) so it need not be set explicitly
    const pkg = JSON.parse(fs.readFileSync(CLI_PKG_PATH, 'utf8'));
    if (pkg.agenfkUpgradeTier !== undefined) {
      expect(['mandatory', 'recommended']).toContain(pkg.agenfkUpgradeTier);
    }
  });
});

// ── Story 1: Server fetches upgradeTier from GitHub raw content ───────────────

describe('server.ts — upgradeTier source code', () => {
  const readServer = () => fs.readFileSync(SERVER_PATH, 'utf8');

  it('should fetch the raw CLI package.json from GitHub for the latest tag', () => {
    const src = readServer();
    expect(src).toMatch(/raw\.githubusercontent\.com|api\.github\.com.*contents.*package\.json/);
  });

  it('should extract agenfkUpgradeTier from the fetched package.json', () => {
    const src = readServer();
    expect(src).toMatch(/agenfkUpgradeTier/);
  });

  it('should default upgradeTier to "optional" when the field is absent', () => {
    const src = readServer();
    // Code must handle the absent case and fall back to "optional"
    expect(src).toMatch(/upgradeTier.*optional|optional.*upgradeTier|\?\?.*['"']optional['"']/);
  });
});

// ── Story 1: GET /releases/latest returns upgradeTier ────────────────────────

describe('GET /releases/latest — upgradeTier in response', () => {
  it('returns upgradeTier: "optional" when field is absent from the fetched package.json', async () => {
    const axios = (await import('axios')).default as any;
    // First call: GitHub releases API
    axios.get.mockResolvedValueOnce({
      data: {
        tag_name: 'v1.2.3',
        name: 'Release 1.2.3',
        body: 'Notes',
        published_at: '2026-01-01T00:00:00Z',
        html_url: 'https://github.com/example/repo/releases/tag/v1.2.3',
      }
    });
    // Second call: raw package.json for that tag (field absent → optional)
    axios.get.mockResolvedValueOnce({
      data: { name: '@agenfk/cli', version: '1.2.3' }
    });
    const res = await request(app).get('/releases/latest');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('upgradeTier');
    expect(res.body.upgradeTier).toBe('optional');
  });

  it('returns upgradeTier: "mandatory" when field is set to "mandatory" in the fetched package.json', async () => {
    const axios = (await import('axios')).default as any;
    axios.get.mockResolvedValueOnce({
      data: {
        tag_name: 'v2.0.0',
        name: 'Release 2.0.0',
        body: 'Breaking change',
        published_at: '2026-02-01T00:00:00Z',
        html_url: 'https://github.com/example/repo/releases/tag/v2.0.0',
      }
    });
    axios.get.mockResolvedValueOnce({
      data: { name: '@agenfk/cli', version: '2.0.0', agenfkUpgradeTier: 'mandatory' }
    });
    const res = await request(app).get('/releases/latest');
    expect(res.status).toBe(200);
    expect(res.body.upgradeTier).toBe('mandatory');
  });

  it('returns upgradeTier: "recommended" when field is set to "recommended"', async () => {
    const axios = (await import('axios')).default as any;
    axios.get.mockResolvedValueOnce({
      data: {
        tag_name: 'v1.5.0',
        name: 'Release 1.5.0',
        body: '',
        published_at: '2026-01-15T00:00:00Z',
        html_url: 'https://github.com/example/repo/releases/tag/v1.5.0',
      }
    });
    axios.get.mockResolvedValueOnce({
      data: { name: '@agenfk/cli', version: '1.5.0', agenfkUpgradeTier: 'recommended' }
    });
    const res = await request(app).get('/releases/latest');
    expect(res.status).toBe(200);
    expect(res.body.upgradeTier).toBe('recommended');
  });

  it('still returns 200 with upgradeTier: "optional" when the raw package.json fetch fails', async () => {
    const axios = (await import('axios')).default as any;
    axios.get.mockResolvedValueOnce({
      data: {
        tag_name: 'v1.3.0',
        name: 'Release 1.3.0',
        body: '',
        published_at: '2026-01-20T00:00:00Z',
        html_url: 'https://github.com/example/repo/releases/tag/v1.3.0',
      }
    });
    // Second call fails (network error)
    axios.get.mockRejectedValueOnce(new Error('Network Error'));
    const res = await request(app).get('/releases/latest');
    expect(res.status).toBe(200);
    expect(res.body.upgradeTier).toBe('optional');
  });
});

// ── Story 4: ReleaseReminder.tsx — source analysis ───────────────────────────

const RELEASE_REMINDER_PATH = path.resolve(__dirname, '../../../ui/src/components/ReleaseReminder.tsx');
const readReleaseReminder = () =>
  fs.existsSync(RELEASE_REMINDER_PATH) ? fs.readFileSync(RELEASE_REMINDER_PATH, 'utf8') : '';

describe('ReleaseReminder.tsx — ReleaseInfo interface', () => {
  it('should include upgradeTier in the ReleaseInfo interface', () => {
    expect(readReleaseReminder()).toMatch(/upgradeTier/);
  });

  it('should type upgradeTier as "mandatory" | "recommended"', () => {
    const src = readReleaseReminder();
    expect(src).toMatch(/mandatory/);
    expect(src).toMatch(/recommended/);
  });
});

describe('ReleaseReminder.tsx — mandatory tier styling (source)', () => {
  it('should apply red styling for mandatory tier', () => {
    expect(readReleaseReminder()).toMatch(/mandatory.*red|red.*mandatory/i);
  });

  it('should hide or disable the Dismiss button for mandatory tier', () => {
    expect(readReleaseReminder()).toMatch(/isMandatory.*[Dd]ismiss|[Dd]ismiss.*isMandatory|!isMandatory/i);
  });
});

describe('ReleaseReminder.tsx — recommended tier styling (source)', () => {
  it('should apply yellow/amber styling for recommended tier', () => {
    expect(readReleaseReminder()).toMatch(/recommended.*yellow|yellow.*recommended|amber.*recommended|recommended.*amber/i);
  });
});

// ── Story 3: MCP response augmentation ───────────────────────────────────────

// Behavioral tests for the MCP upgrade notice (the text appended to MCP tool
// responses). The notice logic lives in mcpUpgradeNotice.ts (buildUpgradeNotice);
// these assert what it actually produces per tier rather than grepping index.ts.
describe('buildUpgradeNotice — MCP upgrade notice content', () => {
  it('produces a mandatory upgrade notice when tier is mandatory and a newer version exists', () => {
    const notice = buildUpgradeNotice({ tier: 'mandatory', version: '2.0.0', currentVersion: '1.0.0' });
    expect(notice).toMatch(/mandatory/i);
    expect(notice).toMatch(/upgrade/i);
    expect(notice).toContain('2.0.0');
    expect(notice).toMatch(/agenfk upgrade/);
  });

  it('produces a recommended upgrade notice when tier is recommended and a newer version exists', () => {
    const notice = buildUpgradeNotice({ tier: 'recommended', version: '2.0.0', currentVersion: '1.0.0' });
    expect(notice).toMatch(/recommended/i);
    expect(notice).toMatch(/upgrade/i);
    expect(notice).toContain('2.0.0');
  });

  it('emits no notice for the optional tier', () => {
    expect(buildUpgradeNotice({ tier: 'optional', version: '2.0.0', currentVersion: '1.0.0' })).toBe('');
  });

  it('emits no notice when the current version is already up to date', () => {
    expect(buildUpgradeNotice({ tier: 'mandatory', version: '1.0.0', currentVersion: '1.0.0' })).toBe('');
    expect(buildUpgradeNotice({ tier: 'recommended', version: '1.0.0', currentVersion: '2.0.0' })).toBe('');
  });
});

// BUG b233143b — this endpoint forwarded GitHub's /releases/latest verbatim, and
// that is exactly the endpoint that got poisoned: hub-v1.1.19-beta.1 was created
// without --prerelease, so GitHub counted the HUB build as the latest STABLE.
// Every CLI then read version "hub-v1.1.19-beta.1" from here — and because this
// endpoint also decides the upgrade tier, a hub tag could drive `mandatory`,
// which makes every agenfk invocation exit 1.
describe('GET /releases/latest — hub-only releases are never the framework version', () => {
  it('re-queries the release list when GitHub reports a hub tag as latest', async () => {
    const axios = (await import('axios')).default as any;
    axios.get
      .mockResolvedValueOnce({
        data: { tag_name: 'hub-v1.1.19-beta.1', name: 'hub', body: '', published_at: '2026-09-10T13:00:00Z', html_url: 'u', prerelease: false },
      })
      .mockResolvedValueOnce({
        data: [
          { tag_name: 'hub-v1.1.19-beta.1', prerelease: false, published_at: '2026-09-10T13:00:00Z' },
          { tag_name: 'v1.1.18', name: 'Release 1.1.18', body: 'notes', prerelease: false, published_at: '2026-09-08T00:00:00Z', html_url: 'h' },
          { tag_name: 'v1.1.17', name: 'Release 1.1.17', body: '', prerelease: false, published_at: '2026-09-01T00:00:00Z', html_url: 'h' },
        ],
      })
      .mockResolvedValueOnce({ data: { agenfkUpgradeTier: 'optional' } });

    const res = await request(app).get('/releases/latest');

    expect(res.status).toBe(200);
    expect(res.body.tagName).toBe('v1.1.18');
    expect(res.body.version).toBe('1.1.18');
  });

  it('reports no release rather than a hub tag when the list has no framework release', async () => {
    const axios = (await import('axios')).default as any;
    axios.get
      .mockResolvedValueOnce({ data: { tag_name: 'hub-v1.2.0', prerelease: false, published_at: '2026-09-10T13:00:00Z' } })
      .mockResolvedValueOnce({ data: [{ tag_name: 'hub-v1.2.0', prerelease: false, published_at: '2026-09-10T13:00:00Z' }] });

    const res = await request(app).get('/releases/latest');

    // Empty version is what disables the client's nag: applyUpgradeTierAction
    // returns early on a falsy latestVersion.
    expect(res.body.tagName).toBeNull();
    expect(res.body.version).toBe('');
    expect(res.body.upgradeTier).toBe('optional');
  });

  it('never reads upgradeTier from a hub tag — a mandatory tier would exit(1) every CLI call', async () => {
    const axios = (await import('axios')).default as any;
    axios.get
      .mockResolvedValueOnce({ data: { tag_name: 'hub-v1.2.0', prerelease: false, published_at: '2026-09-10T13:00:00Z' } })
      .mockResolvedValueOnce({
        data: [
          { tag_name: 'hub-v1.2.0', prerelease: false, published_at: '2026-09-10T13:00:00Z' },
          { tag_name: 'v1.2.0', prerelease: false, published_at: '2026-09-01T00:00:00Z', name: 'n', body: '', html_url: 'h' },
        ],
      })
      .mockResolvedValueOnce({ data: { agenfkUpgradeTier: 'mandatory' } });

    const res = await request(app).get('/releases/latest');

    const urls = axios.get.mock.calls.map((c: any[]) => String(c[0]));
    // The tier must be read from the tag we are actually reporting, not the hub tag.
    expect(urls.some((u) => u.includes('raw.githubusercontent.com') && u.includes('hub-v'))).toBe(false);
    expect(urls.some((u) => u.includes('raw.githubusercontent.com') && u.includes('v1.2.0'))).toBe(true);
    expect(res.body.tagName).toBe('v1.2.0');
  });

  it('a repo whose latest is a normal framework release is unaffected', async () => {
    const axios = (await import('axios')).default as any;
    axios.get
      .mockResolvedValueOnce({ data: { tag_name: 'v3.0.0', name: 'n', body: '', published_at: '2026-09-11T00:00:00Z', html_url: 'h', prerelease: false } })
      .mockResolvedValueOnce({ data: { agenfkUpgradeTier: 'recommended' } });

    const res = await request(app).get('/releases/latest');
    expect(res.body.tagName).toBe('v3.0.0');
    expect(res.body.upgradeTier).toBe('recommended');
    // No second GitHub query for a healthy response.
    expect(axios.get.mock.calls.filter((c: any[]) => String(c[0]).includes('api.github.com'))).toHaveLength(1);
  });
});

describe('GET /releases/latest — hub recovery keeps the stable channel honest', () => {
  it('never promotes a framework PRERELEASE to "latest stable" while recovering', async () => {
    const axios = (await import('axios')).default as any;
    axios.get
      .mockResolvedValueOnce({ data: { tag_name: 'hub-v2.0.0', prerelease: false, published_at: '2026-09-12T00:00:00Z' } })
      .mockResolvedValueOnce({
        data: [
          { tag_name: 'hub-v2.0.0', prerelease: false, published_at: '2026-09-12T00:00:00Z' },
          // Newer than the stable below, and a framework tag — but a prerelease.
          // The channel is "latest stable", so it must not be reported as one.
          { tag_name: 'v2.0.0-beta.1', prerelease: true, published_at: '2026-09-11T00:00:00Z', name: 'n', body: '', html_url: 'h' },
          { tag_name: 'v1.9.0', prerelease: false, published_at: '2026-09-01T00:00:00Z', name: 'n', body: '', html_url: 'h' },
        ],
      })
      .mockResolvedValueOnce({ data: { agenfkUpgradeTier: 'optional' } });

    const res = await request(app).get('/releases/latest');

    expect(res.body.tagName).toBe('v1.9.0');
  });
});
