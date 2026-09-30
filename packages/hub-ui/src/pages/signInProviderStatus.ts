import type { BadgeTone } from '../components/ui';

export interface ProviderRequirement { label: string; present: boolean }

/**
 * What a sign-in provider's card says about it. "On" while something it needs
 * is missing (the server refuses sign-in without it) is a provider nobody can
 * sign in with, so the card names what is missing instead of looking fine.
 */
export function providerStatus(p: { enabled: boolean; requires: ProviderRequirement[] }): { label: string; tone: BadgeTone } {
  if (!p.enabled) return { label: 'Off', tone: 'neutral' };
  const missing = p.requires.filter(r => !r.present).map(r => r.label);
  if (missing.length === 0) return { label: 'On', tone: 'ok' };
  const list = missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}`;
  return { label: `On · needs ${list}`, tone: 'warn' };
}
