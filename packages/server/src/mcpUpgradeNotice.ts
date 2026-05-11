export type UpgradeTier = 'mandatory' | 'recommended' | 'optional' | string;

export interface UpgradeNoticeInput {
  tier: UpgradeTier;
  version: string;
  currentVersion?: string;
}

function parseSemver(value: string): { core: number[]; pre: string[] } | null {
  const normalized = value.trim().replace(/^v/i, '');
  const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split('.') : [],
  };
}

export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return a.localeCompare(b);

  for (let i = 0; i < 3; i += 1) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] - pb.core[i];
  }

  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;

  const len = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i += 1) {
    const ai = pa.pre[i];
    const bi = pb.pre[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    if (ai === bi) continue;

    const an = /^\d+$/.test(ai);
    const bn = /^\d+$/.test(bi);
    if (an && bn) return Number(ai) - Number(bi);
    if (an) return -1;
    if (bn) return 1;
    return ai.localeCompare(bi);
  }

  return 0;
}

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
