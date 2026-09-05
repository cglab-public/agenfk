/**
 * Per-org flow registry (CGLAB-138).
 *
 * A hub-connected company's admin points the org's flow registry at an
 * EXISTING repo of their own. Three rules shape this module, and each exists
 * because the naive version of it is wrong:
 *
 * 1. FAIL THE SAVE. Write access is probed BEFORE anything is persisted. A
 *    setting that "saved" but cannot actually be written to is worse than a
 *    rejected save: the admin believes their fleet is pointed at a private
 *    repo that will silently serve nothing.
 *
 * 2. READS ARE AUTHENTICATED. The registry read path used to be an anonymous
 *    `fetch`, which GitHub answers with 404 for a private repo. So a private
 *    registry is only servable to the fleet if the hub presents a token — this
 *    is the whole reason the token lives on the hub rather than in a `gh`
 *    login on one admin's laptop.
 *
 * 3. THE COPY IS ONE-TIME. Switching repos copies the community flows present
 *    at that moment; it is not a mirror. A re-runnable `sync` exists because a
 *    partial failure (rate limit, revoked token) must be recoverable without
 *    the admin flipping the setting back and forth.
 */
import { encryptSecret, decryptSecret } from '../crypto.js';
import type { HubDb } from '../db/types.js';

export const PUBLIC_REGISTRY_REPO = 'cglab-public/agenfk-flows';
export const DEFAULT_REGISTRY_BRANCH = 'main';
const GITHUB_API = 'https://api.github.com';

/**
 * GitHub owner/repo names. Deliberately stricter than GitHub itself: the slug
 * is interpolated into URLs and, on the publish path, into argv for git/gh.
 * Disallowing a leading '-' stops the value being read as a FLAG by an
 * argv-form call, and rejecting '/' beyond the single separator stops path
 * traversal. Mirrors GH_NAME_RE on the local publish route.
 */
export const GH_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

export function isValidRegistrySlug(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parts = value.split('/');
  if (parts.length !== 2) return false;
  return parts.every((p) => GH_NAME_RE.test(p));
}

/**
 * Git ref name for the registry branch. Every use interpolates it through
 * `encodeURIComponent`, so an unvalidated value cannot break out of the URL it
 * sits in — this is not the injection defence. What it does is reject, at the
 * boundary, the values that would otherwise be stored and then fail on every
 * later read: GitHub answers a malformed `ref` with 404, and `listRegistryFiles`
 * reads 404 as "empty registry", so a typo'd branch silently presents an admin
 * with a registry of zero flows rather than an error.
 *
 * Stricter than git, which permits almost any byte in a refname. Rejects a
 * leading '-' (argv-form calls on the publish path), a trailing '/' or '.'
 * (git forbids these), the '..' sequence (path traversal), and any character
 * outside the safe set. A ref with '/' in it stays legal — `release/2.0` is a
 * normal branch name.
 */
export const GIT_REF_RE = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;

export function isValidRegistryBranch(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  // Reject line breaks outright rather than relying on trim(). `$` in a
  // JavaScript regex matches *before* a trailing newline (verified: /a$/
  // .test("a\n") is true), so a `$`-anchored pattern accepts "main\n" — and
  // since trim() strips it too, an implementation that trimmed first would pass
  // a test written against "main\n" while still being wrong for a value that
  // reached the regex untrimmed. JavaScript has no `\z`; an explicit
  // control-character check is the only sound guard. It also covers \r, which
  // trim() removes but which must not reach a stored ref either.
  if (/\r|\n/.test(value)) return false;
  const ref = value.trim();
  if (!ref || ref.length > 255) return false;
  if (!GIT_REF_RE.test(ref)) return false;
  if (ref.includes('..')) return false;
  if (ref.endsWith('/') || ref.endsWith('.')) return false;
  if (ref.includes('//') || ref.includes('/.')) return false;
  return true;
}

export interface RegistryConfig {
  /** 'owner/repo'. Null means the public community registry. */
  repo: string;
  branch: string;
  isPublic: boolean;
  hasToken: boolean;
  /** ISO timestamp of the last successful community→org copy, if any. */
  copiedAt: string | null;
}

interface OrgSettingsRow {
  org_id: string;
  registry_repo: string | null;
  registry_branch: string | null;
  registry_token_enc: string | null;
  registry_copied_at: string | null;
}

