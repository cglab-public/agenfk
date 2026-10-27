/**
 * Airlock server authority (GH-294, T2): where the policy lives, who may change
 * it, and the one place a tool call is judged.
 *
 *   GET  /airlock/policy     the effective policy and where it came from
 *   PUT  /airlock/policy     a local write: refused while the hub owns the policy
 *   POST /airlock/evaluate   judge one tool call (adapters, CLI, MCP); loopback only
 *   GET  /airlock/decisions  the capped decision log, newest first
 *
 * WHO MAY WRITE (user decision, 2026-10-27; no passkeys anywhere in Airlock):
 *  - a hub-joined installation can NOT overrule the policy. Every local write is
 *    refused with 409 HUB_OWNS_AIRLOCK_POLICY, like HUB_OWNS_VERIFY_COMMAND, and
 *    the refusal is reported to the hub as airlock.local-write-refused;
 *  - a standalone installation can always overrule it: the write is accepted
 *    with no passkey and no board or authority check. What still stands is the
 *    policy's validation (400) and the compare-and-swap on its revision (409).
 *
 * EFFECTIVE POLICY: the hub row when there is one, else the local row, else
 * DEFAULT_AIRLOCK_POLICY (off). A hub row with no hub config (left the hub) is
 * still the hub's: T3 copies it to local on leaving.
 *
 * Every dependency is handed in, so the routes are testable without the rest of
 * server.ts and server.ts keeps owning the hub client and the socket.
 */
import * as os from 'os';
import * as path from 'path';
import {
  DEFAULT_AIRLOCK_POLICY,
  airlockPolicyErrors,
  capabilitiesOf,
  evaluateAirlock,
  modelFromPi,
  normalizeAirlockPolicy,
  writePrivateFileSync,
  type AirlockClient,
  type AirlockPolicy,
  type AirlockVerdict,
  type Capability,
  type HubEventType,
  type SessionModel,
  type StorageProvider,
  type StoredAirlockPolicy,
} from '@agenfk/core';
import { redactLog } from '../hub/redact.js';

export const HUB_OWNS_AIRLOCK_POLICY = 'HUB_OWNS_AIRLOCK_POLICY';
export const AIRLOCK_REVISION_CONFLICT = 'AIRLOCK_REVISION_CONFLICT';

const CLIENTS: readonly AirlockClient[] = ['pi', 'opencode'];
/** A logged target is for a person to read, not a copy of the command. */
const MAX_TARGET_CHARS = 500;
/** Redaction works on at most this much of a target, so its cost is bounded. */
const MAX_REDACT_INPUT = 16 * 1024;
/** Request size for the airlock routes (review finding 3). */
export const AIRLOCK_BODY_LIMIT = '256kb';
/** toolName, sessionId and each model part. */
export const MAX_AIRLOCK_FIELD = 256;
/** Capabilities one tool call may carry. */
export const MAX_AIRLOCK_CAPABILITIES = 32;

export interface AirlockRouteDeps {
  storage: () => StorageProvider;
  /** True while this installation is joined to a hub. */
  hubJoined: () => boolean;
  recordHubEvent: (event: { type: HubEventType; payload: Record<string, unknown> }) => unknown;
  emit: (event: string, payload?: unknown) => void;
  /** The card the session's workflow last authorised, for the decision log. */
  activeWork: (sessionId?: string) => { itemId: string; projectId?: string } | null;
  /** Where adapters read the last-known policy when the server is unreachable. */
  stateFile?: () => string;
}

export interface AirlockPolicyView {
  effective: AirlockPolicy;
  source: 'hub' | 'local';
  revision: number;
  hubManaged: boolean;
  local: StoredAirlockPolicy | null;
  hub: StoredAirlockPolicy | null;
}

export const defaultAirlockStateFile = (): string => path.join(os.homedir(), '.agenfk', 'airlock-state.json');

