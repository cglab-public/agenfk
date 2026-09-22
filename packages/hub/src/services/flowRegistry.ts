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

/**
 * Which registry a browse/install should read: the org's own repo, or the
 * public community one.
 *
 * This exists because an org can point its registry at a private repo, after
 * which `resolveRegistryRead` has exactly one answer per org — so the real
 * community catalogue becomes invisible and uninstallable from the hub UI. The
 * one-time copy hides that at switch time (the org repo starts as a superset),
 * but any flow published to community afterwards is unreachable.
 *
 * The caller picks a SOURCE, never a repo. That distinction is the security
 * boundary: this route holds the org's `contents:write` PAT, so accepting an
 * `owner/repo` from the request would make it a proxy that spends that
 * credential against any repo the token can reach — a cross-tenant read driven
 * by a server-side secret. Only two names are ever reachable, and both are
 * ones the server already knows.
 *
 * Returns `ok: false` rather than throwing so the route answers 400 instead of
 * a 500 that would read like a server fault.
 */
export type RegistrySource = 'org' | 'community';

export type ResolvedRegistrySource =
  | { ok: true; repo: string; branch: string; token: string | null }
  | { ok: false; error: string };

export async function resolveRegistrySource(
  db: HubDb,
  orgId: string,
  secretKey: string,
  source: unknown,
): Promise<ResolvedRegistrySource> {
  const cfg = await getRegistryConfig(db, orgId);

  // Absent or empty means "the org's registry" — the behaviour every existing
  // caller (and the shipped hub-ui client) already depends on.
  if (source === undefined || source === null || source === '') {
    return {
      ok: true,
      repo: cfg.repo,
      branch: cfg.branch,
      token: cfg.isPublic ? null : await registryToken(db, orgId, secretKey),
    };
  }

  // Exact match, no trim and no case-folding: `source` is an enum, and a client
  // with a casing or whitespace bug should hear about it rather than be routed
  // to a repo it did not ask for.
  if (source !== 'org' && source !== 'community') {
    return { ok: false, error: 'source must be "org" or "community"' };
  }

  if (source === 'community') {
    // Never the org's token. The PAT is scoped to the org's repo; attaching it
    // to a public cglab-owned repo leaks the credential to a repo the org has
    // no relationship with and into GitHub's access logs. Anonymous is also
    // simply what a public repo needs.
    return { ok: true, repo: PUBLIC_REGISTRY_REPO, branch: cfg.branch, token: null };
  }

  return {
    ok: true,
    repo: cfg.repo,
    branch: cfg.branch,
    token: cfg.isPublic ? null : await registryToken(db, orgId, secretKey),
  };
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

/** What a publish produced. `error` carries the HTTP status to answer with. */
export type PublishResult =
  | { kind: 'pr'; url: string; repo: string; branch: string; base: string; version: string }
  | { kind: 'existing'; url: string; repo: string; version: string; note?: string }
  | { kind: 'error'; status: number; error: string };

/** JSON with object keys sorted, so two documents compare by content, not by key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object).sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as any)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Do two registry documents describe the same flow? `author` and `version`
 * are ignored. The author records who published, and a second person
 * re-publishing an unchanged flow must not open a PR whose only change
 * overwrites the first one's credit. The version is assigned BY the publish,
 * so against the REGISTRY a version-only difference is not a change; against
 * an open pull request it is (the PR must carry the version being reported).
 */
function sameRegistryFlow(onGitHub: string, ours: string, opts: { ignoreVersion: boolean }): boolean {
  try {
    const a = JSON.parse(onGitHub);
    const b = JSON.parse(ours);
    for (const d of [a, b]) {
      if (d && typeof d === 'object') {
        delete d.author;
        if (opts.ignoreVersion) delete d.version;
      }
    }
    return canonicalJson(a) === canonicalJson(b);
  } catch {
    return onGitHub.trim() === ours.trim();
  }
}

const BACKTICK = '`';
const FENCE = BACKTICK.repeat(3);
/** Inline-code a value from an installation, so no mention, link or image can render. */
const inertInline = (v: unknown) =>
  BACKTICK + String(v).replace(/[\u0000-\u001f\u007f`]/g, ' ').trim() + BACKTICK;
/** Fence a multi-line value from an installation, with no way to close the fence early. */
const inertBlock = (v: unknown) =>
  `${FENCE}text\n${String(v).replace(/`{3,}/g, "'''")}\n${FENCE}`;

/**
 * The numeric core of a version (`2.0.0` of `2.0.0-rc.1`), and whether it had a
 * prerelease/build suffix. Null for anything without an x.y.z core.
 */
const semver = (v: unknown): { core: [number, number, number]; suffixed: boolean } | null => {
  const m = /^(\d+)\.(\d+)\.(\d+)([-+].*)?$/.exec(String(v ?? '').trim());
  return m ? { core: [Number(m[1]), Number(m[2]), Number(m[3])], suffixed: !!m[4] } : null;
};
const coreAfter = (a: [number, number, number], b: [number, number, number]) =>
  a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];

/**
 * The version to publish a CHANGED flow at: one patch past what the registry
 * holds - as the laptop's gh path does - unless the author's version is
 * already past that. Never BELOW the registry's, prereleases included.
 */
function nextRegistryVersion(ours: string, onRegistry: unknown): string {
  const base = semver(onRegistry);
  if (!base) return ours;
  const bumped: [number, number, number] = [base.core[0], base.core[1], base.core[2] + 1];
  const mine = semver(ours);
  if (!mine) return bumped.join('.');
  // Mine is kept when its core is past the bump, or equal to it (a prerelease
  // of exactly the next version is still "the next version").
  return coreAfter(bumped, mine.core) ? bumped.join('.') : ours;
}

/** Every GitHub call gets a bound: several sequential calls must not hold a request forever. */
const GH_TIMEOUT_MS = 15_000;
/** A pull request link the hub may hand on. */
const GITHUB_LINK = /^https:\/\/github\.com\//;

/**
 * Publish one flow to an org registry as a PULL REQUEST (CGLAB-367).
 *
 * The flow is committed on the branch `flow/<slug>` - one branch per flow, so
 * re-publishing while its PR is open updates THAT PR rather than stacking a
 * second one that conflicts with it. Nothing is ever written onto the registry
 * branch itself.
 *
 * The branch is only ever moved when that cannot lose work: an open PR into a
 * DIFFERENT base is refused, and a branch with commits of its own is reset
 * only once those commits are on the registry branch or in a MERGED pull
 * request (a squash merge gives new SHAs, so ancestry alone would lock the
 * flow out). A branch this call created is deleted again if the write fails.
 *
 * The registry branch's head is read FIRST and the file is read AT that
 * commit, so the comparison, the blob sha and the branch point all describe one
 * tree. The branch goes in the Contents-API body: GitHub's create-or-update
 * endpoint reads `branch` there and defaults to the repo's default branch.
 */
export async function publishFlowPullRequest(
  fetchImpl: typeof fetch,
  opts: { repo: string; branch: string; token: string; flow: any; publisher: string; installationId: string | null },
): Promise<PublishResult> {
  const { repo, branch, token, flow, publisher, installationId } = opts;
  const slug = slugify(String(flow?.name ?? ''));
  const filename = `${slug}.json`;
  const filePath = `flows/${encodeURIComponent(filename)}`;
  const api = `${GITHUB_API}/repos/${repo}`;
  const headers = ghHeaders(token);
  const headBranch = `flow/${slug}`;
  const flowVersion = typeof flow?.version === 'string' && flow.version.trim() ? flow.version.trim() : '1.0.0';
  const call = (url: string, init: { method?: string; body?: unknown } = {}) => fetchImpl(url, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(GH_TIMEOUT_MS),
  });
  const fail = (status: number, error: string): PublishResult => ({ kind: 'error', status, error });
  // GitHub answers 403 - or 404, for a repo the token may not act on - when
  // the token lacks a permission. Say which one, instead of a bare status.
  const refused = (status: number, permissionError: string, otherwise: string): PublishResult =>
    status === 403 || status === 404 ? fail(403, permissionError) : fail(502, otherwise);
  const readFile = async (ref: string) => {
    const r = await call(`${api}/contents/${filePath}?ref=${encodeURIComponent(ref)}`);
    if (r.status === 404) return { ok: true as const, file: null };
    if (!r.ok) return { ok: false as const, status: r.status };
    const f: any = await r.json();
    return {
      ok: true as const,
      file: {
        sha: typeof f?.sha === 'string' ? f.sha : undefined,
        text: Buffer.from(String(f?.content ?? ''), 'base64').toString('utf8'),
      },
    };
  };
  const writeFile = (content: string, sha: string | undefined, message: string) =>
    call(`${api}/contents/${filePath}`, {
      method: 'PUT',
      body: {
        message,
        content: Buffer.from(content, 'utf8').toString('base64'),
        branch: headBranch,
        ...(sha ? { sha } : {}),
      },
    });
  /** The open pull request FROM flow/<slug>, whatever it targets. */
  const findOpenPr = async (): Promise<{ ok: true; pr: { url: string; base: string } | null } | { ok: false; status: number }> => {
    const owner = repo.split('/')[0];
    const r = await call(`${api}/pulls?state=open&head=${encodeURIComponent(`${owner}:${headBranch}`)}`);
    if (!r.ok) return { ok: false, status: r.status };
    const list: any = await r.json();
    const first = (Array.isArray(list) ? list : [])
      .find((p: any) => typeof p?.html_url === 'string' && GITHUB_LINK.test(p.html_url));
    return { ok: true, pr: first ? { url: first.html_url, base: String(first.base?.ref ?? '') } : null };
  };

  // 1. The registry branch: its head, and the file at exactly that commit.
  const head = await call(`${api}/git/ref/heads/${branch}`);
  if (head.status === 404) {
    return fail(409, `branch ${branch} of ${repo} is not visible to the org registry token - it does not exist, `
      + 'or the token cannot see the repository. An admin can check the registry settings in Admin > Flows.');
  }
  if (!head.ok) return fail(502, `could not read branch ${branch} of ${repo} (GitHub returned ${head.status})`);
  const baseSha = (await head.json() as any)?.object?.sha;
  if (typeof baseSha !== 'string') return fail(502, `GitHub did not report a commit for branch ${branch} of ${repo}`);

  const onBase = await readFile(baseSha);
  if (!onBase.ok) return fail(502, `GitHub returned ${onBase.status} reading flows/${filename} on ${repo}`);
  let registryVersion: unknown;
  try { registryVersion = onBase.file ? JSON.parse(onBase.file.text)?.version : undefined; } catch { /* unreadable */ }

  // 2. The flow's own branch, and any pull request open FROM it.
  const branchRef = await call(`${api}/git/ref/heads/${headBranch}`);
  const branchExists = branchRef.ok;
  if (!branchExists && branchRef.status !== 404) {
    return fail(502, `could not read branch ${headBranch} of ${repo} (GitHub returned ${branchRef.status})`);
  }
  const tipSha: string | undefined = branchExists ? (await branchRef.json() as any)?.object?.sha : undefined;
  let openPr: { url: string; base: string } | null = null;
  if (branchExists) {
    const found = await findOpenPr();
    if (!found.ok) {
      return refused(found.status, `the org registry token cannot read pull requests on ${repo} (it needs pull-requests: read)`,
        `could not list pull requests on ${repo} (GitHub returned ${found.status})`);
    }
    openPr = found.pr;
  }
  if (openPr && openPr.base !== branch) {
    return fail(409, `${headBranch} already has an open pull request into ${openPr.base || 'another branch'} (${openPr.url}), `
      + `but the registry branch is now ${branch}. Merge or close that pull request, then publish again.`);
  }

  // 3. Already on the registry? Then there is nothing to propose - but an open
  //    PR still proposing something else must not be hidden behind "done".
  const regDoc = serializeRegistryFlow(flow, publisher);
  if (onBase.file && sameRegistryFlow(onBase.file.text, regDoc, { ignoreVersion: true })) {
    return {
      kind: 'existing', url: `https://github.com/${repo}/blob/${branch}/flows/${filename}`, repo,
      version: typeof registryVersion === 'string' ? registryVersion : flowVersion,
      ...(openPr ? { note: `The registry already has this flow, but ${openPr.url} is still open and proposes a different version of it.` } : {}),
    };
  }

  // A changed flow gets a version past the registry's; a new one keeps its own.
  const version = onBase.file ? nextRegistryVersion(flowVersion, registryVersion) : flowVersion;
  const content = serializeRegistryFlow({ ...flow, version }, publisher);
  const verb = onBase.file ? 'Update' : 'Add';
  // A title renders no markdown, but an @ in it still reads as a mention.
  const title = `${verb} flow: ${String(flow.name).replace(/@/g, '@​')}`;

  // 4a. An open PR already carries this flow: commit onto it, and point at it.
  //     Compared INCLUDING the version, so a version change reaches the PR.
  if (openPr) {
    const onHead = await readFile(headBranch);
    if (!onHead.ok) return fail(502, `GitHub returned ${onHead.status} reading flows/${filename} on ${headBranch}`);
    if (!(onHead.file && sameRegistryFlow(onHead.file.text, content, { ignoreVersion: false }))) {
      const put = await writeFile(content, onHead.file?.sha, title);
      if (!put.ok) {
        return refused(put.status, `the org registry token cannot write to ${repo} (it needs contents: write)`,
          `could not update flows/${filename} on ${headBranch} (GitHub returned ${put.status})`);
      }
    }
    return { kind: 'pr', url: openPr.url, repo, branch: headBranch, base: branch, version };
  }

  // 4b. No open PR. A leftover flow/<slug> is moved only if that loses nothing.
  if (branchExists) {
    const cmp = await call(`${api}/compare/${baseSha}...${encodeURIComponent(headBranch)}`);
    if (!cmp.ok) return fail(502, `could not compare ${headBranch} with ${branch} on ${repo} (GitHub returned ${cmp.status})`);
    const aheadBy = Number((await cmp.json() as any)?.ahead_by ?? 0);
    if (aheadBy > 0) {
      const tipPrs = tipSha ? await call(`${api}/commits/${tipSha}/pulls`) : null;
      const merged = tipPrs?.ok ? ((await tipPrs.json()) as any[]).some?.((p: any) => !!p?.merged_at) : false;
      if (!merged) {
        return fail(409, `${headBranch} on ${repo} has ${aheadBy} commit(s) that are not on ${branch} and belong to no `
          + 'merged pull request, so publishing would overwrite them. Open, merge or delete that branch, then publish again.');
      }
    }
  }
  const moved = branchExists
    ? await call(`${api}/git/refs/heads/${headBranch}`, { method: 'PATCH', body: { sha: baseSha, force: true } })
    : await call(`${api}/git/refs`, { method: 'POST', body: { ref: `refs/heads/${headBranch}`, sha: baseSha } });
  if (!moved.ok) {
    if (moved.status === 422 && !branchExists) {
      return fail(409, `another publish of this flow is in progress (${headBranch} appeared meanwhile). Publish again in a moment.`);
    }
    return refused(moved.status, `the org registry token cannot create branches on ${repo} (it needs contents: write)`,
      `could not prepare branch ${headBranch} on ${repo} (GitHub returned ${moved.status})`);
  }
  const put = await writeFile(content, onBase.file?.sha, title);
  if (!put.ok) {
    // Best effort: a branch this call created must not be left behind empty.
    if (!branchExists) {
      await call(`${api}/git/refs/heads/${headBranch}`, { method: 'DELETE' }).catch(() => undefined);
    }
    return refused(put.status, `the org registry token cannot write to ${repo} (it needs contents: write)`,
      `could not write flows/${filename} on ${headBranch} (GitHub returned ${put.status})`);
  }

  const body = [
    'Published from the AgEnFK flow editor, through the org hub.',
    '',
    `**Flow**: ${inertInline(flow.name)} (file ${inertInline(`flows/${filename}`)})`,
    ...(flow.description ? ['**Description**:', '', inertBlock(flow.description), ''] : []),
    `**Published by**: ${inertInline(publisher)}, as reported by the installation`,
    `**Installation**: ${inertInline(installationId ?? 'fleet key (no installation)')}`,
  ].join('\n');
  const pr = await call(`${api}/pulls`, { method: 'POST', body: { title, head: headBranch, base: branch, body } });
  if (!pr.ok) {
    // 422 is GitHub refusing a duplicate: a concurrent publish opened it first.
    // The flow IS proposed - point at that pull request instead of failing.
    if (pr.status === 422) {
      const found = await findOpenPr();
      if (found.ok && found.pr && found.pr.base === branch) {
        return { kind: 'pr', url: found.pr.url, repo, branch: headBranch, base: branch, version };
      }
    }
    return refused(pr.status,
      `the org registry token cannot open pull requests on ${repo} (it needs pull-requests: write). `
        + `The flow was pushed to branch ${headBranch}; grant the permission, or open the pull request by hand.`,
      `could not open the pull request on ${repo} (GitHub returned ${pr.status}); the flow is on branch ${headBranch}`);
  }
  const url = (await pr.json() as any)?.html_url;
  if (typeof url !== 'string' || !GITHUB_LINK.test(url)) {
    return fail(502, `GitHub opened a pull request on ${repo} but returned no usable link to it`);
  }
  return { kind: 'pr', url, repo, branch: headBranch, base: branch, version };
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