/**
 * Read the org's registry config. NEVER returns the token — callers get
 * `hasToken` and must go through `registryToken()` to actually use it. This
 * split is what keeps the secret out of every admin API response by
 * construction rather than by remembering to redact.
 */
export async function getRegistryConfig(db: HubDb, orgId: string): Promise<RegistryConfig> {
  const row = await db.get<OrgSettingsRow>('SELECT * FROM org_settings WHERE org_id = ?', [orgId]);
  const repo = row?.registry_repo ?? PUBLIC_REGISTRY_REPO;
  return {
    repo,
    branch: row?.registry_branch || DEFAULT_REGISTRY_BRANCH,
    isPublic: repo === PUBLIC_REGISTRY_REPO,
    hasToken: Boolean(row?.registry_token_enc),
    copiedAt: row?.registry_copied_at ?? null,
  };
}

/** Decrypt the org's registry token. Null when none is stored. */
export async function registryToken(
  db: HubDb,
  orgId: string,
  secretKey: string,
): Promise<string | null> {
  const row = await db.get<{ registry_token_enc: string | null }>(
    'SELECT registry_token_enc FROM org_settings WHERE org_id = ?', [orgId]);
  if (!row?.registry_token_enc) return null;
  return decryptSecret(row.registry_token_enc, secretKey);
}

/**
 * Resolve the repo/branch/token to use for a registry read. Public orgs get no
 * token — anonymous is correct there and sending a token to a public repo
 * would leak the org's credential to a repo it has no relationship with.
 */
export async function resolveRegistryRead(
  db: HubDb,
  orgId: string,
  secretKey: string,
): Promise<{ repo: string; branch: string; token: string | null }> {
  const cfg = await getRegistryConfig(db, orgId);
  const token = cfg.isPublic ? null : await registryToken(db, orgId, secretKey);
  return { repo: cfg.repo, branch: cfg.branch, token };
}

export function ghHeaders(token: string | null): Record<string, string> {
  const h: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'agenfk-hub',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

/**
 * Probe that the token can actually WRITE to the repo. Checks the repo is
 * reachable and reports a `permissions.push` the token really has — GitHub
 * tells us this on the single repos call, so we do not need to attempt a
 * throwaway commit to find out.
 */
export async function probeWriteAccess(
  fetchImpl: typeof fetch,
  repo: string,
  token: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let resp: Awaited<ReturnType<typeof fetchImpl>>;
  try {
    resp = await fetchImpl(`${GITHUB_API}/repos/${repo}`, { headers: ghHeaders(token) });
  } catch (e: any) {
    return { ok: false, error: `could not reach GitHub: ${e?.message ?? e}` };
  }
  if (resp.status === 404) {
    // 404 rather than 403 is GitHub hiding a private repo from a token that
    // cannot see it. Same advice either way.
    return { ok: false, error: `repo ${repo} not found or not visible to this token (GitHub reports 404 for private repos a token cannot see)` };
  }
  if (!resp.ok) {
    return { ok: false, error: `GitHub returned ${resp.status} for ${repo}` };
  }
  const meta: any = await resp.json().catch(() => null);
  // A real /repos document always identifies the repo. Anything else — an API
  // gateway's `{ message, url }`, a portal's HTML parsed to nothing — means we
  // are not looking at a repository, so we cannot claim it is writable.
  // Keyed on `full_name` rather than "no permissions block" because an error
  // payload IS an object, and absence of `permissions` alone must still pass
  // (a proxy that strips it should not lock every admin out).
  if (!meta || typeof meta !== 'object' || typeof meta.full_name !== 'string') {
    return { ok: false, error: `could not read a repository document for ${repo} from GitHub` };
  }
  const canPush = meta?.permissions?.push;
  if (canPush === false) {
    return { ok: false, error: `the token can read ${repo} but cannot write to it (needs contents:write)` };
  }
  return { ok: true };
}

/** List the flow files in a registry repo's flows/ directory. */
export async function listRegistryFiles(
  fetchImpl: typeof fetch,
  repo: string,
  branch: string,
  token: string | null,
): Promise<Array<{ name: string; download_url: string }>> {
  const url = `${GITHUB_API}/repos/${repo}/contents/flows?ref=${encodeURIComponent(branch)}`;
  const resp = await fetchImpl(url, { headers: ghHeaders(token) });
  // A repo with no flows/ directory yet is an EMPTY registry, not an error —
  // this is exactly the state a brand-new private registry starts in.
  if (resp.status === 404) return [];
  if (!resp.ok) throw new Error(`registry listing failed: ${resp.status}`);
  const entries: any = await resp.json();
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((e: any) => e.type === 'file' && typeof e.name === 'string' && e.name.endsWith('.json'))
    .map((e: any) => ({ name: e.name, download_url: e.download_url }));
}

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Normalise a flow document for the registry. Drops step ids (they are
 * per-installation UUIDs; shipping them would make two installs collide) and
 * re-derives step order, so a copied flow installs the same way a published
 * one does.
 */
export function serializeRegistryFlow(flow: any, author: string): string {
  const steps = (Array.isArray(flow?.steps) ? flow.steps : [])
    .slice()
    .sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0))
    .map((s: any) => ({
      name: s.name,
      label: s.label ?? s.name,
      order: s.order,
      exitCriteria: s.exitCriteria ?? '',
      isSpecial: s.isSpecial ?? false,
      isAnchor: s.isAnchor ?? false,
    }));
  return JSON.stringify({
    schemaVersion: '1',
    name: flow?.name,
    description: flow?.description ?? '',
    author,
    version: flow?.version ?? '1.0.0',
    steps,
  }, null, 2) + '\n';
}

