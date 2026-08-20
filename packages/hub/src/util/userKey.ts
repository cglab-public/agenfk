import { HubEvent } from '@agenfk/core';

/**
 * Identity key derivation (task c534ab9a).
 *
 * A person is keyed by their git email, because that is the same on every
 * machine they work from. When there is no git email we have only an OS
 * username — and a BARE username is not an identity: every developer who is
 * `dev`, `ubuntu`, `runner` or `ec2-user` on their own machine would share one
 * key, so dashboards silently merged distinct people and no automatic identity
 * merge could ever be safe.
 *
 * Scoping the fallback to the installation makes such a key mean exactly one
 * machine. The `osuser:` scheme keeps it unmistakable from a real address, which
 * matters because these keys are shown in dashboards and typed into merge forms.
 */

const INSTALLATION_PREFIX_LENGTH = 8;
export const OS_USER_KEY_PREFIX = 'osuser:';

/** Is this key a real email address (rather than a username-derived one)? */
export function isEmailShapedKey(key: string): boolean {
  if (key.startsWith(OS_USER_KEY_PREFIX)) return false;
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(key);
}

/** Is this key already scoped to an installation by us? */
export function isNamespacedOsUserKey(key: string): boolean {
  return key.startsWith(OS_USER_KEY_PREFIX);
}

/**
 * Build the installation-scoped key for an OS username. Only a prefix of the
 * installation id is used: enough to separate machines, short enough to stay
 * readable in a table cell.
 */
export function namespacedOsUserKey(osUser: string, installationId: string): string {
  const who = osUser.trim() || 'unknown';
  return `${OS_USER_KEY_PREFIX}${who}@${installationId.replace(/^inst-/, '').slice(0, INSTALLATION_PREFIX_LENGTH)}`;
}

/**
 * The identity a batch of events is attributed to.
 *
 * Case handling is deliberately asymmetric: emails are lowercased because
 * addresses are case-insensitive, while OS usernames keep their case because on
 * Windows `DPolistchuck` is how the account is actually named.
 */
export function userKeyFor(actor: HubEvent['actor'], installationId: string): string {
  const email = actor.gitEmail?.trim();
  if (email) return email.toLowerCase();
  const osUser = actor.osUser?.trim() ?? '';
  // No installation to scope by — an event this malformed is better keyed
  // honestly than given an invented scope.
  if (!installationId) return osUser || 'unknown';
  return namespacedOsUserKey(osUser, installationId);
}
