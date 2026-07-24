// Pure derivation of the repo-override picker options from the hub's project
// discovery (`GET /v1/admin/projects`, which returns distinct repos). The repo
// (git remote URL) is the globally-shared identity used for flow assignment;
// local per-installation projectIds are never surfaced here.
export interface RepoOption {
  /** The assignment target id — the normalized remote URL. */
  id: string;
  /** Display label. */
  label: string;
  /** Sub-label (recency). */
  sub: string;
}

export interface RepoDiscoveryRow {
  remoteUrl: string | null;
  lastSeen: string;
}

export function repoOverrideOptions(rows: RepoDiscoveryRow[]): RepoOption[] {
  const seen = new Set<string>();
  const out: RepoOption[] = [];
  for (const r of rows) {
    const repo = r.remoteUrl;
    if (!repo || seen.has(repo)) continue; // skip repo-less rows; dedup by repo
    seen.add(repo);
    out.push({ id: repo, label: repo, sub: `last seen ${r.lastSeen}` });
  }
  return out;
}