/** hub row > local row > the (off) default. */
export async function resolveAirlockPolicy(storage: StorageProvider, hubJoined: boolean): Promise<AirlockPolicyView> {
  const [local, hub] = await Promise.all([storage.getAirlockPolicy('local'), storage.getAirlockPolicy('hub')]);
  const winner = hub ?? local;
  return {
    effective: winner ? winner.policy : normalizeAirlockPolicy(DEFAULT_AIRLOCK_POLICY),
    source: hub ? 'hub' : 'local',
    revision: winner ? winner.revision : 0,
    hubManaged: hubJoined || !!hub,
    local,
    hub,
  };
}

/**
 * The adapters' cold-start fallback: only what deciding "does this apply, and
 * is it enforcing" needs - never the host or IOC lists. 0600: it is the user's.
 */
export function writeAirlockStateFile(view: AirlockPolicyView, file: string = defaultAirlockStateFile()): void {
  const state = {
    mode: view.effective.mode,
    revision: view.revision,
    source: view.source,
    models: view.effective.models,
    appliesWhenModelUnknown: view.effective.appliesWhenModelUnknown,
    writtenAt: new Date().toISOString(),
  };
  writePrivateFileSync(file, JSON.stringify(state, null, 2) + '\n');
}

export type StateFileResult = { status: 'written' } | { status: 'write-failed'; reason: string };

function tryWriteAirlockStateFile(view: AirlockPolicyView, file: string): StateFileResult {
  try {
    writeAirlockStateFile(view, file);
    return { status: 'written' };
  } catch (e) {
    const reason = (e as Error).message;
    console.error('[AIRLOCK] could not write the state file:', reason);
    return { status: 'write-failed', reason };
  }
}

/**
 * Rewrite the state file from the effective policy: at server startup, and
 * (T3) whenever the hub row changes, so a write that failed once, or a file
 * someone edited, does not outlive the next start. Never throws.
 */
export async function reconcileAirlockStateFile(storage: StorageProvider, hubJoined: boolean, file: string = defaultAirlockStateFile()): Promise<StateFileResult> {
  try {
    return tryWriteAirlockStateFile(await resolveAirlockPolicy(storage, hubJoined), file);
  } catch (e) {
    return { status: 'write-failed', reason: (e as Error).message };
  }
}

export const isLoopback = (addr: string | undefined): boolean =>
  !!addr && (addr === '::1' || addr.startsWith('127.') || addr.startsWith('::ffff:127.'));

function sessionModelOf(raw: unknown): SessionModel | null {
  if (raw === undefined || raw === null) return { provider: null, id: null };
  if (typeof raw === 'string') return modelFromPi(raw);
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  return modelFromPi(null, { provider: str(m.provider) ?? str(m.providerID), model: str(m.id) ?? str(m.model) ?? str(m.modelID) });
}

const capabilityText = (cap: Capability): string =>
  cap.kind === 'command' ? cap.command : cap.kind === 'path' ? cap.path : cap.url;

