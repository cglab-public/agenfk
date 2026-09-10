/**
 * @file BUG b233143b — `checkUpgradeTier` is the code that actually printed the
 * reported symptom ("AgEnFK vhub-v1.1.19-beta.1 is available"), and it never
 * called the resolver that got the hub-v* guard. It reads three sources — the
 * local server's /releases/latest, GitHub's /releases/latest directly, and a
 * one-hour cache file — and all three can hand it a hub tag.
 *
 * This is not only a wrong banner. `isUpgrade()` cannot parse a hub tag, falls
 * back to a string compare that ranks letters above digits, and answers "upgrade
 * available"; the tier that accompanies the tag is then honoured, and `mandatory`
 * calls process.exit(1) on every CLI invocation.
 *
 * All three sources now funnel through one reducer, so the rule exists once and a
 * new source cannot forget it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@agenfk/telemetry', () => ({
  TelemetryClient: vi.fn(function (this: any) {
    this.capture = vi.fn();
    this.shutdown = vi.fn().mockResolvedValue(undefined);
    this.isEnabled = true;
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
vi.mock('figlet', () => ({ default: { textSync: vi.fn().mockReturnValue('AgEnFK') } }));

import { frameworkUpgradeInfo } from '../index';

describe('frameworkUpgradeInfo — a hub tag is "no information", never an upgrade', () => {
  beforeEach(() => vi.clearAllMocks());

  it('neutralises GitHub\'s /releases/latest when it reports a hub tag', () => {
    const info = frameworkUpgradeInfo({ tag_name: 'hub-v1.1.19-beta.1', prerelease: false });
    expect(info).toEqual({ version: '', tier: 'optional' });
  });

  it('neutralises the LOCAL SERVER payload, including its mandatory tier', () => {
    // The exact shape that reached the CLI in production: the server forwards
    // GitHub's response and its own tier lookup. Honouring `mandatory` here is
    // what would make every agenfk command exit 1.
    const info = frameworkUpgradeInfo({
      tagName: 'hub-v1.1.19-beta.1',
      version: 'hub-v1.1.19-beta.1',
      upgradeTier: 'mandatory',
    });
    expect(info.version).toBe('');
    expect(info.tier).toBe('optional');
  });

  it('neutralises a poisoned cache entry (version only, no tag name)', () => {
    // The cache survives up to an hour, so a hub tag learned before the fix
    // keeps nagging after the CLI is upgraded unless the cache read is guarded
    // too. This shape has no tagName at all — the version must be checked.
    const info = frameworkUpgradeInfo({ version: 'hub-v1.1.19-beta.1', upgradeTier: 'recommended' });
    expect(info).toEqual({ version: '', tier: 'optional' });
  });

  it('passes a real framework release through untouched, mandatory included', () => {
    // The guard must not quietly soften genuine tiers — a mandatory security
    // upgrade still has to block.
    const info = frameworkUpgradeInfo({ tag_name: 'v1.2.0', upgradeTier: 'mandatory' });
    expect(info).toEqual({ version: '1.2.0', tier: 'mandatory' });
  });

  it('keeps a prerelease framework version intact', () => {
    const info = frameworkUpgradeInfo({ version: '1.1.19-beta.1', upgradeTier: 'recommended' });
    expect(info).toEqual({ version: '1.1.19-beta.1', tier: 'recommended' });
  });

  it('treats an empty or missing payload as no information', () => {
    expect(frameworkUpgradeInfo(undefined)).toEqual({ version: '', tier: 'optional' });
    expect(frameworkUpgradeInfo({})).toEqual({ version: '', tier: 'optional' });
  });
});
