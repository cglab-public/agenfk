interface ApiKeyLike {
  installationId: string | null;
  label: string | null;
  gitName: string | null;
  gitEmail: string | null;
  osUser?: string | null;
  revokedAt?: string | null;
}

/**
 * Build a human-readable display string for an installation, joining its
 * GUID against the org's api-key list to surface a label / git identity /
 * os user. Falls back to the truncated GUID alone when no match is known.
 *
 * Precedence (most → least specific):
 *   1. api_key.label
 *   2. gitName + " <" + gitEmail + ">"
 *   3. gitEmail
 *   4. gitName
 *   5. osUser
 *   6. (none — show GUID alone)
 *
 * When multiple api-key rows bind the same installation, prefer a non-revoked
 * one — that's the rotation case (old key revoked, new key issued).
 */
export function installationDisplayName(apiKeys: ApiKeyLike[], installationId: string): string {
  const matches = apiKeys.filter(k => k.installationId === installationId);
  const live = matches.find(k => !k.revokedAt) ?? matches[0];

  const guidShort = installationId.slice(0, 8) + '…';

  if (!live) return guidShort;

  const friendly = live.label
    ?? (live.gitName && live.gitEmail ? `${live.gitName} <${live.gitEmail}>` : null)
    ?? live.gitEmail
    ?? live.gitName
    ?? live.osUser
    ?? null;

  return friendly ? `${friendly} · ${guidShort}` : guidShort;
}
