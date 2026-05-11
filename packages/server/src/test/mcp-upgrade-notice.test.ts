import { describe, expect, it } from 'vitest';
import { buildUpgradeNotice } from '../mcpUpgradeNotice';

describe('buildUpgradeNotice', () => {
  it('suppresses recommended notices when the installed beta is newer than the recommended stable release', () => {
    const notice = buildUpgradeNotice({
      tier: 'recommended',
      version: '1.0.0',
      currentVersion: '1.0.1-beta.9',
    });

    expect(notice).toBe('');
  });

  it('suppresses mandatory notices when the installed beta is newer than the mandatory stable release', () => {
    const notice = buildUpgradeNotice({
      tier: 'mandatory',
      version: '1.0.0',
      currentVersion: '1.0.1-beta.9',
    });

    expect(notice).toBe('');
  });

  it('still emits notices when the target version is newer than the installed beta', () => {
    const notice = buildUpgradeNotice({
      tier: 'recommended',
      version: '1.0.1',
      currentVersion: '1.0.1-beta.9',
    });

    expect(notice).toContain('Recommended upgrade available');
    expect(notice).toContain('v1.0.1');
  });
});