/**
 * Write one flow file via the Contents API. GitHub requires the existing
 * blob sha to overwrite a file, so fetch-then-put. Returns false when the
 * write was refused, so the caller can report a partial copy honestly.
 */
export async function writeRegistryFile(
  fetchImpl: typeof fetch,
  repo: string,
  branch: string,
  token: string,
  filename: string,
  content: string,
  message: string,
): Promise<boolean> {
  const pathPart = `flows/${encodeURIComponent(filename)}`;
  const base = `${GITHUB_API}/repos/${repo}/contents/${pathPart}`;
  let sha: string | undefined;
  try {
    const existing = await fetchImpl(`${base}?ref=${encodeURIComponent(branch)}`, { headers: ghHeaders(token) });
    if (existing.ok) sha = (await existing.json())?.sha;
  } catch { /* treat as new file */ }

  const resp = await fetchImpl(`${base}?ref=${encodeURIComponent(branch)}`, {
    method: 'PUT',
    headers: ghHeaders(token),
    body: JSON.stringify({
      message,
      content: Buffer.from(content, 'utf8').toString('base64'),
      ...(sha ? { sha } : {}),
    }),
  });
  return resp.ok;
}

export interface CopyResult {
  copied: number;
  skipped: number;
  failed: string[];
  /**
   * Whether the source had more flows than this run was allowed to copy.
   * Always present rather than optional: a caller that reads `undefined` as
   * "not truncated" is right by accident, and `?? false` at every call site is
   * how a field like this gets silently dropped.
   */
  truncated: boolean;
}

/**
 * Upper bound on flows copied per run. The community registry is small, but
 * "small" is not a contract — the public repo is writable by contributors, and
 * an unbounded loop over its contents turns a save click into an unbounded
 * series of GitHub writes. GitHub's unauthenticated content read is 60
 * requests/hour per IP and the copy does a read + a PUT per flow, so a few
 * hundred flows is already enough to exhaust it and fail midway. Failing at a
 * known, reported limit beats discovering one at an arbitrary point.
 */
export const MAX_COPY_FLOWS = 200;

/**
 * Copy the community flows into the org's repo, ONCE.
 *
 * Idempotent by content, not by "have we run before": a flow whose bytes
 * already match is skipped rather than rewritten, so re-running after a
 * partial failure costs nothing and cannot churn the target repo's history.
 */
