import { compareSemver } from '@agenfk/core';

export type UpgradeTier = 'mandatory' | 'recommended' | 'optional' | string;

export interface UpgradeNoticeInput {
  tier: UpgradeTier;
  version: string;
  currentVersion?: string;
}

// compareSemver lives in @agenfk/core (single source of truth — correct numeric
// prerelease ordering). Re-exported here so existing importers keep working.
export { compareSemver };

export function buildUpgradeNotice(input: UpgradeNoticeInput): string {
  const tier = input.tier ?? 'optional';
  const version = input.version ?? '';
  const currentVersion = input.currentVersion ?? '';

  if (!version || (currentVersion && compareSemver(currentVersion, version) >= 0)) {
    return '';
  }

  if (tier === 'mandatory') {
    return `\n\n⛔ **MANDATORY UPGRADE REQUIRED**: AgEnFK v${version} must be installed before continuing. Run \`agenfk upgrade\`.`;
  }

  if (tier === 'recommended') {
    return `\n\n⚠️ Recommended upgrade available: AgEnFK v${version}. Run \`agenfk upgrade\` when convenient.`;
  }

  return '';
}