const R = '[REDACTED]';
const SENSITIVE_HEADER = /auth|token|key|secret|cookie|session|passw|credential/i;
const SECRET_ASSIGNMENT = /\b(password|passwd|pass|pwd|token|access_token|refresh_token|id_token|api_?key|apikey|secret|client_secret|key|auth|session|sig|signature)=([^&\s'"]+)/gi;
const URL_USERINFO = /([a-z][a-z0-9+.-]{0,30}:\/\/)[^\s\/@'"?#]{1,512}@/gi;
const URL_QUERY = /([a-z][a-z0-9+.-]{0,30}:\/\/[^\s'"?#]{0,2048})\?([^\s'"#]{0,4096})/gi;
/** `Authorization: <scheme> <value>` wherever it appears, quoted or not. */
const AUTHORIZATION_VALUE = /\b((?:proxy-)?authorization)[ \t]*:[ \t]*(?!\[REDACTED\])(?:(?:basic|bearer|digest|negotiate|ntlm|token|aws4-hmac-sha256)[ \t]+)?[^\s'"]+/gi;
/** Options whose argument is a credential, whole. */
const CREDENTIAL_OPTIONS = new Set(['-u', '-U', '-b', '--user', '--proxy-user', '--cookie', '--oauth2-bearer']);
/** Options whose argument is a header; its value always goes, its name stays. */
const HEADER_OPTIONS = new Set(['-H', '--header', '--proxy-header']);

/**
 * Split a command into shell words, honouring quotes and backslashes, so an
 * option's argument is found however it is written: `-H 'X: y'`, `-H'X: y'`,
 * `--header="X: y"`. Approximate (no expansions), which suits a log excerpt.
 */
export function shellWords(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let open = false;
  // `$'…'` is ANSI-C quoting: single-quoted, but backslash escapes apply.
  let quote: '"' | "'" | '$' | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === (quote === '$' ? "'" : quote)) quote = null;
      else if (c === '\\' && quote !== "'" && i + 1 < text.length) cur += text[++i];
      else cur += c;
      continue;
    }
    if (c === '$' && text[i + 1] === "'") { quote = '$'; open = true; i++; continue; }
    if (c === "'" || c === '"') { quote = c; open = true; continue; }
    if (c === '\\' && i + 1 < text.length) { cur += text[++i]; open = true; continue; }
    if (/\s/.test(c)) {
      if (open) { out.push(cur); cur = ''; open = false; }
      continue;
    }
    cur += c;
    open = true;
  }
  if (open) out.push(cur);
  return out;
}

/** `Name: value` with a sensitive name keeps the name and loses the value. */
function redactHeader(word: string): string {
  const m = /^([A-Za-z0-9_-]{1,100})[ \t]*:/.exec(word);
  return m && SENSITIVE_HEADER.test(m[1]) ? `${m[1]}: ${R}` : word;
}

/**
 * A header option's argument loses its value whatever the header is called:
 * which names carry secrets cannot be known (X-Tenant-Ref may be one), and a
 * header value is never what a reader of the decision log needs.
 */
function redactHeaderArgument(word: string): string {
  const m = /^([A-Za-z0-9_-]{1,100})[ \t]*:/.exec(word);
  return m ? `${m[1]}: ${R}` : R;
}

/** Credential option arguments, in every spelling: separate, attached, or `--long=value`. */
function redactWords(words: string[]): string[] {
  const out = [...words];
  for (let i = 0; i < out.length; i++) {
    const w = out[i];
    if (CREDENTIAL_OPTIONS.has(w)) {
      if (i + 1 < out.length) out[++i] = R;
      continue;
    }
    if (HEADER_OPTIONS.has(w)) {
      if (i + 1 < out.length) { out[i + 1] = redactHeaderArgument(out[i + 1]); i++; }
      continue;
    }
    const long = /^(--[A-Za-z0-9-]+)=([\s\S]*)$/.exec(w);
    if (long && CREDENTIAL_OPTIONS.has(long[1])) { out[i] = `${long[1]}=${R}`; continue; }
    if (long && HEADER_OPTIONS.has(long[1])) { out[i] = `${long[1]}=${redactHeaderArgument(long[2])}`; continue; }
    const attached = /^-([HuUb])([\s\S]+)$/.exec(w);
    if (attached) { out[i] = attached[1] === 'H' ? `-H${redactHeaderArgument(attached[2])}` : `-${attached[1]}${R}`; continue; }
    // A sensitive header anywhere else (an echoed line, a config piped in).
    out[i] = redactHeader(w);
  }
  return out;
}

/**
 * A target as it may be stored and sent to the hub. The command is split into
 * shell words and credential option arguments go (-u/--user, -b/--cookie,
 * --oauth2-bearer, sensitive -H/--header values, attached or not); then URL
 * userinfo and query values, `Authorization: <scheme> <value>` and
 * key=value secrets; then the known secret formats, this machine's secret env
 * values and the home directory (redactLog); then a length cap. The result is
 * an excerpt with normalised quoting, and over-redaction is the accepted
 * failure, not a leak.
 */
export function redactTarget(text: string): string {
  const bounded = text.length > MAX_REDACT_INPUT ? text.slice(0, MAX_REDACT_INPUT) : text;
  let s = redactWords(shellWords(bounded)).join(' ');
  s = s.replace(URL_USERINFO, `$1${R}@`);
  s = s.replace(URL_QUERY, (_m, base: string, query: string) => `${base}?${query.replace(/=[^&]*/g, `=${R}`)}`);
  s = s.replace(AUTHORIZATION_VALUE, `$1: ${R}`);
  s = s.replace(SECRET_ASSIGNMENT, `$1=${R}`);
  const { text: redacted } = redactLog(s, { home: os.homedir(), env: process.env });
  return redacted.length > MAX_TARGET_CHARS ? `${redacted.slice(0, MAX_TARGET_CHARS)}…` : redacted;
}

/** The verdict worth a log line: anything but a plain allow (observe logs what enforce would do). */
function loggedVerdict(verdict: AirlockVerdict): Exclude<AirlockVerdict, { decision: 'allow' }> | null {
  if (verdict.decision !== 'allow') return verdict;
  return verdict.observed ?? null;
}

export function registerAirlockRoutes(app: any, deps: AirlockRouteDeps): void {
  const stateFile = deps.stateFile ?? defaultAirlockStateFile;

  app.get('/airlock/policy', async (_req: any, res: any, next: any) => {
    try {
      // `?refresh=1` is accepted for the hub sync (T3), which owns the refetch.
      res.json(await resolveAirlockPolicy(deps.storage(), deps.hubJoined()));
    } catch (e) { next(e); }
  });

  app.put('/airlock/policy', async (req: any, res: any, next: any) => {
    try {
      const storage = deps.storage();
      const body = req.body ?? {};
      const before = await resolveAirlockPolicy(storage, deps.hubJoined());

      // Hub first: while the hub owns the policy no local write is considered at
      // all, valid or not, whoever sends it.
      if (before.hubManaged) {
        deps.recordHubEvent({
          type: 'airlock.local-write-refused',
          payload: { source: before.source, revision: before.revision, expectedRevision: typeof body.expectedRevision === 'number' ? body.expectedRevision : null },
        });
        return res.status(409).json({
          error: HUB_OWNS_AIRLOCK_POLICY,
          message: `The Airlock policy is managed by your organization's hub${before.hub ? ` (revision ${before.hub.revision})` : ''} and cannot be changed on this installation. An org admin changes it on the hub.`,
        });
      }

      const errors = airlockPolicyErrors(body.policy);
      if (errors.length) return res.status(400).json({ error: 'INVALID_AIRLOCK_POLICY', errors });
      const expected = body.expectedRevision;
      if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0) {
        return res.status(400).json({ error: 'expectedRevision (a whole number, 0 for the first write) is required' });
      }

      const policy = normalizeAirlockPolicy(body.policy);
      let stored: StoredAirlockPolicy;
      try {
        stored = await storage.putAirlockPolicy({
          scope: 'local',
          revision: expected + 1,
          policy,
          updatedAt: new Date().toISOString(),
          updatedBy: os.userInfo().username,
          authority: 'local',
        }, expected);
      } catch (e: any) {
        if (e?.code === 'AIRLOCK_STALE_REVISION') {
          return res.status(409).json({
            error: AIRLOCK_REVISION_CONFLICT,
            message: `The policy changed since it was read: it is at revision ${e.currentRevision}, not ${expected}. Reload and apply the change again.`,
            currentRevision: e.currentRevision,
          });
        }
        throw e;
      }

      const view = await resolveAirlockPolicy(storage, deps.hubJoined());
      // The policy is stored either way; a failed write leaves only the
      // adapters' cold-start copy stale, and the caller is told so (startup
      // reconciles it again).
      const stateFileResult = tryWriteAirlockStateFile(view, stateFile());
      deps.recordHubEvent({ type: 'airlock.policy-changed', payload: { revision: stored.revision, mode: policy.mode, scope: 'local' } });
      deps.emit('airlock_policy_changed', { revision: view.revision, source: view.source });
      res.json({ ...view, stateFile: stateFileResult });
    } catch (e) { next(e); }
  });

  app.post('/airlock/evaluate', async (req: any, res: any, next: any) => {
    try {
      if (!isLoopback(req.socket?.remoteAddress)) {
        return res.status(403).json({ error: 'Airlock evaluation is only answered on this machine' });
      }
      const body = req.body ?? {};
      if (!CLIENTS.includes(body.client)) {
        return res.status(400).json({ error: `client must be one of ${CLIENTS.join(', ')}` });
      }
      if (!body.args || typeof body.args !== 'object' || Array.isArray(body.args)) {
        return res.status(400).json({ error: 'args (the tool call\'s arguments, an object) is required' });
      }
      const tooLong = (['toolName', 'sessionId'] as const).find(k => typeof body[k] === 'string' && body[k].length > MAX_AIRLOCK_FIELD);
      if (tooLong) return res.status(400).json({ error: `${tooLong} is longer than ${MAX_AIRLOCK_FIELD} characters` });
      const model = sessionModelOf(body.model);
      if (!model) return res.status(400).json({ error: 'model must be "provider/model" or { provider, id }' });
      if ((model.provider?.length ?? 0) > MAX_AIRLOCK_FIELD || (model.id?.length ?? 0) > MAX_AIRLOCK_FIELD) {
        return res.status(400).json({ error: `model provider and id must each be at most ${MAX_AIRLOCK_FIELD} characters` });
      }
      const toolName = typeof body.toolName === 'string' ? body.toolName : '';
      const sessionId = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : undefined;

      const capabilities = capabilitiesOf(body.args);
      if (capabilities.length > MAX_AIRLOCK_CAPABILITIES) {
        return res.status(400).json({ error: `a tool call may carry at most ${MAX_AIRLOCK_CAPABILITIES} capabilities (commands, paths, URLs); this one has ${capabilities.length}` });
      }
      const view = await resolveAirlockPolicy(deps.storage(), deps.hubJoined());
      const work = deps.activeWork(sessionId);
      // Grants arrive with the approval flow (T5); until then none is held.
      const card = work ? { itemId: work.itemId, projectId: work.projectId, grants: [] as string[] } : undefined;
      const verdict = evaluateAirlock(view.effective, { client: body.client, model, toolName, capabilities, card });
      const applies = !(verdict.decision === 'allow' && (verdict.why === 'mode-off' || verdict.why === 'model-not-selected'));

      const logged = body.dryRun === true ? null : loggedVerdict(verdict);
      if (logged) {
        const target = (logged.target && capabilities.find(c => capabilityText(c).includes(logged.target!))) || capabilities[0];
        const record = {
          ts: new Date().toISOString(),
          client: body.client as string,
          model: model.provider || model.id ? [model.provider, model.id].filter(Boolean).join('/') : null,
          tool: toolName.slice(0, 200),
          capabilityKind: target?.kind ?? null,
          target: target ? redactTarget(capabilityText(target)) : null,
          decision: logged.decision,
          rule: logged.rule,
          mode: view.effective.mode,
          itemId: work?.itemId ?? null,
          sessionId: sessionId ?? null,
        };
        await deps.storage().recordAirlockDecision(record);
        // The session id stays on this machine; the hub gets the redacted decision.
        const { sessionId: _local, ...shared } = record;
        deps.recordHubEvent({ type: 'airlock.decision', payload: { ...shared, revision: view.revision, source: view.source } });
      }

      res.json({ verdict, mode: view.effective.mode, applies, revision: view.revision, source: view.source });
    } catch (e) { next(e); }
  });

  app.get('/airlock/decisions', async (req: any, res: any, next: any) => {
    try {
      const limit = Number(req.query?.limit);
      res.json({ decisions: await deps.storage().listAirlockDecisions(Number.isFinite(limit) && limit > 0 ? { limit } : {}) });
    } catch (e) { next(e); }
  });
}