export async function copyCommunityFlows(
  fetchImpl: typeof fetch,
  sourceRepo: string,
  sourceBranch: string,
  targetRepo: string,
  targetBranch: string,
  token: string,
  author: string,
): Promise<CopyResult> {
  const result: CopyResult = { copied: 0, skipped: 0, failed: [], truncated: false };

  const allSource = await listRegistryFiles(fetchImpl, sourceRepo, sourceBranch, null);
  if (allSource.length === 0) return result;
  // Bound the loop (see MAX_COPY_FLOWS). `sourceFiles` is what this run
  // attempts; `allSource` is what exists — the difference is what `sync` is for.
  const sourceFiles = allSource.slice(0, MAX_COPY_FLOWS);
  if (allSource.length > sourceFiles.length) result.truncated = true;

  // What the target already holds, so a re-run skips instead of clobbering.
  const existingNames = new Set(
    (await listRegistryFiles(fetchImpl, targetRepo, targetBranch, token)).map((f) => f.name),
  );

  for (const file of sourceFiles) {
    try {
      const resp = await fetchImpl(file.download_url, { headers: ghHeaders(null) });
      if (!resp.ok) { result.failed.push(file.name); continue; }
      const flow = await resp.json();
      if (!flow?.name || !Array.isArray(flow.steps)) { result.failed.push(file.name); continue; }

      const filename = `${slugify(String(flow.name))}.json`;
      if (existingNames.has(filename)) { result.skipped++; continue; }

      const content = serializeRegistryFlow(flow, author);
      const ok = await writeRegistryFile(
        fetchImpl, targetRepo, targetBranch, token, filename, content,
        `Import community flow: ${flow.name}`,
      );
      if (ok) result.copied++; else result.failed.push(file.name);
    } catch {
      result.failed.push(file.name);
    }
  }
  return result;
}

/**
 * Persist the org's registry choice. Caller must have probed first — this
 * function does not, so the probe/commit ordering stays visible at the call
 * site instead of being hidden behind a helper that might be skipped.
 */
export async function saveRegistryConfig(
  db: HubDb,
  orgId: string,
  opts: {
    repo: string;
    branch?: string;
    token?: string | null;
    secretKey: string;
    /** `undefined` = leave the column alone; `null` = clear it. */
    copiedAt?: string | null;
  },
): Promise<void> {
  // Validate at the boundary rather than in the route, so the value is safe on
  // every read path (admin browse, installation proxy, copy) and not merely on
  // the one path that wrote it. `undefined`/empty means "keep the default".
  if (opts.branch !== undefined && opts.branch !== '' && !isValidRegistryBranch(opts.branch)) {
    throw new Error(`invalid registry branch: ${JSON.stringify(opts.branch)}`);
  }
  if (!isValidRegistrySlug(opts.repo)) {
    throw new Error(`invalid registry repo: ${JSON.stringify(opts.repo)}`);
  }
  // Upsert: org_settings has no default row seeded, unlike auth_config.
  const existing = await db.get<{ org_id: string }>('SELECT org_id FROM org_settings WHERE org_id = ?', [orgId]);
  if (!existing) {
    await db.run(
      'INSERT INTO org_settings (org_id, registry_repo, registry_branch, registry_token_enc, registry_copied_at) VALUES (?, ?, ?, ?, ?)',
      [orgId, opts.repo, opts.branch || DEFAULT_REGISTRY_BRANCH,
        opts.token ? encryptSecret(opts.token, opts.secretKey) : null, opts.copiedAt ?? null],
    );
    return;
  }
  const sets: string[] = ['registry_repo = ?', 'registry_branch = ?'];
  const params: any[] = [opts.repo, opts.branch || DEFAULT_REGISTRY_BRANCH];
  // A blank token means "keep the one we have" — the admin UI never echoes the
  // secret back, so it has nothing to resend on an unrelated edit.
  if (opts.token) {
    sets.push('registry_token_enc = ?');
    params.push(encryptSecret(opts.token, opts.secretKey));
  }
  // `copiedAt: null` is a deliberate clear, not an omission. Moving back to the
  // public repo passes null precisely to drop the copy record; treating null as
  // "unspecified" would leave the admin looking at a stale "community flows
  // copied" badge on an org that is no longer on a private registry. So only
  // `undefined` means "leave the column alone".
  if (opts.copiedAt !== undefined) {
    sets.push('registry_copied_at = ?');
    params.push(opts.copiedAt);
  }
  sets.push("updated_at = datetime('now')");
  params.push(orgId);
  await db.run(`UPDATE org_settings SET ${sets.join(', ')} WHERE org_id = ?`, params);
}
