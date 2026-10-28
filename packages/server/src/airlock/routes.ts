/**
 * Airlock server authority (GH-294, T2): where the policy lives, who may change
 * it, and the one place a tool call is judged.
 *
 *   GET  /airlock/policy     the effective policy and where it came from;
 *                            ?projectId= that project's (its overrides applied)
 *   PUT  /airlock/policy     a local write: refused while the hub owns the policy
 *   POST /airlock/evaluate   judge one tool call (adapters, CLI, MCP); loopback only
 *   POST /airlock/proxy-decisions   what the sandbox proxy allowed and denied (TEL-1); loopback only
 *   GET  /airlock/decisions  the capped decision log, newest first; ?itemId= &client= &source= &alert= (TEL-2)
 *   GET  /airlock/approvals  human-approval requests: pending, and the recent ones (T5)
 *   POST /airlock/approvals/:key/grant|deny   a person's answer, on the board (T5)
 *   /airlock/learning[/import|/accept|/forward]   learning mode's proposed allowlist (TEL-3, learn.ts)
 *   GET  /airlock/dataset    whether past sessions can be imported: joined, and the hub's switch on (DS-3)
 *   POST /airlock/dataset/import   past sessions' tool calls, as dataset rows; loopback, never from a sandbox
 *
 * APPROVALS (T5): a needs-human-approval verdict records a pending request under
 * its approval key (bound to the rule, the project and every capability). A
 * person grants it on the board - no passkey, but never the agent: the board
 * header is required and the agent's internal header is refused - and the grant
 * is single-use and expires after AIRLOCK_GRANT_TTL_MS. Evaluate hands usable
 * grants to the engine as card.grants and consumes each one the allowed call
 * used, atomically, so a grant lets exactly one call through. A denial holds
 * (the same request is denied) until someone grants it.
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
 * PROXY DECISIONS (TEL-1): the launcher's sandbox proxy (packages/cli/src/airlock)
 * reports its decisions (denials) in batches, from loopback AND with the report
 * token as x-agenfk-airlock-report (reportToken.ts), which the sandbox cannot read.
 * Each lands in the same decision log as source 'proxy' (a tool call's is source 'tool'), goes to the hub
 * redacted and without the session id, as evaluate's do, and an identical one
 * repeated within AIRLOCK_PROXY_DEDUPE_MS is dropped so a retry loop does not
 * flood the log; the dedupe is capped, and so is each client's rate (the rest
 * is dropped and counted). The proxy decided before it reported: nothing here
 * can change a verdict.
 *
 * Every dependency is handed in, so the routes are testable without the rest of
 * server.ts and server.ts keeps owning the hub client and the socket.
 */
import * as os from 'os';
import * as path from 'path';
import {
  AIRLOCK_ALERTS,
  DEFAULT_AIRLOCK_POLICY,
  airlockAlertOf,
  airlockPolicyErrors,
  airlockRepoKey,
  effectivePolicyFor,
  capabilitiesOf,
  evaluateAirlock,
  modelFromPi,
  normalizeAirlockPolicy,
  writePrivateFileSync,
  type AgentRun,
  type AirlockApprovalCapability,
  type AirlockApprovalRecord,
  type AirlockClient,
  type AirlockAlert,
  type AirlockDecisionQuery,
  type AirlockDecisionRecord,
  type AirlockGrantScope,
  type AirlockPolicy,
  type AirlockVerdict,
  type Capability,
  type HubEventType,
  type SessionModel,
  type StorageProvider,
  type StoredAirlockPolicy,
} from '@agenfk/core';
import { redactLog } from '../hub/redact.js';
import { airlockDataset, AIRLOCK_DATASET_IMPORT_MAX_CALLS } from './dataset.js';
import { AIRLOCK_REPORT_HEADER } from './reportToken.js';
import { registerAirlockLearning } from './learn.js';

export const HUB_OWNS_AIRLOCK_POLICY = 'HUB_OWNS_AIRLOCK_POLICY';
export const AIRLOCK_REVISION_CONFLICT = 'AIRLOCK_REVISION_CONFLICT';
/** 503: a project's repository could not be read, so its overrides cannot be told (the adapter, unanswered, blocks in enforce). */
export const AIRLOCK_PROJECT_UNKNOWN = 'AIRLOCK_PROJECT_UNKNOWN';

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
/** How long a person's grant stays usable. */
export const AIRLOCK_GRANT_TTL_MS = 30 * 60 * 1000;
/** Decisions one proxy report may carry (the launcher sends at most this many per batch). */
export const MAX_PROXY_DECISIONS = 200;
/** An identical proxy decision repeated within this long is not logged again. */
export const AIRLOCK_PROXY_DEDUPE_MS = 10_000;
/** Distinct decisions the dedupe remembers; past it the oldest is forgotten first. */
export const AIRLOCK_PROXY_DEDUPE_CAP = 5_000;
/** Proxy decisions logged per client per minute; the rest are dropped and counted. */
export const AIRLOCK_PROXY_RATE_PER_MIN = 600;
/** A host as the proxy names it: a DNS name or an address literal (IPv6 included); ASRT's own limit is 255. */
const PROXY_HOST = /^[A-Za-z0-9._:\[\]%-]{1,255}$/;
/** Answered requests the board lists beside the pending ones. */
const RECENT_APPROVALS = 50;

