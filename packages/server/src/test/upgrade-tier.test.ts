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
const MCP_INDEX_PATH = path.resolve(__dirname, '../index.ts');

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

describe('index.ts — MCP upgrade notice augmentation', () => {
  const readIndex = () => fs.readFileSync(MCP_INDEX_PATH, 'utf8');

  it('should check upgradeTier before returning MCP tool responses', () => {
    const src = readIndex();
    expect(src).toMatch(/upgradeTier/);
  });

  it('should append a mandatory upgrade notice to MCP responses when tier is mandatory', () => {
    const src = readIndex();
    // Must contain logic that adds an upgrade warning for mandatory tier
    expect(src).toMatch(/mandatory.*upgrade|upgrade.*mandatory/i);
  });

  it('should append a recommended upgrade notice to MCP responses when tier is recommended', () => {
    const src = readIndex();
    expect(src).toMatch(/recommended.*upgrade|upgrade.*recommended/i);
  });

  it('should include the upgrade notice text in MCP tool response content', () => {
    const src = readIndex();
    // The notice must be appended to the response content (not just logged)
    expect(src).toMatch(/upgradeNotice|upgrade_notice|⚠️.*upgrade|UPGRADE REQUIRED/i);
  });
});
