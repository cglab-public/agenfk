import { installationDisplayName, type ApiKeyLike, type LiveIdentity } from './installationDisplayName';

/** The shape GET /v1/admin/installations returns (one row per MACHINE). */
export interface InstallationRow {
  id: string;
  gitName?: string | null;
  gitEmail?: string | null;
  osUser?: string | null;
  retired?: boolean;
  hidden?: boolean;
}

export interface InstallationOption {
  id: string;
  label: string;
}

/**
 * The installs a fleet upgrade can target: one option per installation.
 *
 * Deliberately NOT derived from api_keys. A key is a credential, not a machine:
 * one machine holds many (production: six live keys on installation 97f4db4c),
 * so a key-derived list repeats that machine once per key, inflates the "All (n)"
 * count, and — worse — silently omits any machine whose live key was minted
 * without an installation binding, which is exactly how two members became
 * unselectable (BUG bb27c0aa). The installations table is one row per machine,
 * carries the live identity, and includes machines with no bound key at all.
 *
 * apiKeys is passed in only as the fallback for the display name, for a machine
 * the installations row has no identity for.
 */
export function buildInstallationOptions(
  installations: readonly InstallationRow[],
  apiKeys: readonly ApiKeyLike[] = [],
): InstallationOption[] {
  const seen = new Set<string>();
  const options: InstallationOption[] = [];
  for (const inst of installations) {
    if (!inst?.id || inst.retired || seen.has(inst.id)) continue;
    seen.add(inst.id);
    const identity: LiveIdentity = {
      gitName: inst.gitName ?? null,
      gitEmail: inst.gitEmail ?? null,
      osUser: inst.osUser ?? null,
    };
    options.push({
      id: inst.id,
      label: installationDisplayName([...apiKeys], inst.id, identity),
    });
  }
  return options;
}