export interface AirlockRouteDeps {
  storage: () => StorageProvider;
  /** True while this installation is joined to a hub. */
  hubJoined: () => boolean;
  recordHubEvent: (event: { type: HubEventType; payload: Record<string, unknown> }) => unknown;
  emit: (event: string, payload?: unknown) => void;
  /** The card the session's workflow last authorised, for the decision log. */
  activeWork: (sessionId?: string) => { itemId: string; projectId?: string } | null;
  /**
   * The Airlock report token (~/.agenfk/airlock/report-token, reportToken.ts)
   * the unsandboxed launcher sends as x-agenfk-airlock-report with proxy
   * decisions, as it is now. Absent, null or empty: every report is refused.
   */
  reportToken?: () => string | null;
  /** Overrides AIRLOCK_PROXY_DEDUPE_CAP and AIRLOCK_PROXY_RATE_PER_MIN (tests). */
  proxyLimits?: { dedupeCap?: number; ratePerMin?: number };
  /** Where adapters read the last-known policy when the server is unreachable. */
  stateFile?: () => string;
  /** Pull the hub's policy now (GET ?refresh=1). Absent, or not joined: refresh is a no-op. Never throws. */
  refreshFromHub?: () => Promise<void>;
  /** The clock grants are judged by (epoch ms). Defaults to Date.now. */
  now?: () => number;
  /**
   * The hub's dataset switch (DS-1, hub/airlockSync.ts). On, and joined to a hub:
   * each judged call and proxy decision is sent as a full row (airlock/dataset.ts).
   * Absent or off: nothing is built or sent.
   */
  datasetEnabled?: () => boolean;
  /** Changes when the hub configuration does (hub/airlockSync.ts): the dataset forgets what it remembered. */
  datasetScope?: () => unknown;
  /**
   * A project's repository (its git origin, any form), for its per-project
   * override (PO-1); null when it has none. Absent: only project:<id> overrides apply.
   */
  projectRepoOf?: (projectId: string) => Promise<string | null>;
}

export type AirlockApprovalStatus = 'pending' | 'granted' | 'consumed' | 'expired' | 'denied';

/** Where a request stands at `now`. */
export function approvalStatusOf(row: AirlockApprovalRecord, now: number): AirlockApprovalStatus {
  if (row.deniedAt) return 'denied';
  if (!row.grantedAt) return 'pending';
  if (row.consumedAt) return 'consumed';
  if (row.expiresAt && Date.parse(row.expiresAt) <= now) return 'expired';
  return 'granted';
}

/** Approvals and denials are a person's, made on the board: never the agent's. */
function refuseUnlessBoard(req: any, res: any): boolean {
  if (req.headers?.['x-agenfk-internal'] !== undefined || req.headers?.['x-agenfk-ui'] !== '1') {
    res.status(403).json({ error: 'Airlock approvals are made by a person on the board (agenfk ui), never by an agent.' });
    return true;
  }
  return false;
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

/** Why a request's model is refused (400), or null when it is fine. */
function modelErrorOf(model: SessionModel | null): string | null {
  if (!model) return 'model must be "provider/model" or { provider, id }';
  if ((model.provider?.length ?? 0) > MAX_AIRLOCK_FIELD || (model.id?.length ?? 0) > MAX_AIRLOCK_FIELD) {
    return `model provider and id must each be at most ${MAX_AIRLOCK_FIELD} characters`;
  }
  return null;
}

/** `provider/id` as the decision log names a model, or null when neither is known. */
const modelLabel = (model: SessionModel): string | null =>
  model.provider || model.id ? [model.provider, model.id].filter(Boolean).join('/') : null;

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
/**
 * An option whose name says it carries a secret (`--secret-string`,
 * `--password`, `--master-user-password`, `--api-key`, `--token`, `-auth`...):
 * its argument goes, separate or `=value`. Over-redaction (`--key-type`) is the
 * accepted failure.
 */
const SECRET_OPTION_NAME = /secret|passw|token|key|credential|auth/i;
const isSecretOption = (word: string): boolean => {
  const m = /^-{1,2}([A-Za-z0-9][A-Za-z0-9_.-]{0,100})$/.exec(word);
  return !!m && SECRET_OPTION_NAME.test(m[1]);
};
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
    if (isSecretOption(w)) {
      if (i + 1 < out.length) out[++i] = R;
      continue;
    }
    const long = /^(--[A-Za-z0-9-]+)=([\s\S]*)$/.exec(w);
    if (long && CREDENTIAL_OPTIONS.has(long[1])) { out[i] = `${long[1]}=${R}`; continue; }
    if (long && HEADER_OPTIONS.has(long[1])) { out[i] = `${long[1]}=${redactHeaderArgument(long[2])}`; continue; }
    const assigned = /^(-{1,2}[A-Za-z0-9][A-Za-z0-9_.-]{0,100})=[\s\S]*$/.exec(w);
    if (assigned && isSecretOption(assigned[1])) { out[i] = `${assigned[1]}=${R}`; continue; }
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
  const redacted = redactText(text.length > MAX_REDACT_INPUT ? text.slice(0, MAX_REDACT_INPUT) : text);
  return redacted.length > MAX_TARGET_CHARS ? `${redacted.slice(0, MAX_TARGET_CHARS)}…` : redacted;
}

/**
 * Text that is not a shell command (a file's content, a path, a URL), with its
 * secrets removed and its layout kept: the stages of redactText that do not
 * reparse it as shell words, then redactLog (DS-1).
 */
export function redactPlainText(text: string): string {
  return redactStages(text);
}

/** `NAME=value` as one shell word (quotes already gone), NAME naming a secret. */
const SECRET_NAMED_WORD = /^([A-Za-z_][A-Za-z0-9_]{0,100})=([\s\S]+)$/;
/** Every name SECRET_ASSIGNMENT and redactLog treat as a secret, and more: the word rule hides the whole value. */
const SECRET_NAME = /(TOKEN|SECRET|PASS|PWD|API_?KEY|KEY|CREDENTIAL|AUTH|SESSION|SIG)/i;

/**
 * A shell command with its secrets removed, whole - no excerpt (DS-1). Read as shell
 * words, so a value is hidden however it was quoted or escaped (-u alice:'pw'), and a
 * word that assigns a secret-named variable loses its whole value (PASSWORD='a b c');
 * then the stages redactText applies. Its quoting and spacing come back normalised.
 */
