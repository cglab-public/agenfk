interface ApiKeyLike {
  installationId: string | null;
  label: string | null;
  gitName: string | null;
  gitEmail: string | null;
  osUser?: string | null;
  revokedAt?: string | null;
}

/** Identity as the hub currently knows it, from the `installations` row. */
export interface LiveIdentity {
  gitName: string | null;
  gitEmail: string | null;
  osUser: string | null;
}

/**
 * Build a human-readable display string for an installation.
 *
 * Precedence puts LIVE identity first, then the api-key snapshot, then the GUID:
 *   1. installations.gitName <gitEmail>  ─┐ refreshed from every event's actor
 *   2. installations.gitEmail             │ by the ingest upsert, so it tracks
 *   3. installations.gitName              │ reality
 *   4. installations.osUser              ─┘
 *   5. api_key.label                     ─┐ snapshot from when the key was
 *   6. api_key git/os identity           ─┘ issued; never refreshed
 *   7. (none — show GUID alone)
 *
 * The api_key label used to come first, which showed stale usernames
 * indefinitely: an install that had no git email configured at invite-redeem
 * time kept its `invite:<osuser>` label on the fleet board long after its real
 * address was known. Live identity also labels installs with no bound key at
 * all, which the device-code flow used to produce.
 *
 * When multiple api-key rows bind the same installation, prefer a non-revoked
 * one — that's the rotation case (old key revoked, new key issued).
 */
export function installationDisplayName(
  apiKeys: ApiKeyLike[],
  installationId: string,
  identity?: LiveIdentity | null,
): string {
  const matches = apiKeys.filter(k => k.installationId === installationId);
  const live = matches.find(k => !k.revokedAt) ?? matches[0];

  const guidShort = installationId.slice(0, 8) + '…';

  const named = (gitName: string | null, gitEmail: string | null, osUser: string | null) =>
    (gitName && gitEmail ? `${gitName} <${gitEmail}>` : null) ?? gitEmail ?? gitName ?? osUser ?? null;

  const friendly =
    named(identity?.gitName ?? null, identity?.gitEmail ?? null, identity?.osUser ?? null)
    ?? live?.label
    ?? named(live?.gitName ?? null, live?.gitEmail ?? null, live?.osUser ?? null)
    ?? null;

  return friendly ? `${friendly} · ${guidShort}` : guidShort;
}
