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

interface GoogleFields { clientId: string; clientSecretSet: boolean; clientSecret?: string }
interface EntraFields { tenantId: string; clientId: string; clientSecretSet: boolean; clientSecret?: string; assertionEnabled?: boolean }

/** What a Google sign-in needs; the server refuses one without any of these. A typed secret counts as well as a stored one. */
export function googleRequires(g: GoogleFields): ProviderRequirement[] {
  return [
    { label: 'a client ID', present: !!g.clientId?.trim() },
    { label: 'a client secret', present: g.clientSecretSet || !!g.clientSecret },
  ];
}

/**
 * What a Microsoft Entra sign-in needs. With the operator's AWS STS client
 * assertion on (AGENFK_HUB_ENTRA_ASSERTION=aws-sts) the hub signs in without a
 * secret, so the secret is optional there, as the server's guard judges it.
 */
export function entraRequires(e: EntraFields): ProviderRequirement[] {
  return [
    { label: 'a tenant ID', present: !!e.tenantId?.trim() },
    { label: 'a client ID', present: !!e.clientId?.trim() },
    ...(e.assertionEnabled ? [] : [{ label: 'a client secret', present: e.clientSecretSet || !!e.clientSecret }]),
  ];
}

export interface EntraLastExchange { path: 'assertion' | 'secret-fallback' | 'secret'; at: string; fallbackReason?: string; fallbackCount: number }

/**
 * A warning for the Entra card when assertion mode is on but the last sign-in
 * fell back to the client secret: the secret will expire, and with it sign-in
 * (INFRA-629). Null when there is nothing to warn about.
 */
export function entraFallbackWarning(e: { assertionEnabled?: boolean; lastExchange?: EntraLastExchange | null }): string | null {
  const last = e.lastExchange;
  if (!e.assertionEnabled || !last || last.path !== 'secret-fallback') return null;
  const why = last.fallbackReason === 'sts' ? 'AWS STS did not issue a token' : `Entra refused the assertion (${last.fallbackReason ?? 'unknown'})`;
  return `Signing in with the client secret: ${why}. ${last.fallbackCount} sign-in(s) fell back since this hub started. Fix the assertion before the secret expires.`;
}

/**
 * True when nobody could sign in under this config: every method is off, or
 * the only ones on lack what they need. The hub refuses to save such a config;
 * the form says so before the admin presses Save.
 */
export function noWorkingSignInMethod(c: {
  passwordEnabled: boolean; googleEnabled: boolean; entraEnabled: boolean; google: GoogleFields; entra: EntraFields;
}): boolean {
  const complete = (rs: ProviderRequirement[]) => rs.every(r => r.present);
  const google = c.googleEnabled && complete(googleRequires(c.google));
  const entra = c.entraEnabled && complete(entraRequires(c.entra));
  return !(c.passwordEnabled || google || entra);
}