export function redactCommandWhole(text: string): string {
  const words = redactWords(shellWords(text)).map((w) => {
    const m = SECRET_NAMED_WORD.exec(w);
    return m && SECRET_NAME.test(m[1]) ? `${m[1]}=${R}` : w;
  });
  return redactStages(words.join(' '));
}

/** redactText's stages after the shell words: URL userinfo and query values, Authorization, key=value secrets, redactLog. */
function redactStages(text: string): string {
  let s = text.replace(URL_USERINFO, `$1${R}@`);
  s = s.replace(URL_QUERY, (_m, base: string, query: string) => `${base}?${query.replace(/=[^&]*/g, `=${R}`)}`);
  s = s.replace(AUTHORIZATION_VALUE, `$1: ${R}`);
  s = s.replace(SECRET_ASSIGNMENT, `$1=${R}`);
  return redactLog(s, { home: os.homedir(), env: process.env }).text;
}

/** The redaction redactTarget applies, without its input bound or its excerpt cap. */
function redactText(text: string): string {
  return redactTextTracked(text).text;
}

/**
 * redactText, also saying whether any stage replaced a value. Tracked stage by
 * stage rather than inferred from `[REDACTED]` markers in the output, which the
 * input itself can contain. The home directory becoming `~` is not a redaction.
 */
function redactTextTracked(text: string): { text: string; redacted: boolean } {
  const words = shellWords(text);
  let s = redactWords(words).join(' ');
  let redacted = s !== words.join(' ');
  const stage = (next: string) => { if (next !== s) redacted = true; s = next; };
  stage(s.replace(URL_USERINFO, `$1${R}@`));
  stage(s.replace(URL_QUERY, (_m, base: string, query: string) => `${base}?${query.replace(/=[^&]*/g, `=${R}`)}`));
  stage(s.replace(AUTHORIZATION_VALUE, `$1: ${R}`));
  stage(s.replace(SECRET_ASSIGNMENT, `$1=${R}`));
  const log = redactLog(s, { home: os.homedir(), env: process.env });
  if (log.count > 0) redacted = true;
  return { text: log.text, redacted };
}

/**
 * Shell syntax that runs code, anywhere and however quoted: substitutions,
 * process substitution, parameter expansion, command separators and pipes,
 * and interpreters handed code inline (`bash -c`, `python -c`, `node -e`, eval).
 */
