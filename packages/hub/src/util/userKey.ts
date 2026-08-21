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

/**
 * Longest key we will even attempt to shape-check. RFC 5321 caps an address at
 * 254 octets; the headroom is for namespaced variants. Anything longer is not a
 * real identity and is rejected without being scanned.
 */
const MAX_EMAIL_SHAPED_KEY_LENGTH = 320;

/**
 * Dot-separated labels on both sides of a single `@`, with the dot excluded from
 * the label class.
 *
 * The exclusion is the point. The previous pattern was
 * `^[^@\s]+@[^@\s]+\.[^@\s]+$`, where `\.` was ALSO matched by `[^@\s]`, so the
 * domain was ambiguous and the engine backtracked quadratically over it: a
 * crafted key measured 96ms at 20KB, 2.4s at 100KB and 38s at 400KB. Because the
 * hub is single-threaded, one such key stalled the service for every tenant.
 * Keep `.` out of these classes — reintroducing it restores the blowup.
 */
const EMAIL_SHAPED = /^[^@\s.]+(?:\.[^@\s.]+)*@[^@\s.]+(?:\.[^@\s.]+)+$/;

/** Is this key a real email address (rather than a username-derived one)? */
export function isEmailShapedKey(key: string): boolean {
  if (key.startsWith(OS_USER_KEY_PREFIX)) return false;
  // Bound the length before the regex runs, not after. This is the belt to the
  // pattern's braces: even a future edit that reintroduces ambiguity cannot be
  // driven past a few hundred characters of input.
  if (key.length > MAX_EMAIL_SHAPED_KEY_LENGTH) return false;
  return EMAIL_SHAPED.test(key);
}

/**
 * Could this string plausibly name a person or a machine account?
 *
 * Deliberately weak: one letter or digit anywhere. Usernames are wildly varied —
 * unicode, dots, dashes, underscores, a trailing `$` on Windows service accounts
 * — and rejecting a real person is worse than accepting an odd-looking one,
 * because the fallback costs them their attribution, which is the exact harm the
 * identity work exists to repair. This only has to catch values that cannot
 * name anyone at all. (CGLAB-77.)
 */
function namesSomeone(value: string): boolean {
  return /[\p{L}\p{N}]/u.test(value);
}

/**
 * Is this a usable git email?
 *
 * NOT `isEmailShapedKey`, which demands a dotted domain: `root@localhost` is a
 * real address on internal hosts and rejecting it would silently downgrade those
 * machines to an osUser identity. This asks only for an `@` with something
 * nameable on each side.
 */
function usableGitEmail(value: string): boolean {
  const at = value.indexOf('@');
  if (at <= 0 || at === value.length - 1) return false;
  return namesSomeone(value.slice(0, at)) && namesSomeone(value.slice(at + 1));
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
  const trimmed = osUser.trim();
  // A value that cannot name anyone becomes the unknown identity rather than a
  // person. Production minted `osuser:=@5d686242` from a six-hour glitch on one
  // machine, and it took an admin merge to undo — a transient blip must not
  // create a permanent identity. (CGLAB-77.)
  const who = namesSomeone(trimmed) ? trimmed : 'unknown';
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
  // Junk here is worse than junk in osUser: an email key is NOT namespaced by
  // installation, so it pools across every machine reporting it — the shared
  // bucket that namespacing exists to prevent. (CGLAB-77.)
  const email = actor.gitEmail?.trim();
  if (email && usableGitEmail(email)) return email.toLowerCase();
  const osUser = actor.osUser?.trim() ?? '';
  const who = namesSomeone(osUser) ? osUser : '';
  // No installation to scope by — an event this malformed is better keyed
  // honestly than given an invented scope.
  if (!installationId) return who || 'unknown';
  return namespacedOsUserKey(who, installationId);
}