const RUNS_CODE = new RegExp([
  /\$\(|`|<\(|>\(|\$\{|[;|&]/.source,
  /\b(?:ba|z|k|da|fi|c|tc)?sh\b[^\n]*?\s-[A-Za-z]*c\b/.source,
  /\b(?:python[\d.]*|node|deno|bun|perl|ruby|php|lua|osascript)\b[^\n]*?\s-(?:[A-Za-z]*[ec]\b|-eval\b)/.source,
  /\beval\b/.source,
].join('|'));

/** The verdict worth a log line: anything but a plain allow (observe logs what enforce would do). */
function loggedVerdict(verdict: AirlockVerdict): Exclude<AirlockVerdict, { decision: 'allow' }> | null {
  if (verdict.decision !== 'allow') return verdict;
  return verdict.observed ?? null;
}

/**
 * The longest capability an approval stores and shows whole. A person approves
 * what they read, so an approval is never an excerpt: a longer value is stored
 * as far as it goes, marked incomplete, and that request cannot be approved.
 */
export const MAX_APPROVAL_VALUE = 64 * 1024;

/** A capability's whole redacted value, for a person to approve; `complete: false` when it is too long. */
export function approvalValue(text: string, kind: Capability['kind'] = 'command'): { value: string; complete: boolean; concealed: boolean } {
  const complete = text.length <= MAX_APPROVAL_VALUE;
  const original = complete ? text : text.slice(0, MAX_APPROVAL_VALUE);
  const { text: value, redacted } = redactTextTracked(original);
  // THE invariant, checked once at the end of the whole pipeline: a COMMAND
  // with anything redacted cannot be approved, because whether a hidden span
  // runs code cannot be decided from shell text (bash -''c, newlines, $var).
  // A path or URL only names a target, so its redaction hides a value, never
  // code, unless the original itself looks like code. Over-refusing is the
  // accepted failure: the agent can run it without the secret, or a person can
  // change the policy.
  const concealed = redacted && (kind === 'command' || RUNS_CODE.test(original));
  return { value, complete, concealed };
}

/** A bound capability as a person reads it: kind, redacted value, and a path's access. */
export function approvalCapabilities(caps: readonly Capability[]): AirlockApprovalCapability[] {
  return caps.map(c => {
    const { value, complete, concealed } = approvalValue(capabilityText(c), c.kind);
    return {
      kind: c.kind,
      value,
      ...(c.kind === 'path' ? { access: c.access } : {}),
      ...(complete ? {} : { complete: false }),
      ...(concealed ? { concealed: true } : {}),
    };
  });
}

/** The same capabilities as the capped, redacted excerpts the log and the hub carry. */
const excerptCapabilities = (caps: readonly Capability[]): AirlockApprovalCapability[] =>
  caps.map(c => ({ kind: c.kind, value: redactTarget(capabilityText(c)), ...(c.kind === 'path' ? { access: c.access } : {}) }));

/** The verdict as the caller gets it: an approval's raw capabilities stay on the server. */
function publicVerdict(v: AirlockVerdict): unknown {
  const strip = (x: AirlockVerdict | undefined) => {
    if (!x || x.decision !== 'needs-human-approval') return x;
    const { capabilities: _raw, ...rest } = x;
    return rest;
  };
  if (v.decision === 'allow' && v.observed) return { ...v, observed: strip(v.observed) };
  return strip(v);
}

/**
 * The verdict once the grants a person made are applied (T5). An approval the
 * call needs that is granted, unused and unexpired is handed to the engine as
 * card.grants, one finding at a time, until the call is allowed or stops on
 * something no grant covers. A grant is spent only by a call it lets through,
 * and only once: each is consumed in one statement, so of two racing calls one
 * gets it and the other is judged without it. A dry run sees grants, spends none.
 */
async function verdictWithGrants(
  storage: StorageProvider,
  judge: (grants: string[]) => AirlockVerdict,
  scope: AirlockGrantScope,
  at: number,
  dryRun: boolean,
): Promise<{ verdict: AirlockVerdict; used: string[] }> {
  const grants: string[] = [];
  let verdict = judge(grants);
  while (verdict.decision === 'needs-human-approval' && !grants.includes(verdict.approvalKey)) {
    const row = await storage.getAirlockApproval(verdict.approvalKey);
    if (!row || approvalStatusOf(row, at) !== 'granted') break;
    grants.push(verdict.approvalKey);
    verdict = judge(grants);
  }
  if (!grants.length || verdict.decision !== 'allow' || dryRun) return { verdict, used: [] };
  // All the grants the call needs, in one transaction, and only in the scope
  // (session and card) that asked for each: lose one (a race, or another
  // session's grant) and none is spent; the call is judged again with none.
  if (await storage.consumeAirlockApprovals(grants, scope, new Date(at).toISOString())) return { verdict, used: grants };
  return { verdict: judge([]), used: [] };
}

export function registerAirlockRoutes(app: any, deps: AirlockRouteDeps): void {
  const stateFile = deps.stateFile ?? defaultAirlockStateFile;
  const now = deps.now ?? Date.now;
  // TEL-3 learning mode (learn.ts): its routes, and the two hooks below that feed it.
  const learning = registerAirlockLearning(app, {
    ...deps, now,
    resolvePolicy: () => resolveAirlockPolicy(deps.storage(), deps.hubJoined()),
    writeStateFile: (view) => tryWriteAirlockStateFile(view as AirlockPolicyView, stateFile()),
    redact: redactTarget,
  });

  // DS-1: full rows for the hub's dataset, only while its switch is on and this installation is joined.
  const datasetOn = (): boolean => !!deps.datasetEnabled?.() && deps.hubJoined();
  const dataset = airlockDataset({
    enabled: datasetOn,
    scope: () => deps.datasetScope?.(),
    send: (event) => deps.recordHubEvent(event as { type: HubEventType; payload: Record<string, unknown> }),
    redactCommand: redactCommandWhole,
    redactText: redactPlainText,
  });
  /** The card a row was for: its title, description and step (null when it cannot be read). */
  const cardOf = async (itemId: string | null | undefined) => {
    if (!itemId) return null;
    try {
      const it: any = await deps.storage().getItem(itemId);
      return it ? { itemId, title: it.title ?? null, description: it.description ?? null, step: it.status ?? null } : { itemId, title: null, description: null, step: null };
    } catch {
      return { itemId, title: null, description: null, step: null };
    }
  };

  /**
   * One decision into the log, to the hub and to the board. The session id
   * stays on this machine; the hub gets the redacted decision, with its source
   * ('tool' | 'proxy') and client, and the policy revision and where that
   * policy came from (policySource).
   *
   * TEL-2: a decision that is an alert (airlockAlertOf) carries its category
   * in `alert`, on the record and so in the hub payload (the hub reads the
   * field; there is no separate hub event), and is raised once on the board
   * as airlock_alert. It is judged on `judgedTarget`, the whole target before
   * redaction and the excerpt cap (a host past the excerpt still alerts); only
   * the category and the redacted record leave this function.
   */
  const logDecision = async (logged: AirlockDecisionRecord, view: AirlockPolicyView, judgedTarget?: string): Promise<void> => {
    const alert = airlockAlertOf({ ...logged, target: judgedTarget ?? logged.target }, view.effective);
    const record: AirlockDecisionRecord = alert ? { ...logged, alert } : logged;
    await deps.storage().recordAirlockDecision(record);
    const { sessionId: _local, ...shared } = record;
    deps.recordHubEvent({ type: 'airlock.decision', payload: { ...shared, revision: view.revision, policySource: view.source } });
    deps.emit('airlock_decision', { decision: record.decision, rule: record.rule, source: record.source });
    if (alert) deps.emit('airlock_alert', shared);
  };

  /**
   * When each proxy decision was last logged, by everything that makes it the
   * same decision. Kept in the order they were logged (a key logged again moves
   * to the end), so the oldest is the first key: at the cap it is evicted in O(1).
   */
  const dedupeCap = deps.proxyLimits?.dedupeCap ?? AIRLOCK_PROXY_DEDUPE_CAP;
  const ratePerMin = deps.proxyLimits?.ratePerMin ?? AIRLOCK_PROXY_RATE_PER_MIN;
  const proxyLastLogged = new Map<string, number>();
  const proxySeenRecently = (key: string, at: number): boolean => {
    const last = proxyLastLogged.get(key);
    if (last !== undefined && at - last < AIRLOCK_PROXY_DEDUPE_MS) return true;
    proxyLastLogged.delete(key);
    proxyLastLogged.set(key, at);
    if (proxyLastLogged.size > dedupeCap) proxyLastLogged.delete(proxyLastLogged.keys().next().value as string);
    return false;
  };
  /** Proxy decisions logged per client in the current minute. */
  const proxyRate = new Map<string, { windowStart: number; count: number }>();
  const proxyRateAllows = (client: string, at: number): boolean => {
    let r = proxyRate.get(client);
    if (!r || at - r.windowStart >= 60_000) { r = { windowStart: at, count: 0 }; proxyRate.set(client, r); }
    if (r.count >= ratePerMin) return false;
    r.count++;
    return true;
  };

  /**
   * A project's effective policy (PO-1). Its repository (pinned, repoPins.ts) is
   * needed only when the policy has repository overrides; a lookup that fails or times out
   * throws AIRLOCK_PROJECT_UNKNOWN rather than reading as "no repository", which
   * would drop the overrides that tighten.
   */
  const projectPolicy = async (policy: AirlockPolicy, projectId: string, opts: { pin?: boolean } = {}): Promise<{ effective: AirlockPolicy; repo: string | null }> => {
    const needsRepo = Object.keys(policy.projects ?? {}).some(k => !k.startsWith('project:'));
    let repo: string | null = null;
    // `pin`: the launcher's and exec's fetch, made before a sandbox runs, looks the
    // repository up (and so pins it) even when no override needs it yet.
    if ((needsRepo || opts.pin) && deps.projectRepoOf) {
      try {
        repo = airlockRepoKey(await deps.projectRepoOf(projectId));
      } catch (e) {
        if (!needsRepo) return { effective: effectivePolicyFor(policy, { repo: null, projectId }), repo: null };
        throw Object.assign(new Error(`The repository of project ${projectId} could not be read (${(e as Error)?.message ?? e}), so its Airlock overrides cannot be told; retry shortly.`), { code: AIRLOCK_PROJECT_UNKNOWN });
      }
    }
    return { effective: effectivePolicyFor(policy, { repo, projectId }), repo };
  };
  const projectUnknown = (e: unknown, res: any): boolean => {
    if ((e as any)?.code !== AIRLOCK_PROJECT_UNKNOWN) return false;
    res.status(503).json({ error: AIRLOCK_PROJECT_UNKNOWN, message: (e as Error).message });
    return true;
  };

  app.get('/airlock/policy', async (req: any, res: any, next: any) => {
    try {
      // `?refresh=1` (or true) pulls the hub's policy now instead of at the next
      // flow-sync tick; a hub that fails leaves what is stored, as the tick does.
      const q = req.query?.refresh;
      const refresh = Array.isArray(q) ? q[q.length - 1] : q;
      if ((refresh === '1' || refresh === 'true') && deps.hubJoined() && deps.refreshFromHub) {
        try { await deps.refreshFromHub(); } catch (e) { console.error('[AIRLOCK] refresh from hub failed:', (e as Error).message); }
      }
      const view = await resolveAirlockPolicy(deps.storage(), deps.hubJoined());
      const p = req.query?.projectId;
      const projectId = typeof p === 'string' && p ? p : null;
      if (!projectId) return res.json(view);
      const { effective, repo } = await projectPolicy(view.effective, projectId, { pin: true });
      res.json({ ...view, effective, project: { id: projectId, repo } });
    } catch (e) { if (!projectUnknown(e, res)) next(e); }
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
      const modelError = modelErrorOf(model);
      if (!model || modelError) return res.status(400).json({ error: modelError });
      const toolName = typeof body.toolName === 'string' ? body.toolName : '';
      const sessionId = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : undefined;

      const capabilities = capabilitiesOf(body.args);
      if (capabilities.length > MAX_AIRLOCK_CAPABILITIES) {
        return res.status(400).json({ error: `a tool call may carry at most ${MAX_AIRLOCK_CAPABILITIES} capabilities (commands, paths, URLs); this one has ${capabilities.length}` });
      }
      const storage = deps.storage();
      const dryRun = body.dryRun === true;
      const view = await resolveAirlockPolicy(storage, deps.hubJoined());
      const work = deps.activeWork(sessionId);
      // A sandboxed call is judged under the project its launch was signed for
      // (the coverage middleware read it from the marker), never a note the
      // agent could choose; any other call, under its active card's project.
      const projectId: string | null = req.airlockSession !== undefined ? (req.airlockProject ?? null) : (work?.projectId ?? null);
      const effective = projectId ? (await projectPolicy(view.effective, projectId)).effective : view.effective;
      const at = now();
      const judge = (grants: string[]) => evaluateAirlock(effective, {
        client: body.client, model, toolName, capabilities,
        card: { itemId: work?.itemId, projectId: projectId ?? undefined, grants },
      });
      const targetOf = (v: { target?: string }) => (v.target && capabilities.find(c => capabilityText(c).includes(v.target!))) || capabilities[0];

      const nowIso = new Date(at).toISOString();
      const scope: AirlockGrantScope = { sessionId: sessionId ?? null, itemId: work?.itemId ?? null };
      const granted = await verdictWithGrants(storage, judge, scope, at, dryRun);
      /** The approval request's generation, when this call opened or re-asked one (DS-1 labels join it). */
      let approvalGeneration: number | null = null;
      let verdict = granted.verdict;
      for (const key of granted.used) {
        deps.recordHubEvent({ type: 'airlock.approval', payload: { action: 'consumed', key, itemId: work?.itemId ?? null } });
      }
      if (granted.used.length) deps.emit('airlock_approvals_changed', { keys: granted.used });
      if (verdict.decision === 'needs-human-approval') {
        const approval = verdict;
        const prior = await storage.getAirlockApproval(approval.approvalKey);
        if (prior?.deniedAt) {
          // A person said no to exactly this: it is denied until someone grants it.
          verdict = {
            decision: 'deny',
            rule: approval.rule,
            reason: `${approval.reason}. Denied on the board by a person (approval ${approval.approvalKey}); it stays denied until someone approves it there.`,
            ...(approval.target !== undefined ? { target: approval.target } : {}),
          };
        } else if (!dryRun) {
          // Every capability the key binds, so the person sees all a grant lets through.
          const raw = approval.capabilities?.length ? approval.capabilities : [targetOf(approval)].filter(Boolean) as Capability[];
          // The row carries every value whole, for the person deciding; the hub an excerpt.
          const bound = approvalCapabilities(raw);
          const excerpts = excerptCapabilities(raw);
          const summary = excerpts.map(c => c.value).join(' · ') || approval.rule;
          const row = await storage.upsertAirlockApproval({
            key: approval.approvalKey,
            rule: approval.rule,
            summary,
            capabilities: bound,
            projectId,
            itemId: work?.itemId ?? null,
            sessionId: sessionId ?? null,
            requestedAt: nowIso,
          }, nowIso);
          approvalGeneration = row.generation ?? null;
          // The hub hears of a request when it (re)opens, not on every retry.
          if (approvalStatusOf(row, at) === 'pending' && (!prior || approvalStatusOf(prior, at) !== 'pending')) {
            deps.recordHubEvent({
              type: 'airlock.approval',
              payload: { action: 'requested', key: approval.approvalKey, rule: approval.rule, summary, capabilities: excerpts, itemId: work?.itemId ?? null, projectId },
            });
          }
          deps.emit('airlock_approvals_changed', { key: approval.approvalKey });
        }
      }
      const applies = !(verdict.decision === 'allow' && (verdict.why === 'mode-off' || verdict.why === 'model-not-selected'));

      const logged = dryRun ? null : loggedVerdict(verdict);
      if (logged) {
        const target = targetOf(logged);
        const record = {
          ts: new Date().toISOString(),
          client: body.client as string,
          model: modelLabel(model),
          tool: toolName.slice(0, 200),
          capabilityKind: target?.kind ?? null,
          target: target ? redactTarget(capabilityText(target)) : null,
          decision: logged.decision,
          rule: logged.rule,
          mode: view.effective.mode,
          itemId: work?.itemId ?? null,
          sessionId: sessionId ?? null,
          source: 'tool' as const,
        };
        await logDecision(record, view, target ? capabilityText(target) : undefined);
      }
      if (!dryRun) await learning.observeTool(capabilities, body.client, work?.itemId ?? null);
      if (!dryRun && datasetOn()) {
        dataset.tool({
          client: body.client, model: modelLabel(model), sessionId: sessionId ?? null, tool: toolName, args: body.args, capabilities,
          verdict: { decision: verdict.decision, rule: 'rule' in verdict ? verdict.rule : null, ...(verdict.decision === 'allow' ? { why: verdict.why } : {}) },
          mode: effective.mode, revision: view.revision, card: await cardOf(work?.itemId),
          ...(verdict.decision === 'needs-human-approval' && approvalGeneration !== null ? { approvalKey: `${verdict.approvalKey}#${approvalGeneration}` } : {}),
        });
      }

      res.json({ verdict: publicVerdict(verdict), mode: view.effective.mode, applies, revision: view.revision, source: view.source });
    } catch (e) { if (!projectUnknown(e, res)) next(e); }
  });

  app.post('/airlock/proxy-decisions', async (req: any, res: any, next: any) => {
    try {
      if (!isLoopback(req.socket?.remoteAddress)) {
        return res.status(403).json({ error: 'Airlock proxy decisions are only accepted from this machine' });
      }
      // Loopback is not enough: the sandboxed agent reaches this port from
      // loopback too. Only the unsandboxed launcher holds the report token (the
      // sandbox cannot read ~/.agenfk/airlock/), so only it can
      // report. Its own header and its own token: verify-token, which the agent
      // can read, is no use here, in either header.
      const token = deps.reportToken?.();
      if (!token || req.headers?.[AIRLOCK_REPORT_HEADER] !== token) {
        return res.status(403).json({ error: 'Airlock proxy decisions are only accepted from the Airlock launcher' });
      }
      const body = req.body ?? {};
      if (!CLIENTS.includes(body.client)) {
        return res.status(400).json({ error: `client must be one of ${CLIENTS.join(', ')}` });
      }
      if (typeof body.sessionId === 'string' && body.sessionId.length > MAX_AIRLOCK_FIELD) {
        return res.status(400).json({ error: `sessionId is longer than ${MAX_AIRLOCK_FIELD} characters` });
      }
      const model = sessionModelOf(body.model);
      const modelError = modelErrorOf(model);
      if (!model || modelError) return res.status(400).json({ error: modelError });
      const list = body.decisions;
      if (!Array.isArray(list)) return res.status(400).json({ error: 'decisions (an array) is required' });
      if (list.length > MAX_PROXY_DECISIONS) {
        return res.status(400).json({ error: `a report may carry at most ${MAX_PROXY_DECISIONS} decisions; this one has ${list.length}` });
      }
      // The envelope is refused whole (above); one entry that does not fit is
      // skipped and counted, so an odd denial does not lose the rest of the batch.
      const valid = (d: any): boolean => !!d && typeof d === 'object'
        && typeof d.host === 'string' && PROXY_HOST.test(d.host)
        && (d.port === null || d.port === undefined || (Number.isInteger(d.port) && d.port >= 0 && d.port <= 65535))
        && (d.decision === 'allow' || d.decision === 'deny')
        && typeof d.rule === 'string' && !!d.rule && d.rule.length <= MAX_AIRLOCK_FIELD;

      const sessionId = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : undefined;
      const view = await resolveAirlockPolicy(deps.storage(), deps.hubJoined());
      const work = deps.activeWork(sessionId);
      const at = now();
      let recorded = 0;
      let skipped = 0;
      let dropped = 0;
      let invalid = 0;
      for (const d of list) {
        if (!valid(d)) {
          invalid++;
          continue;
        }
        const port: number | null = d.port ?? null;
        if (proxySeenRecently(JSON.stringify([body.client, sessionId ?? null, d.host, port, d.decision, d.rule]), at)) {
          skipped++;
          continue;
        }
        if (!proxyRateAllows(body.client, at)) {
          dropped++;
          continue;
        }
        const ts = typeof d.ts === 'string' && !Number.isNaN(Date.parse(d.ts)) ? new Date(d.ts).toISOString() : new Date(at).toISOString();
        await logDecision({
          ts,
          client: body.client as string,
          model: modelLabel(model),
          tool: 'proxy',
          capabilityKind: 'host',
          // A host name can carry data (a secret as a DNS label), so it is redacted like any target.
          target: redactTarget(port === null ? d.host : `${d.host}:${port}`),
          decision: d.decision,
          rule: d.rule,
          mode: view.effective.mode,
          itemId: work?.itemId ?? null,
          sessionId: sessionId ?? null,
          source: 'proxy',
        }, view, port === null ? d.host : `${d.host}:${port}`);
        if (datasetOn()) {
          dataset.proxy({
            client: body.client as string, model: modelLabel(model), sessionId: sessionId ?? null, host: d.host, port,
            decision: d.decision, rule: d.rule, mode: view.effective.mode, revision: view.revision, card: await cardOf(work?.itemId),
          });
        }
        recorded++;
      }
      await learning.observeProxy(list.filter(valid).map((d: any) => d.host), body.client, work?.itemId ?? null);
      res.json({ recorded, skipped, dropped, invalid });
    } catch (e) { next(e); }
  });

  app.get('/airlock/dataset', (_req: any, res: any) => {
    res.json({ joined: deps.hubJoined(), enabled: datasetOn() });
  });

  // DS-3: a person's import of past sessions (agenfk airlock dataset import). Never from a
  // sandbox: an agent must not be able to plant rows in what the scorer learns from.
  app.post('/airlock/dataset/import', async (req: any, res: any, next: any) => {
    try {
      if (!isLoopback(req.socket?.remoteAddress)) return res.status(403).json({ error: 'Imports are only accepted from this machine' });
      if (req.airlockSession !== undefined) {
        return res.status(403).json({ error: 'AIRLOCK_DATASET_FROM_SANDBOX', message: 'An Airlock session cannot import into the dataset: run agenfk airlock dataset import outside the sandbox.' });
      }
      if (!datasetOn()) {
        return res.status(409).json({
          error: 'AIRLOCK_DATASET_OFF',
          message: deps.hubJoined()
            ? "Your organization's hub has the Airlock dataset switched off, so nothing is imported. An org admin switches it on (Admin -> Airlock -> Dataset)."
            : 'This installation is not joined to a hub, so there is no Airlock dataset to import into.',
        });
      }
      const body = req.body ?? {};
      if (!CLIENTS.includes(body.client) || typeof body.sessionId !== 'string' || !body.sessionId || body.sessionId.length > MAX_AIRLOCK_FIELD
        || !Array.isArray(body.calls) || (body.model !== undefined && body.model !== null && typeof body.model !== 'string')) {
        return res.status(400).json({ error: `client (${CLIENTS.join(', ')}), sessionId and calls (an array) are required` });
      }
      if (body.calls.length > AIRLOCK_DATASET_IMPORT_MAX_CALLS) {
        return res.status(413).json({ error: `at most ${AIRLOCK_DATASET_IMPORT_MAX_CALLS} calls a request` });
      }
      const view = await resolveAirlockPolicy(deps.storage(), deps.hubJoined());
      // Each call joins the run of its session that was under way at its time: the latest
      // started at or before it, unless that one had already ended. A session that moved
      // from one card to another does not put its earlier calls on the later card (story
      // review F4); a call before any run, or after the last ended, is on no card.
      const runs = (await deps.storage().listAgentRuns({ sessionId: body.sessionId, limit: 1000 }).catch(() => [] as AgentRun[]))
        .filter(r => Number.isFinite(Date.parse(r.startedAt)))
        .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
      const runAt = (at: number): AgentRun | null => {
        const started = runs.filter(r => Date.parse(r.startedAt) <= at);
        const r = started[started.length - 1];
        return r && !(r.endedAt && Date.parse(r.endedAt) < at) ? r : null;
      };
      const policies = new Map<string | null, Promise<AirlockPolicy>>();
      const policyFor = (projectId: string | null): Promise<AirlockPolicy> => {
        if (!policies.has(projectId)) {
          policies.set(projectId, projectId ? projectPolicy(view.effective, projectId).then(p => p.effective) : Promise.resolve(view.effective));
        }
        return policies.get(projectId)!;
      };
      const cards = new Map<string | undefined, ReturnType<typeof cardOf>>();
      const cardFor = (itemId: string | undefined): ReturnType<typeof cardOf> => {
        if (!cards.has(itemId)) cards.set(itemId, cardOf(itemId));
        return cards.get(itemId)!;
      };
      const model = sessionModelOf(body.model ?? null);
      let sent = 0;
      let skipped = 0;
      for (const c of body.calls) {
        const ok = c && typeof c === 'object' && typeof c.callId === 'string' && c.callId && c.callId.length <= MAX_AIRLOCK_FIELD
          && typeof c.tool === 'string' && c.tool.length <= MAX_AIRLOCK_FIELD && c.args && typeof c.args === 'object' && !Array.isArray(c.args)
          && typeof c.at === 'string' && Number.isFinite(Date.parse(c.at));
        if (!ok) { skipped++; continue; }
        const capabilities = capabilitiesOf(c.args);
        if (capabilities.length > MAX_AIRLOCK_CAPABILITIES) { skipped++; continue; }
        const run = runAt(Date.parse(c.at));
        const projectId = run?.projectId ?? null;
        const effective = await policyFor(projectId);
        const card = await cardFor(run?.itemId);
        // What Airlock would say of it now: the current policy, no grants.
        const verdict = evaluateAirlock(effective, { client: body.client, model: model ?? { provider: null, id: null }, toolName: c.tool, capabilities, card: { itemId: run?.itemId, projectId: projectId ?? undefined, grants: [] } });
        const rowId = dataset.imported({
          client: body.client, model: model ? modelLabel(model) : null, sessionId: body.sessionId, callId: c.callId, tool: c.tool, args: c.args,
          at: new Date(c.at).toISOString(), capabilities,
          verdict: { decision: verdict.decision, rule: 'rule' in verdict ? verdict.rule : null, ...(verdict.decision === 'allow' ? { why: verdict.why } : {}) },
          mode: effective.mode, revision: view.revision, card,
        });
        if (rowId) sent++; else skipped++;
      }
      res.json({ sent, skipped });
    } catch (e) { if (!projectUnknown(e, res)) next(e); }
  });

  app.get('/airlock/decisions', async (req: any, res: any, next: any) => {
    try {
      const q = req.query ?? {};
      const limit = Number(q.limit);
      const query: AirlockDecisionQuery = Number.isFinite(limit) && limit > 0 ? { limit } : {};
      // A filter is one value it knows; anything else is refused, not read as "no filter".
      const one = (k: string): string | undefined | null =>
        q[k] === undefined ? undefined : typeof q[k] === 'string' && q[k].length <= MAX_AIRLOCK_FIELD ? q[k] : null;
      const itemId = one('itemId');
      const client = one('client');
      const source = one('source');
      const alert = one('alert');
      if (itemId === null) return res.status(400).json({ error: `itemId must be one card id of at most ${MAX_AIRLOCK_FIELD} characters` });
      if (client === null || (client !== undefined && !CLIENTS.includes(client as AirlockClient))) {
        return res.status(400).json({ error: `client must be one of ${CLIENTS.join(', ')}` });
      }
      if (source === null || (source !== undefined && source !== 'tool' && source !== 'proxy')) {
        return res.status(400).json({ error: 'source must be one of tool, proxy' });
      }
      if (alert === null || (alert !== undefined && alert !== 'any' && !AIRLOCK_ALERTS.includes(alert as AirlockAlert))) {
        return res.status(400).json({ error: `alert must be one of any, ${AIRLOCK_ALERTS.join(', ')}` });
      }
      if (itemId !== undefined) query.itemId = itemId;
      if (client !== undefined) query.client = client;
      if (source !== undefined) query.source = source as 'tool' | 'proxy';
      if (alert !== undefined) query.alert = alert as AirlockAlert | 'any';
      res.json({ decisions: await deps.storage().listAirlockDecisions(query) });
    } catch (e) { next(e); }
  });

  app.get('/airlock/approvals', async (_req: any, res: any, next: any) => {
    try {
      const at = now();
      const rows = (await deps.storage().listAirlockApprovals()).map(r => ({ ...r, status: approvalStatusOf(r, at) }));
      res.json({
        pending: rows.filter(r => r.status === 'pending'),
        recent: rows.filter(r => r.status !== 'pending' && r.status !== 'denied').slice(0, RECENT_APPROVALS),
        // Denials hold until someone grants them, so every one stays reachable: all of them, uncapped.
        denied: rows.filter(r => r.status === 'denied'),
      });
    } catch (e) { next(e); }
  });

  const answer = (action: 'grant' | 'deny') => async (req: any, res: any, next: any) => {
    try {
      if (refuseUnlessBoard(req, res)) return;
      const key = String(req.params.key ?? '');
      if (!key || key.length > MAX_AIRLOCK_FIELD) return res.status(400).json({ error: 'an approval key is required' });
      const generation = req.body?.generation;
      if (typeof generation !== 'number' || !Number.isInteger(generation) || generation < 1) {
        return res.status(400).json({ error: 'generation (the request generation this answer is for, from GET /airlock/approvals) is required' });
      }
      const storage = deps.storage();
      const by = os.userInfo().username;
      if (action === 'grant') {
        const current = await storage.getAirlockApproval(key);
        if (current?.capabilities?.some(c => c.concealed === true)) {
          return res.status(409).json({
            error: 'AIRLOCK_APPROVAL_CONCEALED',
            message: 'This request cannot be approved: redaction would hide code that runs (a secret-looking value holds $(…), backticks, <(…) or a command separator). Deny it, or have the agent pass the secret without running anything inside it.',
          });
        }
        if (current?.capabilities?.some(c => c.complete === false)) {
          return res.status(409).json({
            error: 'AIRLOCK_APPROVAL_INCOMPLETE',
            message: `This request could not be shown in full (a value is longer than ${MAX_APPROVAL_VALUE} characters), so it cannot be approved: nobody can approve what they could not read. Deny it, or have the agent split the call.`,
          });
        }
      }
      const row = action === 'grant'
        ? await storage.grantAirlockApproval(key, { grantedBy: by, authority: 'board', expiresAt: new Date(now() + AIRLOCK_GRANT_TTL_MS).toISOString(), generation })
        : await storage.denyAirlockApproval(key, { deniedBy: by, generation }, new Date(now()).toISOString());
      if (!row) return res.status(404).json({ error: `No Airlock approval request has the key ${key}` });
      const { transition, ...approval } = row;
      const status = approvalStatusOf(approval, now());
      const landed = action === 'grant' ? status === 'granted' : status === 'denied';
      if (transition === 'refused' || !landed) {
        return res.status(409).json({
          error: 'AIRLOCK_APPROVAL_NOT_OPEN',
          message: `That answer is for a request that is no longer open (it is ${status}, generation ${approval.generation}). Reload the list.`,
          approval: { ...approval, status },
        });
      }
      if (transition === 'changed') {
        deps.recordHubEvent({
          type: 'airlock.approval',
          payload: { action: action === 'grant' ? 'granted' : 'denied', key, rule: approval.rule, generation: approval.generation, itemId: approval.itemId ?? null, projectId: approval.projectId ?? null, expiresAt: approval.expiresAt },
        });
        deps.emit('airlock_approvals_changed', { key });
        // DS-1: the person's answer, as a label on the dataset rows of the request they
        // answered: the generation they named (the answer itself moves the row's on).
        dataset.answered(`${key}#${generation}`, action);
      }
      res.json({ approval: { ...approval, status } });
    } catch (e) { next(e); }
  };
  app.post('/airlock/approvals/:key/grant', answer('grant'));
  app.post('/airlock/approvals/:key/deny', answer('deny'));
}
