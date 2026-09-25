import { StringDecoder } from 'string_decoder';
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { SQLiteStorageProvider } from "@agenfk/storage-sqlite";
import { commitStagedForCard, resolveCommitRoot } from './closeCommit';
import { mayPropagate, readCleanTreeSha, readHead, readTreeStatus } from './propagation';
import { insideRoot, parseJunitXml, parseVitestJson, surfaceOf } from './stepRecords';
import { parseActor, parseFindings, readTranscriptIdentity } from './reviewRecords';
import * as passkeys from './passkeys';
import { argvHash, awaitsPersonApproval, judgeCommandChecks, type CommandApproval } from './commandChecks';
import { suggestTestReport } from './testReportHint';
import { countedApproval, evaluateChecks, judgeReview, formatCheckResults, needsCapture, needsEntryRecord, parseAgentReports, type AgentReport, type CheckResult } from './checkEngine';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { StorageProvider, ItemType, buildBranchName, Status, AgEnFKItem, Project, ReviewRecord, migrateCardsToFlow, Flow, DEFAULT_FLOW, getActiveFlow, getActiveStepItems, isBoundaryStep, computeSizingFromItems, SizingCounts, normalizeFlowSteps, DEFAULT_APP_SETTINGS, isLegalSettingValue, type AppSettings, TERMINAL_AGENT_IDS, isPersistableProjectRoot, parseGitStatus, isInsideRoot, containedPath, resolveThroughLinks, EXPENSIVE_ROUTE_LIMIT, EXPENSIVE_ROUTE_WINDOW_MS, planPrImport, isValidPrNumber, isWellFormedClaim, gateOnClaims, claimTreeOf, sameClaimTree, strayStaged, claimlessNeighbours, leavingEndsFlow, type ClaimHolder, canTransition, isTerminal, recordFailure, stillHolds, isHubRelease, type DispatchState, flowChecksErrors, mergeStepContracts, resolveStepChecks, describeFlowContract, stepContractFields, wouldStripContracts, STRIPPED_PUBLISH_MESSAGE, registryInstallSteps, commitOnLeaveNote, stepCommitsOnLeave, verifyAtError, flowVerifyAt, INACTIVE_STATUSES } from "@agenfk/core";
import { TelemetryClient, getInstallationId, isTelemetryEnabled, setTelemetryEnabled, getInstallSource, findAvailablePort, writeServerPortFile, removeServerPortFile, DEFAULT_API_PORT } from "@agenfk/telemetry";
import { HubClient, Flusher, loadHubConfig, PENDING_ORG } from "./hub/index.js";
import type { RecordEventInput } from "./hub/index.js";
import { startFlowSync, type FlowSyncHandle } from "./hub/flowSync.js";
import { refreshProjectFlowFromHub } from "./hub/flowRefresh.js";
import { startRunTailer } from "./agent-runs/tailer.js";
import { createWorktree, removeWorktree } from "./worktrees.js";
import { applySetupResult, SETUP_TIMEOUT_MS, type SetupDecision, type SetupRun } from "./worktreeSetup.js";
import { readGitHubAccount, signOutGitHub } from "./githubAccount.js";
import { createOutputCapture, formatBytes, type CapturedOutput } from "./verifyCapture.js";
import { startUpgradeSync, replayPendingUpgradeOutcome, type UpgradeSyncHandle } from "./hub/upgradeSync.js";
import { startRepointSync, type RepointSyncHandle } from "./hub/repointSync.js";
import { spawnSync } from 'child_process';
import { v4 as uuidv4 } from "uuid";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as crypto from "crypto";
import axios from "axios";

// Load the install-time secret token used to authenticate verify_changes transitions.
// Generated at install time and stored in ~/.agenfk/verify-token — not in the codebase.
export const VERIFY_TOKEN = (() => {
  const tokenPath = path.join(os.homedir(), '.agenfk', 'verify-token');
  try {
    return fs.readFileSync(tokenPath, 'utf8').trim();
  } catch {
    const ephemeral = crypto.randomBytes(32).toString('hex');
    console.warn(`[SERVER_START] Warning: ~/.agenfk/verify-token not found. Run npm run install:framework to generate it. Using ephemeral token for this session.`);
    return ephemeral;
  }
})();
import { exec, execFile, execSync, execFileSync, spawn } from "child_process";
import { createServer } from "http";
import { Server } from "socket.io";
import { readGitStatus } from './gitStatus.js';
import { openHubJiraSession, fetchHubJiraStatus, clearHubJiraStatusCache, startHubJiraOAuth, completeHubJiraOAuth, disconnectHubJira, ASK_HUB_ADMIN, CONNECT_FROM_BOARD, type JiraSession, type HubTarget } from './jira/hubJira.js';

// The local API server is for this machine only. It binds to loopback by
// default (override with AGENFK_HOST) and only accepts browser requests from
// localhost origins, so unauthenticated routes are neither LAN-reachable nor
// drivable by a malicious page on another origin. (Security: bug 55229bae.)
export const BIND_HOST = process.env.AGENFK_HOST || "127.0.0.1";

// Allow requests with no Origin header (CLI, curl, same-origin, server-to-
// server) and any loopback origin on any port (the UI dev server, previews).
// Everything else is rejected — no wildcard.
const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
export const isAllowedOrigin = (origin: string | undefined | null): boolean =>
  !origin || LOCAL_ORIGIN_RE.test(origin);
const corsOriginFn = (
  origin: string | undefined,
  cb: (err: Error | null, allow?: boolean) => void,
): void => cb(null, isAllowedOrigin(origin));

export const app = express();
export const httpServer = createServer(app);
export const io = new Server(httpServer, {
  cors: {
    origin: corsOriginFn,
    methods: ["GET", "POST"]
  }
});
// Requested base port. The server probes upward from here for the first free
// port (mirrors Vite's default behaviour) and persists the bound port to
// ~/.agenfk/server-port so other components (CLI, MCP, scripts) can discover it.
const REQUESTED_PORT = Number.parseInt(
  String(process.env.AGENFK_PORT || process.env.PORT || DEFAULT_API_PORT),
  10,
);

// Directory of the built UI bundle this server is also serving, or null when
// the UI is somebody else's job (the `agenfk up` flow, where `vite preview`
// owns port 5173). Set by mountStaticUI() at the bottom of the route table.
let servedUiDir: string | null = null;
/** The port this server listens on, once bound. */
let boundPort: number | null = null;

// Does this caller want a page or data? A browser navigating to a URL asks for
// html; the CLI, `agenfk health` and curl land on json. Both the "/" banner and
// the SPA fallback branch on this, so they must agree on the answer.
const wantsHtml = (req: express.Request): boolean =>
  req.accepts(["json", "html"]) === "html";

app.use(cors({
  origin: corsOriginFn,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-agenfk-internal", "x-agenfk-ui"]
}));
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

// Initialised dynamically in initStorage() based on dbPath file extension.
let storage: StorageProvider;
let dbPath: string = "";

// Anonymous usage telemetry — no-op when AGENFK_POSTHOG_KEY is unset or opted out.
const telemetry = new TelemetryClient();

// Corporate Hub sender — dormant when ~/.agenfk/hub.json is absent. Storage is
// attached after initStorage(); flusher is started at boot if configured.
const hubClient = new HubClient(getInstallationId(), loadHubConfig());
let hubFlusher: Flusher | null = null;
let flowSyncHandle: FlowSyncHandle | null = null;
// Per-project ETag cache for hub flow reconciles. Shared between the polling
// reconciler (startFlowSync) and on-demand refreshes (GET .../flow?refresh=true)
// so the two never re-fetch the same unchanged flow.
const flowSyncEtagCache = new Map<string, string>();
let upgradeSyncHandle: UpgradeSyncHandle | null = null;
let repointSyncHandle: RepointSyncHandle | null = null;

// recordHubEvent is a thin wrapper kept at module scope so the many existing
// io.emit('items_updated', ...) sites can be augmented with one line.
//
// The wrapper enriches each event with cross-cutting fields:
// - itemType: lifted from the payload when present so the hub can index it.
// - remoteUrl: resolved from the project's git origin via projectRemoteCache.
//   On cache miss the function AWAITS warmProjectRemote so the FIRST event for
//   any project still ships with its remoteUrl populated. (Bug 0bc7669b: the
//   prior implementation did fire-and-forget warming, leaving the first event
//   for every project with remoteUrl=null.)
// - itemTitle / externalId: same lazy-cache pattern via itemMetaCache.
//
// Returns a Promise so internal awaits work; existing call sites that ignore
// the return value remain correct because hubClient.recordEvent itself only
// enqueues into the local outbox (the flusher delivers asynchronously).
const recordHubEvent = async (input: RecordEventInput): Promise<void> => {
  // No isEnabled gate (CGLAB-11): while the hub is disconnected, events are
  // queued to the local outbox with a pending orgId and stamped at the first
  // boot with a config — dropping them here made pre-login history (incl.
  // pr.opened) unrecoverable.
  let payload: any = { ...(input.payload ?? {}) };
  if (input.projectId) {
    payload = {
      ...payload,
      flow: { name: await resolveFlowName(input.projectId), install_source: getInstallSource() },
    };
  }
  const itemType = (input as any).itemType ?? (typeof payload.itemType === 'string' ? payload.itemType : null);
  const payloadTitle = typeof payload.title === 'string' ? payload.title : undefined;
  const payloadExternalId = typeof payload.externalId === 'string' ? payload.externalId : undefined;

  let remoteUrl: string | null = (input as any).remoteUrl ?? null;
  if (!remoteUrl && input.projectId) {
    if (!projectRemoteCache.has(input.projectId)) {
      // First event for this project — wait for the git lookup so we don't
      // ship a null remoteUrl. Subsequent events hit the cache and skip this.
      await warmProjectRemote(input.projectId);
    }
    const cached = projectRemoteCache.get(input.projectId);
    remoteUrl = cached && cached.length > 0 ? cached : null;
  }

  let itemTitle: string | null = (input as any).itemTitle ?? payloadTitle ?? null;
  let externalId: string | null = (input as any).externalId ?? payloadExternalId ?? null;
  if (input.itemId) {
    const cached = itemMetaCache.get(input.itemId);
    if (cached) {
      itemTitle = itemTitle ?? cached.title ?? null;
      externalId = externalId ?? cached.externalId ?? null;
    } else {
      warmItemMeta(input.itemId).catch(() => { /* best-effort */ });
    }
    // Prime the cache when this very event already carries the metadata, so
    // subsequent events for the same item don't need a storage round-trip.
    if (itemTitle || externalId) {
      itemMetaCache.set(input.itemId, {
        title: itemTitle ?? cached?.title ?? null,
        externalId: externalId ?? cached?.externalId ?? null,
      });
    }
  }

  hubClient.recordEvent({ ...input, payload, itemType, remoteUrl, itemTitle, externalId } as RecordEventInput);
};

// projectId → git remote URL ("" when no remote, null when not yet resolved).
const projectRemoteCache = new Map<string, string | null>();

// itemId → { title, externalId }. Best-effort cache, populated lazily by
// warmItemMeta() and primed inline by recordHubEvent when an event arrives
// already carrying the metadata.
const itemMetaCache = new Map<string, { title: string | null; externalId: string | null }>();
async function resolveFlowName(projectId: string | undefined): Promise<string> {
  if (!projectId) return DEFAULT_FLOW.name;
  try {
    const project = await storage.getProject(projectId);
    const flowId = project ? (project as any).flowId : null;
    if (!flowId) return DEFAULT_FLOW.name;
    const flow = await storage.getFlow(flowId);
    return flow?.name ?? DEFAULT_FLOW.name;
  } catch {
    return DEFAULT_FLOW.name;
  }
}

async function warmItemMeta(itemId: string): Promise<void> {
  try {
    const it = await storage.getItem(itemId);
    if (!it) { itemMetaCache.set(itemId, { title: null, externalId: null }); return; }
    itemMetaCache.set(itemId, {
      title: typeof (it as any).title === 'string' ? (it as any).title : null,
      externalId: typeof (it as any).externalId === 'string' ? (it as any).externalId : null,
    });
  } catch {
    itemMetaCache.set(itemId, { title: null, externalId: null });
  }
}

async function warmProjectRemote(projectId: string): Promise<void> {
  try {
    const proj = await storage.getProject(projectId);
    const root = (proj as any)?.projectRoot;
    if (!root) { projectRemoteCache.set(projectId, ''); return; }
    const { execFile } = await import('child_process');
    // Async execFile (not execSync): this runs on the request path AND per
    // project in the flow-sync poller loop; a synchronous git hang (network
    // mount, credential prompt) would block the whole Node event loop. execFile
    // keeps it off-thread; the 1.5s timeout + closed stdin bound the wait.
    const out = await new Promise<string>((resolve) => {
      execFile('git', ['remote', 'get-url', 'origin'], { cwd: root, timeout: 1500 }, (err, stdout) => {
        resolve(err ? '' : (stdout || '').toString().trim());
      });
    });
    projectRemoteCache.set(projectId, out || '');
  } catch {
    projectRemoteCache.set(projectId, '');
  }
}

// Resolve a project's raw git remote URL for the repo-keyed hub queries,
// warming the cache on a miss. Returns null when the project has no remote
// (empty cache sentinel) so callers fall back to the legacy projectId key.
async function resolveProjectRepo(projectId: string): Promise<string | null> {
  if (!projectRemoteCache.has(projectId)) {
    await warmProjectRemote(projectId);
  }
  const cached = projectRemoteCache.get(projectId);
  return cached && cached.length > 0 ? cached : null;
}

// ── Validation log persistence ───────────────────────────────────────────────
// Full command output from validate_progress is written to
// <tmpdir>/agenfk-verify-<uid>/<itemId>/<testId>.log. The HTTP response,
// comment, and tests[] record carry only a head+tail truncated preview plus the
// log file path, so MCP payloads stay small while full logs remain available.
//
// The temp dir, not <dbDir>/logs: the old home was ~/.agenfk-system/.agenfk/logs
// on a system install — buried, and named only in a trailer, which made a
// failing verifyCommand harder to diagnose than the failure was (BUG b233143b).
const MAX_LOGS_PER_ITEM = 3;
const PREVIEW_HEAD_BYTES = 1024;
const PREVIEW_TAIL_BYTES = 1024;
// How much raw output a failure message repeats. A test suite prints its verdict
// at the END, so this is a tail, not a head.
const FAILURE_TAIL_LINES = 25;
// …and the tail is capped in BYTES too. A command that reports progress with a
// bare \r (curl, wget, pip, docker pull, gh's spinner, test runners under the
// FORCE_COLOR=1 this spawn sets) produces output that a \n-only splitter sees as
// ONE line, so a line count alone was no bound at all: 500 KB of download
// progress went straight into the message, which is the field an agent reads and
// the one that is not byte-capped the way `output` is.
const FAILURE_TAIL_BYTES = 4096;
// After a cap-kill, how long to wait for stdio to drain before answering anyway.
const KILL_GRACE_MS = 5000;

/**
 * Item ids are server-generated uuids. Anything else must never reach a path
 * segment: `../..` in an id would put log writes and the prune-by-mtime unlink
 * outside the logs directory entirely.
 */
const SAFE_ITEM_ID = /^[A-Za-z0-9._-]{1,128}$/;
function assertSafeItemId(itemId: string): string {
  // Returns the MATCH, not the argument. The value that reaches a path is then
  // one the matcher produced rather than one that merely survived a test — the
  // pattern admits no separator, no dot-dot and no absolute prefix, and it is
  // worth being explicit about that because a recursive rmSync downstream is
  // keyed off this value.
  const matched = SAFE_ITEM_ID.exec(String(itemId ?? ''))?.[0];
  if (!matched || matched === '.' || matched === '..') {
    throw new Error(`Refusing to use '${itemId}' as a log path segment: not a valid item id.`);
  }
  return matched;
}

/**
 * Test seam only — redirects the log root so a suite does not share the
 * machine-global default with a live agenfk server running on the same box.
 *
 * Deliberately a function and not an environment variable: an env override puts
 * an unvalidated, operator-supplied path into the source of every log write,
 * which is a wider surface than the tests need. There is no supported way for a
 * deployment to relocate these logs.
 */
let verifyLogRootOverride = '';
export function setVerifyLogRootForTests(dir: string | null): void {
  verifyLogRootOverride = dir ?? '';
}

/**
 * Root for validation logs. Per-uid because os.tmpdir() is world-writable and
 * verify output routinely echoes environment — tokens, connection strings, the
 * occasional pasted credential. Exported so tests assert against the real path
 * instead of re-implementing the naming and drifting from it.
 *
 * The default name is stable and predictable, shared by every agenfk server this
 * uid runs; on a machine dogfooding agenfk a live server is writing here while
 * tests run, so suites redirect via setVerifyLogRootForTests().
 */
export function getVerifyLogRoot(): string {
  if (verifyLogRootOverride) return verifyLogRootOverride;
  const uid = typeof process.getuid === 'function' ? `-${process.getuid()}` : '';
  return path.join(os.tmpdir(), `agenfk-verify${uid}`);
}

/** Why the log root was refused, surfaced in the message and the server log. */
let logRootRefusal = '';
let logRootRefusalLogged = false;

function refuseVerifyLogRoot(root: string, reason: string): null {
  logRootRefusal = `${root} (${reason})`;
  if (!logRootRefusalLogged) {
    logRootRefusalLogged = true;
    console.warn(`[verify] validation logs disabled — log root refused: ${logRootRefusal}`);
  }
  return null;
}

/**
 * The temp root, created if needed — or null when it must not be used.
 *
 * Three separate hazards, all because the path is predictable and the directory
 * is world-writable:
 *
 * 1. `mkdirSync(recursive)` is a no-op when the path already exists — including
 *    one another user created, which would put our logs in their directory.
 * 2. Worse, it is also a no-op for a SYMLINK, and `statSync` follows symlinks: an
 *    attacker who plants `agenfk-verify-<uid> -> /somewhere/they/chose` passes a
 *    uid check that is answering "is the thing at the other end mine?" instead of
 *    "is this a real directory I own?". So the ENTRY is checked with lstat.
 * 3. A local user can pre-create the path as their own to switch logging off
 *    permanently for this uid. That cannot be prevented on a shared /tmp without
 *    an unpredictable name, so the refusal is at least made LOUD — a silent
 *    "couldn't write a log" is the same class of failure this module exists to
 *    fix. (Windows has no getuid; %TEMP% is already per-user there.)
 */
function ensureVerifyLogRoot(): string | null {
  const root = getVerifyLogRoot();
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(root);
    if (!st.isDirectory()) return refuseVerifyLogRoot(root, 'not a directory');
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
      return refuseVerifyLogRoot(root, `owned by uid ${st.uid}, not ${process.getuid()}`);
    }
    return root;
  } catch (err: any) {
    return refuseVerifyLogRoot(root, err?.code || 'unusable');
  }
}

const getItemLogDir = (itemId: string): string =>
  path.join(getVerifyLogRoot(), assertSafeItemId(itemId));

/**
 * Open the log BEFORE the command runs, so its output can be streamed straight
 * to disk instead of accumulated in memory (BUG 24c679df). Returns the fd and
 * the path, or null when no log can be written safely — which must cost the
 * diagnostics, never the run.
 *
 * Same guarantees the whole-string writer it replaced had: 'wx' so the 0600 mode is real (writeFileSync applies `mode` only when
 * it CREATES the file, and follows symlinks, so without the exclusive flag a
 * pre-planted name would be overwritten with someone else's permissions), and
 * assertSafeItemId so nothing but a server-minted id reaches a path segment.
 */
const openValidationLog = (itemId: string, testId: string): { fd: number; logPath: string } | null => {
  const root = ensureVerifyLogRoot();
  if (!root) return null;
  try {
    const dir = path.join(root, assertSafeItemId(itemId));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const logPath = path.join(dir, `${testId}.log`);
    const fd = fs.openSync(logPath, 'wx', 0o600);
    return { fd, logPath };
  } catch {
    return null;
  }
};

/**
 * Post-run housekeeping for the streamed log. The fd is NOT closed here — the
 * capture owns it and closes it in end(), so that write-eligibility and fd
 * ownership cannot drift apart while an orphaned grandchild is still printing.
 *
 * Returns null when the file is gone, which on this path means the item was
 * deleted mid-run and purgeItemLogs took the directory with it.
 */
const closeValidationLog = (handle: { fd: number; logPath: string } | null): string | null => {
  if (!handle) return null;
  try { pruneItemLogDir(path.dirname(handle.logPath), path.basename(handle.logPath)); } catch { /* advisory */ }
  return fs.existsSync(handle.logPath) ? handle.logPath : null;
};

/**
 * Post-write housekeeping, deliberately unable to invalidate the write it
 * follows. Two hazards it avoids: the prune ranks by mtime and a coarse or
 * backdated clock can tie — with readdir order being filesystem hash order, the
 * file just written can land in the evicted slice, and the response then names a
 * path the server deleted microseconds after promising it. And a concurrent
 * DELETE (or an OS tmp-cleaner) can make statSync throw mid-prune, which used to
 * abort the whole write path and report the log as unwritable.
 */
function pruneItemLogDir(dir: string, keep: string): void {
  try {
    const entries = fs.readdirSync(dir).flatMap((name) => {
      try {
        return [{ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }];
      } catch {
        return []; // vanished since readdir — skip it, do not abort
      }
    });
    // MAX_LOGS_PER_ITEM counts files IN TOTAL, not 'old files besides the one
    // just written' — so the budget for everything else is MAX - 1. Getting this
    // wrong quietly grew the rolling window to 4 and a pre-existing test caught
    // it: the promised file is protected, but the cap must still hold.
    const evict = entries
      .filter((e) => e.name !== keep)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(Math.max(0, MAX_LOGS_PER_ITEM - 1));
    for (const old of evict) {
      try { fs.unlinkSync(path.join(dir, old.name)); } catch { /* ignore */ }
    }
  } catch { /* pruning is advisory */ }
}

/**
 * The message shown when there is no log to point at. Names the reason, because
 * "we couldn't write a log" with no cause is indistinguishable from a bug in the
 * logging code, and the operator has no way to learn that a foreign-owned
 * directory is the actual answer.
 */
const logUnavailable = (): string =>
  logRootRefusal
    ? `Full log: unavailable — log root refused: ${logRootRefusal}`
    : 'Full log: unavailable — the temp directory could not be written';

/**
 * What became of the full log, in one clause — named once so the preview and
 * the failure message cannot disagree. A ceiling, a failed write and a deleted
 * item are three different problems with three different fixes, and reporting
 * them all as the ceiling sends the operator to tune an env var that is not it.
 */
const describeLog = (captured: CapturedOutput, logPath: string | null, vanished = false): string => {
  // A log that was written and then disappeared is not a log that could not be
  // written. On this path it means the item was deleted mid-run and
  // purgeItemLogs took the directory with it — telling the operator the temp
  // directory is unwritable would send them hunting a problem they do not have.
  if (vanished) return 'Full log: gone — the item was deleted while the command ran';
  if (!logPath) return logUnavailable();
  if (captured.logWriteError) return `Full log: ${logPath} (INCOMPLETE — writing it failed: ${captured.logWriteError})`;
  if (captured.logTruncated) return `Full log: ${logPath} (truncated at the AGENFK_VERIFY_MAX_LOG_BYTES ceiling)`;
  return `Full log: ${logPath}`;
};

/**
 * Head + tail of the output, from the BOUNDED buffers the capture kept — never
 * from the whole stream, which is no longer held anywhere (BUG 24c679df).
 * `totalBytes` is the true size, so "the last 1KB of 900MB" cannot read the
 * same as "all of it".
 */
const buildOutputPreview = (captured: CapturedOutput, logPath: string | null, vanished = false): string => {
  const headTailBudget = PREVIEW_HEAD_BYTES + PREVIEW_TAIL_BYTES;
  let body: string;
  // headIsComplete, not a byte count: the budgets are enforced in UTF-16 code
  // units while totalBytes counts bytes, so for multi-byte output the head can
  // already hold everything while totalBytes says otherwise — and the stitched
  // form then duplicates the whole output and claims it truncated something.
  if (captured.headIsComplete && captured.head.length <= headTailBudget) {
    body = captured.head;
  } else {
    const head = captured.head.substring(0, PREVIEW_HEAD_BYTES);
    const tail = captured.tail.substring(Math.max(0, captured.tail.length - PREVIEW_TAIL_BYTES));
    const omitted = Math.max(0, captured.totalBytes - Buffer.byteLength(head) - Buffer.byteLength(tail));
    body = `${head}\n... (${omitted} bytes truncated of ${formatBytes(captured.totalBytes)} total) ...\n${tail}`;
  }
  return `${body}\n[${describeLog(captured, logPath, vanished)}]`;
};

/** ANSI escape sequences, stripped so the repeated tail is readable text. */
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/**
 * Last N non-blank lines — what a failing verifier actually wanted to see.
 *
 * Splits on bare \r as well as \n: progress-reporting tools rewrite one line
 * with \r and never emit \n, and to a \n-only splitter the entire run is a
 * single "line", so the line cap would hand back everything. Byte-capped after
 * that, because a line count is not a size bound.
 */
const tailLines = (output: string, n: number): string => {
  const lines = output.split(/\r\n|\r|\n/).filter((l) => l.trim() !== '');
  const tail = lines.slice(-n).join('\n').replace(ANSI_RE, '');
  return tail.length > FAILURE_TAIL_BYTES
    ? `… (tail truncated) …\n${tail.slice(-FAILURE_TAIL_BYTES)}`
    : tail;
};

/**
 * What happened to the command, in one clause. Deliberately dumb: the exit code
 * is reported as the number it returned, with no attempt to interpret the
 * output. A guessed summary is worse than none — the full log path is always
 * given alongside it.
 */
const describeExit = (
  r: { code: number | null; timedOut?: boolean; signal?: NodeJS.Signals | null; spawnError?: string },
  maxMs: number,
): string => {
  if (r.timedOut) {
    return `killed after the ${Math.round(maxMs / 60000)}min runtime cap (exit code 124)`;
  }
  if (r.spawnError) {
    // Not "exit code 1": a command that never started is a different diagnosis
    // from one that ran and failed.
    return `could not be started: ${r.spawnError}`;
  }
  if (r.code === null) {
    // An OOM-kill is common enough on constrained machines that reporting
    // "exit code null" — which is what a signal death looks like — would be the
    // single most confusing thing this message could say.
    return r.signal ? `killed by signal ${r.signal}, no exit code` : 'terminated without an exit code';
  }
  return `exit code ${r.code}`;
};

/** Hard cap on a verifyCommand's runtime; see its use in the validate route. */
const verifyMaxMs = (): number =>
  Number(process.env.AGENFK_VERIFY_MAX_MS) > 0 ? Number(process.env.AGENFK_VERIFY_MAX_MS) : 60 * 60 * 1000;

const purgeItemLogs = (itemId: string): void => {
  try {
    const dir = getItemLogDir(itemId);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // Advisory. Thrown, this ran after the parent was already marked TRASHED and
    // before the children were walked — a malformed legacy id would answer
    // DELETE /items/:id with a 500 and leave the tree half-trashed.
  }
};

// ── Backup ───────────────────────────────────────────────────────────────────

function backupDir(): string { return path.join(os.homedir(), '.agenfk', 'backup'); }
const MAX_BACKUPS = 10;

const performBackup = async (): Promise<string> => {
  if (!fs.existsSync(backupDir())) fs.mkdirSync(backupDir(), { recursive: true });

  const [projects, items] = await Promise.all([
    storage.listProjects(),
    storage.listItems({ limit: 1_000_000 }),  // all items including archived
  ]);

  const timestamp = new Date().toISOString().replace(/:/g, '-');
  const dbType = 'sqlite';
  const backupFile = path.join(backupDir(), `agenfk-backup-${timestamp}.json`);

  fs.writeFileSync(backupFile, JSON.stringify({ version: '1', backupDate: new Date().toISOString(), dbType, projects, items }, null, 2));

  // Rotate — keep only the MAX_BACKUPS most recent files
  const existing = fs.readdirSync(backupDir())
    .filter(f => f.startsWith('agenfk-backup-') && f.endsWith('.json'))
    .sort();
  for (const old of existing.slice(0, Math.max(0, existing.length - MAX_BACKUPS))) {
    fs.unlinkSync(path.join(backupDir(), old));
  }

  console.log(`[BACKUP] Written: ${backupFile}`);
  return backupFile;
};

// ── Archive / unarchive helpers ──────────────────────────────────────────────

const archiveRecursively = async (id: string) => {
  const item = await storage.getItem(id);
  if (!item || item.status === Status.ARCHIVED) return;

  console.log(`[AUTO_ARCHIVE] Archiving ${item.id} (${item.title})`);
  await storage.updateItem(id, {
    previousStatus: item.status,
    status: Status.ARCHIVED
  });

  const children = await storage.listItems({ parentId: id });
  for (const child of children) {
    await archiveRecursively(child.id);
  }
};

const unarchiveRecursively = async (id: string) => {
  const item = await storage.getItem(id);
  if (!item || item.status !== Status.ARCHIVED) return;

  const targetStatus = item.previousStatus || Status.TODO;
  console.log(`[AUTO_UNARCHIVE] Restoring ${item.id} (${item.title}) to ${targetStatus}`);
  await storage.updateItem(id, {
    status: targetStatus,
    previousStatus: undefined
  });

  const children = await storage.listItems({ parentId: id });
  for (const child of children) {
    if (child.status === Status.ARCHIVED) {
      await unarchiveRecursively(child.id);
    }
  }
};

const trashRecursively = async (id: string): Promise<boolean> => {
  const item = await storage.getItem(id);
  if (!item || item.status === Status.TRASHED) return false;

  console.log(`[AUTO_TRASH] Trashing ${item.id} (${item.title}) and its children`);

  await storage.updateItem(id, { status: Status.TRASHED });
  purgeItemLogs(id);

  const children = await storage.listItems({ parentId: id });
  for (const child of children) {
    await trashRecursively(child.id);
  }

  return true;
};

/**
 * Validate a proposed parent before it is written. All three write paths share
 * this: POST /items, PUT /items/:id and POST /items/bulk each used to apply
 * `parentId` straight to storage with no checks, so a dangling parent, a
 * cross-project parent, or a cycle were reachable from any REST/MCP caller.
 *
 * @param itemId    the item being parented, or null at create time (a brand-new
 *                  id can have no descendants, so no cycle is possible)
 * @param projectId the item's project — the parent must be in the same one
 * @param parentId  the proposed value, straight off the request body
 * @returns an error message, or null when the assignment is acceptable
 */
async function validateParentAssignment(
  itemId: string | null,
  projectId: string,
  parentId: unknown,
): Promise<string | null> {
  if (parentId === undefined || parentId === null || parentId === '') return null;
  if (typeof parentId !== 'string') {
    // Otherwise this reaches the sqlite bind and throws, surfacing as a 500.
    return "parentId must be a string, or null to detach the item to top level.";
  }
  if (itemId !== null && parentId === itemId) {
    return "An item cannot be its own parent.";
  }
  const parent = await storage.getItem(parentId);
  if (!parent) {
    return `Parent item '${parentId}' not found.`;
  }
  if (parent.projectId !== projectId) {
    return "Parent must belong to the same project as the item.";
  }
  if (itemId === null) return null;

  // Walk up from the proposed parent: meeting this item means the proposed
  // parent is one of its descendants. The parent chain has out-degree 1, so the
  // walk visits every reachable ancestor once before any repeat — the `seen`
  // break therefore cannot skip an ancestor, it only stops the walk on data that
  // already contains a cycle.
  const seen = new Set<string>([parentId]);
  let cursor: string | undefined = parent.parentId;
  while (cursor) {
    if (cursor === itemId) {
      return "Cannot re-parent an item under one of its own descendants — that would create a cycle.";
    }
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const ancestor: any = await storage.getItem(cursor);
    cursor = ancestor?.parentId;
  }
  return null;
}

/**
 * Apply a flow-migration plan, refusing any mapping that would land an item on
 * the target flow's exit anchor.
 *
 * migrateCardsToFlow maps POSITIONALLY, so a flow whose first step is named DONE
 * moved every TODO item straight onto it — project-wide, in a single request,
 * with no evidence and no exit criteria. Flows arrive from a community registry
 * and from org-wide hub pushes, so that was the cheapest bypass in the codebase.
 * Migration may reshuffle items between working steps; it may never complete
 * their work for them.
 */
async function applyMigrationPlan(
  plan: Array<{ itemId: string; oldStatus: string; newStatus: string }>,
  targetFlow: { steps: Array<{ name: string; order: number; isAnchor?: boolean; isSpecial?: boolean }> },
): Promise<Array<{ itemId: string; newStatus: string }>> {
  const real = [...targetFlow.steps]
    .sort((a, b) => a.order - b.order)
    .filter(st => !st.isSpecial && !PLATFORM_STATUSES.has(st.name as Status));
  const exitName = real[real.length - 1]?.name?.toUpperCase();
  const entryName = real[0]?.name;
  const refused: Array<{ itemId: string; newStatus: string }> = [];

  for (const step of plan) {
    if (step.oldStatus === step.newStatus) continue;
    let target = step.newStatus;
    const landsOnExit = String(target).toUpperCase() === exitName
      || String(target).toUpperCase() === Status.DONE;
    if (landsOnExit && String(step.oldStatus).toUpperCase() !== Status.DONE) {
      refused.push({ itemId: step.itemId, newStatus: target });
      // Fall back to the entry step — unless the entry step is ITSELF the exit or
      // is named DONE, which happens on exactly the pathological flow this guard
      // exists for (first step named DONE). Then leave the item where it is:
      // there is nowhere safe to put it, and not moving it is always safe.
      const fallback = entryName;
      const fallbackUnsafe = !fallback
        || String(fallback).toUpperCase() === Status.DONE
        || String(fallback).toUpperCase() === exitName;
      if (fallbackUnsafe) continue;
      target = fallback;
      if (target === step.oldStatus) continue;
    }
    await storage.updateItem(step.itemId, { status: target as Status });
  }
  if (refused.length) {
    console.warn(`[FLOW_MIGRATION] Refused to migrate ${refused.length} item(s) onto the flow's final step; anchored them at '${entryName}' instead.`);
  }
  return refused;
}

const syncParentStatus = async (parentId: string) => {
  const parent = await storage.getItem(parentId);
  if (!parent) return;

  const allChildren = await storage.listItems({ parentId });
  const children = allChildren.filter(c => c.status !== Status.TRASHED && c.status !== Status.ARCHIVED);
  if (children.length === 0) return;

  // Compare children by their ORDER in the active flow, not by hardcoded step
  // names. The previous version tested Status.IN_PROGRESS/REVIEW/TEST/DONE
  // literally, so on any custom flow none of the intermediate branches could
  // fire and a parent lagged behind its children indefinitely — only the
  // allDone -> DONE case worked, because DONE is an anchor every flow has.
  const parentProject = await storage.getProject(parent.projectId);
  const parentFlow = getActiveFlow((parentProject as any)?.flowId, await storage.listFlows());
  // Real workflow steps only. Nothing here may write a platform status onto a
  // parent: a flow is free to name a step BLOCKED, and driving a parent there
  // would archive or block it outside the routes that record previousStatus.
  const ordered = [...parentFlow.steps]
    .sort((a, b) => a.order - b.order)
    .filter(st => !(st as any).isSpecial && !PLATFORM_STATUSES.has(st.name as Status));
  const orderOf = (name: string) => {
    const i = ordered.findIndex(st => st.name.toUpperCase() === String(name).toUpperCase());
    return i === -1 ? null : i;
  };

  // A child on a platform status has no position in the flow, so it neither
  // holds the parent back nor pushes it forward — it is simply skipped.
  const positioned = children
    .map(c => orderOf(c.status))
    .filter((n): n is number => n !== null);

  let newStatus: Status | null = null;

  if (positioned.length > 0) {
    // The parent may advance to the LEAST advanced positioned child's step, and
    // only FORWARD. Moving it backward is not propagation: it would un-pause a
    // parent that someone deliberately paused, and the pre-existing behaviour
    // never moved a parent back.
    let laggard = Math.min(...positioned);
    const parentIdx = orderOf(parent.status);
    /*
     * CGLAB-381: never past the parent's own review. Reviews happen at the
     * parent, so a step whose checks include the review record is where the
     * parent stops; only verify, which runs that check, moves it on.
     */
    if (parentIdx !== null) {
      for (let i = parentIdx; i < laggard; i++) {
        if (resolveStepChecks(parentFlow.steps, ordered[i].name).some(c => c.id === 'review-record' && c.applicable)) { laggard = i; break; }
        // CGLAB-382: nor past a go-ahead the parent has not been given.
        if (!(await approvalSatisfied(parent, parentFlow.steps, ordered[i].name))) { laggard = i; break; }
      }
    }
    /*
     * 281adef0: on a flow that runs the suite once at the top-level card, the
     * parent's own final verify IS that run. Walking it onto the exit step here
     * would close it - and every child that deferred to it - with the suite run
     * nowhere. It stops one step short; only verify moves it on.
     */
    const owed = children.some(c => (c as any).suiteDeferredTo === parent.id);
    const endName = sortedFlowSteps(parentFlow as any).slice(-1)[0]?.name;
    // Keyed on what HAPPENED (a child deferred to it), not on the flow's setting now:
    // turning 'parent' off must not let the owed run slip.
    if ((owed || flowVerifyAt(parentFlow) === 'parent') && ordered[laggard]?.name === endName && laggard > 0) laggard -= 1;
    if (parentIdx !== null && laggard > parentIdx) {
      newStatus = ordered[laggard].name as Status;
    }
  }

  if (newStatus) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [AUTO_SYNC] Updating parent ${parent.id} (${parent.title}) to ${newStatus}`);
    await storage.updateItem(parent.id, { status: newStatus });
    io.emit('items_updated');
    recordMoveEvents(parent, parent.status, newStatus, parentFlow);

    if (parent.parentId) {
      await syncParentStatus(parent.parentId);
    }
  }
};

/**
 * Where a path really lands, following symlinks as far as the filesystem knows.
 *
 * `path.resolve` collapses `..` and stops there, which is why a lexical
 * containment check is defeated by a single link. The target usually does not
 * exist yet, so this resolves the deepest ancestor that DOES and re-attaches
 * the rest.
 */
function realBase(p: string): string {
  // Same implementation as worktrees.canonical, because it IS the same
  // question. It used to be a second copy with a comment explaining why the
  // copy was justified; the explanation was a rationalisation.
  return resolveThroughLinks(p, {
    resolve: path.resolve, dirname: path.dirname, basename: path.basename,
    join: path.join, exists: fs.existsSync, realpath: fs.realpathSync,
  });
}

export const findProjectRoot = (startDir: string): string | null => {
  const home = os.homedir();
  /*
   * RESOLVED FIRST, and this is not tidiness - it is what makes the loop below
   * terminate.
   *
   * `path.parse('.').root` is '' and `path.dirname('.')` is '.', so the walk
   * never moved and never ended. Node is single threaded, so ONE relative path
   * stopped the whole server answering anything, for ever, with no error and no
   * crash to point at. Every relative path reaches it, not only '.':
   * 'relative/dir' walks to 'relative', then to '.', and sticks.
   *
   * It arrives from POST /items/:id/validate, which takes `cwd` off the request
   * body - behind the internal token, so a local client can wedge the server,
   * which is exactly the population this product runs agents from.
   *
   * Resolving also fixes the ANSWER: callers use the return value as a cwd for
   * git, and handing back the caller's relative string would resolve it against
   * the server's own working directory, which is the defect this whole area
   * keeps producing.
   */
  let currentDir = path.resolve(startDir);
  const stopAt = path.parse(currentDir).root;
  /*
   * A belt as well as braces. The walk is bounded by the path's own depth now,
   * but a bound that does not depend on `path` behaving as expected is what
   * turns "should terminate" into "does terminate" - and the cost of being
   * wrong here is the whole process, not one request.
   */
  for (let guard = 0; guard < 256 && currentDir !== stopAt; guard++) {
    // $HOME always contains ~/.agenfk, so without this guard any walk that
    // reaches it "finds" a project there. The consequence is not cosmetic:
    // projectRoot becomes the home directory, and `git add -A && git commit`
    // then runs over the user's dotfiles, ~/.ssh and ~/.aws included.
    if (currentDir !== home && fs.existsSync(path.join(currentDir, ".agenfk"))) {
      return currentDir;
    }
    const parent = path.dirname(currentDir);
    // `dirname` of a root returns the root, so this is the other way the walk
    // stops: it has stopped moving.
    if (parent === currentDir) break;
    currentDir = parent;
  }
  /*
   * NOT FOUND IS null, not the starting directory.
   *
   * Returning `path.resolve(startDir)` made a FAILURE indistinguishable from
   * an answer: a caller could not tell "this is the project root" from "the
   * walk reached the filesystem root and gave up". A worktree has no
   * `.agenfk` (it is gitignored, so it does not travel into one), so a verify
   * run from one recorded that worktree as the project's own root - and
   * everything resolving through projectRoot, autoGitCommit above all, then
   * aimed at one card's directory, permanently, with no message.
   *
   * The sink above stays where it is; this is the return value telling the
   * truth about it.
   */
  return null;
};

/**
/**
 * The commit the server makes when an item reaches its final flow step.
 *
 * It commits the INDEX and stages nothing itself (BUG 315edc11 / CGLAB-22).
 *
 * It used to run `git add -A`, which staged every untracked file in the
 * repository — so closing one item swept in whatever happened to be lying
 * around, including work in progress belonging to a DIFFERENT task or branch.
 * Observed: a close(bug) commit carrying another item's WIP test, which had no
 * implementation on that branch and would have failed CI under someone else's
 * name.
 *
 * `git add -u` was tried and rejected: it narrows to TRACKED files, which is an
 * orthogonal axis to "whose work is this". It leaves the same leak open for
 * tracked modifications (and since git 2.0 it stages the whole repository, not
 * the directory it runs in), while turning a rename into a commit that deletes
 * the old path and never adds the new one — a commit that does not build,
 * pushed under the item's name.
 *
 * The index is the only thing here that actually carries provenance: it is the
 * author's explicit statement of what belongs to this change, renames and new
 * files included. So nothing is staged automatically, and anything left
 * unstaged is REPORTED rather than guessed at — silently dropping a file the
 * author expected to land is the same defect as silently adding one they did
 * not.
 *
 * THE ITEM'S OWN ROOT, and its CLAIMS. Two things this branch adds to the
 * upstream result: the commit runs in `resolveCommitRoot` (a linked worktree
 * has its OWN index, so committing from the primary checkout reads a different
 * one), and when the card has declared claims the pathspec limits the commit to
 * them — `.git/index` belongs to the WORKTREE, not to an agent, and several
 * agents share one by design.
 *
 * Exported for the test; nothing else outside this module should call it.
 */
/** What the close commit actually did. Every state the agent must be told apart. */
export type AutoGitCommitOutcome = 'committed' | 'nothing-staged' | 'declined' | 'failed';

export interface AutoGitCommitResult {
  outcome: AutoGitCommitOutcome;
  /** Nothing went wrong that the operator needs to act on. */
  success: boolean;
  committed: boolean;
  output: string;
  /** Paths git can see changes in that the author did not stage. */
  unstaged: string[];
  /** Staged paths this card never claimed, when it declared claims. */
  outsideClaims?: string[];
  /** Why, for every outcome but 'committed'. */
  detail?: string;
  /** The commit it made, for 'committed' (see CloseCommitResult.sha). */
  sha?: string;
  /** The same reason under the name callers and older tests already use. */
  error?: string;
}

/*
 * ARGUMENTS, never a shell string. These run against the USER's repository, and
 * a shell adds quoting rules nobody here needs and a surface nobody here wants:
 * the only interpolated value today is a constant, but "today" is the whole
 * problem. execFile takes argv directly, like the rest of the server.
 */
const git = (args: readonly string[], cwd: string): Promise<{ ok: boolean; out: string; err: string }> =>
  new Promise((resolve) => execFile('git', args as string[], { cwd }, (e, stdout, stderr) =>
    resolve({ ok: !e, out: stdout ?? '', err: (stderr || (e as any)?.message || '').trim() })));

/** A merge, rebase, cherry-pick or revert the author has not finished. */
const IN_PROGRESS_HEADS = ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'] as const;

/**
 * The worktree a card's work lives in: its own, else its nearest ancestor's.
 *
 * Branches and worktrees are tracked on top-level items only (`agenfk branch
 * create` refuses a child), so a child never carries a worktreePath of its
 * own. Resolving the tree from the item alone sent every child's verify and
 * close commit to projectRoot - somebody else's checkout, in a shared repo
 * (CGLAB-366). Bounded and cycle-safe: a hand-edited parent loop must not hang
 * a request.
 */
export async function effectiveWorktreePath(
  item: { parentId?: string | null; worktreePath?: string | null } | null | undefined,
): Promise<string | undefined> {
  const seen = new Set<string>();
  let cur: any = item;
  for (let depth = 0; cur && depth < 32; depth++) {
    const wt = typeof cur.worktreePath === 'string' ? cur.worktreePath.trim() : '';
    if (wt) return wt;
    const parentId = cur.parentId;
    if (!parentId || seen.has(parentId) || !storage) return undefined;
    seen.add(parentId);
    cur = await storage.getItem(parentId);
  }
  return undefined;
}

/** The item as resolveCommitRoot should see it: carrying its effective worktree. */
async function withEffectiveWorktree<T extends object>(item: T): Promise<T> {
  const wt = await effectiveWorktreePath(item as any);
  return wt ? { ...item, worktreePath: wt } : item;
}

/**
 * Every card in a project as a claim holder, carrying the tree it works in
 * (aaa01834). Claims are per worktree: `gateOnClaims` compares a card only
 * with holders in its own tree, and an unknown tree stays strict. One listing,
 * resolved in memory, rather than a storage round-trip per ancestor.
 */
async function claimHoldersIn(projectId: string, projectRoot: string | null | undefined): Promise<{ holders: ClaimHolder[]; treeOf: (item: any) => string | null }> {
  const all: any[] = (await storage.listItems({ projectId, limit: 1_000_000 } as any)) as any;
  const byId = new Map<string, any>(all.map(i => [i.id, i]));
  /*
   * A card moved to another project keeps its parentId (move takes only
   * descendants), and verify commits in THAT parent's worktree
   * (effectiveWorktreePath reads any project). Resolve the same way, or claims
   * and strays would be judged against a tree the commit never touches.
   */
  for (let round = 0; round < 32; round++) {
    const missing = [...new Set([...byId.values()].map(i => i.parentId).filter((id: any) => id && !byId.has(id)))] as string[];
    if (!missing.length) break;
    for (const id of missing) {
      const parent = await storage.getItem(id);
      byId.set(id, parent ?? { id });
    }
  }
  const treeOf = (item: any) => claimTreeOf(item, id => byId.get(id), projectRoot ?? null);
  return { holders: all.map(i => ({ id: i.id, status: String(i.status), claims: i.claims, tree: treeOf(i) })), treeOf };
}

/**
 * Staged files this card's close would leave behind with no owner (aaa01834).
 *
 * The close commit (and a step commit) takes only the card's claimed files.
 * What else is staged is either another card's in the same tree - theirs, left
 * alone - or nobody's, and a nobody's file sitting in the index after DONE is
 * how a dirty tree reaches the next agent. Empty for a card that claims
 * nothing, and when the index cannot be read: the commit then reports that.
 */
async function strayStagedFor(
  item: any,
  projectRoot: string | null | undefined,
  isWorking: (status: string) => boolean,
): Promise<{ strays: string[]; claimless: string[] }> {
  const none = { strays: [], claimless: [] };
  if (!Array.isArray(item?.claims) || !item.claims.length) return none;
  const root = resolveCommitRoot(await withEffectiveWorktree(item), projectRoot).root;
  if (!root) return none;
  // --no-renames: with rename detection `--name-only` prints only a rename's
  // DESTINATION, and the staged deletion of its source would be left behind
  // unseen - exactly the ownerless file this looks for.
  const listed = await git(['diff', '--cached', '--name-only', '--no-renames', '-z'], root);
  if (!listed.ok) return none;
  const staged = listed.out.split('\0').filter(Boolean);
  if (!staged.length) return none;
  const { holders, treeOf } = await claimHoldersIn(item.projectId, projectRoot);
  const me = { id: item.id, claims: item.claims, tree: treeOf(item) };
  const strays = strayStaged(staged, me, holders);
  return { strays, claimless: strays.length ? claimlessNeighbours(me, holders, isWorking) : [] };
}

/** What an agent reads when strays stop it, and how to get past them. */
function describeStrays(item: any, strays: readonly string[]): string {
  const SHOWN = 20;
  const list = strays.slice(0, SHOWN).map(f => `\`${f}\``).join(', ') + (strays.length > SHOWN ? ` and ${strays.length - SHOWN} more` : '');
  // Every stray, not the ones listed: a partial command would be refused again.
  const widened = [...(item.claims ?? []), ...strays].join(',');
  return `Staged, but outside this card's claims and claimed by no other active card in this worktree: ${list}. `
    + `The commit takes only claimed files, so these would stay staged with no owner. `
    + `Claim them (\`agenfk update ${String(item.id).slice(0, 8)} --claims "${widened}"\`) or unstage them (\`git restore --staged <file>\`).`;
}

/** The note when a stray may belong to a card that claims nothing. */
function describeUnowned(strays: readonly string[], claimless: readonly string[]): string {
  const SHOWN = 20;
  const list = strays.slice(0, SHOWN).map(f => `\`${f}\``).join(', ') + (strays.length > SHOWN ? ` and ${strays.length - SHOWN} more` : '');
  return `Staged outside this card's claims, and not committed with it: ${list}. `
    + `They may belong to ${claimless.map(id => String(id).slice(0, 8)).join(', ')}, which ${claimless.length === 1 ? 'works in this tree and claims' : 'work in this tree and claim'} nothing, so they are left staged for ${claimless.length === 1 ? 'it' : 'them'}.`;
}

/** realpath that canonicalises case on macOS; the input unchanged when it fails. */
const realDir = (p: string): string => { try { return fs.realpathSync.native(p); } catch { return p; } };

/** Is there a `.git` entry (directory or worktree file) at `dir` or any ancestor? */
function hasGitEntryAbove(dir: string): boolean {
  let cur = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(cur, '.git'))) return true;
    const up = path.dirname(cur);
    if (up === cur) return false;
    cur = up;
  }
}

/**
 * What kind of checkout `dir` is in.
 *
 *  - 'main'    a repository's own checkout (git-dir IS the common dir), or a
 *              checkout of a BARE repository - in that layout every checkout is
 *              technically linked, and one of them has to be the project's root.
 *  - 'linked'  a `git worktree add` checkout of a non-bare repository: one
 *              card's tree, never the project's.
 *  - 'none'    not inside any git repository (a project need not use git).
 *  - 'unknown' git could not say (too old, safe.directory, not installed) and
 *              the `.git` file did not settle it either.
 *
 * Deliberately avoids `--path-format` (git >= 2.31): an older git failing that
 * flag used to read as "not linked", which is fail-OPEN on exactly the check
 * that keeps a worktree from becoming the whole project's root.
 */
async function checkoutKind(dir: string): Promise<'main' | 'linked' | 'none' | 'unknown'> {
  const [gitDir, common] = await Promise.all([
    git(['rev-parse', '--absolute-git-dir'], dir),
    git(['rev-parse', '--git-common-dir'], dir),
  ]);
  // Not in a repository at all is an ANSWER, not a failure: a project need not
  // use git, and a directory outside every repository cannot be a worktree.
  // Decided by looking for a `.git` entry on the way up, NOT by matching git's
  // error text - that is translated on a localized git.
  if (!gitDir.ok && !hasGitEntryAbove(dir)) return 'none';
  if (gitDir.ok && common.ok) {
    const g = realDir(gitDir.out.trim());
    const c = realDir(path.resolve(dir, common.out.trim()));
    if (g === c) return 'main';
    const bare = await git(['--git-dir', c, 'rev-parse', '--is-bare-repository'], dir);
    return bare.ok && bare.out.trim() === 'true' ? 'main' : 'linked';
  }
  // git could not answer. The `.git` entry still can: a directory is a main
  // checkout, and a file pointing into `.../worktrees/<name>` is a linked one.
  try {
    const dotGit = path.join(dir, '.git');
    const st = fs.statSync(dotGit);
    if (st.isDirectory()) return 'main';
    if (st.isFile() && /^gitdir:.*[\\/]worktrees[\\/]/m.test(fs.readFileSync(dotGit, 'utf8'))) return 'linked';
  } catch { /* fall through */ }
  return 'unknown';
}

/** The top of the git checkout containing `dir`, or null when it is not in one. */
async function gitTopLevel(dir: string): Promise<string | null> {
  const r = await git(['rev-parse', '--show-toplevel'], dir);
  if (!r.ok || !r.out.trim()) return null;
  return realDir(r.out.trim());
}

/** The deepest of `dirs` that is `p` or contains it, by whole path segments. */
function deepestContaining(p: string, dirs: readonly string[]): string | null {
  let best: string | null = null;
  for (const d of dirs) {
    if ((p === d || p.startsWith(d + path.sep)) && (!best || d.length > best.length)) best = d;
  }
  return best;
}

/**
 * Where a verify's caller is, relative to the checkout the verify will test.
 *
 *  - 'tested'    inside that checkout.
 *  - 'other'     inside ANOTHER checkout of the same repository (`checkout`).
 *  - 'unrelated' anywhere else: another repository, no repository, or a path
 *                that is not absolute.
 *
 * `rawCwd` comes off the request body, so it is MATCHED, never trusted (CodeQL
 * #136-139). Git runs in `tested` - a directory the server already holds - to
 * list every checkout of that repository; the caller's path is compared with
 * the list as a string, and only once it lies inside one of them is it resolved
 * on disk. Resolving is still required: a link inside one checkout can point
 * into another, and that caller is in the other one. The deepest match wins,
 * because a worktree may sit inside the main checkout's directory.
 */
async function placeCaller(
  rawCwd: string,
  tested: string,
): Promise<{ kind: 'tested' } | { kind: 'other'; checkout: string; testedTop: string } | { kind: 'unrelated' }> {
  if (!path.isAbsolute(rawCwd)) return { kind: 'unrelated' };
  const [list, testedTop] = await Promise.all([
    git(['worktree', 'list', '--porcelain'], tested),
    gitTopLevel(tested),
  ]);
  if (!list.ok || !testedTop) return { kind: 'unrelated' };
  // One record per checkout, separated by a blank line. A record flagged
  // `bare` is the repository directory of a bare layout, not a checkout, so
  // nothing inside it is "a different checkout". Paths are taken verbatim:
  // trimming would turn a directory ending in a space into another one.
  const listed = list.out.split(/\r?\n\r?\n/)
    .map(rec => rec.split(/\r?\n/))
    .filter(lines => !lines.includes('bare'))
    .map(lines => lines.find(l => l.startsWith('worktree '))?.slice('worktree '.length) ?? '')
    .filter(Boolean);
  // As git recorded them, and resolved: the caller may report either spelling.
  const checkouts = [...new Set([...listed, ...listed.map(realDir)])];
  const resolved = checkouts.map(realDir);

  const lexical = path.resolve(rawCwd);
  let real: string | null = null;
  for (const d of checkouts) {
    if (lexical === d || lexical.startsWith(d + path.sep)) { real = realDir(lexical); break; }
  }
  if (real === null) return { kind: 'unrelated' };
  const at = deepestContaining(real, resolved);
  if (!at) return { kind: 'unrelated' };
  return at === testedTop ? { kind: 'tested' } : { kind: 'other', checkout: at, testedTop };
}

export const autoGitCommit = async (item: AgEnFKItem, projectRoot: string | null | undefined, opts: { message?: string } = {}): Promise<AutoGitCommitResult> => {
  const message = opts.message ?? `close(${item.type.toLowerCase()}): ${item.title} [${item.id}]`;
  const stamp = () => new Date().toISOString();
  const done = (r: AutoGitCommitResult): AutoGitCommitResult => {
    const line = r.outcome === 'committed' ? `Committed: "${message}"` : `${r.outcome}: ${r.detail ?? ''}`;
    console.log(`[${stamp()}] [AUTO_GIT] ${line}`);
    return r;
  };
  const stop = (outcome: AutoGitCommitOutcome, detail: string, extra: Partial<AutoGitCommitResult> = {}): AutoGitCommitResult =>
    done({ outcome, success: outcome !== 'failed', committed: false, output: '', unstaged: [], detail, error: detail, ...extra });

  /*
   * THE ITEM'S WORKTREE (its own, else its top-level ancestor's - children
   * carry none), not the project root: a linked worktree has its own
   * index, so committing from the primary checkout reads a different one. The
   * root is refused rather than guessed - a stale projectRoot used to report
   * every close as "nothing staged" forever.
   */
  const resolved = resolveCommitRoot(await withEffectiveWorktree(item as any), projectRoot);
  if (resolved.root === null) return stop('failed', resolved.reason);
  const root = resolved.root;

  // Swallowing git's own refusal made a server started outside a repository —
  // or pointed at one by a stale projectRoot — report every close as a clean
  // "nothing staged", forever.
  const repo = await git(['rev-parse', '--git-dir'], root);
  if (!repo.ok) return stop('failed', `not a git repository: ${root}`);

  // An unfinished merge leaves MERGE_HEAD set and the index full of somebody
  // else's resolution; committing it produces a two-parent merge titled after
  // this item.
  for (const head of IN_PROGRESS_HEADS) {
    if ((await git(['rev-parse', '-q', '--verify', head], root)).ok) {
      return stop('declined', `a ${head.replace('_HEAD', '').toLowerCase().replace('_', ' ')} is in progress`);
    }
  }

  // Working-tree changes the author did NOT stage: not ours to commit, ours to
  // mention. Porcelain v1 with -z (a quoted path is a name the reader cannot
  // copy), consuming the second   a rename emits.
  const unstaged: string[] = [];
  const status = await git(['status', '--porcelain', '-z'], root);
  const entries = status.out.split('\0');
  for (let k = 0; k < entries.length; k++) {
    const entry = entries[k];
    if (entry.length < 4) continue;
    const [x, y] = [entry[0], entry[1]];
    if (x === 'R' || x === 'C') k++;
    if (entry.startsWith('??') || y !== ' ') unstaged.push(entry.slice(3));
  }

  /*
   * THE COMMIT ITSELF IS `commitStagedForCard`'s decision, not a second copy of
   * it. That module owns "commit the INDEX", the claims pathspec, the
   * staged-then-changed refusal and the reason strings; reimplementing any of
   * it here is how the two would drift.
   */
  const result = commitStagedForCard(
    item as any,
    root,
    { run: args => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) },
    (item as any).claims,
    { message },
  );
  if (result.committed) {
    return done({
      outcome: 'committed', success: true, committed: true,
      output: result.output ?? '', unstaged, outsideClaims: result.outsideClaims ? [...result.outsideClaims] : undefined,
      ...(result.sha ? { sha: result.sha } : {}),
    });
  }
  const reason = result.reason ?? 'the close commit did not run';
  /*
   * An EMPTY index is a normal, well-behaved close (the author committed their
   * own work first). Staged files that are not OURS is a different fact - the
   * card's work is not in the index - and a refusal the agent must act on.
   * `commitStagedForCard` reports both under the same "nothing was staged"
   * wording, so `outsideClaims` is what tells them apart.
   */
  const nothingOfOurs = (result.outsideClaims?.length ?? 0) > 0;
  const outcome: AutoGitCommitOutcome =
    !nothingOfOurs && /nothing was staged/i.test(reason) ? 'nothing-staged' : 'failed';
  return stop(outcome, reason, { unstaged, outsideClaims: result.outsideClaims ? [...result.outsideClaims] : undefined });
};

// ── Storage initialisation ───────────────────────────────────────────────────

const initStorage = async () => {
  // Priority: env var → ~/.agenfk/config.json → default
  if (process.env.AGENFK_DB_PATH) {
    dbPath = process.env.AGENFK_DB_PATH;
  } else {
    const configPath = path.join(os.homedir(), '.agenfk', 'config.json');
    if (fs.existsSync(configPath)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (cfg.dbPath) dbPath = cfg.dbPath;
      } catch { /* ignore malformed config */ }
    }
    if (!dbPath) {
      const root = findProjectRoot(process.cwd()) ?? process.cwd();
      dbPath = path.join(root, ".agenfk", "db.sqlite");
    }
  }

  // Always use SQLite. If a legacy .json path was configured, remap to .sqlite.
  if (dbPath.endsWith('.json')) {
    const remapped = dbPath.replace(/\.json$/, '.sqlite');
    console.warn(`[SERVER_START] Legacy JSON path detected (${dbPath}) — remapping to SQLite: ${remapped}`);
    dbPath = remapped;
  }

  storage = new SQLiteStorageProvider();

  console.log(`[SERVER_START] Using Database: ${dbPath} (SQLite)`);
  await storage.init({ path: dbPath });

  // Apply pending migration (written by install/upgrade when a db.json was detected)
  const migrationPath = path.join(os.homedir(), '.agenfk', 'migration.json');
  if (fs.existsSync(migrationPath)) {
    try {
      console.log(`[MIGRATION] Found migration.json — importing data...`);
      const data = JSON.parse(fs.readFileSync(migrationPath, 'utf8'));
      let imported = 0;
      for (const project of (data.projects || [])) {
        try { await storage.createProject(project); imported++; } catch { /* duplicate — skip */ }
      }
      for (const item of (data.items || [])) {
        try { await storage.createItem(item); imported++; } catch { /* duplicate — skip */ }
      }
      fs.unlinkSync(migrationPath);
      console.log(`[MIGRATION] Complete — imported ${imported} records.`);
    } catch (e: any) {
      console.error(`[MIGRATION] Failed to import migration.json: ${e.message}`);
    }
  }

  startHubSubsystems();
};

/**
 * (Re)start every hub subsystem against whatever config HubClient currently
 * holds. Extracted from initStorage so `POST /internal/hub/reload` can adopt a
 * freshly-written ~/.agenfk/hub.json without a server restart: the Flusher and
 * both reconcilers capture their credential and base URL at construction, so
 * after `agenfk hub login` issues a replacement token the old objects would
 * keep presenting the revoked one forever. Safe to call repeatedly — it stops
 * the previous handles first.
 */
const startHubSubsystems = (): void => {
// Attach the corporate-hub outbox to the storage layer and start the flusher
// when configured. No-op when ~/.agenfk/hub.json is absent.
//
// Stop any pre-existing flusher / flow-sync first. initStorage is re-entrant
// in tests (each setup calls it), and without these stops every re-entry
// would leak a setInterval timer holding a stale storage reference, which
// races against the live test's writes and causes hard-to-diagnose flakes
// (item.id undefined, GET /flows 500, etc).
hubFlusher?.stop();
flowSyncHandle?.stop();
upgradeSyncHandle?.stop();
repointSyncHandle?.stop();
hubClient.attachStorage(storage as SQLiteStorageProvider);

// Never start the outbound hub machinery under a test runner.
//
// initStorage() is called directly by the suite — often in beforeEach, so many
// times per file — and the NODE_ENV guard further down only wraps the
// auto-listen path. That meant every test run stood up a Flusher plus the flow
// and upgrade reconcilers pointed at the PRODUCTION hub using the real token in
// ~/.agenfk/hub.json, never stopped them, and accumulated sockets and timers
// across the whole run. That is the source of the intermittent `read ECONNRESET`
// that moved between files run to run: it was a real remote connection being
// reset, not a supertest artifact. It also meant test runs could push events
// into production. Set AGENFK_TEST_ENABLE_HUB=1 in the rare test that wants it.
const hubDisabledForTests = (process.env.NODE_ENV === 'test' || !!process.env.VITEST)
  && !process.env.AGENFK_TEST_ENABLE_HUB;

if (hubDisabledForTests) {
  hubFlusher = null;
} else if (hubClient.isEnabled && hubClient.hubConfig) {
  // Stamp events queued while disconnected (pending-org sentinel '') with
  // the real orgId BEFORE the flusher starts, so pre-login history delivers
  // instead of being rejected on orgId mismatch.
  try {
    const stamped = (storage as SQLiteStorageProvider).hubOutboxRewriteOrgId(PENDING_ORG, hubClient.hubConfig.orgId);
    if (stamped > 0) console.log(`[HUB] Stamped ${stamped} pre-login outbox event(s) with org=${hubClient.hubConfig.orgId}`);
  } catch (e: any) {
    console.error('[HUB] Failed to stamp pre-login outbox events:', e?.message || e);
  }
  hubFlusher = new Flusher(storage as SQLiteStorageProvider, hubClient.hubConfig, getInstallationId());
  hubFlusher.start();
  console.log(`[HUB] Configured: pushing events to ${hubClient.hubConfig.url} (org=${hubClient.hubConfig.orgId})`);

  // Start pulling the org-assigned flow from the Hub. Poll interval can be
  // tuned via AGENFK_HUB_FLOW_SYNC_INTERVAL_MS (default 5min).
  const intervalMs = Number(process.env.AGENFK_HUB_FLOW_SYNC_INTERVAL_MS) || undefined;
  flowSyncHandle = startFlowSync({
    storage: storage as SQLiteStorageProvider,
    hubConfig: hubClient.hubConfig,
    intervalMs,
    etagCache: flowSyncEtagCache,
    emit: (event, payload) => io.emit(event, payload),
    resolveRepo: resolveProjectRepo,
  });
  console.log(`[HUB] Flow reconciler running against ${hubClient.hubConfig.url}/v1/flows/active`);

  // Story 3 — fleet upgrade reconciler.
  const dbDir = path.dirname(dbPath);
  const installationId = getInstallationId();
  const currentVersion: string = (() => {
    try {
      const pkg = JSON.parse(require('fs').readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
      return typeof pkg?.version === 'string' ? pkg.version : '0.0.0';
    } catch { return '0.0.0'; }
  })();
  const recordEvent = (e: { installationId: string; type: any; payload: any; occurredAt?: string }) => {
    hubClient.recordEvent({
      installationId: e.installationId,
      orgId: hubClient.hubConfig!.orgId,
      type: e.type,
      payload: e.payload,
      occurredAt: e.occurredAt,
    } as any);
  };
  // Boot-time replay: a previous run may have spawned an upgrade that killed
  // this very process before its outcome event drained. Reconcile by
  // comparing currentVersion to the directive's intent and emit accordingly.
  replayPendingUpgradeOutcome({
    dbDir,
    currentVersion,
    installationId,
    recordEvent,
  }).catch((e) => console.error('[HUB_UPGRADE_SYNC] replay failed:', (e as Error).message));

  // CGLAB-66 — repoint campaign reconciler. Applies an admin-issued move to
  // a new hub DNS name, after re-verifying the target's identity locally.
  repointSyncHandle = startRepointSync({
    hubUrl: hubClient.hubConfig.url,
    hubToken: hubClient.hubConfig.token,
    orgId: hubClient.hubConfig.orgId,
    installationId,
    // AGENFK_HUB_URL overrides hub.json, so a rewrite would be a no-op here;
    // the reconciler reports blocked_by_env instead of a false success.
    envHubUrl: process.env.AGENFK_HUB_URL ?? null,
    intervalMs: Number(process.env.AGENFK_HUB_REPOINT_SYNC_INTERVAL_MS) || undefined,
    writeConfigImpl: (cfg) => {
      const target = path.join(os.homedir(), '.agenfk', 'hub.json');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify(cfg, null, 2), { mode: 0o600 });
      try { fs.chmodSync(target, 0o600); } catch { /* best effort */ }
    },
    // Swap the live transport in-process. The Flusher bakes its baseURL and
    // bearer token in at construction and nothing re-reads hub.json, so
    // without this the confirmation would be POSTed to the OLD host — where
    // the hub correctly refuses it and resets the target to pending, forever.
    // The outbox is in SQLite, not in the Flusher, so the pending
    // confirmation survives the swap.
    rebuildTransportImpl: async (cfg) => {
      const previous = hubFlusher;
      previous?.stop();
      const next = new Flusher(storage as SQLiteStorageProvider, cfg, getInstallationId());
      next.start();
      hubFlusher = next;
      console.log(`[HUB_REPOINT_SYNC] Repointed to ${cfg.url}; transport rebuilt.`);
    },
    recordEvent,
    flushNow: (timeoutMs) => hubFlusher!.flushNow(timeoutMs),
  });

  const upgradeIntervalMs = Number(process.env.AGENFK_HUB_UPGRADE_SYNC_INTERVAL_MS) || undefined;
  upgradeSyncHandle = startUpgradeSync({
    dbDir,
    currentVersion,
    installationId,
    hubUrl: hubClient.hubConfig.url,
    hubToken: hubClient.hubConfig.token,
    intervalMs: upgradeIntervalMs,
    fetchImpl: async ({ hubUrl, hubToken, installationId }) => {
      const r = await axios.get(`${hubUrl}/v1/upgrade-directive`, {
        headers: { Authorization: `Bearer ${hubToken}`, 'X-Installation-Id': installationId },
        timeout: 10_000,
        validateStatus: (s) => s < 500,
      });
      return { status: r.status, json: async () => r.data };
    },
    recordEvent,
    flushNow: (timeoutMs) => hubFlusher!.flushNow(timeoutMs),
    // Async spawn keeps the API event loop responsive while `agenfk
    // upgrade` runs. spawnSync would block every probe (the CLI's own
    // `is the server running?` curl, install.mjs's pre-install probe)
    // so all of them would falsely report "not running" and skip the
    // down/up restart — leaving the upgrade landed on disk while the
    // in-memory process keeps executing the old code.
    spawnImpl: (cmd, args) => new Promise((resolve) => {
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      child.stdout?.on('data', (d) => { stdout += d.toString(); });
      child.stderr?.on('data', () => { /* ignore — agenfk upgrade --json puts everything on stdout */ });
      child.on('exit', (code) => resolve({ exitCode: code, stdout }));
      child.on('error', () => resolve({ exitCode: 1, stdout }));
    }),
  });
  console.log(`[HUB] Upgrade reconciler running against ${hubClient.hubConfig.url}/v1/upgrade-directive`);

}
};


// ── Error handler wrapper ────────────────────────────────────────────────────

const asyncHandler = (fn: any) => (req: any, res: any, next: any) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// ── Flow-aware transition resolver ───────────────────────────────────────────

/**
 * Platform-level statuses that exist outside any flow definition.
 * They are always reachable from ANY status, and any status is reachable from them (bidirectional).
 * These are never part of a flow's step list.
 */
const PLATFORM_STATUSES = new Set([
  Status.BLOCKED,
  Status.PAUSED,
  Status.ARCHIVED,
  Status.TRASHED,
  Status.IDEAS,
]);

/**
 * The platform statuses a card may come back from to the step it left
 * (`previousStatus`). Only these: the server records that step when a card
 * enters them, and clears it on every other status change, so on IDEAS or
 * TRASHED (a deleted card) it is never a way back into the middle of a flow.
 */
const RETURNS_TO_PREVIOUS = new Set<Status>([Status.PAUSED, Status.BLOCKED, Status.ARCHIVED]);

/**
 * Build the set of statuses reachable from `fromStatus` given the active Flow.
 * Rules:
 *  - PLATFORM_STATUSES (BLOCKED, PAUSED, ARCHIVED, TRASHED, IDEAS) are always reachable
 *    from any status, and any flow step is reachable from them (bidirectional).
 *  - Flow steps define the main progression: each step can move to the adjacent step.
 *  - TODO (order 0, anchor) → first non-anchor step is always allowed.
 *  - Last non-anchor step → DONE (highest order, anchor) is always allowed.
 */
export function buildAllowedTransitions(fromStatus: string, flow: { steps: Array<{ name: string; order: number; isSpecial?: boolean; isAnchor?: boolean }> }, previousStatus?: string): Set<string> {
  const allowed = new Set<string>();

  // Platform statuses are always reachable from any step
  for (const s of PLATFORM_STATUSES) {
    allowed.add(s);
  }

  const sorted = [...flow.steps].sort((a, b) => a.order - b.order);

  // Real workflow steps only. Older flows list the platform statuses AS steps
  // marked `isSpecial` and never set `isAnchor`, so anchors cannot be found by
  // that flag alone — treat the first and last real step as the entry and exit
  // anchors when the flag is absent. The same progression isForwardMove uses
  // (CGLAB-377): boundary steps marked only `isSpecial`, as `agenfk flow
  // create` makes them, stay in, or the two disagree on which step is the
  // entry and a card parked on PAUSED has nowhere it may go back to.
  const realSteps = flowProgression(flow);
  const entryStep = realSteps[0]?.name;
  // The step immediately AFTER the entry — positional on purpose. Using
  // `find(!isAnchor)` instead offered the first non-anchor step at ANY depth, so
  // a flow whose early steps are anchors (TODO/PLAN/SPEC anchored, then IMPL)
  // let PAUSED reach IMPL and skip PLAN and SPEC. And the exit anchor is never a
  // valid target, or a two-step flow {TODO, DONE} would sanction PAUSED -> DONE.
  const exitStep = realSteps[realSteps.length - 1];
  const adjacent = realSteps[1];
  const codingStep = (adjacent && adjacent !== exitStep) ? adjacent.name : undefined;
  const firstAnchor = entryStep;

  // Where a card may go back to after a platform status: the step it left
  // when it entered it (`previousStatus`, recorded by the server, never by the
  // caller) or anywhere earlier — the user's decision, so that marking a card
  // BLOCKED does not cost the progress it had verified (CGLAB-377).
  const returnable = (): string[] => {
    if (!RETURNS_TO_PREVIOUS.has(fromStatus as Status)) return [];
    const i = previousStatus ? realSteps.findIndex(st => st.name === previousStatus) : -1;
    return i === -1 ? [] : realSteps.slice(0, i + 1).map(st => st.name);
  };

  // Coming FROM a platform status. This used to allow every step, which made
  // `--status PAUSED` then `--status <final step>` two legal writes that skipped
  // every gate in between. Only offer somewhere workable: the entry anchor, the
  // coding step, and the steps the card had already reached. Genuine resumption
  // goes through POST /items/:id/resume, which restores the snapshot status via
  // storage directly; it consults this table only to check the snapshot's step,
  // without a previousStatus, and clears the remembered step.
  if (PLATFORM_STATUSES.has(fromStatus as Status)) {
    if (firstAnchor) allowed.add(firstAnchor);
    if (codingStep) allowed.add(codingStep);
    for (const name of returnable()) allowed.add(name);
    return allowed;
  }

  const currentIdx = sorted.findIndex(s => s.name === fromStatus);

  if (currentIdx === -1) {
    // Status not in this flow — e.g. the project's flow changed under the item.
    // Previously this allowed EVERY step, so an unknown status was a free jump
    // to the last one. Allow recovery only.
    if (firstAnchor) allowed.add(firstAnchor);
    if (codingStep) allowed.add(codingStep);
    for (const name of returnable()) allowed.add(name);
    return allowed;
  }

  // Allow forward and backward one step
  if (currentIdx > 0) allowed.add(sorted[currentIdx - 1].name);
  if (currentIdx < sorted.length - 1) allowed.add(sorted[currentIdx + 1].name);
  // Also allow staying in the same status (idempotent updates)
  allowed.add(fromStatus);

  return allowed;
}

type TransitionFlow = { steps: Array<{ name: string; order: number; isSpecial?: boolean; isAnchor?: boolean }> };

/**
 * The flow's own steps in order, the way validate walks them: every step that
 * is not a platform status. Boundary steps stay in, including those marked
 * only `isSpecial` - which is how `agenfk flow create` marks its entry and
 * exit - and so does a step held mid-flow.
 */
function flowProgression(flow: TransitionFlow) {
  return [...flow.steps]
    .sort((a, b) => a.order - b.order)
    .filter(st => !PLATFORM_STATUSES.has(st.name as Status));
}

/**
 * CGLAB-377 — is `to` a step AFTER `from` in the flow's own progression?
 *
 * Forward moves are what `agenfk verify` exists to gate: it records evidence
 * and runs the step's checks. PUT and bulk used to allow one step forward, so
 * `agenfk update --status <next>` walked a card to the step before DONE with
 * neither.
 *
 * From a platform status (PAUSED, ARCHIVED...) or a status the flow doesn't
 * know, anything past the entry step counts as forward: otherwise parking on
 * PAUSED and coming back to the second step skips the entry step's verify.
 * Genuine resumption goes through POST /items/:id/resume, not this route.
 */
export function isForwardMove(fromStatus: string, toStatus: string, flow: TransitionFlow, previousStatus?: string): boolean {
  const steps = flowProgression(flow);
  const from = steps.findIndex(st => st.name === fromStatus);
  const to = steps.findIndex(st => st.name === toStatus);
  if (to === -1) return false;
  if (from === -1) {
    // Back to the step the card left for the platform status, or earlier, is
    // a return, not an advance (see buildAllowedTransitions).
    const left = previousStatus && RETURNS_TO_PREVIOUS.has(fromStatus as Status)
      ? steps.findIndex(st => st.name === previousStatus) : -1;
    return to > Math.max(0, left);
  }
  return to > from;
}

/**
 * Does landing on `toStatus` finish the card? The literal DONE, or the flow's
 * last step when it is a boundary - the same rule as validate's `endsFlow`.
 * A last step that is not a boundary is still work: validate runs the final
 * command from it, not into it.
 */
export function isCompletionStep(toStatus: string, flow: TransitionFlow): boolean {
  if (toStatus === Status.DONE) return true;
  const steps = flowProgression(flow);
  const exit = steps[steps.length - 1];
  return !!exit && exit.name === toStatus && isBoundaryStep(exit);
}

/**
 * A card moved: the hub sees the move and, when the move ends the flow, the
 * closure (BUG a829ab35). Every route that lands a card on its flow's end -
 * verify, sibling propagation, the parent roll-up - goes through this, and
 * "the end" is the flow's own exit step, not the word DONE: the hub counts
 * closed cards by `item.closed`, so a close it is not told about is a close
 * that never happened on its dashboards.
 */
function recordMoveEvents(item: { id: string; projectId: string; type: string }, from: string, to: string, flow: TransitionFlow): void {
  if (to === from) return;
  recordHubEvent({
    type: 'step.transitioned',
    projectId: item.projectId,
    itemId: item.id,
    payload: { fromStatus: from, toStatus: to, itemType: item.type },
  });
  if (isCompletionStep(to, flow) && !isCompletionStep(from, flow)) {
    recordHubEvent({
      type: 'item.closed',
      projectId: item.projectId,
      itemId: item.id,
      payload: { fromStatus: from, toStatus: to, itemType: item.type },
    });
  }
}

/**
 * What `previousStatus` becomes after a status change through PUT/bulk. It is
 * single-use: entering PAUSED or BLOCKED from a real flow step remembers that
 * step, moving between PAUSED and BLOCKED keeps it, and EVERY other status
 * change clears it - the return itself included - so it can never outlive the
 * stay it was recorded for and be spent after a rollback (CGLAB-377 review).
 * ARCHIVED records its own through archiveRecursively.
 */
function previousStatusAfter(fromStatus: string, toStatus: string, flow: TransitionFlow, current?: string): string | undefined {
  if (toStatus !== Status.PAUSED && toStatus !== Status.BLOCKED) return undefined;
  if (flowProgression(flow).some(st => st.name === fromStatus)) return fromStatus;
  return fromStatus === Status.PAUSED || fromStatus === Status.BLOCKED ? current : undefined;
}

/**
 * The step records that survive a move BACK to `toStatus` (CGLAB-379): those
 * of steps before it. The records of `toStatus` and every later step describe
 * work the card is now redoing, so a later check must not read them as done.
 */
/**
 * Is a move to `toStatus` a move BACK, judged from the step the card really
 * occupies? On PAUSED/BLOCKED/ARCHIVED that is the step it left
 * (`previousStatus`); with none recorded, any real step counts as back, so
 * records are dropped rather than trusted (CGLAB-379 review).
 */
function isMoveBack(fromStatus: string, previousStatus: string | undefined, toStatus: string, flow: TransitionFlow): boolean {
  const steps = flowProgression(flow).map(st => st.name);
  if (!steps.includes(toStatus)) return false;
  const occupied = steps.includes(fromStatus) ? fromStatus : previousStatus;
  if (!occupied || !steps.includes(occupied)) return true;
  return steps.indexOf(toStatus) < steps.indexOf(occupied);
}

function recordsAfterRollback(records: any[] | undefined, toStatus: string, flow: TransitionFlow): any[] | undefined {
  if (!records) return records;
  const steps = flowProgression(flow).map(st => st.name);
  const target = steps.indexOf(toStatus);
  if (target === -1) return records;
  return records.filter(r => {
    const i = steps.indexOf(r?.step);
    return i === -1 || i < target;
  });
}

/** Refusal text for completing a card outside verify, whatever the exit step is called. */
function completionRefusal(toStatus: string): string {
  return `WORKFLOW VIOLATION: Cannot set status to '${toStatus}' directly: it completes the card. It is only reachable through \`agenfk verify\` on the flow's final step, which runs the project's verify command.`;
}

/** Refusal text for a forward move outside verify. Names the command that does it. */
function forwardMoveRefusal(itemId: string, fromStatus: string, toStatus: string): string {
  return `FORWARD MOVE REFUSED: '${fromStatus}' -> '${toStatus}' is a forward move. Forward moves go through \`agenfk verify ${itemId} --evidence "<how you met ${fromStatus}'s exit criteria>"\`, which records the evidence and runs the step's checks. \`agenfk update --status\` only moves a card back or to a platform status (PAUSED, BLOCKED).`;
}

/**
 * The record a status move through PUT/bulk leaves on the card.
 *
 * A forward move here can only come from the board (x-agenfk-ui), and it skips
 * verify, so it says so: no evidence, no checks. A backward move is a rollback,
 * which later steps' records depend on (CGLAB-379), so it is never silent.
 */
/** A forward drag on the board skipped verify and the step's checks: kept on the card, and listed on the PR (CGLAB-382). */
function manualAdvanceRecord(fromStatus: string, toStatus: string) {
  return { id: uuidv4(), step: fromStatus, kind: 'manual-advance', to: toStatus, at: new Date().toISOString(), head: null, clean: false, by: 'board' };
}

function statusMoveComment(fromStatus: string, toStatus: string, forward: boolean, fromBoard: boolean) {
  return forward
    ? { id: uuidv4(), author: 'Board', timestamp: new Date(),
        content: `### Moved forward by hand\n\n**Step**: ${fromStatus} -> ${toStatus}\n\nMoved on the board, without agenfk verify: no evidence was recorded and no checks ran.` }
    : { id: uuidv4(), author: fromBoard ? 'Board' : 'Status change', timestamp: new Date(),
        content: `### Moved back\n\n**Step**: ${fromStatus} -> ${toStatus}` };
}

/**
 * The one rule PUT /items/:id and POST /items/bulk share for a status change
 * the transition table has already allowed: a forward move is refused unless
 * it is the board's, and any move along the flow is recorded on the card.
 * A move to or from a platform status is neither, and passes unrecorded.
 */
function classifyStatusMove(
  itemId: string, fromStatus: string, toStatus: string,
  flow: TransitionFlow, fromBoard: boolean, previousStatus?: string,
): { refusal: string } | { comment?: ReturnType<typeof statusMoveComment> } {
  const forward = isForwardMove(fromStatus, toStatus, flow, previousStatus);
  if (forward && !fromBoard) return { refusal: forwardMoveRefusal(itemId, fromStatus, toStatus) };
  if (forward || isForwardMove(toStatus, fromStatus, flow)) {
    return { comment: statusMoveComment(fromStatus, toStatus, forward, fromBoard) };
  }
  return {};
}

// ── Flow step helpers (used by review_changes / test_changes) ────────────────

type FlowStepInfo = { name: string; order: number; isAnchor?: boolean };

/** Returns steps sorted by order, excluding platform-only statuses. */
function sortedFlowSteps(flow: { steps: FlowStepInfo[] }): FlowStepInfo[] {
  return [...flow.steps].sort((a, b) => a.order - b.order);
}

/**
 * The "coding" step: the first non-anchor step in the flow.
 * In the default flow this is IN_PROGRESS. Custom flows may use any name.
 */
function getCodingStep(sorted: FlowStepInfo[]): FlowStepInfo | undefined {
  // isBoundaryStep, not !isAnchor. A flow authored through `agenfk flow create`
  // marks its boundary steps with isSpecial and never sets isAnchor, so the
  // narrower test picked the HOLDING step as the place to send a failed verify
  // back to. The item then sat on a step getActiveStepItems counts as finished,
  // the gatekeeper reported "no active task", and the PreToolUse hook blocked
  // every edit — the agent was sent back to fix a failure and simultaneously
  // forbidden from touching the code.
  return sorted.find(s => !isBoundaryStep(s));
}

/**
 * Returns the step in the flow that matches the item's current status (case-insensitive).
 * Returns undefined if the status is not in the flow (e.g. platform status or unknown).
 */
function findCurrentFlowStep(sorted: FlowStepInfo[], status: string): { step: FlowStepInfo; index: number } | undefined {
  const idx = sorted.findIndex(s => s.name.toUpperCase() === status.toUpperCase());
  if (idx === -1) return undefined;
  return { step: sorted[idx], index: idx };
}

// ── Routes ───────────────────────────────────────────────────────────────────

app.get("/", (req, res, next) => {
  // When we are also serving the UI bundle, a browser asking for "/" wants the
  // app, not the API banner. Everything else — the CLI, `agenfk health`, curl —
  // negotiates to JSON and keeps reading `.message` as it always has.
  if (servedUiDir && wantsHtml(req)) return next();
  res.json({
    message: "AgEnFK Framework API is running",
    endpoints: {
      projects: "/projects",
      items: "/items",
      ui: servedUiDir ? "/" : `http://localhost:${process.env.VITE_PORT || 5173}`
    }
  });
});

app.get("/api/readme", asyncHandler(async (_req: any, res: any) => {
  const root = findProjectRoot(process.cwd()) ?? process.cwd();
  const readmePath = path.join(root, "README.md");
  if (!fs.existsSync(readmePath)) {
    return res.status(404).json({ error: "README.md not found" });
  }
  const content = fs.readFileSync(readmePath, "utf8");
  res.json({ content });
}));

app.get("/version", (_req: any, res: any) => {
  res.json({ version: getCurrentVersion() });
});

app.get("/api/telemetry/config", (_req: any, res: any) => {
  try {
    res.json({
      installationId: getInstallationId(),
      telemetryEnabled: isTelemetryEnabled(),
    });
  } catch {
    // Never fail — UI treats errors as telemetry disabled
    res.json({ installationId: null, telemetryEnabled: false });
  }
});

/**
 * Changing the telemetry choice from the settings screen.
 *
 * The flag stays in `~/.agenfk/config.json`, which is where `agenfk config set
 * telemetry` has always kept it and where `isTelemetryEnabled` reads it.
 * Copying it into the settings table would give one value two homes, and
 * whichever the UI read, the other would silently disagree — the mistake
 * tmuxByDefault already made once in the other direction. Both writers call the
 * same function in @agenfk/telemetry, so there is one implementation of "keep
 * the other keys" rather than two.
 *
 * The READ above is open and this write is not. Opting somebody IN to analytics
 * is a privacy decision, and this server is unauthenticated on loopback with a
 * CORS allowlist that trusts any localhost origin — so the same custom-header
 * preflight that guards POST /releases/update guards this. (Security: bug
 * 968259c4.)
 */
app.put("/api/telemetry/config", (req: any, res: any) => {
  if (!req.headers['x-agenfk-ui']) {
    return res.status(403).json({ error: "Forbidden: this route requires the x-agenfk-ui header." });
  }
  const enabled = req.body?.telemetryEnabled;
  // Type-checked, never coerced. 'false' is a truthy string, and coercing it
  // would opt in a user who was opting out.
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'telemetryEnabled must be a boolean' });
  }
  try {
    setTelemetryEnabled(enabled);
  } catch (err: any) {
    // Unlike the read, this must not answer "fine" when nothing was written —
    // the switch would show a choice the machine never made.
    return res.status(500).json({ error: `Could not write the telemetry setting: ${err?.message ?? err}` });
  }
  // Read back rather than echoed, so the caller sees what is stored.
  res.json({ installationId: getInstallationId(), telemetryEnabled: isTelemetryEnabled() });
});

// DB status & backup endpoints

app.get("/db/status", asyncHandler(async (_req: any, res: any) => {
  const dbType = 'sqlite';
  let backupCount = 0;
  let latestBackup: string | null = null;
  if (fs.existsSync(backupDir())) {
    const files = fs.readdirSync(backupDir())
      .filter(f => f.startsWith('agenfk-backup-') && f.endsWith('.json'))
      .sort();
    backupCount = files.length;
    latestBackup = files.length > 0 ? files[files.length - 1] : null;
  }
  res.json({ dbType, dbPath, backupDir: backupDir(), backupCount, latestBackup });
}));

app.post("/backup", asyncHandler(async (req: any, res: any) => {
  if (req.headers['x-agenfk-internal'] !== VERIFY_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const backupPath = await performBackup();
  res.json({ backupPath });
}));

// Projects API

app.get("/projects", asyncHandler(async (req: any, res: any) => {
  const projects = await storage.listProjects();
  res.json(projects);
}));

app.post("/projects", asyncHandler(async (req: any, res: any) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: "Name is required" });

  const existing = (await storage.listProjects()).find((p: Project) => p.name === name);

  const project: Project = {
    id: uuidv4(),
    name,
    description: description || "",
    createdAt: new Date(),
    updatedAt: new Date()
  };

  const created = await storage.createProject(project);
  io.emit('items_updated');
  if (!existing) {
    telemetry.capture('project_created', {
      storageBackend: 'sqlite',
      flow_name: await resolveFlowName(created.id),
    });
  }
  res.status(201).json(created);
}));

/**
 * Installation-wide settings.
 *
 * Not project-scoped and not in ~/.agenfk/config.json. config.json is read and
 * written directly by the CLI with no server in the path, so putting a value
 * the UI also writes in there would give it two owners and no arbiter. The
 * database is already one per installation, which makes a table here global
 * across projects and reachable identically by the CLI, the UI and MCP.
 */
/**
 * Terminals the user had open, so they can come back with their conversations.
 *
 * The agent's own conversation id is stored alongside, and it is the reason
 * this is worth anything: without it "restore" puts empty shells on screen
 * that look like the sessions the user left and are not.
 *
 * Unauthenticated like the rest of the board's routes, and that is defensible
 * here in a way it was not for auto-approve: nothing recorded through these
 * routes changes what a process is allowed to do. The agent id is checked
 * against the closed launchable set, and the conversation id against a strict
 * UUID shape, because both end up in the argv of a spawned process.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The state of a session's worktree (CGLAB-173).
 *
 * Thin on purpose. The CLI already knows how to do this (`agenfk branch
 * status`); what was missing was a way for the desktop to ASK. So the route
 * resolves the worktree, runs one git command and hands the bytes to core's
 * parser — the parsing is where the hard cases live and it is unit-tested
 * without a repository.
 *
 * execFile with an ARGUMENT ARRAY, never a shell string. Branch names and
 * paths come from user data, and one `exec` with an interpolated value is the
 * difference between a status panel and a shell.
 *
 * `--porcelain=v1 -z` because the human-readable output is localised and
 * changes between versions, and because a filename may contain a newline —
 * with newline-separated output one file reads as two.
 */
/**
 * A ceiling on the routes that do real work per request (CodeQL js/missing-rate-limiting).
 *
 * Applied to the five that spawn a process, walk a directory, or reach the
 * network: git-status, the file listing, worktree creation, the project-root
 * setter and the PR import.
 *
 * THE NUMBER COMES FROM WHAT THIS APP DOES, not from the alert. The UI polls
 * git-status every four seconds, so fifteen requests a minute is ordinary; a
 * ceiling near that would break the product to satisfy a static check, which is
 * an easy trade to make without looking. Sixty leaves normal use four times
 * under the line and still stops a runaway loop.
 *
 * Keyed by CALLER AND ROUTE, so one client looping on git-status cannot lock
 * another out of the PR import. Swept on write, because a map keyed by caller
 * that is never evicted is a denial of service inside the fix for one.
 */
/**
 * A ceiling on the routes that do real work per request (CodeQL js/missing-rate-limiting).
 *
 * Applied to the five that spawn a process, walk a directory, or reach the
 * network: git-status, the file listing, worktree creation, the project-root
 * setter and the PR import.
 *
 * THE NUMBER COMES FROM WHAT THIS APP DOES, not from the alert. The UI polls
 * git-status every four seconds, so fifteen requests a minute is ordinary; a
 * ceiling near that would break the product to satisfy a static check, which is
 * an easy trade to make without looking. Sixty leaves normal use four times
 * under the line and still stops a runaway loop.
 *
 * WHY THE LIBRARY AND NOT THE TWENTY LINES IT REPLACES. There was a hand-rolled
 * version here, tested, with a per-item key and its own sweep - and CodeQL went
 * on reporting all five routes, because the query recognises known middleware
 * and cannot be argued with about a Map. That is a bad reason to choose a
 * dependency and a good reason to look again at the one you wrote: this handles
 * the standard RateLimit headers, the proxy cases and the clock properly, and
 * express-rate-limit was ALREADY in the tree as a transitive dependency of the
 * MCP SDK, so making it direct adds no supply-chain surface.
 *
 * The decision module it replaces (core/requestBudget) keeps the reasoning and
 * the tests for the NUMBER, which is the part no library can choose.
 */
const limitExpensive = rateLimit({
  windowMs: EXPENSIVE_ROUTE_WINDOW_MS,
  limit: EXPENSIVE_ROUTE_LIMIT,
  // Per route AND per id, not per route alone. Keyed by pattern only, every
  // card shares one git-status budget, so two split panes polling two worktrees
  // spend each other's allowance and the app throttles itself.
  /*
   * `ipKeyGenerator`, not `req.ip` raw.
   *
   * express-rate-limit REFUSES a custom key built from a bare `req.ip`, and it
   * is right to: an IPv6 client takes a fresh address out of its /64 whenever
   * it likes, so keying on the exact address hands every one of them a private
   * budget and the limit stops limiting. The helper normalises to the prefix.
   *
   * It threw ERR_ERL_KEY_GEN_IPV6 at module load, which is before anything
   * listens - so the desktop app waited sixty times for a server that was never
   * going to answer. Every test was green, because the suite imports `app`
   * rather than booting the process. serverBoots.test.ts now covers that gap.
   */
  keyGenerator: (req: any) => `${ipKeyGenerator(req.ip ?? '127.0.0.1')}\u0000${req.route?.path ?? req.path}\u0000${req.params?.id ?? ''}`,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req: any, res: any) => {
    /*
     * The message names the ceiling and the likely cause. A bare 429 on a
     * local-only server reads as a bug in the server, and the caller is almost
     * always a loop in something the same person is writing.
     */
    res.status(429).json({
      error: `Too many requests to ${req.path}. This route is capped at ${EXPENSIVE_ROUTE_LIMIT} a minute: `
        + 'it does real work per call, or records a person\'s authority. '
        + 'If this was not a loop, say so on the card.',
    });
  },
});

app.get("/items/:id/git-status", limitExpensive, asyncHandler(async (req: any, res: any) => {
  const item: any = await storage.getItem(req.params.id);
  if (!item) return res.status(404).json({ error: "Item not found" });

  const cwd = item.worktreePath;
  if (!cwd || !fs.existsSync(cwd)) {
    // Never the server's own cwd: that would report the state of whatever
    // repository the server happens to be running in — confidently, and about
    // the wrong tree.
    return res.status(409).json({ error: "This item has no worktree on disk yet." });
  }

  try {
    /*
     * ASYNC, and the comment this replaces is why. It said "the server is
     * single-threaded and this runs on its event loop" and then ran
     * `execFileSync` anyway — so each call held the entire server still for
     * its duration. The panel refetches every four seconds and is always
     * shown: around nine hundred forks an hour, during each of which there is
     * no REST and no Socket.io, including the `resolveWorktree` calls that
     * opening a terminal depends on.
     *
     * See gitStatus.ts; the exec is injectable there so the non-blocking
     * property is something a test can actually observe.
     */
    res.json(await readGitStatus(cwd));
  } catch (e: any) {
    // An empty status would read as a clean tree, which is a lie about a
    // directory that is not a repository at all.
    res.status(409).json({ error: `Could not read the worktree: ${e?.message ?? 'git failed'}` });
  }
}));

/**
 * List a directory inside a session's worktree (CGLAB-175).
 *
 * The containment is the feature. This server listens on loopback with no
 * authentication and its CORS allowlist trusts any localhost origin, so an
 * endpoint that lists an arbitrary directory is filesystem read access for
 * any page open in the user's browser.
 *
 * Checked against the RESOLVED path — realpath — not by looking for `..` in
 * the string. A lexical check is defeated by a symlink, which git worktrees
 * and node_modules are full of, and by an absolute path, which contains no
 * `..` at all. Both the root and the candidate are resolved, because a
 * worktree can itself sit behind a symlink (/tmp is one on macOS) and
 * comparing a resolved path against an unresolved root refuses everything.
 */
app.get("/items/:id/files", limitExpensive, asyncHandler(async (req: any, res: any) => {
  const item: any = await storage.getItem(req.params.id);
  if (!item) return res.status(404).json({ error: "Item not found" });
  if (!item.worktreePath || !fs.existsSync(item.worktreePath)) {
    return res.status(409).json({ error: "This item has no worktree on disk yet." });
  }

  let root: string;
  let target: string;
  try {
    root = fs.realpathSync(item.worktreePath);
    const asked = typeof req.query?.path === 'string' && req.query.path ? req.query.path : root;
    // Resolved relative to the ROOT, never to the server's cwd.
    target = fs.realpathSync(path.resolve(root, asked));
  } catch {
    // A path that cannot be resolved does not exist, and saying which of
    // "missing" or "forbidden" it was would answer questions about the
    // filesystem outside the worktree.
    return res.status(403).json({ error: "Not a readable path inside this worktree." });
  }

  /*
   * The CHECKED value is the one used from here on. `safe` and `target` hold
   * the same string today; the point is that there is no longer a way to read
   * the unchecked one by accident - a second `fs` call added below cannot
   * silently skip the guard, because the only path in scope that is not `null`
   * is the one that passed.
   */
  const safe = containedPath(root, target);
  if (safe === null) {
    return res.status(403).json({ error: "Refusing to read outside the worktree." });
  }

  try {
    const entries = fs.readdirSync(safe, { withFileTypes: true })
      // .git is machinery, not the user's work, and listing it invites
      // walking into it.
      .filter(e => e.name !== '.git')
      .map(e => ({
        name: e.name,
        // A symlink is reported as what it IS, not as what it points at: a
        // caller that treats it as a directory would ask to descend, and that
        // request is refused by the check above rather than silently followed.
        kind: e.isDirectory() ? 'directory' : e.isSymbolicLink() ? 'symlink' : 'file',
      }))
      .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1));
    res.json({ path: path.relative(root, safe), entries });
  } catch (e: any) {
    res.status(409).json({ error: `Could not read that directory: ${e?.message ?? 'failed'}` });
  }
}));

/**
 * The DIFF of one file in the item's worktree.
 *
 * The panel could say a file changed and never what changed, so answering
 * "what did this agent just do" meant leaving the app and running git by hand -
 * which is the thing the panel exists to avoid.
 *
 * CONTAINMENT, and it is lexical on purpose. `isInsideRoot` collapses `..`
 * because the file may be DELETED, and a deleted path cannot be realpath'd;
 * the resulting pathspec is handed to git as an ARGUMENT (execFile, never a
 * shell), and git confines a pathspec to its own repository. Between the two,
 * nothing here reads or runs outside the worktree.
 */
app.get("/items/:id/diff", limitExpensive, asyncHandler(async (req: any, res: any) => {
  const item: any = await storage.getItem(req.params.id);
  if (!item) return res.status(404).json({ error: "Item not found" });
  if (!item.worktreePath || !fs.existsSync(item.worktreePath)) {
    return res.status(409).json({ error: "This item has no worktree on disk yet." });
  }
  const asked = typeof req.query?.path === 'string' ? req.query.path : '';
  if (!asked) return res.status(400).json({ error: "path is required" });
  const staged = req.query?.staged === 'true';

  let root: string;
  try { root = fs.realpathSync(item.worktreePath); }
  catch { return res.status(409).json({ error: "This item's worktree is not readable." }); }

  const safe = containedPath(root, path.resolve(root, asked));
  if (safe === null) {
    return res.status(403).json({ error: "Refusing to diff outside the worktree." });
  }
  const rel = path.relative(root, safe);

  // A whole generated file can be megabytes; the reader wants the shape, not
  // the payload. Truncated rather than refused, and SAID rather than silently.
  const MAX = 400_000;
  const run = (args: string[]): string => execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', maxBuffer: MAX * 2, stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    let diff = run(['diff', ...(staged ? ['--cached'] : []), '--', rel]);
    if (!diff && !staged && fs.existsSync(safe)) {
      // UNTRACKED: `git diff` ignores it, so show the whole file as added.
      // --no-index exits 1 when there is a difference, so the output arrives
      // on the throw.
      try { diff = run(['diff', '--no-index', '--', '/dev/null', rel]); }
      catch (e: any) { diff = e?.stdout ?? ''; }
    }
    if (diff.length > MAX) diff = `${diff.slice(0, MAX)}\n… diff truncated\n`;
    res.json({ path: rel, staged, diff });
  } catch (e: any) {
    const why = (e?.stderr || e?.message || 'failed').toString();
    res.status(409).json({ error: `Could not diff that file: ${why.slice(0, 300)}` });
  }
}));

/**
 * Start a task from a branch, in one action (CGLAB-179).
 *
 * A composition, not new machinery — the card's own reading and it is right:
 * creating the item, naming the branch, cutting the worktree and recording
 * which agent to use are four steps a person does by hand, and three of them
 * are bookkeeping.
 *
 * What a composition has to get right is the failure in the middle. A card
 * with a branch name and no worktree LOOKS finished, and the user has no way
 * to tell which of the four steps did not happen — so if the worktree cannot
 * be cut, the item is removed and the call fails. Half a task is worse than
 * none.
 */
app.post("/projects/:id/tasks-from-branch", asyncHandler(async (req: any, res: any) => {
  const project: any = await storage.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const { title, branchName, agentId, type, description } = req.body ?? {};
  if (typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: "title (string) required" });
  }
  if (agentId !== undefined && !(TERMINAL_AGENT_IDS as readonly string[]).includes(agentId)) {
    // The launchable set is a closed list and a security boundary: recording
    // something outside it either fails at spawn or becomes a way to influence
    // what runs.
    return res.status(400).json({ error: `agentId must be one of: ${TERMINAL_AGENT_IDS.join(", ")}` });
  }

  const itemType = typeof type === 'string' && ['STORY', 'TASK', 'BUG'].includes(type) ? type : 'TASK';
  // Derived from the title when not given, by the same rule the CLI uses, so
  // the two do not produce different branches for the same card.
  const branch = typeof branchName === 'string' && branchName.trim()
    ? branchName.trim()
    : buildBranchName(itemType as ItemType, title);

  // Built the same way POST /items builds one, so a card made here is
  // indistinguishable from a card made there — a composition that produces a
  // subtly different item is how two code paths start disagreeing.
  const created: any = await storage.createItem({
    id: uuidv4(),
    projectId: project.id,
    type: itemType as ItemType,
    title: title.trim(),
    description: typeof description === 'string' ? description : "",
    status: Status.TODO,
    parentId: undefined,
    implementationPlan: "",
    branchName: branch,
    ...(agentId ? { agentId } : {}),
    createdAt: new Date(),
    updatedAt: new Date(),
  } as any);

  try {
    if (!project.projectRoot) {
      throw Object.assign(new Error('Project has no projectRoot. Set it before creating a worktree.'), { statusCode: 400 });
    }
    const result = createWorktree({
      repoRoot: project.projectRoot,
      root: defaultWorktreeRoot(),
      branchName: branch,
      setupCommand: project.setupCommand,
    });
    const withWorktree = await storage.updateItem(created.id, {
      worktreePath: result.path,
      branchName: branch,
    } as any);
    if (req.headers['x-agenfk-internal'] === VERIFY_TOKEN && result.created) {
      startWorktreeSetup(withWorktree, result.setup, result.path);
    } else if (!result.setup.ready) {
      await noteOnItem(withWorktree.id, result.setup.notice);
    }
    io.emit('items_updated');
    res.status(201).json({ item: withWorktree, worktree: result });
  } catch (e: any) {
    // Rolled back rather than left half-made. The item only exists to hold a
    // worktree that does not exist, and leaving it would put a card on the
    // board that silently is not what it appears to be.
    await storage.deleteItem(created.id).catch(() => {});
    res.status(e?.statusCode ?? 400).json({ error: e?.message ?? 'Could not create the worktree' });
  }
}));

app.get("/terminal-sessions", asyncHandler(async (req: any, res: any) => {
  const projectId = typeof req.query?.projectId === 'string' ? req.query.projectId : undefined;
  const sessions = await storage.listTerminalSessions(projectId);
  // Filtered here rather than cascaded on delete. `DELETE /items/:id` does not
  // delete — it TRASHES — so a delete-time cascade simply never ran, and a
  // trashed card can come back. Checking availability at read time covers
  // every route by which a card can stop being available, including ones that
  // do not exist yet, and it is the moment that actually matters: the caller
  // is about to try to open these.
  const alive = await Promise.all(sessions.map(async s => {
    const item = await storage.getItem(s.itemId);
    // TRASHED, not absent: deleting a card sets its status rather than removing
    // the row, so checking existence alone would keep offering terminals for
    // cards the user threw away. The row stays, so restoring the card from the
    // trash brings its terminals back with it.
    if (!item || item.status === Status.TRASHED) return null;
    // The item is already loaded here, so its title costs nothing and saves the
    // caller a second round trip. Without it the desktop had no name for a
    // restored tab and fell back to the raw item id — a uuid where a card title
    // belongs, on every tab and in the header.
    return { ...s, itemTitle: item.title };
  }));
  res.json(alive.filter(Boolean));
}));

app.post("/terminal-sessions", asyncHandler(async (req: any, res: any) => {
  const { itemId, projectId, agentId, agentSessionId, persist, autoApprove } = req.body ?? {};
  if (typeof itemId !== 'string' || !itemId) {
    return res.status(400).json({ error: "itemId (string) required" });
  }
  if (typeof agentId !== 'string' || !(TERMINAL_AGENT_IDS as readonly string[]).includes(agentId)) {
    // The launchable set is a closed list and a security boundary. A row naming
    // something outside it either fails at restore or becomes a way to
    // influence what gets spawned.
    return res.status(400).json({
      error: `agentId must be one of: ${TERMINAL_AGENT_IDS.join(", ")}`,
    });
  }
  if (agentSessionId !== undefined && agentSessionId !== null) {
    // Refused, never escaped or coerced — the same posture tmuxSessionName
    // takes with a session name, and for the same reason: this string is
    // handed to a process as an argument.
    if (typeof agentSessionId !== 'string' || !UUID_RE.test(agentSessionId)) {
      return res.status(400).json({ error: "agentSessionId must be a UUID" });
    }
  }
  const item = await storage.getItem(itemId);
  if (!item) {
    // Caught here rather than at restore, which would fail at the least
    // helpful moment there is: app startup.
    return res.status(404).json({ error: "Item not found" });
  }
  const session = await storage.recordTerminalSession({
    id: crypto.randomUUID(),
    itemId,
    projectId: typeof projectId === 'string' ? projectId : item.projectId,
    agentId,
    agentSessionId: typeof agentSessionId === 'string' ? agentSessionId : undefined,
    /*
     * Both are part of the session's IDENTITY, not preferences (BUG 63fcf702).
     *
     * `persist` decides whether the terminal lives inside tmux at all, and
     * `autoApprove` is baked into the tmux session NAME. A restore that does
     * not know them puts the tab back outside tmux, orphaning the session that
     * survived — or looks for the "ask" variant of a session created as "auto"
     * and finds nothing.
     *
     * `=== true` rather than truthy: these reach a session name and a spawn
     * decision, and the string "false" is truthy.
     */
    persist: persist === true,
    autoApprove: autoApprove === true,
    openedAt: new Date().toISOString(),
  });
  io.emit('items_updated');
  res.status(201).json(session);
}));

app.delete("/terminal-sessions/:id", asyncHandler(async (req: any, res: any) => {
  // Closing a tab is the user saying they are done with it. Restoring it on
  // the next launch would be the app arguing.
  await storage.forgetTerminalSession(req.params.id);
  io.emit('items_updated');
  res.status(204).end();
}));

app.get("/settings", asyncHandler(async (_req: any, res: any) => {
  // Always 200 with the defaults. A fresh install has nothing stored, and a
  // 404 would push every caller into inventing its own idea of the default.
  res.json(await storage.getSettings());
}));

app.put("/settings", asyncHandler(async (req: any, res: any) => {
  const body = req.body || {};
  const allowed = Object.keys(DEFAULT_APP_SETTINGS);
  const unknown = Object.keys(body).filter(k => !allowed.includes(k));
  if (unknown.length > 0) {
    // Refused rather than ignored. Silently dropping a key means a typo writes
    // a setting nothing ever reads back, and the user is left believing they
    // changed something. Naming the key is what makes it fixable.
    return res.status(400).json({
      error: `Unknown setting(s): ${unknown.join(", ")}. Known: ${allowed.join(", ")}`,
    });
  }
  const patch: Record<string, unknown> = {};
  for (const key of allowed) {
    if (!(key in body)) continue;
    // Type-checked, never coerced: 'false' is a truthy string, and coercing it
    // would switch a feature ON for a client trying to switch it off.
    if (typeof body[key] !== typeof (DEFAULT_APP_SETTINGS as any)[key]) {
      return res.status(400).json({
        error: `Setting "${key}" must be ${typeof (DEFAULT_APP_SETTINGS as any)[key]}, got ${typeof body[key]}`,
      });
    }
    /*
     * And for a setting with a fixed set of values, that the value is one of
     * them. `typeof` alone is blind here: 'always' and 'whenever' are both
     * strings, so without this the second is accepted, stored, read back, and
     * then falls through every `=== 'always'` comparison in the UI to behave as
     * the other option. A choice the user made that quietly means something
     * else is worse than a rejected write.
     *
     * Checked for EVERY key before anything is written, so a rejected request
     * cannot land the valid half of the batch — the storage write is one
     * transaction, but the validation has to be too.
     */
    if (!isLegalSettingValue(key as keyof AppSettings, body[key])) {
      return res.status(400).json({
        error: `Setting "${key}" cannot be ${JSON.stringify(body[key])}.`,
      });
    }
    patch[key] = body[key];
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: `Provide at least one of: ${allowed.join(", ")}` });
  }
  const settled = await storage.updateSettings(patch);
  // The whole settled state, so a caller never has to re-read to find out what
  // it now has.
  io.emit("settings_updated", settled);
  res.json(settled);
}));

app.get("/projects/:id", asyncHandler(async (req: any, res: any) => {
  const project = await storage.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: "Project not found" });
  res.json(project);
}));

app.put("/projects/:id", asyncHandler(async (req: any, res: any) => {
  // Allowlist the mutable fields. Passing req.body straight through let an
  // unauthenticated caller overwrite verifyCommand (a shell string later run
  // by validate_progress), projectRoot (its cwd) and flowId — mass assignment
  // → RCE. verifyCommand has its own internal-only endpoint below; flowId has
  // POST /projects/:id/flow. (Security: bug e60e20aa.)
  // autoWorktree joins the allowlist because it is a boolean preference with
  // no execution semantics: the worst a caller can do is turn worktree
  // creation on or off. projectRoot and verifyCommand stay out — those are a
  // cwd and a shell string.
  const updates: Partial<{ name: string; description: string; autoWorktree: boolean }> = {};
  if (typeof req.body?.name === 'string') updates.name = req.body.name;
  if (typeof req.body?.description === 'string') updates.description = req.body.description;
  if (typeof req.body?.autoWorktree === 'boolean') updates.autoWorktree = req.body.autoWorktree;
  // tmuxByDefault deliberately does NOT belong here. It was project-scoped for
  // one commit; the decision changed to installation-wide, and it now lives at
  // PUT /settings. Accepting it in both places would give one preference two
  // sources of truth, so whichever the UI read, the other would silently
  // disagree — worse than either home alone.
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "Provide at least one of: name, description, autoWorktree. (verifyCommand: PUT /projects/:id/verify-command; flowId: POST /projects/:id/flow)" });
  }
  try {
    const updated = await storage.updateProject(req.params.id, updates);
    io.emit('items_updated');
    res.json(updated);
  } catch (error) {
    res.status(404).json({ error: "Project not found" });
  }
}));

// verifyCommand is a shell string executed by validate_progress on the final
// step, so setting it is privileged. Gate it with the install-time secret like
// /backup — only a local trusted caller (the CLI, which reads
// ~/.agenfk/verify-token) may set it, never a browser or LAN peer. (bug e60e20aa.)
app.put("/projects/:id/verify-command", asyncHandler(async (req: any, res: any) => {
  if (req.headers['x-agenfk-internal'] !== VERIFY_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const { verifyCommand } = req.body ?? {};
  if (typeof verifyCommand !== 'string') {
    return res.status(400).json({ error: "verifyCommand (string) required" });
  }
  try {
    const before: any = await storage.getProject(req.params.id);
    const previous = before?.verifyCommand as string | undefined;
    const changed = !!before && previous !== verifyCommand;
    // Kept on the project as well as on cards: with no card in flight, a card
    // note alone would leave no trace of the change at all.
    const updated = await storage.updateProject(req.params.id, {
      verifyCommand,
      ...(changed ? { verifyCommandChanges: [...(before.verifyCommandChanges ?? []), { from: previous ?? null, to: verifyCommand, at: new Date().toISOString() }] } : {}),
    } as any);
    /*
     * CGLAB-378: the final step runs this command and nothing else, so
     * changing it changes what every card in flight will be held to. Anyone
     * holding the internal token can change it - swapping in `true` is the
     * obvious cheat - so the change is written on each of those cards, where
     * the people reading the board will see it.
     */
    if (changed) {
      const shown = (c?: string) => (c ? `\`${c}\`` : '(none)');
      await noteGateChangeOnCards(before, 'Project verify command changed', `From ${shown(previous)} to ${shown(verifyCommand)}. This card's final step now runs the new command.`);
    }
    io.emit('items_updated');
    res.json(updated);
  } catch (error) {
    res.status(404).json({ error: "Project not found" });
  }
}));

/**
 * Write a note on every card of `project` that is in flight: in an active
 * working step, or parked on PAUSED/BLOCKED (pausing is the obvious way to
 * dodge a note). Used for changes to the settings that decide what a gate
 * checks (CGLAB-378, CGLAB-379).
 */
async function noteGateChangeOnCards(project: any, heading: string, body: string): Promise<void> {
  const flow = getActiveFlow(project.flowId, await storage.listFlows());
  const items: any[] = await storage.listItems({ projectId: project.id, limit: 1_000_000 } as any);
  const active = new Set(getActiveStepItems(items as any, flow as any).map((i: any) => i.id));
  for (const it of items.filter(i => active.has(i.id) || i.status === Status.PAUSED || i.status === Status.BLOCKED)) {
    await noteOnItem(it.id, `### ${heading}\n\n${body}`);
  }
}

// ── Test reports and step records (CGLAB-379) ────────────────────────────────

const TEST_REPORT_FORMATS = new Set(['vitest-json', 'junit-xml']);
type TestReportSetting = { format: string; command: string; reportPath: string; surface?: string[] };

/**
 * How the server gets per-test results for a project: a command that writes a
 * report, where it writes it, and in which format. A shell string the server
 * runs, so it is set behind the internal token like verifyCommand, and every
 * change is recorded on the project and on the cards in flight.
 */
app.put("/projects/:id/test-report", asyncHandler(async (req: any, res: any) => {
  if (req.headers['x-agenfk-internal'] !== VERIFY_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const body = req.body ?? {};
  let next: TestReportSetting | null;
  if (Object.prototype.hasOwnProperty.call(body, 'testReport') && body.testReport === null) {
    next = null;
  } else {
    const { format, command, reportPath, surface } = body;
    const text = (v: unknown) => typeof v === 'string' && v.trim().length > 0;
    if (!TEST_REPORT_FORMATS.has(format) || !text(command) || !text(reportPath)) {
      return res.status(400).json({ error: `testReport needs format (${[...TEST_REPORT_FORMATS].join(' | ')}), command and reportPath, or { "testReport": null } to clear it.` });
    }
    if (surface !== undefined && !(Array.isArray(surface) && surface.every(text))) {
      return res.status(400).json({ error: 'testReport.surface must be an array of paths (files or directories) relative to the tree: helpers, fixtures and setup files the tests depend on.' });
    }
    next = { format, command, reportPath, ...(surface !== undefined ? { surface } : {}) };
  }
  const before: any = await storage.getProject(req.params.id);
  if (!before) return res.status(404).json({ error: "Project not found" });
  const previous: TestReportSetting | null = before.testReport ?? null;
  const changed = JSON.stringify(previous) !== JSON.stringify(next);
  const updated = await storage.updateProject(req.params.id, {
    testReport: next ?? undefined,
    ...(changed ? { testReportChanges: [...(before.testReportChanges ?? []), { from: previous, to: next, at: new Date().toISOString() }] } : {}),
  } as any);
  if (changed) {
    const shown = (t: TestReportSetting | null) => (t ? `${t.format} from \`${t.command}\` (${t.reportPath})${t.surface?.length ? `, test paths ${t.surface.join(', ')}` : ''}` : '(none)');
    await noteGateChangeOnCards(before, 'Project test report changed', `From ${shown(previous)} to ${shown(next)}. Checks that read per-test results now use it.`);
  }
  io.emit('items_updated');
  res.json(updated);
}));

/**
 * CGLAB-382 — human gates. An approval is a person's go-ahead for the card's
 * current step; an override is their pass of ONE check that blocked the card's
 * last verify, with a written reason. Both are made on the board: a request
 * without the board header, or carrying the agent's internal token, is
 * refused. The header is forgeable by any same-user process until CGLAB-383
 * gives approvals an authority the agent cannot reach.
 *
 * Both are server-written step records of the current step, so PUT cannot
 * forge one, and a rollback over the step drops them like the step's other
 * records: a card that comes back needs a fresh go-ahead.
 */
/** A card's approvals of one step, as the board recorded them. */
const approvalsAt = (card: any, step: string) => (card?.stepRecords ?? [])
  .filter((r: any) => r?.kind === 'approval' && r.step === step)
  .map((r: any) => ({ by: String(r.by ?? 'board'), at: String(r.at), ...(r.note ? { note: String(r.note) } : {}), ...(r.authority ? { authority: String(r.authority) } : {}) }));

/**
 * Approvals of the same step on a card's ancestors, nearest first - only those
 * that covered this card when they were given (CGLAB-383 review): a card moved
 * under an approved one later is not approved with it.
 */
async function ancestorApprovals(card: any, step: string): Promise<Array<{ by: string; at: string; note?: string; authority?: string; from: string }>> {
  const out: Array<{ by: string; at: string; note?: string; authority?: string; from: string }> = [];
  let cur: any = card?.parentId ? await storage.getItem(card.parentId) : null;
  for (let depth = 0; cur && depth < 16; depth++) {
    const covering = (cur.stepRecords ?? []).filter((r: any) => r?.kind === 'approval' && r.step === step && Array.isArray(r.covers) && r.covers.includes(card.id));
    for (const a of approvalsAt({ stepRecords: covering }, step).reverse()) out.push({ ...a, from: cur.id });
    cur = cur.parentId ? await storage.getItem(cur.parentId) : null;
  }
  return out;
}

/** Would the card's human-approval check on this step pass? False when the step asks for one nobody gave. */
async function approvalSatisfied(card: any, steps: any[], step: string): Promise<boolean> {
  const check = resolveStepChecks(steps, step).find(c => c.id === 'human-approval' && c.applicable);
  if (!check) return true;
  const counts = (a: { authority?: string }) => check.params.signature !== 'passkey' || a.authority === 'passkey';
  if (approvalsAt(card, step).some(counts)) return true;
  return check.params.appliesTo !== 'every-card' && (await ancestorApprovals(card, step)).some(counts);
}

function refuseUnlessBoard(req: any, res: any): boolean {
  if (req.headers['x-agenfk-internal'] !== undefined || req.headers['x-agenfk-ui'] !== '1') {
    res.status(403).json({ error: 'Approvals and overrides are made by a person on the board (agenfk ui), never by an agent.' });
    return true;
  }
  return false;
}

/** The card, its active flow, and the step the request names, or the refusal already sent. */
async function gateTarget(req: any, res: any): Promise<{ item: any; flow: Flow } | null> {
  const item: any = await storage.getItem(req.params.id);
  if (!item) { res.status(404).json({ error: 'Item not found' }); return null; }
  const step = req.body?.step;
  if (step !== undefined && step !== item.status) {
    res.status(409).json({ error: `The card is on ${item.status}, not ${String(step)}: refresh the board and try again.` });
    return null;
  }
  const project: any = await storage.getProject(item.projectId);
  return { item, flow: getActiveFlow(project?.flowId, await storage.listFlows()) };
}

const gateText = (v: unknown, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * A card's history of its checks, approvals and overrides (4a428bb0): what the
 * board's Checks tab shows. A log, not live state - unlike step records, a
 * rollback never drops it - kept to the latest CHECK_HISTORY_MAX entries.
 * Server-written only: PUT /items/:id takes an allow-list without it.
 */
const CHECK_HISTORY_MAX = 100;
const withHistory = (fresh: any, entry: Record<string, unknown>) => [...(Array.isArray(fresh?.checkHistory) ? fresh.checkHistory : []), entry].slice(-CHECK_HISTORY_MAX);
const gateEntry = (rec: any) => ({
  kind: rec.kind, step: rec.step, at: rec.at, by: rec.by, authority: rec.authority,
  ...(rec.note ? { note: rec.note } : {}), ...(rec.check ? { check: rec.check, reason: rec.reason } : {}),
});

async function appendGateRecord(item: any, rec: any, comment: string) {
  const fresh: any = await storage.getItem(item.id);
  await storage.updateItem(item.id, {
    stepRecords: [...(fresh?.stepRecords ?? []), rec],
    checkHistory: withHistory(fresh, gateEntry(rec)),
    comments: [...(fresh?.comments ?? []), { id: uuidv4(), author: 'Board', content: comment, timestamp: new Date(), step: item.status }],
  } as any);
  io.emit('items_updated');
}

/**
 * What the board shows for the card's current step: whether it waits for a
 * go-ahead, the approvals and overrides given on it, and the last verify's
 * checks - only when they were run on THIS step, so a previous step's results
 * never pose as the current one's.
 */
/*
 * CGLAB-383 — passkeys on the board. Once one is enrolled, approvals and
 * overrides need an assertion over a challenge bound to the act; the board
 * header alone no longer suffices. The first passkey is trust-on-first-use
 * (announced as a hub event); adding or removing one needs an assertion from
 * a passkey already enrolled.
 */
/**
 * Where the board runs, and so the only origins a passkey signature is
 * accepted from (CGLAB-383 review): the server itself when it serves the UI
 * (the desktop app, reached on localhost), else the UI's own port.
 */
function boardOrigins(): string[] {
  const env = process.env.AGENFK_BOARD_ORIGINS;
  if (env) return env.split(',').map(s => s.trim()).filter(Boolean);
  if (servedUiDir) return boundPort ? [`http://localhost:${boundPort}`] : [];
  return [`http://localhost:${process.env.VITE_PORT || 5173}`];
}

app.get("/webauthn/status", (_req: any, res: any) => {
  const creds = passkeys.loadCredentials();
  res.json({ enrolled: creds.length > 0, rpId: passkeys.RP_ID, credentials: creds.map(c => ({ id: c.id, createdAt: c.createdAt ?? null })) });
});

app.post("/webauthn/challenge", (req: any, res: any) => {
  if (refuseUnlessBoard(req, res)) return;
  const b = req.body ?? {};
  if (!passkeys.isPurpose(b.purpose)) return res.status(400).json({ error: 'purpose must be one of enroll, add-passkey, remove, approval, override' });
  const act: passkeys.Act = {
    purpose: b.purpose,
    ...(typeof b.itemId === 'string' ? { itemId: b.itemId } : {}),
    ...(typeof b.step === 'string' ? { step: b.step } : {}),
    ...(gateText(b.note) ? { note: gateText(b.note) } : {}),
    ...(typeof b.checkId === 'string' ? { checkId: b.checkId } : {}),
    ...(gateText(b.reason) ? { reason: gateText(b.reason) } : {}),
    ...(typeof b.credentialId === 'string' ? { credentialId: b.credentialId } : {}),
    ...(typeof b.publicKey === 'string' ? { publicKey: b.publicKey } : {}),
  };
  const creds = passkeys.loadCredentials();
  res.json({ challenge: passkeys.issueChallenge(act), rpId: passkeys.RP_ID, allowCredentials: creds.map(c => c.id) });
});

app.post("/webauthn/credentials", limitExpensive, (req: any, res: any) => {
  if (refuseUnlessBoard(req, res)) return;
  const reg = req.body?.registration;
  let cred: ReturnType<typeof passkeys.verifyRegistration>;
  try {
    if (!passkeys.consumeChallenge(passkeys.challengeOf(reg?.clientDataJSON), { purpose: 'enroll' })) throw new Error('the enrollment challenge is unknown, used or expired: start again');
    cred = passkeys.verifyRegistration(reg, passkeys.challengeOf(reg.clientDataJSON)!, boardOrigins());
  } catch (e: any) { return res.status(400).json({ error: e?.message ?? String(e) }); }
  const creds = passkeys.loadCredentials();
  if (creds.some(c => c.id === cred.id)) return res.status(409).json({ error: 'This passkey is already enrolled.' });
  if (creds.length) {
    try { passkeys.authorise(req.body?.assertion, { purpose: 'add-passkey', credentialId: cred.id, publicKey: cred.publicKey }, boardOrigins()); } catch (e: any) {
      return res.status(401).json({ error: `Adding a passkey needs a signature from one already enrolled: ${e?.message ?? e}` });
    }
  }
  const stored = { ...cred, signCount: 0, createdAt: new Date().toISOString() };
  passkeys.saveCredentials([...passkeys.loadCredentials(), stored]);
  recordHubEvent({ type: 'passkey.enrolled', payload: { credentialId: cred.id, first: creds.length === 0 } });
  res.status(201).json({ id: stored.id, createdAt: stored.createdAt });
});

app.delete("/webauthn/credentials/:credId", limitExpensive, (req: any, res: any) => {
  if (refuseUnlessBoard(req, res)) return;
  const id = req.params.credId;
  if (!passkeys.loadCredentials().some(c => c.id === id)) return res.status(404).json({ error: 'No such passkey.' });
  try { passkeys.authorise(req.body?.assertion, { purpose: 'remove', credentialId: id }, boardOrigins()); } catch (e: any) {
    return res.status(401).json({ error: `Removing a passkey needs a signature from an enrolled one: ${e?.message ?? e}` });
  }
  passkeys.saveCredentials(passkeys.loadCredentials().filter(c => c.id !== id));
  recordHubEvent({ type: 'passkey.removed', payload: { credentialId: id } });
  res.json({ removed: id });
});

/**
 * The authority behind a human gate. A step whose human-approval check asks
 * for `signature: passkey` needs an assertion for exactly this act, and so do
 * overrides on that step; elsewhere the board's word is recorded as
 * 'unverified' (an assertion offered anyway is still checked).
 */
const stepWantsPasskey = (flow: Flow, step: string) =>
  resolveStepChecks(flow.steps, step).some(c => c.id === 'human-approval' && c.applicable && c.params.signature === 'passkey');

function gateAuthority(req: any, res: any, act: passkeys.Act, required: boolean): { authority: 'passkey'; credentialId: string } | { authority: 'unverified' } | null {
  if (required && !passkeys.loadCredentials().length) {
    res.status(401).json({ error: 'Passkey required: this step asks for approvals signed with a passkey, and none is enrolled on this board yet. Enroll one on the board first.' });
    return null;
  }
  // Not asked for and not offered: the board's word, recorded as such.
  if (!required && !req.body?.assertion) return { authority: 'unverified' };
  try {
    const cred = passkeys.authorise(req.body?.assertion, act, boardOrigins());
    return { authority: 'passkey', credentialId: cred.id };
  } catch (e: any) {
    res.status(401).json({ error: `Passkey required: ${e?.message ?? e}` });
    return null;
  }
}

app.get("/items/:id/gates", asyncHandler(async (req: any, res: any) => {
  const item: any = await storage.getItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const project: any = await storage.getProject(item.projectId);
  const flow = getActiveFlow(project?.flowId, await storage.listFlows());
  const here = (item.stepRecords ?? []).filter((r: any) => r?.step === item.status);
  const overrides: Record<string, any> = {};
  for (const r of here) if (r.kind === 'override' && typeof r.check === 'string') overrides[r.check] = { id: r.id, by: r.by, at: r.at, reason: r.reason };
  const approval = resolveStepChecks(flow.steps, item.status).find(c => c.id === 'human-approval' && c.applicable);
  // A go-ahead given at a parent covers its children, unless the step asks every card for its own.
  const inherited = approval && approval.params.appliesTo !== 'every-card' ? await ancestorApprovals(item, item.status) : [];
  res.json({
    step: item.status,
    approvalRequired: !!approval,
    passkeyRequired: stepWantsPasskey(flow, item.status),
    // On a step that asks for a passkey only signed approvals count, so only they show.
    approvals: [
      ...here.filter((r: any) => r.kind === 'approval').map((r: any) => ({ id: r.id, by: r.by, at: r.at, ...(r.note ? { note: r.note } : {}), ...(r.authority ? { authority: r.authority } : {}) })),
      ...inherited,
    ].filter(a => !stepWantsPasskey(flow, item.status) || a.authority === 'passkey'),
    overrides,
    lastChecks: item.lastChecks?.step === item.status ? item.lastChecks : null,
    // C3b: which commands are approved here (hash and when), so a verify waiting
    // on ONE command wakes for that command, not for any approval in the project.
    commandApprovals: (Array.isArray(project?.commandApprovals) ? project.commandApprovals : [])
      .map((a: any) => ({ hash: String(a?.hash ?? ''), at: String(a?.at ?? '') })).filter((a: any) => a.hash),
  });
}));

/** Every approval and override on a card and its descendants, for the PR body (CGLAB-382). */
app.get("/items/:id/gate-events", asyncHandler(async (req: any, res: any) => {
  const root: any = await storage.getItem(req.params.id);
  if (!root) return res.status(404).json({ error: 'Item not found' });
  const events: any[] = [];
  const queue = [root];
  for (let seen = 0; queue.length && seen < 5000; seen++) {
    const card = queue.shift();
    for (const r of card.stepRecords ?? []) {
      if (r?.kind !== 'approval' && r?.kind !== 'override' && r?.kind !== 'manual-advance') continue;
      events.push({
        itemId: card.id, title: card.title, step: r.step, kind: r.kind, by: r.by, at: r.at, ...(r.to ? { to: r.to } : {}), ...(r.authority ? { authority: r.authority } : {}),
        ...(r.note ? { note: r.note } : {}), ...(r.check ? { check: r.check, reason: r.reason } : {}),
      });
    }
    queue.push(...((await storage.listItems({ parentId: card.id } as any)) as any[]));
  }
  res.json(events);
}));

/**
 * The custom checks a card tree passed its steps with, for the PR body (C3b).
 *
 * From each card's EXIT records: the results that let it leave a step, not
 * attempts that were refused. A command check names who approved its command
 * when the step asked for a person; an agent check is labelled as the agent's
 * word, because the server never checked it.
 */
app.get("/items/:id/custom-checks", asyncHandler(async (req: any, res: any) => {
  const root: any = await storage.getItem(req.params.id);
  if (!root) return res.status(404).json({ error: 'Item not found' });
  const rows: any[] = [];
  const queue = [root];
  for (let seen = 0; queue.length && seen < 5000; seen++) {
    const card = queue.shift();
    // The LAST exit per step and check: a step left again after a rollback supersedes the earlier result.
    const latest = new Map<string, any>();
    for (const r of card.stepRecords ?? []) {
      if (r?.kind !== 'exit' || !Array.isArray(r.checks)) continue;
      for (const c of r.checks) {
        const id = String(c?.id ?? '');
        const kind = id.startsWith('command-check:') ? 'command' : id.startsWith('agent-check:') ? 'agent' : null;
        if (!kind) continue;
        // What the check DID, from the facts stamped when it was judged - never from its wording.
        const m = c.meta ?? {};
        latest.set(`${r.step}\u0000${id}`, {
          itemId: card.id, title: card.title, step: r.step, check: id.slice(id.indexOf(':') + 1), kind,
          outcome: c.outcome, at: r.at,
          ...(kind === 'command' ? { ran: m.ran === true } : { reported: m.reported === true }),
          ...(m.note ? { note: m.note } : {}),
          ...(typeof c.detail === 'string' ? { detail: c.detail } : {}),
          ...(m.approval ? { approval: m.approval } : {}),
          ...(c.overridden ? { overridden: { by: c.overridden.by, reason: c.overridden.reason } } : {}),
        });
      }
    }
    rows.push(...latest.values());
    queue.push(...((await storage.listItems({ parentId: card.id } as any)) as any[]));
  }
  res.json(rows);
}));

/** The card's check history, newest first (4a428bb0). */
app.get("/items/:id/check-history", asyncHandler(async (req: any, res: any) => {
  const item: any = await storage.getItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  res.json([...(Array.isArray(item.checkHistory) ? item.checkHistory : [])].reverse());
}));

app.post("/items/:id/approvals", limitExpensive, asyncHandler(async (req: any, res: any) => {
  if (refuseUnlessBoard(req, res)) return;
  const target = await gateTarget(req, res);
  if (!target) return;
  const { item, flow } = target;
  if (!resolveStepChecks(flow.steps, item.status).some(c => c.id === 'human-approval' && c.applicable)) {
    return res.status(400).json({ error: `Step ${item.status} does not ask for an approval.` });
  }
  const note = gateText(req.body?.note);
  const authority = gateAuthority(req, res, { purpose: 'approval', itemId: item.id, step: item.status, ...(note ? { note } : {}) }, stepWantsPasskey(flow, item.status));
  if (!authority) return;
  // The cards this go-ahead covers: the card and its descendants as they are now.
  const covers: string[] = [];
  const queue = [item.id];
  while (queue.length && covers.length < 5000) {
    const kids: any[] = (await storage.listItems({ parentId: queue.shift() } as any)) as any;
    for (const k of kids) { covers.push(k.id); queue.push(k.id); }
  }
  const rec = { id: uuidv4(), step: item.status, kind: 'approval', at: new Date().toISOString(), head: null, clean: false, by: 'board', ...authority, ...(note ? { note } : {}), covers };
  await appendGateRecord(item, rec, `### Step approved\n\n**Step**: ${item.status} — a person approved it on the board.${note ? `\n\n${note}` : ''}`);
  recordHubEvent({ type: 'step.approved', projectId: item.projectId, itemId: item.id, payload: { step: item.status, by: 'board' } });
  res.status(201).json(rec);
}));

app.post("/items/:id/overrides", limitExpensive, asyncHandler(async (req: any, res: any) => {
  if (refuseUnlessBoard(req, res)) return;
  const checkId = req.body?.checkId;
  const reason = gateText(req.body?.reason);
  if (typeof checkId !== 'string' || !checkId) return res.status(400).json({ error: 'checkId is required: the check to pass.' });
  if (!reason) return res.status(400).json({ error: 'A reason is required: say why this check may be passed.' });
  const target = await gateTarget(req, res);
  if (!target) return;
  const { item, flow } = target;
  // The server's own entry hold is no flow check, but a person may pass it like one (5a8d22e6 review).
  if (checkId !== ENTRY_BASELINE && !resolveStepChecks(flow.steps, item.status).some(c => c.id === checkId)) {
    return res.status(400).json({ error: `Step ${item.status} does not run the check '${checkId}'.` });
  }
  const last = item.lastChecks;
  const blocked = last?.step === item.status ? (last.results ?? []).find((r: any) => r.id === checkId && r.blocking) : undefined;
  if (!blocked) {
    return res.status(409).json({ error: `'${checkId}' is not blocking this card on ${item.status}. Only a check that blocked the card's last verify can be overridden.` });
  }
  const authority = gateAuthority(req, res, { purpose: 'override', itemId: item.id, step: item.status, checkId, reason }, stepWantsPasskey(flow, item.status));
  if (!authority) return;
  const rec = { id: uuidv4(), step: item.status, kind: 'override', at: new Date().toISOString(), head: null, clean: false, by: 'board', ...authority, check: checkId, reason, detail: String(blocked.detail ?? '') };
  await appendGateRecord(item, rec, `### Check overridden\n\n**Step**: ${item.status}\n**Check**: ${checkId} — a person passed it on the board.\n\n**Reason**: ${reason}`);
  recordHubEvent({ type: 'check.overridden', projectId: item.projectId, itemId: item.id, payload: { step: item.status, check: checkId, reason, by: 'board' } });
  res.status(201).json(rec);
}));

/**
 * efcacdeb: a person's approval of a command check's exact argv for this
 * project, signed with a passkey on the board. The check runs once the argv's
 * hash is approved, and asks again when the command changes.
 */
app.post("/projects/:id/command-approvals", limitExpensive, asyncHandler(async (req: any, res: any) => {
  if (refuseUnlessBoard(req, res)) return;
  const project: any = await storage.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const argv = req.body?.argv;
  if (!Array.isArray(argv) || !argv.length || !argv.every((a: unknown) => typeof a === 'string' && a.length > 0)) {
    return res.status(400).json({ error: 'argv must be the command as a list of strings, exactly as the flow defines it.' });
  }
  const hash = argvHash(argv);
  const authority = gateAuthority(req, res, { purpose: 'command', itemId: project.id, checkId: hash }, true);
  if (!authority) return;
  const rec: CommandApproval = { hash, argv, at: new Date().toISOString(), by: 'board', ...(authority as any) };
  const approvals: CommandApproval[] = Array.isArray(project.commandApprovals) ? project.commandApprovals : [];
  await storage.updateProject(project.id, { commandApprovals: [...approvals.filter(a => a.hash !== hash), rec] } as any);
  recordHubEvent({ type: 'command.approved', projectId: project.id, payload: { hash, argv, by: 'board' } });
  io.emit('items_updated');
  res.status(201).json(rec);
}));

/**
 * Record an independent review of a card (CGLAB-381): the reviewer's
 * transcript, the commit range it reviewed, and what became of each finding.
 * The reviewer's identity is read from the transcript - never from the
 * request - and the transcript must have been written after the range's tip
 * commit, or it cannot have reviewed it. Server-written only: PUT
 * /items/:id never accepts `reviewRecords`.
 */
app.post("/items/:id/review-records", asyncHandler(async (req: any, res: any) => {
  if (req.headers['x-agenfk-internal'] !== VERIFY_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const item: any = await storage.getItem(req.params.id);
  if (!item) return res.status(404).json({ error: "Item not found" });
  const body = req.body ?? {};
  let reviewer: ReturnType<typeof readTranscriptIdentity>;
  let findings: ReturnType<typeof parseFindings>;
  try {
    reviewer = readTranscriptIdentity(body.transcript);
    findings = parseFindings(body.findings);
  } catch (e: any) {
    return res.status(400).json({ error: e?.message ?? String(e) });
  }
  const m = typeof body.range === 'string' ? /^\s*([^\s.]+)\.\.([^\s.]+)\s*$/.exec(body.range) : null;
  if (!m) return res.status(400).json({ error: 'range must be <from>..<to>: the commits the review covered' });
  const project: any = await storage.getProject(item.projectId);
  const root = resolveCommitRoot(await withEffectiveWorktree(item), project?.projectRoot).root;
  if (!root) return res.status(400).json({ error: 'This card has no tree to read the range from: set the project root or give the card a worktree.' });
  const git = (args: string[]) => gitRun.run(['-C', root, ...args]).trim();
  let from: string;
  let to: string;
  let tipAt: string;
  try {
    from = git(['rev-parse', '--verify', `${m[1]}^{commit}`]);
    to = git(['rev-parse', '--verify', `${m[2]}^{commit}`]);
    tipAt = git(['show', '-s', '--format=%cI', to]);
  } catch {
    return res.status(400).json({ error: `range ${body.range} names a commit this card's tree (${root}) does not have` });
  }
  try { git(['merge-base', '--is-ancestor', from, to]); } catch {
    return res.status(400).json({ error: `range ${body.range}: ${m[1]} is not an ancestor of ${m[2]}` });
  }
  // Both the records' own clock and the file's: either written before the
  // tip means the transcript cannot have reviewed it.
  const last = [reviewer.lastAt, reviewer.mtime].map(t => (t ? Date.parse(t) : NaN));
  if (last.some(t => Number.isNaN(t) || t < Date.parse(tipAt))) {
    return res.status(400).json({ error: `The transcript was last written ${reviewer.lastAt ?? 'at no recorded time'} (file: ${reviewer.mtime}), before the range's tip commit (${tipAt}): it cannot have reviewed it.` });
  }
  const rec = {
    id: uuidv4(), at: new Date().toISOString(),
    reviewer: { client: reviewer.client, sessionId: reviewer.sessionId, agentId: reviewer.agentId, transcript: reviewer.transcript, edits: reviewer.edits, advancedCards: reviewer.advancedCards },
    range: { from, to }, findings,
    // The tree as reviewed, uncommitted work included: a change after this
    // needs the review recorded again (CGLAB-381 review).
    tree: treeContentState(root, null),
  };
  const fresh: any = await storage.getItem(item.id);
  await storage.updateItem(item.id, { reviewRecords: [...(fresh?.reviewRecords ?? []), rec] } as any);
  io.emit('items_updated');
  res.status(201).json(rec);
}));

/** A card's step records: what each step left behind (exit) and any captured reports. */
app.get("/items/:id/step-records", asyncHandler(async (req: any, res: any) => {
  if (req.headers['x-agenfk-internal'] !== VERIFY_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const item: any = await storage.getItem(req.params.id);
  if (!item) return res.status(404).json({ error: "Item not found" });
  res.json(item.stepRecords ?? []);
}));

/** Run `command` in `cwd` without blocking the server; resolves to its exit code (null on a kill). */
function runForExitCode(command: string, cwd: string, maxMs: number, onOutput?: (chunk: string) => void): Promise<number | null> {
  return new Promise(resolve => {
    // Its own process group, killed whole: a runner's workers outlive a killed
    // shell, and a leftover one could write the NEXT capture's report.
    // 9569b4d7: its output streams to whoever follows the run - the agent's chat and the card - when asked.
    const child = spawn(command, { shell: true, cwd, stdio: onOutput ? ['ignore', 'pipe', 'pipe'] : 'ignore', detached: true });
    if (onOutput) for (const s of [child.stdout, child.stderr]) {
      // Whole characters only: a chunk can end inside a multi-byte one.
      const decoder = new StringDecoder('utf8');
      s?.on('data', (d: Buffer) => { const text = decoder.write(d); if (text) onOutput(text); });
    }
    const killGroup = () => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } };
    let grace: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      killGroup();
      resolve(code);
    };
    const timer = setTimeout(killGroup, maxMs);
    child.on('error', () => finish(null));
    // With pipes, 'close' waits for every process holding them - a runner's
    // leftover worker or server would hold the capture open (9569b4d7 review).
    // The shell's exit is the answer: kill what it left, let stdio drain briefly.
    child.on('exit', code => {
      killGroup();
      grace = setTimeout(() => finish(code), Math.min(KILL_GRACE_MS, 1000));
      if (typeof grace.unref === 'function') grace.unref();
    });
    child.on('close', code => finish(code));
  });
}

/**
 * The content of a tree as one hash: HEAD plus every tracked AND untracked
 * (non-ignored) file - new test files are usually untracked while they are
 * being written. `excludeRel` (the report being produced) is left out. Null
 * when the tree cannot be read (not a git repository, no commit yet, git
 * failed): the caller treats that as "cannot say", never as unchanged.
 */
function treeContentState(root: string, excludeRel: string | null): string | null {
  try {
    const git = (args: string[]) => execFileSync('git', ['-C', root, ...args], { maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    const head = git(['rev-parse', 'HEAD']).toString().trim();
    if (!head) return null;
    const files = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).toString().split('\0').filter(Boolean).sort();
    const h = crypto.createHash('sha256').update(head);
    for (const rel of new Set(files)) {
      if (rel === excludeRel) continue;
      const abs = path.join(root, rel);
      let digest = 'absent';
      try {
        const st = fs.lstatSync(abs);
        digest = st.isSymbolicLink() ? `link:${fs.readlinkSync(abs)}`
          : st.isFile() ? crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex') : 'other';
      } catch { /* deleted: 'absent' */ }
      h.update(`\0${rel}\0${digest}`);
    }
    return h.digest('hex');
  } catch {
    return null;
  }
}

/**
 * Capture a test report for the card's CURRENT step, in the tree its commands
 * run in, and store it as a step record. Driven by the checks that need one
 * (CGLAB-380); a check that needs none never pays for a suite run.
 *
 * With no testReport setting it falls back to the verify command's exit code,
 * and per-test results are then `available: false` - unavailable, never passed.
 *
 * Used by the endpoint below and by the check engine. Resolves to the stored
 * record, or to a refusal.
 */
type CaptureOutcome = { record: any } | { status: number; error: string; message: string };
async function captureStepRecord(item: any, opts?: { onOutput?: (chunk: string) => void }): Promise<CaptureOutcome> {
  const project: any = await storage.getProject(item.projectId);
  const root = resolveCommitRoot(await withEffectiveWorktree(item), project?.projectRoot).root;
  if (!root) {
    return { status: 400, error: 'NO_TREE', message: 'This card has no tree to run in: set the project root (agenfk verify from the repository sets it) or give the card a worktree.' };
  }
  const setting: TestReportSetting | undefined = project?.testReport;
  const command = setting?.command ?? project?.verifyCommand;
  if (!command) {
    return { status: 400, error: 'NO_REPORT_COMMAND', message: 'Nothing to run: set a test report (agenfk update-project <id> --test-report-...) or a verifyCommand.' };
  }

  const cleanSha = readCleanTreeSha(root, gitRun);
  const reused = await reusableCapture(item, project, root, cleanSha);
  if (reused) {
    const fresh: any = await storage.getItem(item.id);
    if (!fresh || fresh.status !== item.status) return { status: 409, error: 'CARD_MOVED', message: `The card moved (${item.status} -> ${fresh?.status ?? 'deleted'}); nothing was recorded.` };
    await storage.updateItem(item.id, { stepRecords: [...(fresh.stepRecords ?? []), reused] } as any);
    return { record: reused };
  }

  const record: any = {
    step: item.status, kind: 'capture', at: new Date().toISOString(),
    head: readHead(root, gitRun), clean: cleanSha !== null,
    format: setting ? setting.format : 'exit-code', available: false,
    // What ran, and where: a later card may reuse this record only for the same command in the same tree (961f301d).
    command, root,
  };
  // Inside the tree lexically AND through symlinks: a report path is never a
  // way to delete or read a file somewhere else.
  const insideTree = (abs: string): boolean => insideRoot(root, abs) !== null;
  let reportAbs: string | null = null;
  if (setting) {
    const abs = path.resolve(root, setting.reportPath);
    if (!insideTree(abs)) {
      record.parseError = `reportPath ${JSON.stringify(setting.reportPath)} is outside the tree`;
    } else {
      reportAbs = abs;
      // A report left by an earlier run must never be read as this one's.
      fs.rmSync(reportAbs, { force: true });
    }
  }
  const reportRel = reportAbs ? insideRoot(root, reportAbs) : null;
  const stateBefore = treeContentState(root, reportRel);
  record.exitCode = await runForExitCode(command, root, verifyMaxMs(), opts?.onOutput);
  const stateAfter = treeContentState(root, reportRel);
  if (setting && reportAbs) {
    try {
      if (stateBefore === null || stateAfter === null) throw new Error('the tree could not be read (not a git repository, no commit yet, or git failed), so the results cannot be tied to it');
      if (stateAfter !== stateBefore) throw new Error('the tree changed while the command ran, so the results cannot be tied to it');
      if (!insideTree(reportAbs)) throw new Error('the report resolves outside the tree');
      const text = fs.readFileSync(reportAbs, 'utf8');
      const parsed = setting.format === 'vitest-json' ? parseVitestJson(text, root) : parseJunitXml(text, root);
      // A name two tests share cannot be compared by name, so it is left out and
      // listed; a check that needs it finds it missing, never passed. The rest
      // of the report stays usable - real suites do carry the odd duplicate.
      const ambiguous = new Set(parsed.duplicateNames);
      // The project's declared test paths are the surface (9afdba7d); the tree is listed only to suggest some
      // when a name is no file and none are declared. The report this run wrote is never hashed.
      const listTree = () => execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000, maxBuffer: 256 * 1024 * 1024 }).split('\0').filter(Boolean);
      const surface = surfaceOf(root, [...new Set([...parsed.tests.map(t => t.file), ...parsed.brokenFiles.map(b => b.file)])], setting.surface ?? [], { listTree, exclude: reportRel ? [reportRel] : [] });
      record.available = true;
      record.tests = parsed.tests.filter(t => !ambiguous.has(t.name));
      if (ambiguous.size) record.duplicateNames = [...ambiguous];
      record.brokenFiles = parsed.brokenFiles;
      record.surface = { files: surface.files };
      record.surfaceComplete = surface.missing.length === 0;
      // Which files a surface holds changed with 9afdba7d: an older capture cannot be compared with a newer one,
      // nor one taken under different declared paths.
      record.surfaceScope = 'declared';
      record.surfaceDeclared = [...(setting.surface ?? [])];
      if (surface.suggested) record.surfaceSuggested = surface.suggested;
      if (surface.missing.length) record.surfaceMissing = surface.missing;
    } catch (e: any) {
      record.parseError = `could not use the ${setting.format} report at ${setting.reportPath}: ${e?.message ?? e}`;
    }
  }
  // The card may have moved while the command ran: a record for a step it
  // no longer occupies (or was rolled back over) must not be written.
  const fresh: any = await storage.getItem(item.id);
  if (!fresh || fresh.status !== item.status) {
    return { status: 409, error: 'CARD_MOVED', message: `The card moved (${item.status} -> ${fresh?.status ?? 'deleted'}) while the capture ran; nothing was recorded.` };
  }
  await storage.updateItem(item.id, { stepRecords: [...(fresh.stepRecords ?? []), record] } as any);
  // Only a per-test capture is ever reused (an exit code alone comes from a close's test record).
  if (record.available && record.clean && record.exitCode === 0) noteGreen(item.projectId, root, record.head, item.id);
  return { record };
}

/**
 * 961f301d — greens on record, by project, tree and commit: the cards that may
 * hold one. Built from ONE scan per project per server process, then kept at
 * the two places a green is written (a clean per-test capture that exited 0,
 * and the commit a close stamps on its test record), so a capture never reads the whole
 * project on the request path. Only a hint: every candidate is re-checked in
 * full before it is used, so a stale entry costs a lookup, never a wrong green.
 * After a restart it is rebuilt on first use.
 */
const greensAt = new Map<string, Set<string>>();
/** The one scan per project: awaited by every lookup, dropped if it fails so the next one retries. */
const greensIndexed = new Map<string, Promise<void>>();
const greenKey = (projectId: string, root: string, sha: string) => `${projectId}\0${root}\0${sha}`;
function noteGreen(projectId: string, root: string | null, sha: string | null | undefined, itemId: string): void {
  if (!root || !sha) return;
  const key = greenKey(projectId, root, sha);
  const cards = greensAt.get(key) ?? new Set<string>();
  cards.add(itemId);
  greensAt.set(key, cards);
}
function indexProjectGreens(projectId: string): Promise<void> {
  let scan = greensIndexed.get(projectId);
  if (!scan) {
    scan = (async () => {
      // The tree each green RAN in is on its record: a card's current tree may be another by now.
      for (const card of (await storage.listItems({ projectId } as any)) as any[]) {
        for (const r of card.stepRecords ?? []) if (r?.kind === 'capture' && r.available === true && r.clean === true && r.exitCode === 0 && !r.reusedFrom) noteGreen(projectId, r.root, r.head, card.id);
        for (const x of testRecords(card.tests)) if (x.status === 'PASSED' && x.commit) noteGreen(projectId, x.commitRoot, x.commit, card.id);
      }
    })();
    scan.catch(() => greensIndexed.delete(projectId));
    greensIndexed.set(projectId, scan);
  }
  return scan.catch(() => undefined);
}

/**
 * 961f301d — a green already on record for exactly this tree, as a capture.
 * The tree must be CLEAN at a commit a run of the same command was recorded
 * against, by a card of this project working in THIS tree (CGLAB-366: another
 * checkout at the same commit can differ in what git ignores - node_modules, a
 * build, an .env). With a test report it is an earlier capture with per-test
 * results (same format and declared surface); without one, a PASSED test
 * record stamped with that commit (what a close stamps) - the exit code is all
 * a capture would have known. Null: capture it.
 */
async function reusableCapture(item: any, project: any, root: string, sha: string | null): Promise<any | null> {
  if (!sha) return null;
  const setting: TestReportSetting | undefined = project?.testReport;
  const command = setting?.command ?? project?.verifyCommand;
  if (!command) return null;
  await indexProjectGreens(item.projectId);
  const candidates: any[] = [];
  for (const id of greensAt.get(greenKey(item.projectId, root, sha)) ?? []) {
    const card: any = await storage.getItem(id);
    if (card && card.projectId === item.projectId) candidates.push(card);
  }
  const base = { step: item.status, kind: 'capture', at: new Date().toISOString(), head: sha, clean: true, command, root };
  if (setting) {
    const same = (r: any) => r?.kind === 'capture' && r.root === root && r.clean === true && r.head === sha && r.available === true && r.exitCode === 0
      && !r.reusedFrom && r.command === command && r.format === setting.format && r.surfaceScope === 'declared'
      && JSON.stringify(r.surfaceDeclared ?? []) === JSON.stringify(setting.surface ?? []);
    let best: { card: any; r: any } | null = null;
    for (const card of candidates) for (const r of card.stepRecords ?? []) if (same(r) && (!best || String(r.at) > String(best.r.at))) best = { card, r };
    if (!best) return null;
    return { ...best.r, ...base, reusedFrom: { itemId: best.card.id, step: best.r.step, at: best.r.at } };
  }
  let found: { card: any; t: any } | null = null;
  for (const card of candidates) for (const x of testRecords(card.tests)) {
    if (x.status === 'PASSED' && x.commit === sha && x.commitRoot === root && x.command === command && (!found || String(x.executedAt) > String(found.t.executedAt))) found = { card, t: x };
  }
  if (!found) return null;
  return { ...base, format: 'exit-code', available: false, exitCode: 0, reusedFrom: { itemId: found.card.id, testId: found.t.id } };
}

app.post("/items/:id/step-records/capture", asyncHandler(async (req: any, res: any) => {
  if (req.headers['x-agenfk-internal'] !== VERIFY_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const item: any = await storage.getItem(req.params.id);
  if (!item) return res.status(404).json({ error: "Item not found" });
  const outcome = await captureStepRecord(item);
  if ('error' in outcome) return res.status(outcome.status).json({ error: outcome.error, message: outcome.message });
  res.json(outcome.record);
}));

/**
 * What to run in a newly cut worktree (CGLAB-203).
 *
 * Behind the internal token for exactly the reason `verify-command` is, and it
 * would be easy to put on `PUT /projects/:id` instead because it FEELS like a
 * preference: it is a shell string this machine later runs in a directory it
 * just created. That is the same mass-assignment-to-RCE shape as bug e60e20aa,
 * arriving under a friendlier name.
 */
app.put("/projects/:id/setup-command", asyncHandler(async (req: any, res: any) => {
  if (req.headers['x-agenfk-internal'] !== VERIFY_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const { setupCommand } = req.body ?? {};
  if (typeof setupCommand !== 'string') {
    return res.status(400).json({ error: "setupCommand (string) required" });
  }
  try {
    const updated = await storage.updateProject(req.params.id, { setupCommand } as any);
    io.emit('items_updated');
    res.json(updated);
  } catch (error) {
    res.status(404).json({ error: "Project not found" });
  }
}));

/**
 * Repoint a project at the repository it actually lives in (CGLAB-185).
 *
 * Behind the internal token for the same reason `verify-command` is, and the
 * reason `PUT /projects/:id` deliberately refuses this field: `projectRoot` is a
 * CWD. It is where `git add -A && git commit` runs and where worktrees are cut
 * from, so an unauthenticated caller setting it is mass assignment with
 * execution consequences — bug e60e20aa.
 *
 * It exists at all because there was NO way to correct a wrong one. The value is
 * otherwise only ever written as a side effect of validating from inside a
 * directory, which means a project that picked up the wrong root kept it. That
 * is not hypothetical: four projects on this machine have `projectRoot` set to
 * $HOME, so an auto-worktree would cut a branch from the user's home directory
 * and an auto-commit would run `git add -A` over their dotfiles.
 *
 * `isPersistableProjectRoot` is the same guard the walk-up already uses. Worth
 * saying that it was written for exactly this class of mistake and had no
 * caller that could FIX one.
 */
app.put("/projects/:id/project-root", limitExpensive, asyncHandler(async (req: any, res: any) => {
  if (req.headers['x-agenfk-internal'] !== VERIFY_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const { projectRoot } = req.body ?? {};
  if (typeof projectRoot !== 'string' || !projectRoot.trim()) {
    return res.status(400).json({ error: "projectRoot (non-empty string) required" });
  }
  const candidate = projectRoot.trim();
  // Absolute only. A relative path resolves against whatever cwd the SERVER
  // happens to have, which is nobody's intent and is not even visible to the
  // person typing it.
  if (!path.isAbsolute(candidate)) {
    return res.status(400).json({ error: `Refusing a path that is not absolute: ${candidate}` });
  }
  if (!isPersistableProjectRoot(candidate, os.homedir())) {
    return res.status(400).json({
      error: `Refusing ${candidate}: a project root must not be your home directory, ~/.agenfk, or /. Those are what a bad walk-up finds, and a worktree or an auto-commit there runs over your own files.`,
    });
  }
  // It has to BE a directory, and one that is there. A path that does not exist
  // fails later, at worktree time, with an error about git rather than about
  // the setting that caused it.
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) {
    return res.status(400).json({ error: `Not a directory: ${candidate}` });
  }
  try {
    const updated = await storage.updateProject(req.params.id, { projectRoot: candidate } as any);
    if (!updated) return res.status(404).json({ error: "Project not found" });
    io.emit('items_updated');
    res.json(updated);
  } catch {
    res.status(404).json({ error: "Project not found" });
  }
}));

app.delete("/projects/:id", asyncHandler(async (req: any, res: any) => {
  // Purge verify logs BEFORE the rows go. They are keyed by item id, and
  // deleteProject hard-deletes the items — so once the rows are gone nothing can
  // ever name those directories again, and <tmpdir>/agenfk-verify-<uid>/<itemId>/
  // would sit on disk indefinitely holding the full raw output of every command
  // that project ever ran. That output routinely echoes environment: tokens,
  // connection strings. The trash path already purges; this is the same promise.
  try {
    const items = await storage.listItems({ projectId: req.params.id, limit: 1_000_000 });
    for (const item of items) purgeItemLogs(item.id);
  } catch {
    // Advisory — never fail a project delete over a log directory.
  }
  await storage.deleteProject(req.params.id);
  io.emit('items_updated');
  res.status(204).send();
}));

// ── Project Flow assignment ───────────────────────────────────────────────────

app.post("/projects/:id/flow", asyncHandler(async (req: any, res: any) => {
  const project = await storage.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const { flowId } = req.body;
  if (flowId === undefined) return res.status(400).json({ error: "flowId is required" });

  // Validate that the flow exists (unless clearing with null/empty string)
  if (flowId) {
    const flow = await storage.getFlow(flowId);
    if (!flow) return res.status(404).json({ error: "Flow not found" });
  }

  const updated = await storage.updateProject(req.params.id, { flowId: flowId || undefined });

  // Run card migration if flowId is being set
  if (flowId) {
    const items = await storage.listItems({ projectId: req.params.id });
    const flows = await storage.listFlows();
    const activeFlow = getActiveFlow(flowId, flows);
    const oldFlow = (project as any).flowId
      ? (await storage.getFlow((project as any).flowId)) ?? DEFAULT_FLOW
      : DEFAULT_FLOW;
    const migrationPlan = migrateCardsToFlow(items, oldFlow, activeFlow);
    await applyMigrationPlan(migrationPlan, activeFlow);
  }

  io.emit('flow:updated', { projectId: req.params.id, flowId: flowId || null });
  io.emit('items_updated');
  res.json(updated);
}));

app.get("/projects/:id/flow", asyncHandler(async (req: any, res: any) => {
  let project = await storage.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: "Project not found" });

  // Opt-in on-demand refresh (used by `agenfk flow show`): pull the project's
  // currently-assigned Hub flow now instead of waiting for the 5-minute poll.
  // Never throws — on any Hub error we fall through to the local flow below.
  const refreshRequested = (() => {
    const q = req.query.refresh;
    const v = Array.isArray(q) ? q[q.length - 1] : q; // last value wins on ?refresh=..&refresh=..
    return v === "true" || v === "1";
  })();
  if (refreshRequested && hubClient.isEnabled && hubClient.hubConfig) {
    await refreshProjectFlowFromHub({
      storage: storage as SQLiteStorageProvider,
      hubEnabled: hubClient.isEnabled,
      hubConfig: hubClient.hubConfig,
      projectId: req.params.id,
      remoteUrl: await resolveProjectRepo(req.params.id),
      fetchImpl: globalThis.fetch as any,
      emit: (event, payload) => io.emit(event, payload),
      etagCache: flowSyncEtagCache,
    });
    // The reconcile may have rebound the project to a new flow id.
    project = (await storage.getProject(req.params.id)) ?? project;
  }

  if (!(project as any).flowId) {
    return res.json(DEFAULT_FLOW);
  }

  const flows = await storage.listFlows();
  const activeFlow = getActiveFlow((project as any).flowId, flows);
  res.json(activeFlow);
}));

// ── Org-available flows (Hub-published set) + client self-selection ──────────
app.get("/flows/org-available", asyncHandler(async (_req: any, res: any) => {
  if (!hubClient.isEnabled || !hubClient.hubConfig) {
    return res.json({ flows: [], defaultFlowId: null, hubEnabled: false });
  }
  const { url, token } = hubClient.hubConfig;
  try {
    const r = await (globalThis.fetch as any)(`${url.replace(/\/$/, "")}/v1/flows/available`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!r.ok) return res.status(502).json({ error: `Hub returned ${r.status}`, hubEnabled: true });
    const body = await r.json();
    return res.json({ flows: body.flows ?? [], defaultFlowId: body.defaultFlowId ?? null, hubEnabled: true });
  } catch (e: any) {
    return res.status(502).json({ error: `Hub unreachable: ${e?.message ?? "error"}`, hubEnabled: true });
  }
}));

app.post("/projects/:id/flow/select-org", asyncHandler(async (req: any, res: any) => {
  const project = await storage.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: "Project not found" });
  const flowId = req.body?.flowId;
  if (flowId === undefined) return res.status(400).json({ error: "flowId is required" });
  if (!hubClient.isEnabled || !hubClient.hubConfig) {
    return res.status(400).json({ error: "Hub is not configured; cannot select an org flow" });
  }
  const { url, token } = hubClient.hubConfig;
  const oldFlowId = (project as any).flowId ?? null;

  // The hub keys selections on the global repo (remote URL). Resolve this
  // project's git remote; fall back to the legacy projectId key only when the
  // project has no remote.
  const repo = await resolveProjectRepo(req.params.id);
  const selectionBody = repo
    ? { repo, flowId: flowId || null }
    : { projectId: req.params.id, flowId: flowId || null };

  // 1) Write the selection to the hub.
  let sel: any;
  try {
    sel = await (globalThis.fetch as any)(`${url.replace(/\/$/, "")}/v1/flows/selection`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(selectionBody),
    });
  } catch (e: any) {
    return res.status(502).json({ error: `Hub unreachable: ${e?.message ?? "error"}` });
  }
  if (!sel.ok) {
    let msg = `Hub returned ${sel.status}`;
    try { const b = await sel.json(); if (b?.error) msg = b.error; } catch { /* ignore */ }
    const status = (sel.status === 400 || sel.status === 401 || sel.status === 403 || sel.status === 404) ? sel.status : 502;
    return res.status(status).json({ error: msg });
  }

  // 2) Clear path: unbind locally (reconcile never unbinds). Migrate in-flight
  // cards off the old flow's custom statuses to DEFAULT_FLOW first, so items
  // aren't orphaned on statuses the default flow doesn't have (same as the
  // bind path below and POST /projects/:id/flow).
  if (!flowId) {
    if (oldFlowId) {
      const oldFlow = (await storage.getFlow(oldFlowId)) ?? DEFAULT_FLOW;
      const items = await storage.listItems({ projectId: req.params.id });
      const migrationPlan = migrateCardsToFlow(items, oldFlow, DEFAULT_FLOW);
      await applyMigrationPlan(migrationPlan, DEFAULT_FLOW);
      await storage.updateProject(req.params.id, { flowId: undefined });
    }
    io.emit("flow:updated", { projectId: req.params.id, flowId: null });
    io.emit("items_updated");
    return res.json(DEFAULT_FLOW);
  }

  // 3) Reconcile the selected flow into local storage. Bust the per-project
  // ETag first so we always get a fresh 200 (not a stale 304) right after a
  // selection change.
  flowSyncEtagCache.delete(req.params.id);
  const outcome = await refreshProjectFlowFromHub({
    storage: storage as SQLiteStorageProvider,
    hubEnabled: hubClient.isEnabled,
    hubConfig: hubClient.hubConfig,
    projectId: req.params.id,
    remoteUrl: repo,
    fetchImpl: globalThis.fetch as any,
    emit: (event: string, payload: any) => io.emit(event, payload),
    etagCache: flowSyncEtagCache,
  });
  if (!outcome || (outcome.outcome !== "updated" && outcome.outcome !== "not-modified")) {
    return res.status(502).json({
      error: "Selection saved on the hub but the local flow reconcile failed; try again.",
      reconciled: false,
    });
  }

  // 4) Migrate in-flight cards off now-invalid statuses (same as POST /projects/:id/flow).
  const updated = await storage.getProject(req.params.id);
  const newFlowId = (updated as any)?.flowId ?? null;
  const flows = await storage.listFlows();
  if (newFlowId && newFlowId !== oldFlowId) {
    const items = await storage.listItems({ projectId: req.params.id });
    const newFlow = getActiveFlow(newFlowId, flows);
    const oldFlow = oldFlowId ? (await storage.getFlow(oldFlowId)) ?? DEFAULT_FLOW : DEFAULT_FLOW;
    const migrationPlan = migrateCardsToFlow(items, oldFlow, newFlow);
    await applyMigrationPlan(migrationPlan, newFlow);
  }
  const activeFlow = newFlowId ? getActiveFlow(newFlowId, flows) : DEFAULT_FLOW;
  io.emit("flow:updated", { projectId: req.params.id, flowId: newFlowId });
  io.emit("items_updated");
  res.json(activeFlow);
}));

// ── Built-in default flow (always the hardcoded DEFAULT_FLOW, project-independent) ──
app.get("/flows/default", asyncHandler(async (_req: any, res: any) => {
  res.json(DEFAULT_FLOW);
}));

// ── Flows API ─────────────────────────────────────────────────────────────────

app.get("/flows", asyncHandler(async (_req: any, res: any) => {
  const flows = await storage.listFlows();
  res.json(flows);
}));

// ── Observability: PR registration ──────────────────────────────────────────
// Agent-declared sizing on PR open + re-declares on push. Server computes a
// shadow sizing by walking the item tree from the anchor item — logged for
// discrepancy detection but never overrides the agent's number.

// Walks the item subtree anchored at `rootItemId` and returns per-tier counts,
// including `leafStory` (STORYs with no children). The leaf-story count lets the
// hub size a PR by its atomic work without double-counting container tiers.
async function computeShadowSizing(rootItemId: string): Promise<SizingCounts> {
  const empty: SizingCounts = { epic: 0, story: 0, task: 0, bug: 0, leafStory: 0 };
  const root = await storage.getItem(rootItemId);
  if (!root) return empty;
  const collected: Array<{ id: string; type: string; parentId?: string | null }> = [];
  const stack: any[] = [root];
  const seen = new Set<string>();
  while (stack.length) {
    const node = stack.pop()!;
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    collected.push({ id: node.id, type: node.type, parentId: node.parentId ?? null });
    const children = await storage.listChildren(node.id);
    for (const c of children) stack.push(c);
  }
  return computeSizingFromItems(collected);
}

app.post("/prs", asyncHandler(async (req: any, res: any) => {
  const { itemId, prNumber, repo, sizing, model, harness } = req.body || {};
  if (!itemId || typeof prNumber !== 'number' || !repo) {
    return res.status(400).json({ error: 'itemId, prNumber, repo required' });
  }
  // sizing is OPTIONAL: when omitted, derive it from the item tree (shadow). This
  // is the auto-registration path used by `agenfk pr create`, where one CLI call
  // both opens and registers the PR. When provided, it must be well-formed.
  const sizingProvided = sizing != null;
  if (sizingProvided
    && (typeof sizing.epic !== 'number' || typeof sizing.story !== 'number'
      || typeof sizing.task !== 'number' || typeof sizing.bug !== 'number')) {
    return res.status(400).json({ error: 'sizing{epic,story,task,bug} must be numeric when provided' });
  }
  if (typeof model !== 'string' || !model.trim() || typeof harness !== 'string' || !harness.trim()) {
    return res.status(400).json({ error: 'model and harness are required (your actual model id + harness; do not omit or copy an example)' });
  }

  // POST /prs is idempotent on (repo, prNumber). Newness is decided ATOMICALLY
  // by the upsert, not by a separate pre-read: insertPr does INSERT … ON CONFLICT
  // DO UPDATE without touching `id`, so the returned row keeps our freshly minted
  // id only when this call won the insert. Two concurrent first-registrations
  // therefore can't both see "not registered" and both emit pr.opened — exactly
  // one wins the unique index. (Security: bug fe03d054.)
  const newId = crypto.randomUUID();
  const shadowCounts = await computeShadowSizing(itemId);
  // Stored sizingShadow keeps the flat PrSizing shape; leafStory rides separately
  // in the hub payload so the hub can size by leaf work.
  const shadow = { epic: shadowCounts.epic, story: shadowCounts.story, task: shadowCounts.task, bug: shadowCounts.bug };
  const effectiveSizing = sizingProvided ? sizing : shadow;
  const now = new Date().toISOString();
  const pr = await storage.insertPr({
    id: newId,
    prNumber,
    repo,
    itemId,
    openedAt: now,
    sizing: effectiveSizing,
    sizingDeclaredAt: now,
    sizingShadow: shadow,
    lastSizingCheckAt: now,
  });
  const isNewRegistration = pr.id === newId;

  const matches =
    effectiveSizing.epic === shadow.epic && effectiveSizing.story === shadow.story
    && effectiveSizing.task === shadow.task && effectiveSizing.bug === shadow.bug;
  if (!matches) {
    console.log(
      `[PR_SIZING] discrepancy on ${repo}#${prNumber} (item ${itemId}): ` +
      `agent=${JSON.stringify(effectiveSizing)} shadow=${JSON.stringify(shadow)}`,
    );
  }

  const item = await storage.getItem(itemId);
  recordHubEvent({
    type: isNewRegistration ? 'pr.opened' : 'pr.updated',
    projectId: item?.projectId,
    // model/harness are agent-declared (the CLI/MCP caller knows its own runtime;
    // the server process cannot infer them). Optional — omitted when not supplied.
    payload: {
      prNumber, repo, sizing: effectiveSizing, sizingShadow: shadow,
      leafStory: shadowCounts.leafStory,
      ...(typeof model === 'string' && model ? { model } : {}),
      ...(typeof harness === 'string' && harness ? { harness } : {}),
    },
  });

  res.status(201).json(pr);
}));

app.put("/prs/:repo/:number", asyncHandler(async (req: any, res: any) => {
  const repo = decodeURIComponent(req.params.repo);
  const prNumber = Number(req.params.number);
  if (!Number.isFinite(prNumber)) {
    return res.status(400).json({ error: 'PR number must be an integer' });
  }
  const { sizing, model, harness } = req.body || {};
  if (!sizing
    || typeof sizing.epic !== 'number' || typeof sizing.story !== 'number'
    || typeof sizing.task !== 'number' || typeof sizing.bug !== 'number') {
    return res.status(400).json({ error: 'sizing{epic,story,task,bug} required' });
  }
  if (typeof model !== 'string' || !model.trim() || typeof harness !== 'string' || !harness.trim()) {
    return res.status(400).json({ error: 'model and harness are required (your actual model id + harness; do not omit or copy an example)' });
  }

  const existing = await storage.getPrByRepoNumber(repo, prNumber);
  if (!existing) return res.status(404).json({ error: `PR ${repo}#${prNumber} not registered` });

  const shadowCounts = await computeShadowSizing(existing.itemId);
  const shadow = { epic: shadowCounts.epic, story: shadowCounts.story, task: shadowCounts.task, bug: shadowCounts.bug };
  const updated = await storage.updatePrSizing(repo, prNumber, sizing, shadow);

  const matches =
    sizing.epic === shadow.epic && sizing.story === shadow.story
    && sizing.task === shadow.task && sizing.bug === shadow.bug;
  if (!matches) {
    console.log(
      `[PR_SIZING] discrepancy on ${repo}#${prNumber}: agent=${JSON.stringify(sizing)} shadow=${JSON.stringify(shadow)}`,
    );
  }

  const anchorItem = await storage.getItem(existing.itemId);
  recordHubEvent({
    type: 'pr.updated',
    projectId: anchorItem?.projectId,
    payload: {
      prNumber, repo, sizing, sizingShadow: shadow,
      leafStory: shadowCounts.leafStory,
      ...(typeof model === 'string' && model ? { model } : {}),
      ...(typeof harness === 'string' && harness ? { harness } : {}),
    },
  });

  res.json(updated);
}));

// ── Observability: token events read API ────────────────────────────────────
// Historical token-event reads are left available for compatibility. Runtime
// ingestion and Hub forwarding are disabled; agents no longer self-report or
// stream token consumption into the Hub.

app.get("/token-events", asyncHandler(async (req: any, res: any) => {
  const { itemId, projectId, client, since, until, limit } = req.query as Record<string, string | undefined>;
  const ALLOWED_CLIENTS = new Set(['claude-code', 'codex', 'gemini', 'cursor', 'opencode']);
  if (client && !ALLOWED_CLIENTS.has(client)) {
    return res.status(400).json({ error: `Invalid client '${client}'. Must be one of: ${[...ALLOWED_CLIENTS].join(', ')}` });
  }
  const limitNum = limit !== undefined ? Number(limit) : undefined;
  if (limit !== undefined && (!Number.isFinite(limitNum) || (limitNum as number) <= 0)) {
    return res.status(400).json({ error: 'limit must be a positive integer' });
  }
  const events = await storage.queryTokenEvents({
    itemId, projectId, client: client as any, since, until,
    limit: limitNum,
  });
  res.json(events);
}));

// ── Agent runs (orchestrated worker transcripts per item) ──────────────────
const RUN_ACTORS = new Set(['orchestrator', 'worker', 'reviewer']);
const RUN_STATUSES = new Set(['running', 'done', 'failed']);
const RUN_EVENT_KINDS = new Set(['dispatch', 'think', 'tool', 'result', 'diff', 'verdict', 'note']);

// Register a run when the orchestrator dispatches a worker (establishes the
// session↔card link that heuristic attribution cannot).
/**
 * One git runner for the validate path.
 *
 * Captured stderr and a timeout, like the other call sites here: git's
 * `fatal:` lines belong in the log rather than on the server's stderr, and a
 * synchronous git on a stalled mount must not pin the event loop for the
 * whole server.
 */
const runGitSync = (args: readonly string[]): string =>
  execFileSync('git', args as string[], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000 });
const gitRun = { run: runGitSync };

app.post("/agent-runs", asyncHandler(async (req: any, res: any) => {
  const { itemId, projectId, step, actor, harness, model, sessionId, sourcePath } = req.body || {};
  if (typeof itemId !== 'string' || !itemId) return res.status(400).json({ error: "itemId is required" });
  if (typeof step !== 'string' || !step) return res.status(400).json({ error: "step is required" });
  if (actor && !RUN_ACTORS.has(actor)) {
    return res.status(400).json({ error: `Invalid actor '${actor}'. Must be one of: ${[...RUN_ACTORS].join(', ')}` });
  }
  // Same 500 the PATCH route below just closed: a non-string reaches
  // better-sqlite3's bind and throws there instead of naming the bad field.
  for (const [field, value] of Object.entries({ projectId, harness, model, sessionId, sourcePath })) {
    if (value !== undefined && typeof value !== 'string') {
      return res.status(400).json({ error: `${field} must be a string` });
    }
  }
  /*
   * A re-registration of a session that is STILL RUNNING is the same dispatch
   * seen again, not a second one.
   *
   * The desktop re-registers every restored terminal on launch, so a machine
   * with four relaunches had four `running` rows for ONE conversation and the
   * Runs panel showed four copies of it. Reuse the row and teach it the
   * sourcePath this call carries (a later registration often has one the first
   * did not). A different card, or a previous run that already ended, is a new
   * dispatch and still gets its own row.
   */
  if (sessionId) {
    const existing = await storage.getAgentRunBySession(sessionId);
    if (existing && existing.status === 'running' && existing.itemId === itemId) {
      const updated = sourcePath && sourcePath !== existing.sourcePath
        ? await storage.updateAgentRun(existing.id, { sourcePath })
        : existing;
      io.emit('run:updated', { itemId: updated.itemId, runId: updated.id });
      return res.status(200).json(updated);
    }
  } else {
    /*
     * NO SESSION ID: the card and the harness are the only stable identity
     * there is. codex, gemini and shell cannot be handed a conversation id, so
     * a restore has nothing else to key on - and with sessionId as the ONLY
     * key, every relaunch of such a tab opened ANOTHER `running` row for the
     * same terminal (four after three relaunches, measured).
     *
     * Same reuse, weaker key. The ceiling is stated rather than hidden: two
     * codex panes on ONE card share a run, because nothing in the request can
     * tell them apart - and a second `running` row for that pair is the thing
     * this exists to stop.
     */
    const running = await storage.listAgentRuns({ itemId, status: 'running' });
    const existing = running
      .filter(r => (r.harness ?? 'pi') === (harness || 'pi') && !r.sessionId)
      .at(-1);
    if (existing) {
      io.emit('run:updated', { itemId: existing.itemId, runId: existing.id });
      return res.status(200).json(existing);
    }
  }

  const run = await storage.createAgentRun({
    id: uuidv4(),
    itemId,
    projectId: projectId || undefined,
    step,
    actor: actor || 'worker',
    harness: harness || 'pi',
    model: model || 'unknown',
    sessionId: sessionId || undefined,
    sourcePath: sourcePath || undefined,
    status: 'running',
    startedAt: new Date().toISOString(),
  });
  io.emit('run:updated', { itemId: run.itemId, runId: run.id });
  io.emit('items_updated');
  res.status(201).json(run);
}));

app.patch("/agent-runs/:id", asyncHandler(async (req: any, res: any) => {
  const existing = await storage.getAgentRun(req.params.id);
  if (!existing) return res.status(404).json({ error: "Agent run not found" });
  const { status, verdict, endedAt, sourcePath } = req.body || {};
  if (status !== undefined && !RUN_STATUSES.has(status)) {
    return res.status(400).json({ error: `Invalid status '${status}'. Must be one of: ${[...RUN_STATUSES].join(', ')}` });
  }
  // Non-strings reach better-sqlite3's bind and throw there, which surfaces as
  // a 500 instead of telling the caller what was wrong.
  if (verdict !== undefined && typeof verdict !== 'string') {
    return res.status(400).json({ error: 'verdict must be a string' });
  }
  if (sourcePath !== undefined && typeof sourcePath !== 'string') {
    return res.status(400).json({ error: 'sourcePath must be a string' });
  }
  /*
   * `endedAt` IS THE SERVER'S. It records when the server saw the run end, so
   * a client cannot set it. Letting it through produced both halves of the
   * incoherence: a finished run whose end time was rewritten, and a running
   * run stamped as already ended - "running, finished at 14:02" (BUG
   * 43ac6afe). A null is the same body serialised by another client.
   *
   * Ahead of the transition guard so shape errors (400) beat state errors
   * (409), the way the other field checks above do.
   */
  if (endedAt !== undefined) {
    return res.status(400).json({ error: 'endedAt is stamped by the server when a terminal status arrives; it cannot be set by the client.' });
  }
  /*
   * A FINISHED RUN DOES NOT REOPEN (BUG 43ac6afe). RUN_STATUSES above limits
   * the vocabulary - which words may be stored; `canTransition` limits the
   * moves, and until now nothing asked it. So `done -> running` was accepted
   * and the row went back to saying "running" with an endedAt still stamped.
   *
   * Skipped when the status is unchanged: a resend is a no-op, not an illegal
   * move, and the hook retries after a dropped response.
   */
  if (status !== undefined && status !== existing.status) {
    const move = canTransition(existing.status as DispatchState, status as DispatchState);
    if (!move.allowed) return res.status(409).json({ error: move.reason });
  }
  // ponytail: check-then-write, not a transaction. Two PATCHes interleaving
  // at the awaits below can both pass the guard above; every real caller sends
  // a terminal status once, for a distinct run, so the ceiling is cosmetic.
  // The failure count below has the same shape but a real ceiling: two runs
  // for ONE card failing at once both read N and write N+1, so the breaker
  // opens one late. Make it a conditional UPDATE ... WHERE status = ?, and
  // count in storage, if a card ever gets two concurrent failing runs.
  const updated = await storage.updateAgentRun(req.params.id, {
    ...(status !== undefined ? { status } : {}),
    ...(verdict !== undefined ? { verdict } : {}),
    ...(sourcePath !== undefined ? { sourcePath } : {}),
    // stamp endedAt on the transition INTO a terminal status, and only then.
    // Asked via isTerminal rather than `!== 'running'` so adding a non-terminal
    // word to RUN_STATUSES (blocked, say) cannot silently stamp the record.
    ...(status !== undefined && isTerminal(status as DispatchState) && !existing.endedAt ? { endedAt: new Date().toISOString() } : {}),
  });
  /*
   * A failed attempt counts against the CARD, not the run (CGLAB-202). Three
   * in a row and `mayDispatch` refuses it, which is the breaker: a repeated
   * failure becomes a person looking rather than a fourth agent spent.
   *
   * Only the transition INTO `failed` counts - a resend is a no-op, and
   * `done` clears nothing because SessionEnd is not success. The count lives
   * on the item, so re-asking by another run answers the same.
   */
  if (status === 'failed' && existing.status !== 'failed') {
    const item = await storage.getItem(existing.itemId);
    if (item) {
      const decision = recordFailure({ failureCount: item.failureCount ?? 0 });
      await storage.updateItem(item.id, { failureCount: decision.failureCount });
      // The board's item list is cached with a long staleTime and only
      // refetches on `items_updated`; without this the sheet keeps the old
      // count until some unrelated event, which is the moment the feature
      // exists for.
      io.emit('items_updated');
    }
  }
  io.emit('run:updated', { itemId: updated.itemId, runId: updated.id });
  res.json(updated);
}));

// Append a transcript event. Used both by the orchestrator (dispatch/verdict/note)
// and by the session watcher (think/tool/result). Emits a payload-bearing socket
// event so the UI can stream it live, keyed by itemId.
app.post("/agent-runs/:id/events", asyncHandler(async (req: any, res: any) => {
  const run = await storage.getAgentRun(req.params.id);
  if (!run) return res.status(404).json({ error: "Agent run not found" });
  const { lane, kind, tool, text, payload, tokens, seq } = req.body || {};
  if (!kind || !RUN_EVENT_KINDS.has(kind)) {
    return res.status(400).json({ error: `Invalid kind '${kind}'. Must be one of: ${[...RUN_EVENT_KINDS].join(', ')}` });
  }
  if (lane && !RUN_ACTORS.has(lane)) {
    return res.status(400).json({ error: `Invalid lane '${lane}'. Must be one of: ${[...RUN_ACTORS].join(', ')}` });
  }
  // Caller may supply a deterministic seq (watcher re-parse dedup); else append.
  // Undefined when the caller did not give one, so the STORAGE assigns it
  // inside the insert where it is atomic. Computing it here was a read, an
  // await and then a write: two events in flight got the same number and the
  // second was dropped silently against UNIQUE(run_id, seq), while the API
  // answered 201 and the UI showed an event that vanished on refresh.
  const nextSeq = Number.isInteger(seq) ? seq : undefined;
  const event = {
    id: uuidv4(),
    runId: run.id,
    seq: nextSeq,
    ts: new Date().toISOString(),
    lane: (lane || run.actor) as any,
    kind,
    tool: tool || undefined,
    text: text || undefined,
    payload: payload !== undefined ? (typeof payload === 'string' ? payload : JSON.stringify(payload)) : undefined,
    tokens: Number.isFinite(tokens) ? tokens : undefined,
  };
  /*
   * Emitted WITH the position it was actually given.
   *
   * The store assigns it inside the insert, so `event.seq` is still undefined
   * here — and broadcasting that object is what broke the live transcript: every
   * consumer orders and de-duplicates by `seq`, and a stream of undefineds
   * compares equal to itself, so the second event and every one after it was
   * discarded. A Claude Code session showed one line in the Runs panel and then
   * nothing, for as long as it ran.
   */
  const writtenSeq = await storage.appendRunEvent(event);
  const stored = { ...event, seq: writtenSeq ?? event.seq };
  // Nothing was written — the row was already there. Telling every open panel
  // about it would paint a duplicate.
  if (writtenSeq !== null) io.emit('run:event', { itemId: run.itemId, runId: run.id, event: stored });
  res.status(201).json(stored);
}));

app.get("/items/:id/agent-runs", asyncHandler(async (req: any, res: any) => {
  const runs = await storage.listAgentRuns({ itemId: req.params.id });
  res.json(runs);
}));

/**
 * Runs across every project (CGLAB-170).
 *
 * The per-card route above answers "what happened on this card". The Sessions
 * rail asks a different question — "what is running anywhere" — and answering
 * it from the renderer would mean one request per project on every event.
 *
 * It deliberately does NOT decide what is live. AgentRun.status stays
 * 'running' forever because the hook never issues the closing PATCH (BUG
 * df4b3343), so a server-side liveness filter would report every run this
 * machine has ever started. The server reports what it stored; the client
 * derives liveness from the recency of `run:event`.
 */
// RUN_STATUSES is declared once, above with the other run constants — a second
// copy here would be the same three strings until the day someone adds a
// fourth to only one of them.
const RUNS_DEFAULT_LIMIT = 25;
const RUNS_MAX_LIMIT = 200;

app.get("/agent-runs", asyncHandler(async (req: any, res: any) => {
  const { status, projectId, itemId } = req.query ?? {};

  // Validated, not passed through: the value reaches a storage query, and a
  // filter that forwards arbitrary input is how one becomes an injection point.
  if (status !== undefined && !RUN_STATUSES.has(String(status))) {
    return res.status(400).json({
      error: `Unknown run status "${status}". Expected one of: ${[...RUN_STATUSES].join(', ')}`,
    });
  }

  let limit = RUNS_DEFAULT_LIMIT;
  if (req.query?.limit !== undefined) {
    const asked = Number(req.query.limit);
    // Bounded on purpose. A machine that has been running agents for months
    // would otherwise send its whole history to render a sidebar.
    if (!Number.isInteger(asked) || asked < 1 || asked > RUNS_MAX_LIMIT) {
      return res.status(400).json({ error: `limit must be an integer between 1 and ${RUNS_MAX_LIMIT}` });
    }
    limit = asked;
  }

  const runs = await storage.listAgentRuns({
    ...(status !== undefined ? { status: String(status) as any } : {}),
    ...(projectId !== undefined ? { projectId: String(projectId) } : {}),
    ...(itemId !== undefined ? { itemId: String(itemId) } : {}),
    limit,
  });
  res.json(runs);
}));

// ── Worktrees (CGLAB-166) ────────────────────────────────────────────────────
// One git worktree per item, so several agents can work at once without
// fighting over a single working tree.

/**
 * Where worktrees live unless a caller names somewhere else.
 *
 * Deliberately NOT under ~/.agenfk. findProjectRoot walks up looking for a
 * `.agenfk` directory, so a worktree nested inside one resolves to $HOME —
 * and `agenfk verify` run from that worktree would then persist projectRoot
 * as the home directory, pointing the verifyCommand and `git add -A && git
 * commit` at the user's private files.
 */
export const defaultWorktreeRoot = (): string =>
  path.join(os.homedir(), '.agenfk-worktrees');

/**
 * Resolve the repository an item's worktree is cut from.
 *
 * Requires an explicit projectRoot. Falling back to process.cwd() would run
 * git wherever the server happens to have been started — for the desktop app
 * that is not even a repository, and "somewhere plausible" is a worse answer
 * than a clear error.
 */
async function repoRootForItem(item: any): Promise<string> {
  const project: any = await storage.getProject(item.projectId);
  const repoRoot = project?.projectRoot;
  if (!repoRoot) {
    throw Object.assign(
      new Error(`Project has no projectRoot. Set it before creating a worktree.`),
      { statusCode: 400 },
    );
  }
  return repoRoot;
}

app.post("/items/:id/worktree", limitExpensive, asyncHandler(async (req: any, res: any) => {
  const item: any = await storage.getItem(req.params.id);
  if (!item) return res.status(404).json({ error: "Item not found" });

  let repoRoot: string;
  try {
    repoRoot = await repoRootForItem(item);
  } catch (e: any) {
    return res.status(400).json({ error: e.message });
  }

  const branchName = item.branchName || buildBranchName(item.type, item.title);

  // `root` is caller-supplied on an endpoint any local process can reach, and
  // createWorktree will mkdir -p it and check out a whole repo there. Confine
  // it to the worktree area so this cannot become arbitrary directory
  // creation. (The CLI only ever forwards --root, which stays inside it.)
  const requested = typeof req.body?.root === 'string' && req.body.root ? req.body.root : undefined;
  const base = defaultWorktreeRoot();
  /*
   * RESOLVED, NOT COMPARED AS STRINGS, and checked BEFORE `root` exists.
   *
   * Two defects lived here. `const root = requested ?? base` ran ABOVE the
   * guard, so the value that flowed onward was a different name from the one
   * that was checked - check one thing, use another, a line apart.
   *
   * And `path.resolve(x).startsWith(base)` is LEXICAL: it collapses `..` and
   * stops. It does not follow symlinks, so a path of innocent-looking segments
   * under the worktree area, where one segment links out, passes it - and then
   * `git worktree add` checks out a whole repository at the link's target. Not
   * hypothetical in a workspace monorepo: `npm install` inside a worktree
   * creates `node_modules/@scope/pkg` links that leave it, and this route has
   * no token gate.
   *
   * `realBase` answers where the path actually LANDS, which is the only
   * question worth asking.
   */
  let root = base;
  if (requested !== undefined) {
    if (containedPath(realBase(base), realBase(requested)) === null) {
      return res.status(400).json({
        error: `root must be inside ${base}. If it looks like it is, a directory on the way `
          + 'there is a symlink pointing somewhere else.',
      });
    }
    root = requested;
  }

  let result;
  try {
    const proj: any = await storage.getProject(item.projectId);
    result = createWorktree({ repoRoot, root, branchName, setupCommand: proj?.setupCommand });
  } catch (e: any) {
    return res.status(400).json({ error: e.message });
  }

  await storage.updateItem(item.id, { worktreePath: result.path, branchName } as any);
  /*
   * Execution, not creation, is token-gated. Running an arbitrary project shell
   * string is at least as privileged as `verifyCommand`, and this route has no
   * token (by design - creating a directory is cheap). Without the token the
   * caller gets the decision and the notice; with it, the install starts in the
   * background and reports on the card.
   */
  if (req.headers['x-agenfk-internal'] === VERIFY_TOKEN && result.created) {
    startWorktreeSetup(item, result.setup, result.path);
  } else if (!result.setup.ready) {
    await noteOnItem(item.id, result.setup.notice);
  }
  io.emit('items_updated');
  res.status(result.created ? 201 : 200).json(result);
}));

app.get("/items/:id/worktree", limitExpensive, asyncHandler(async (req: any, res: any) => {
  const item: any = await storage.getItem(req.params.id);
  if (!item) return res.status(404).json({ error: "Item not found" });
  const worktreePath = item.worktreePath ?? null;
  // `exists` is how a caller tells "never made" from "made, then deleted by
  // hand" — the second needs recreating, not a plain cd.
  res.json({
    path: worktreePath,
    branchName: item.branchName ?? null,
    exists: worktreePath ? fs.existsSync(worktreePath) : false,
  });
}));

app.delete("/items/:id/worktree", limitExpensive, asyncHandler(async (req: any, res: any) => {
  // Gated like every other destructive endpoint here: removal is --force, so
  // it discards uncommitted work. Any local process could otherwise walk the
  // item ids and wipe every running agent's in-flight changes.
  if (req.headers['x-agenfk-internal'] !== VERIFY_TOKEN) {
    return res.status(403).json({ error: "Forbidden: removing a worktree requires the internal token." });
  }
  const item: any = await storage.getItem(req.params.id);
  if (!item) return res.status(404).json({ error: "Item not found" });
  if (!item.worktreePath) return res.json({ removed: false });

  try {
    const repoRoot = await repoRootForItem(item);
    // Removal takes the checkout, never the branch: committed work always
    // survives, which is what makes this safe to run automatically.
    removeWorktree(repoRoot, item.worktreePath);
  } catch (e: any) {
    console.warn('[WORKTREE] remove failed, clearing the record anyway:', e.message);
  }

  await storage.updateItem(item.id, { worktreePath: undefined } as any);
  io.emit('items_updated');
  res.json({ removed: true });
}));

app.get("/agent-runs/:id/events", asyncHandler(async (req: any, res: any) => {
  const run = await storage.getAgentRun(req.params.id);
  if (!run) return res.status(404).json({ error: "Agent run not found" });
  const events = await storage.listRunEvents(run.id);
  res.json(events);
}));

const HUB_MANAGED_FLOW_MSG = "Flow is managed by your organization's Hub and cannot be modified locally";

/**
 * BUG 269eeec8 (c): bring local flow writes into line with the shape contract
 * the Hub enforces (packages/hub/src/routes/admin.ts validateDefinition), so a
 * flow authored locally can always be published without an opaque 400.
 *
 * Deliberately NARROWER than the Hub's validator on two points, because the
 * local server has always accepted these and callers (MCP create_flow, the CLI)
 * depend on them:
 *  - `steps: []` is allowed — creating an empty flow and populating it later is
 *    a supported local flow. It only becomes un-publishable, not invalid.
 *  - a missing step `id` is generated rather than rejected (see normalizeSteps).
 *
 * What it does reject is an empty step name, which is the actual defect: it is
 * unusable as a workflow status, since nothing can transition an item to "".
 * Mirrored client-side in packages/flow-editor/src/flowDefinition.ts.
 *
 * @returns an error message, or null when the step list is acceptable.
 */
function flowStepsError(steps: any): string | null {
  if (!Array.isArray(steps)) return "steps must be an array";
  for (const s of steps) {
    if (!s || typeof s !== 'object') return "each step must be an object";
    if (typeof s.name !== 'string' || !s.name.trim()) return "each step requires a name";
    if (typeof s.order !== 'number' || Number.isNaN(s.order)) return "each step requires a numeric order";
  }
  // CGLAB-380: roles and checks, including that every record a check needs is
  // produced by an earlier step.
  const contractErrors = flowChecksErrors(steps);
  return contractErrors.length ? contractErrors.join(' ') : null;
}

/**
 * Fill in step ids the caller omitted. The Hub requires every step to carry a
 * non-empty id, so generating here means anything the local server persists is
 * publishable — without breaking the callers that never sent ids.
 */
function normalizeSteps(steps: any): any {
  // Canonical implementation lives in @agenfk/core so every persisting path —
  // this route, the registry install, and the hub sync — shares one whitelist.
  return normalizeFlowSteps(steps, () => uuidv4());
}


/**
 * CGLAB-384 — what a draft flow's steps mean, for the flow editor: the same
 * functions validate a save and run verify, so the editor cannot drift from
 * what is enforced. Read-only; the browser cannot import core itself.
 */
app.post("/flows/contract", (req: any, res: any) => {
  res.json(describeFlowContract(req.body?.steps));
});

/**
 * Flow writes (CodeQL js/missing-rate-limiting). A ceiling well above what the
 * editor and the test suites do in a minute - they create flows quickly - that
 * still stops a runaway loop; the same threat model as limitExpensive.
 */
const limitFlowWrites = rateLimit({
  windowMs: 60_000,
  limit: 600,
  keyGenerator: (req: any) => `${ipKeyGenerator(req.ip ?? '127.0.0.1')}\u0000${req.route?.path ?? req.path}`,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req: any, res: any) => {
    res.status(429).json({ error: `Too many requests to ${req.path}. Flow writes are capped at 600 a minute; this is almost always a loop.` });
  },
});

app.post("/flows", limitFlowWrites, asyncHandler(async (req: any, res: any) => {
  const { name, description, version, steps, verifyAt } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });

  const stepsError = flowStepsError(steps);
  if (stepsError) return res.status(400).json({ error: stepsError });
  const verifyAtProblem = verifyAtError(verifyAt);
  if (verifyAtProblem) return res.status(400).json({ error: verifyAtProblem });

  // Always force `source = 'local'` on REST-driven creation. The reconciler
  // writes hub-managed rows directly via storage.createFlow(); this route is
  // for user/admin-driven local flow authoring only.
  const flow: Flow = {
    id: uuidv4(),
    name,
    description: description || "",
    version: version || "1.0.0",
    steps: normalizeSteps(steps || []),
    createdAt: new Date(),
    updatedAt: new Date(),
    source: 'local',
    ...(verifyAt ? { verifyAt } : {}),
  };

  const created = await storage.createFlow(flow);
  io.emit('flow:updated', { flowId: created.id });
  res.status(201).json(created);
}));

app.get("/flows/:id", asyncHandler(async (req: any, res: any) => {
  const flow = await storage.getFlow(req.params.id);
  if (!flow) return res.status(404).json({ error: "Flow not found" });
  res.json(flow);
}));

app.put("/flows/:id", limitFlowWrites, asyncHandler(async (req: any, res: any) => {
  const existing = await storage.getFlow(req.params.id);
  if (!existing) return res.status(404).json({ error: "Flow not found" });
  if (existing.source === 'hub') {
    return res.status(409).json({ error: HUB_MANAGED_FLOW_MSG });
  }
  try {
    const { name, description, version, steps, verifyAt } = req.body;
    const verifyAtProblem = verifyAtError(verifyAt);
    if (verifyAtProblem) return res.status(400).json({ error: verifyAtProblem });
    // Only validate steps when the caller is actually replacing them — a
    // rename-only PUT must keep working.
    // A step that omits role/checks keeps the stored ones (CGLAB-380): an
    // older editor must never wipe a contract. Validated AFTER the merge, since
    // that is the flow that would be stored.
    const merged = Array.isArray(steps) ? mergeStepContracts(steps, existing.steps as any) : steps;
    if (steps !== undefined) {
      const stepsError = flowStepsError(merged);
      if (stepsError) return res.status(400).json({ error: stepsError });
    }
    const updates: Partial<Flow> = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (version !== undefined) updates.version = version;
    if (steps !== undefined) updates.steps = normalizeSteps(merged);
    if (verifyAt !== undefined && verifyAt !== null) updates.verifyAt = verifyAt;

    const updated = await storage.updateFlow(req.params.id, updates);
    io.emit('flow:updated', { flowId: updated.id });
    res.json(updated);
  } catch (error) {
    res.status(404).json({ error: "Flow not found" });
  }
}));

app.delete("/flows/:id", asyncHandler(async (req: any, res: any) => {
  const flow = await storage.getFlow(req.params.id);
  if (!flow) return res.status(404).json({ error: "Flow not found" });
  if (flow.source === 'hub') {
    return res.status(409).json({ error: HUB_MANAGED_FLOW_MSG });
  }

  await storage.deleteFlow(req.params.id);
  io.emit('flow:updated', { flowId: req.params.id, deleted: true });
  res.status(204).send();
}));

// ── Flow Registry Proxy ───────────────────────────────────────────────────────

const REGISTRY_OWNER = process.env.AGENFK_REGISTRY_OWNER ?? 'cglab-public';
const REGISTRY_REPO = process.env.AGENFK_REGISTRY_REPO ?? 'agenfk-flows';
const REGISTRY_BRANCH = process.env.AGENFK_REGISTRY_BRANCH ?? 'main';
const GITHUB_API = 'https://api.github.com';

interface RegistryFlowEntry {
  filename: string;
  name: string;
  author?: string;
  version?: string;
  stepCount: number;
  description?: string;
  steps?: { name: string; label: string }[];
}

app.get("/registry/flows", asyncHandler(async (_req: any, res: any) => {
  // A hub-connected installation asks the hub which registry its org uses
  // (CGLAB-138). Two reasons this must be the hub and not a local config read:
  // the org's GitHub token lives on the hub and must not be copied onto every
  // laptop, and the admin's choice is org-wide — a per-machine override would
  // let one workstation browse flows its org deliberately sealed away.
  if (hubClient.isEnabled && hubClient.hubConfig) {
    const { url, token } = hubClient.hubConfig;
    try {
      const r = await (globalThis.fetch as any)(`${url.replace(/\/$/, "")}/v1/registry/flows`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (!r.ok) {
        // Do NOT fall through to the public registry on failure. An org that
        // moved to a private repo would be shown the community catalogue it
        // moved away from, and would have no signal that it was looking at the
        // wrong thing.
        return res.status(502).json({
          error: `Hub registry unavailable (${r.status}); not falling back to the public registry`,
          hubEnabled: true,
        });
      }
      const body = await r.json();
      return res.json(body.flows ?? []);
    } catch (e: any) {
      return res.status(502).json({
        error: `Hub unreachable (${e?.message ?? "error"}); not falling back to the public registry`,
        hubEnabled: true,
      });
    }
  }

  const url = `${GITHUB_API}/repos/${REGISTRY_OWNER}/${REGISTRY_REPO}/contents/flows?ref=${REGISTRY_BRANCH}`;
  try {
    const { data: entries } = await axios.get(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'agenfk-server',
      },
    });

    if (!Array.isArray(entries)) {
      return res.json([]);
    }

    const jsonFiles: { name: string; download_url: string }[] = entries.filter(
      (e: any) => e.type === 'file' && e.name.endsWith('.json')
    );

    const flows: RegistryFlowEntry[] = await Promise.all(
      jsonFiles.map(async (file) => {
        try {
          const { data: content } = await axios.get(file.download_url, { headers: { 'User-Agent': 'agenfk-server' } });
          return {
            filename: file.name,
            name: content.name ?? file.name.replace('.json', ''),
            author: content.author,
            version: content.version,
            stepCount: Array.isArray(content.steps) ? content.steps.length : 0,
            description: content.description,
            steps: Array.isArray(content.steps)
              ? content.steps.map((s: any) => ({ name: s.name ?? '', label: s.label ?? s.name ?? '' }))
              : undefined,
          };
        } catch {
          return {
            filename: file.name,
            name: file.name.replace('.json', ''),
            stepCount: 0,
          };
        }
      })
    );

    res.json(flows);
  } catch (e: any) {
    // 404 means the flows directory doesn't exist yet — treat as empty registry
    if (e?.response?.status === 404) return res.json([]);
    const status = e?.response?.status ?? 502;
    res.status(status).json({ error: 'Failed to fetch registry', detail: e?.message });
  }
}));

app.post("/registry/flows/install", limitExpensive, asyncHandler(async (req: any, res: any) => {
  const { filename } = req.body;
  if (!filename) return res.status(400).json({ error: 'filename is required' });

  // Same hub-first rule as the browse route above: an org on a private registry
  // must not be able to install from the public one behind its admin's back,
  // and cannot read its own private repo without the hub-held token.
  if (hubClient.isEnabled && hubClient.hubConfig) {
    const { url: hubUrl, token: hubToken } = hubClient.hubConfig;
    try {
      const r = await (globalThis.fetch as any)(`${hubUrl.replace(/\/$/, "")}/v1/registry/flows/install`, {
        method: "POST",
        headers: { Authorization: `Bearer ${hubToken}`, Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ filename }),
      });
      if (!r.ok) {
        return res.status(502).json({
          error: `Hub registry install failed (${r.status}); not falling back to the public registry`,
          hubEnabled: true,
        });
      }
      const body = await r.json();
      // Through the step whitelist, and validated, like every other path.
      const hubSteps = normalizeFlowSteps((body.flow?.steps ?? []).map((s: any) => ({ ...s, id: uuidv4() })), () => uuidv4());
      const hubStepsError = flowStepsError(hubSteps);
      if (hubStepsError) return res.status(422).json({ error: `The registry flow cannot be installed: ${hubStepsError}` });
      const created = await storage.createFlow({
        // efcacdeb: someone else's text - its command checks never run.
        origin: 'registry',
        id: uuidv4(),
        name: body.flow?.name ?? filename,
        description: body.flow?.description,
        steps: hubSteps,
        ...(flowVerifyAt(body.flow) === 'parent' ? { verifyAt: 'parent' as const } : {}),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return res.json(created);
    } catch (e: any) {
      return res.status(502).json({
        error: `Hub unreachable (${e?.message ?? "error"}); not falling back to the public registry`,
        hubEnabled: true,
      });
    }
  }

  const url = `${GITHUB_API}/repos/${REGISTRY_OWNER}/${REGISTRY_REPO}/contents/flows/${encodeURIComponent(filename)}?ref=${REGISTRY_BRANCH}`;
  try {
    const { data: fileInfo } = await axios.get(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'agenfk-server',
      },
    });

    const rawContent = Buffer.from(fileInfo.content, 'base64').toString('utf8');
    const flowData = JSON.parse(rawContent);

    // Fresh anchors, and each step's contract kept (anchors' too): the same
    // transform as the hub's install paths.
    const steps = registryInstallSteps(flowData.steps, () => uuidv4());
    // CGLAB-380: a community flow's roles and checks are validated like any
    // other; an invalid one is refused whole, never installed with parts dropped.
    const registryStepsError = flowStepsError(steps);
    if (registryStepsError) return res.status(422).json({ error: `The registry flow cannot be installed: ${registryStepsError}` });

    // Create flow in local storage (no projectId — registry flows are global)
    const newFlow = await storage.createFlow({
        // efcacdeb: someone else's text - its command checks never run.
        origin: 'registry',
      id: uuidv4(),
      name: flowData.name ?? filename.replace('.json', ''),
      description: flowData.description,
      steps,
      ...(flowVerifyAt(flowData) === 'parent' ? { verifyAt: 'parent' as const } : {}),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    res.json(newFlow);
  } catch (e: any) {
    const status = e?.response?.status ?? 502;
    res.status(status).json({ error: 'Failed to install flow', detail: e?.message });
  }
}));

/**
 * Who a hub-published flow names as its publisher (CGLAB-372): this machine's
 * GitHub login when `gh` is signed in - what the old direct gh path showed -
 * else the OS login. Best effort by design, and never allowed to hold up the
 * publish: gh is asked with argv (no shell), and an answer that is late, empty
 * or not shaped like a GitHub login falls back. os.userInfo() throws for a uid
 * with no passwd entry (some containers).
 */
const GH_LOGIN_TIMEOUT_MS = 2_000;
// Loose on purpose: Enterprise Managed User logins carry an underscore
// (`handle_shortcode`), and the hub bounds and neutralises the value anyway.
// What it must reject is not-a-login: a sentence, or jq's `null`.
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,98}[A-Za-z0-9])?$/;
async function reportedPublisher(): Promise<string> {
  const ghLogin = await Promise.race<string | null>([
    new Promise<string | null>((resolve) => {
      try {
        // Pinned to github.com - the registry PR lives there - so a GH_HOST
        // pointing at GitHub Enterprise does not credit a different identity.
        execFile('gh', ['api', '--hostname', 'github.com', 'user', '--jq', '.login'], { timeout: GH_LOGIN_TIMEOUT_MS }, (err, stdout) => {
          const login = err ? '' : String(stdout ?? '').trim();
          resolve(login !== 'null' && GITHUB_LOGIN.test(login) ? login : null);
        });
      } catch {
        resolve(null);
      }
    }),
    // execFile's own timeout kills a real gh at the same 2s; this bound also
    // covers a spawn that never calls back at all.
    new Promise<null>((resolve) => { const t = setTimeout(() => resolve(null), GH_LOGIN_TIMEOUT_MS); t.unref?.(); }),
  ]);
  if (ghLogin) return ghLogin;
  try { return os.userInfo().username || 'unknown'; } catch { return 'unknown'; }
}

app.post("/registry/flows/publish", asyncHandler(async (req: any, res: any) => {
  const { flowId, registry } = req.body;
  if (!flowId) return res.status(400).json({ error: 'flowId is required' });
  // Only a literal true: removing a registry flow's roles/checks must be asked for.
  const allowContractRemoval = req.body?.allowContractRemoval === true;

  const flow = await storage.getFlow(flowId);
  if (!flow) return res.status(404).json({ error: 'Flow not found' });

  /*
   * A HUB-CONNECTED installation publishes through the hub (CGLAB-367), the way
   * it already browses and installs (CGLAB-138): an org that moved to its own
   * registry keeps that repo's token on the hub, so this machine cannot - and
   * must not - push there itself. The hub opens (or updates) the pull request.
   *
   * The same no-fallback rule as browse: a hub that is unreachable or refuses
   * is an ERROR here, never a quiet publish to the public registry the org
   * moved away from. The one case that stays on this machine's gh path is the
   * hub answering that the org itself uses the public registry.
   */
  if (hubClient.isEnabled && hubClient.hubConfig) {
    const { url, token } = hubClient.hubConfig;
    // Worst case the hub makes several sequential GitHub calls, each bounded
    // at 15s; wait longer than that, or a slow success reads as a failure.
    const HUB_PUBLISH_TIMEOUT_MS = 120_000;
    // Reported, not verified: the hub labels it so and records the
    // installation id as the attribution it can vouch for.
    const publisher = await reportedPublisher();
    let r: any;
    try {
      r = await (globalThis.fetch as any)(`${url.replace(/\/$/, '')}/v1/registry/flows/publish`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          flow: {
            name: flow.name,
            description: flow.description ?? '',
            version: (flow as any).version || '1.0.0',
            ...(flowVerifyAt(flow) === 'parent' ? { verifyAt: 'parent' } : {}),
            // The registry's fields only: local step ids and cosmetics stay here.
            steps: [...flow.steps].sort((a: any, b: any) => a.order - b.order).map((st: any) => ({
              name: st.name,
              label: st.label,
              order: st.order,
              exitCriteria: st.exitCriteria,
              isSpecial: st.isSpecial,
              isAnchor: st.isAnchor,
              // The step contract is a registry field: without it the hub
              // refuses this machine's own flow as a stripped copy.
              ...stepContractFields(st),
            })),
          },
          publisher,
          ...(allowContractRemoval ? { allowContractRemoval: true } : {}),
        }),
        signal: AbortSignal.timeout(HUB_PUBLISH_TIMEOUT_MS),
      });
    } catch (e: any) {
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
        return res.status(504).json({
          error: `The hub did not answer within ${HUB_PUBLISH_TIMEOUT_MS / 1000}s. It may still open the pull request; `
            + 'publishing again is safe and updates the same pull request. Nothing was published to the public registry.',
          hubEnabled: true,
        });
      }
      return res.status(502).json({
        error: `Hub unreachable (${e?.message ?? 'error'}); not publishing to the public registry instead`,
        hubEnabled: true,
      });
    }
    const body: any = await r.json().catch(() => null);
    if (r.ok) {
      // A success must carry something to show: a proxy's HTML page or an
      // empty body is not a publish, and reporting it as one is a false
      // "PR opened" with nothing behind it.
      if (!body || typeof body.url !== 'string' || !/^https:\/\/github\.com\//.test(body.url)
        || (body.kind !== 'pr' && body.kind !== 'existing')) {
        return res.status(502).json({
          error: 'The hub returned an unexpected publish response; not publishing to the public registry instead',
          hubEnabled: true,
        });
      }
      // The hub owns the version of what it published; keep the local flow in step.
      // A failure to record it locally must not report a publish that DID
      // happen as a failure - the pull request is open either way.
      let warning: string | undefined;
      if (typeof body.version === 'string' && body.version !== (flow as any).version) {
        try {
          await storage.updateFlow(flowId, { version: body.version } as any);
        } catch (e: any) {
          warning = `Published, but the local flow could not record version ${body.version}: ${e?.message ?? e}`;
        }
      }
      return res.json({
        url: body.url, kind: body.kind, repo: body.repo,
        ...(body.branch ? { branch: body.branch } : {}),
        ...(body.version ? { version: body.version } : {}),
        ...(typeof body.note === 'string' ? { note: body.note } : {}),
        ...(warning ? { warning } : {}),
      });
    }
    // A hub that has the route always explains a refusal. A bare 404 is a hub
    // too old to publish - say so rather than pass through a meaningless 404.
    if (r.status === 404 && typeof body?.error !== 'string') {
      return res.status(502).json({
        error: 'This hub does not support publishing flows yet - upgrade the hub. Nothing was published to the public registry.',
        hubEnabled: true,
      });
    }
    if (!(r.status === 409 && body?.public === true)) {
      return res.status(r.status >= 500 ? 502 : r.status).json({
        error: body?.error ?? `Hub refused the publish (${r.status}); not publishing to the public registry instead`,
        hubEnabled: true,
        ...(body?.repo ? { repo: body.repo } : {}),
      });
    }
    // The org is on the public community registry: publish from here, as before.
  }

  // Require gh CLI
  try { execSync('gh --version', { stdio: 'pipe' }); } catch {
    return res.status(503).json({ error: 'gh CLI is not installed on the server.' });
  }

  // gh must already be authenticated — get current user login (= author)
  let ghUser: string;
  try {
    ghUser = execSync('gh api user --jq .login', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return res.status(503).json({ error: 'gh CLI is not authenticated. Run `gh auth login` on the server.' });
  }

  // Get token from gh for git operations
  const ghToken = execSync('gh auth token', { stdio: 'pipe' }).toString().trim();

  const [registryOwner, registryRepo] = registry
    ? (registry as string).split('/')
    : [REGISTRY_OWNER, REGISTRY_REPO];

  // registry is attacker-controllable and is interpolated into git/gh commands
  // and URLs below. Validate to a GitHub-safe charset so it can never break out
  // of an argument (combined with argv-form exec, no shell). (Security: bug 6d0a982f.)
  // Must not start with '-' (GitHub names never do) so the value can't be read
  // as a flag when passed as an argv element to gh/git. (Security: bug 6d0a982f.)
  const GH_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
  if (!registryOwner || !registryRepo || !GH_NAME_RE.test(registryOwner) || !GH_NAME_RE.test(registryRepo)) {
    return res.status(400).json({ error: 'registry must be "owner/repo" using only letters, digits, dot, dash, underscore' });
  }

  const slug = flow.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const filename = `${slug}.json`;

  const isOwner = ghUser === registryOwner;

  // Non-owners publish via a fork; owners push directly. All git/gh shellouts
  // below use argv form (no shell) so flow.name, registry and the embedded gh
  // token can never be interpreted as shell. (Security: bugs 6d0a982f, 57b4d95b.)
  if (!isOwner) {
    execFileSync('gh', ['repo', 'fork', `${registryOwner}/${registryRepo}`, '--clone=false'], { stdio: 'pipe' });
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-registry-'));
  try {
    // Shallow-clone the upstream to check for name clashes
    execFileSync('git', ['clone', '--depth', '1', '--quiet', `https://oauth2:${ghToken}@github.com/${registryOwner}/${registryRepo}.git`, tmpDir], { stdio: 'pipe' });

    // Non-owners switch the push remote to their fork
    if (!isOwner) {
      execFileSync('git', ['-C', tmpDir, 'remote', 'set-url', 'origin', `https://oauth2:${ghToken}@github.com/${ghUser}/${registryRepo}.git`], { stdio: 'pipe' });
    }

    const flowsDir = path.join(tmpDir, 'flows');
    if (!fs.existsSync(flowsDir)) fs.mkdirSync(flowsDir, { recursive: true });

    const targetPath = path.join(flowsDir, filename);
    const fileExists = fs.existsSync(targetPath);
    // CGLAB-385: never replace a registry flow's roles/checks with a copy that has none.
    if (fileExists) {
      let registrySteps: unknown;
      try { registrySteps = JSON.parse(fs.readFileSync(targetPath, 'utf8'))?.steps; } catch { /* unreadable: nothing to protect */ }
      if (!allowContractRemoval && wouldStripContracts(registrySteps, flow.steps)) return res.status(409).json({ error: STRIPPED_PUBLISH_MESSAGE });
    }

    // Auto-increment patch version on re-publish; persist updated version back to local flow
    let version = (flow as any).version || '1.0.0';
    if (fileExists) {
      const parts = version.split('.').map(Number);
      parts[2] = (parts[2] || 0) + 1;
      version = parts.join('.');
      await storage.updateFlow(flowId, { version } as any);
    }

    const content = JSON.stringify(
      {
        name: flow.name,
        description: flow.description ?? '',
        author: ghUser,
        version,
        ...(flowVerifyAt(flow) === 'parent' ? { verifyAt: 'parent' } : {}),
        steps: flow.steps
          .sort((a: any, b: any) => a.order - b.order)
          .map((s: any) => ({
            name: s.name,
            label: s.label,
            exitCriteria: s.exitCriteria,
            isSpecial: s.isSpecial,
            isAnchor: s.isAnchor,
            order: s.order,
            // CGLAB-385: the step contract travels with the flow.
            ...stepContractFields(s),
          })),
      },
      null,
      2
    );

    // Name clash: identical content → already published, skip
    if (!fileExists || fs.readFileSync(targetPath, 'utf8').trim() !== content.trim()) {
      const commitMsg = fileExists ? `Update flow: ${flow.name}` : `Add flow: ${flow.name}`;

      // Non-owners commit on a feature branch; owners commit directly on the cloned main
      const branchName = isOwner ? null : `flow/${slug}-${Date.now()}`;
      if (branchName) {
        execFileSync('git', ['-C', tmpDir, 'checkout', '-b', branchName], { stdio: 'pipe' });
      }

      fs.writeFileSync(targetPath, content + '\n');
      execFileSync('git', ['-C', tmpDir, 'add', `flows/${filename}`], { stdio: 'pipe' });
      execFileSync('git', ['-C', tmpDir, 'commit', '-m', commitMsg], { stdio: 'pipe' });

      if (isOwner) {
        execFileSync('git', ['-C', tmpDir, 'push', 'origin', 'main'], { stdio: 'pipe' });
        const fileUrl = `https://github.com/${registryOwner}/${registryRepo}/blob/main/flows/${filename}`;
        return res.json({ url: fileUrl, kind: 'direct', version, repo: `${registryOwner}/${registryRepo}` });
      } else {
        execFileSync('git', ['-C', tmpDir, 'push', 'origin', branchName!], { stdio: 'pipe' });
        const prBody = [`Published from AgEnFK Flow Editor.`, '', `**Flow**: ${flow.name}`, flow.description ? `**Description**: ${flow.description}` : ''].filter(Boolean).join('\n');
        const prUrl = execFileSync('gh', [
          'pr', 'create',
          '--repo', `${registryOwner}/${registryRepo}`,
          '--head', `${ghUser}:${branchName}`,
          '--base', 'main',
          '--title', commitMsg,
          '--body', prBody,
        ], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
        return res.json({ url: prUrl, kind: 'pr', version, repo: `${registryOwner}/${registryRepo}` });
      }
    }

    return res.json({
      url: `https://github.com/${registryOwner}/${registryRepo}/blob/main/flows/${filename}`,
      kind: 'existing',
      note: 'Already published — no changes detected.',
      version,
      repo: `${registryOwner}/${registryRepo}`,
    });
  } catch (e: any) {
    res.status(502).json({ error: 'Failed to publish flow', detail: e?.message });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}));

// Flow Migration API
app.post("/projects/:id/flow/migrate", asyncHandler(async (req: any, res: any) => {
  const { id: projectId } = req.params;
  const { flowId, dryRun = false } = req.body;

  if (!flowId) {
    return res.status(400).json({ error: "flowId is required" });
  }

  const project = await storage.getProject(projectId);
  if (!project) {
    return res.status(404).json({ error: "Project not found" });
  }

  // Resolve the old (current) flow for this project
  const projectWithFlow = project as Project & { flowId?: string };
  const currentFlowId: string | undefined = projectWithFlow.flowId;

  let oldFlow: Flow;
  if (currentFlowId) {
    const found = await storage.getFlow(currentFlowId);
    if (!found) {
      return res.status(404).json({ error: `Current project flow '${currentFlowId}' not found` });
    }
    oldFlow = found;
  } else {
    // No custom flow set — use DEFAULT_FLOW
    oldFlow = DEFAULT_FLOW;
  }

  // Resolve the target flow
  const newFlow = await storage.getFlow(flowId);
  if (!newFlow) {
    return res.status(404).json({ error: `Target flow '${flowId}' not found` });
  }

  // Gather all items for this project
  const items = await storage.listItems({ projectId });

  // Run migration algorithm
  const migrationPlan = migrateCardsToFlow(items, oldFlow, newFlow);

  if (dryRun) {
    return res.json({ dryRun: true, migrations: migrationPlan });
  }

  // Apply migrations
  const applied: typeof migrationPlan = [];
  for (const plan of migrationPlan) {
    const item = items.find((i) => i.id === plan.itemId);
    if (!item) continue;

    if (plan.oldStatus !== plan.newStatus) {
      // Same rule as applyMigrationPlan: a migration may reshuffle items between
      // working steps, but it may never land one on the flow's exit anchor and
      // thereby complete the work without evidence. Positional mapping made this
      // reachable with a flow whose first step is simply named DONE.
      const migRealSteps = [...newFlow.steps]
        .sort((a: any, b: any) => a.order - b.order)
        .filter((st: any) => !st.isSpecial && !PLATFORM_STATUSES.has(st.name as Status));
      const migExit = migRealSteps[migRealSteps.length - 1]?.name?.toUpperCase();
      const target = String(plan.newStatus).toUpperCase();
      if ((target === migExit || target === Status.DONE)
          && String(plan.oldStatus).toUpperCase() !== Status.DONE) {
        console.warn(`[FLOW_MIGRATION] Refused to migrate ${plan.itemId} onto '${plan.newStatus}'.`);
        continue;
      }
      const migrationComment = {
        id: uuidv4(),
        author: 'FlowMigration',
        content: `Migrated from step '${plan.oldStatus}' to '${plan.newStatus}' (${plan.reason})`,
        timestamp: new Date(),
      };
      const updatedComments = [...(item.comments || []), migrationComment];
      await storage.updateItem(plan.itemId, {
        status: plan.newStatus as Status,
        comments: updatedComments,
      });
    }
    applied.push(plan);
  }

  io.emit('flow:migrate:complete', { projectId, flowId, migrations: applied });
  io.emit('items_updated');

  return res.json({ dryRun: false, migrations: applied });
}));

// Items API

app.get("/items", asyncHandler(async (req: any, res: any) => {
  const { type, status, parentId, includeArchived, projectId, active } = req.query;
  const query: any = {};
  if (type) query.type = type;
  if (status) query.status = status;
  if (parentId) query.parentId = parentId;
  if (projectId) query.projectId = projectId;

  let items = await storage.listItems(query);

  if (includeArchived !== 'true' && !status) {
    items = items.filter(i => i.status !== Status.ARCHIVED && i.status !== Status.TRASHED);
  }

  // active=true → only items in an active working step, i.e. NOT the flow's
  // anchors (TODO/DONE) and NOT an inactive status (BLOCKED/PAUSED/ARCHIVED/
  // TRASHED/IDEAS). Reuses core getActiveStepItems so this agrees exactly with
  // the gatekeeper's "active working step" definition. Flow-aware: each item is
  // judged against ITS OWN project's flow, so --all across mixed flows and any
  // custom flow both work. Keeps init's resume-check payload small (no DONE
  // pile-up). (TASK 2dd30da3.)
  if (active === 'true') {
    const flowByProject = new Map<string, Flow>();
    const allFlows = await storage.listFlows();
    const resolveFlow = async (pid: string | undefined): Promise<Flow> => {
      const key = pid ?? '';
      const cached = flowByProject.get(key);
      if (cached) return cached;
      let flow = DEFAULT_FLOW;
      if (pid) {
        const proj = await storage.getProject(pid);
        flow = getActiveFlow((proj as any)?.flowId ?? undefined, allFlows);
      }
      flowByProject.set(key, flow);
      return flow;
    };
    const kept: typeof items = [];
    for (const it of items) {
      const flow = await resolveFlow((it as any).projectId);
      if (getActiveStepItems([it as any], flow as any).length > 0) kept.push(it);
    }
    items = kept;
  }

  res.json(items.map(withActiveRun));
}));

app.post("/items/trash-archived", asyncHandler(async (req: any, res: any) => {
  const { projectId } = req.body;
  if (!projectId) return res.status(400).json({ error: "ProjectId is required" });

  const archivedItems = await storage.listItems({ projectId, status: Status.ARCHIVED });
  for (const item of archivedItems) {
    await trashRecursively(item.id);
  }

  io.emit('items_updated');
  res.json({ count: archivedItems.length });
}));

app.get("/items/:id", asyncHandler(async (req: any, res: any) => {
  const item = await storage.getItem(req.params.id);
  if (!item) {
    return res.status(404).json({ error: "Item not found" });
  }
  res.json(withActiveRun(item));
}));

/**
 * 9569b4d7: the verify running on a card and the tail of what it printed, for
 * the board. No agent token: it is the project's own test output, which the
 * card's comments already carry a preview of. 404 when nothing runs.
 */
app.get("/items/:id/active-run", asyncHandler(async (req: any, res: any) => {
  const active = activeRunOf(req.params.id);
  if (!active) return res.status(404).json({ error: 'NO_ACTIVE_RUN' });
  const run = validateRuns.get(active.runId)!;
  res.json({ ...active, output: run.tail ?? run.output.slice(-RUN_TAIL_BYTES) });
}));

/**
 * Statuses an item may be CREATED with.
 *
 * Being born partway through a flow is legitimate — importing from JIRA or
 * GitHub brings items in whatever state they are already in, and parking an item
 * in a working step is normal. Being born FINISHED is not: `status` used to be
 * accepted raw here, so create_item({status:'DONE'}) was advertised on the MCP
 * surface and free, which is the same hole just closed on update_item one
 * function away. Completion is the one state that has to be earned through
 * validate_progress.
 *
 * Anything unrecognised anchors at TODO rather than failing the create: callers
 * legitimately pass a status they inherited, and refusing the whole creation
 * would be worse than starting the item where every item starts.
 */
function sanitizeCreateStatus(status: any, flow: { steps: Array<{ name: string; order: number; isAnchor?: boolean; isSpecial?: boolean }> }): Status {
  if (status === undefined || status === null || status === '') return Status.TODO;
  const upper = String(status).toUpperCase();
  if (PLATFORM_STATUSES.has(upper as Status)) return upper as Status;

  const real = [...flow.steps]
    .sort((a, b) => a.order - b.order)
    .filter(st => !st.isSpecial && !PLATFORM_STATUSES.has(st.name as Status));
  const exitName = real[real.length - 1]?.name?.toUpperCase();

  // Never born complete, whatever the exit step is called.
  if (upper === Status.DONE || (exitName && upper === exitName)) return Status.TODO;

  const match = real.find(st => st.name.toUpperCase() === upper);
  return match ? (match.name as Status) : Status.TODO;
}

// ── External tracker references (JIRA keys, and raw refs for other trackers) ──
//
// externalId/externalUrl have lived on AgEnFKItem since the JIRA importer, and
// the UI renders them as a clickable badge, but until now ONLY the JIRA and
// GitHub imports could write them — the item routes destructured a fixed field
// list that omitted both. These helpers are what let a plain create/update
// attach a reference, and they are the only validation standing in front of it.

/** Passed as `jiraItem` to clear an existing link. Safe as a sentinel because a
 *  bare word with no `-<number>` suffix can never be a valid issue key, so no
 *  real project can collide with it — see parseJiraKey. */
export const JIRA_UNLINK_SENTINEL = 'none';

/**
 * Strict JIRA issue-key parser, returning the canonical uppercase form or null.
 *
 * Anchored deliberately: an embedded key (a browse URL, or prose mentioning an
 * issue) is REJECTED rather than extracted, because silently pulling a key out
 * of arbitrary text turns a paste mistake into a wrong-but-plausible link. On
 * the disconnected path this format check is the only gate there is.
 */
export const parseJiraKey = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  // Bounded FIRST. The grammar below is anchored but not finite — a 5000-char
  // project key or a 400-digit issue number matches it — and this value becomes
  // the item's externalId, part of the derived browse URL, and part of an
  // outbound api.atlassian.com path. The raw-field branches cap their inputs;
  // without this, `jiraItem` was the way around both caps.
  if (trimmed.length > MAX_JIRA_KEY_LENGTH) return null;
  // Matched BEFORE upper-casing and against explicit ASCII classes, because
  // toUpperCase() folds non-ASCII into ASCII — 'ﬀ-1' would otherwise become the
  // accepted 'FF-1'. The project key must start AND end alphanumeric, so the
  // underscore can only appear between them: 'A_-1' is not a key JIRA issues.
  // The issue number is a positive integer with no leading zeros: JIRA numbers
  // issues from 1, and 'AB-007' would be a second spelling of 'AB-7', so two
  // cards could carry different externalIds for one issue.
  if (!/^[A-Za-z][A-Za-z0-9_]*[A-Za-z0-9]-[1-9]\d*$/.test(trimmed)) return null;
  return trimmed.toUpperCase();
};

/** Upper bounds on a stored reference. Items persist as a whole-object JSON blob
 *  (storage-sqlite), so an unbounded string here bloats every read of the item. */
export const MAX_EXTERNAL_ID_LENGTH = 200;
export const MAX_EXTERNAL_URL_LENGTH = 2048;
/** Real JIRA keys are short (project key <= 10 chars by Atlassian's own limit).
 *  This is deliberately generous while still finite. */
export const MAX_JIRA_KEY_LENGTH = 64;

/**
 * externalUrl is rendered as `href={item.externalUrl}` by both KanbanBoard.tsx
 * and CardDetailModal.tsx with no sanitising, so an attacker-supplied
 * `javascript:` or `data:` URL stored here is a stored-XSS trigger on click.
 * The server is the only place that can refuse it. http(s) only.
 *
 * Length is bounded separately, by the caller that accepts user-supplied URLs,
 * so an over-long URL is reported as over-long rather than as an unsafe scheme.
 * The internally derived browse URL is bounded at its source instead: the key
 * is capped by MAX_JIRA_KEY_LENGTH and cloudUrl comes from the OAuth token.
 */
export const isSafeExternalUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    // `http://user:pass@evil.com` is a well-formed http URL, and as a board
    // badge it is a credential-embedding phishing href. Nothing legitimate
    // needs userinfo in a tracker link.
    if (parsed.username || parsed.password) return false;
    return true;
  } catch {
    return false;
  }
};

/** Does this URL look like a JIRA browse link for exactly this key? Used to
 *  decide whether a URL already on the card still describes the key being
 *  linked. It is a shape check, not a provenance check — it cannot tell a
 *  server-derived URL from a caller-supplied one. */
export const isJiraBrowseUrlFor = (value: string, key: string): boolean => {
  if (!isSafeExternalUrl(value)) return false;
  try {
    const parsed = new URL(value);
    // Path only — the HOST is deliberately not checked, because this runs on
    // the disconnected path where there is no token and therefore no known
    // JIRA host to compare against. Stated plainly so nobody reads this as a
    // host guarantee: it does NOT verify the URL points at a real JIRA site.
    //
    // What bounds the risk is that this branch only ever RETAINS a URL already
    // stored on the card; it cannot introduce one. A caller able to plant
    // https://evil.example/browse/KEY can already do so directly via the raw
    // externalUrl field, which is an intentional capability for non-JIRA
    // trackers, and the server binds loopback only.
    //
    // Matched on SEGMENTS, decoded one at a time — not on the decoded whole
    // path. Decoding first and then comparing lets '%2F' smuggle a separator in,
    // so '/x%2Fbrowse%2FKEY' (a single real segment) would read as a browse
    // path. Per-segment decoding keeps '%2D' working as a spelling of '-' while
    // '%2F' stays inside one segment and simply fails to match.
    //
    // The last two segments must be 'browse' and the key, which tolerates a
    // context path ('/jira/browse/KEY' on JIRA Server/DC).
    const segments = parsed.pathname.split('/').map(decodeURIComponent);
    // A trailing slash leaves an empty final segment ('/browse/KEY/'), which
    // would otherwise fail to match and silently drop a usable stored URL.
    while (segments.length && segments[segments.length - 1] === '') segments.pop();
    if (segments.length < 2) return false;
    const last = segments[segments.length - 1].toUpperCase();
    const penultimate = segments[segments.length - 2].toUpperCase();
    return penultimate === 'BROWSE' && last === key.toUpperCase();
  } catch {
    return false;
  }
};

/**
 * Echo a rejected value back safely.
 *
 * `String(raw)` looks harmless but THROWS on an object with null toString and
 * valueOf, which turned the clean-rejection path into a 500. And the echo is
 * caller-controlled: unbounded it returns megabytes in the error body (and,
 * through bulk, once per entry), and raw control bytes reach the operator's
 * terminal, so it is truncated and stripped.
 */
export const describeRejectedInput = (raw: unknown): string => {
  let text: string;
  if (typeof raw === 'string') text = raw;
  else {
    try {
      text = JSON.stringify(raw) ?? Object.prototype.toString.call(raw);
    } catch {
      text = Object.prototype.toString.call(raw);
    }
  }
  // eslint-disable-next-line no-control-regex
  const printable = text.replace(/[\u0000-\u001f\u007f]/g, '');
  // Array.from, not slice: slice cuts UTF-16 code units and would emit a lone
  // surrogate into the JSON error body for input ending in astral characters.
  const chars = Array.from(printable);
  return chars.length > 80 ? `${chars.slice(0, 80).join('')}…` : printable;
};

type JiraResolution =
  | { kind: 'unlink' }
  | { kind: 'link'; externalId: string; externalUrl: string | null; warning?: string }
  | { kind: 'error'; error: string };

// No JIRA call may hang a create/update behind an unresponsive Atlassian, so
// every outbound call on the linking path is bounded — the API request helper
// set no timeout of its own, and neither did the token refresh it falls back to
// on a 401, which is the path that could stall unbounded.
export const JIRA_HTTP_TIMEOUT_MS = 8000;

/**
 * Resolve a `jiraItem` value into the reference pair to store.
 *
 * Validate-if-connected: with an OAuth token present the key is confirmed
 * against JIRA and the browse URL is derived from the token's cloudUrl; a key
 * JIRA refuses (404/403) is rejected outright. Without a token — the offline
 * and CI case — the format-checked key is stored bare, with no URL to invent.
 * If JIRA is merely unreachable the link still goes through, but it comes back
 * with a warning: an unverified link is a fact the caller must be told, not a
 * failure to swallow.
 */
export const resolveJiraReference = async (
  raw: unknown,
  current?: { externalId?: string | null; externalUrl?: string | null },
): Promise<JiraResolution> => {
  if (typeof raw === 'string' && raw.trim().toLowerCase() === JIRA_UNLINK_SENTINEL) {
    return { kind: 'unlink' };
  }

  const key = parseJiraKey(raw);
  if (!key) {
    return {
      kind: 'error',
      error: `Invalid JIRA item '${describeRejectedInput(raw)}'. Expected an issue key like 'CGLAB-163', or '${JIRA_UNLINK_SENTINEL}' to unlink.`,
    };
  }

  // Hub-joined: this user's connection on the hub, never a local token.
  let session: JiraSession | null;
  try {
    session = await openJiraSession();
  } catch (err: any) {
    return {
      kind: 'link',
      externalId: key,
      externalUrl: keptBrowseUrl(key, current),
      warning: `Linked '${key}' without verifying it — the hub could not be reached (${err?.code || err?.message || 'unknown error'}).`,
    };
  }
  if (!session) {
    // Disconnected: the key is all we can honestly assert. But re-linking the
    // SAME key while offline must not destroy the URL already on the card —
    // that would silently strip the badge's href (see keptBrowseUrl).
    const bare: JiraResolution = { kind: 'link', externalId: key, externalUrl: keptBrowseUrl(key, current) };
    // Joined but not connected: same bare link, but say why and what fixes it.
    const hub = joinedHub();
    return hub ? { ...bare, warning: `Linked '${key}' without verifying it — ${await hubNotConnectedMessage(hub)}` } : bare;
  }

  const rawBrowseUrl = `${session.cloudUrl}/browse/${key}`;
  // The derived URL is stored and rendered as an href like any other, so it
  // goes through the same guard. cloudUrl comes from the OAuth resource list
  // unchecked, so a resource without a url yields the literal
  // 'undefined/browse/KEY' — which is not a URL at all, and must not be stored.
  const browseUrl = isSafeExternalUrl(rawBrowseUrl) ? rawBrowseUrl : null;
  try {
    await session.get(`issue/${encodeURIComponent(key)}?fields=summary`, JIRA_HTTP_TIMEOUT_MS);
    return { kind: 'link', externalId: key, externalUrl: browseUrl };
  } catch (err: any) {
    const status = err?.response?.status;
    if (status === 404 || status === 403 || status === 400) {
      return {
        kind: 'error',
        error: `JIRA item '${key}' could not be found or is not readable with the connected account (HTTP ${status}).`,
      };
    }
    // Transport failure, 5xx, expired refresh: the key is well-formed and JIRA
    // simply could not answer. Link, but say so.
    return {
      kind: 'link',
      externalId: key,
      externalUrl: browseUrl,
      warning: `Linked '${key}' without verifying it — JIRA could not be reached (${err?.code || err?.message || 'unknown error'}).`,
    };
  }
};

/**
 * The browse URL already on a card, kept when re-linking the SAME key without
 * a connection. Compared case-insensitively because `key` is normalised to
 * upper case while a raw externalId is stored verbatim. The card carries no
 * record of where its URL came from, so this cannot claim it was verified -
 * only that it is shaped like a browse link for this exact key, which is why a
 * leftover URL for a DIFFERENT issue is dropped.
 */
function keptBrowseUrl(
  key: string,
  current?: { externalId?: string | null; externalUrl?: string | null },
): string | null {
  const sameKey = (current?.externalId ?? '').trim().toUpperCase() === key;
  return sameKey && current?.externalUrl && isJiraBrowseUrlFor(current.externalUrl, key)
    ? current.externalUrl
    : null;
}

/** Attach an unverified-link warning to a response body, when there is one.
 *  Both item write paths need this, and the shape must stay identical between
 *  them so a client can read `jiraWarning` without caring which route ran. */
export const withJiraWarning = <T extends object>(payload: T, warning?: string): T =>
  warning ? { ...payload, jiraWarning: warning } : payload;

/**
 * Shared create/update handling for the reference fields. Returns the updates to
 * apply (possibly nulls, to clear), or an error string for a 400.
 */
export const buildExternalRefUpdates = async (
  body: any,
  current?: { externalId?: string | null; externalUrl?: string | null },
): Promise<{ error: string } | { updates: Record<string, any>; warning?: string }> => {
  const updates: Record<string, any> = {};
  let warning: string | undefined;

  if (body.jiraItem !== undefined) {
    const resolved = await resolveJiraReference(body.jiraItem, current);
    if (resolved.kind === 'error') return { error: resolved.error };
    if (resolved.kind === 'unlink') {
      updates.externalId = null;
      updates.externalUrl = null;
    } else {
      updates.externalId = resolved.externalId;
      updates.externalUrl = resolved.externalUrl;
      warning = resolved.warning;
    }
    // A validated key is authoritative: a conflicting raw externalId in the same
    // payload must not be able to overwrite it below.
    return { updates, warning };
  }

  if (body.externalId !== undefined) {
    if (body.externalId === null || body.externalId === '') {
      updates.externalId = null;
    } else if (typeof body.externalId !== 'string') {
      // String() would have turned an object into the literal '[object Object]'
      // and stored it as the card's tracker id.
      return { error: `Invalid externalId. Expected a string.` };
    } else if (body.externalId.length > MAX_EXTERNAL_ID_LENGTH) {
      return { error: `Invalid externalId. Maximum length is ${MAX_EXTERNAL_ID_LENGTH} characters.` };
    } else {
      updates.externalId = body.externalId;
    }
  }
  if (body.externalUrl !== undefined) {
    if (body.externalUrl === null || body.externalUrl === '') {
      updates.externalUrl = null;
    } else if (typeof body.externalUrl !== 'string') {
      return { error: `Invalid externalUrl. Expected a string.` };
    } else if (body.externalUrl.length > MAX_EXTERNAL_URL_LENGTH) {
      return { error: `Invalid externalUrl. Maximum length is ${MAX_EXTERNAL_URL_LENGTH} characters.` };
    } else if (!isSafeExternalUrl(body.externalUrl)) {
      return { error: `Invalid externalUrl. Only http(s) URLs without embedded credentials are allowed.` };
    } else {
      updates.externalUrl = body.externalUrl;
    }
  }

  return { updates, warning };
};

app.post("/items", asyncHandler(async (req: any, res: any) => {
  console.log(`[API_DEBUG] POST /items body keys: ${Object.keys(req.body).join(', ')}`);
  const { type, title, description, parentId, status, implementationPlan, projectId } = req.body;

  if (!type || !title) {
    return res.status(400).json({ error: "Type and Title are required" });
  }

  if (!projectId) {
    return res.status(400).json({ error: "ProjectId is required" });
  }

  // A brand-new id can have no descendants, so pass itemId=null: existence and
  // project-match still apply, the cycle walk is skipped as impossible.
  // Resolve the project's flow so a create cannot mint a completed item.
  const createFlowForStatus = getActiveFlow(
    (await storage.getProject(projectId) as any)?.flowId,
    await storage.listFlows(),
  );

  const createParentError = await validateParentAssignment(null, projectId, parentId);
  if (createParentError) return res.status(400).json({ error: createParentError });

  // Resolve the tracker reference BEFORE minting the item: a bad key must leave
  // nothing behind, not create a card and then fail.
  const externalRef = await buildExternalRefUpdates(req.body);
  if ('error' in externalRef) return res.status(400).json({ error: externalRef.error });

  const newItem: AgEnFKItem = {
    id: uuidv4(),
    projectId,
    type: type as ItemType,
    title,
    description: description || "",
    // `status` used to be accepted raw here, so create_item({status:'DONE'}) was
    // documented on the MCP surface and free — the same hole just closed on
    // update_item, one function away. The rule that replaced it is the RELAXED
    // one: an item may be parked in any working step it already holds (JIRA and
    // GitHub imports bring items in whatever state they're in, and two
    // pre-existing tests rely on it). Only completion has to be earned, so
    // DONE and the flow's exit anchor are the only refused targets — see
    // sanitizeCreateStatus for the authoritative version of this rule.
    status: sanitizeCreateStatus(status, createFlowForStatus),
    parentId: parentId,
    implementationPlan: implementationPlan || "",
    createdAt: new Date(),
    updatedAt: new Date(),
  } as any;

  if (newItem.type === ItemType.BUG) {
    (newItem as any).severity = "LOW";
  }

  // On a brand-new item an unlink is a no-op — there is no prior reference to
  // clear — so only real values are carried over, leaving the fields absent
  // rather than explicitly null.
  if (externalRef.updates.externalId) (newItem as any).externalId = externalRef.updates.externalId;
  if (externalRef.updates.externalUrl) (newItem as any).externalUrl = externalRef.updates.externalUrl;

  const created = await storage.createItem(newItem);
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [API_CREATE] Item created: ${created.id} (${created.title}). Broadcasting refresh...`);
  io.emit('items_updated');
  io.emit('project_switched', { projectId: created.projectId });
  telemetry.capture('item_created', {
    itemType: created.type,
    flow_name: await resolveFlowName(created.projectId),
  });
  recordHubEvent({
    type: 'item.created',
    projectId: created.projectId,
    itemId: created.id,
    payload: { itemType: created.type, title: created.title, status: created.status, parentId: created.parentId ?? null },
  });

  if (created.parentId) {
    await syncParentStatus(created.parentId);
  }

  res.status(201).json(withJiraWarning(created, externalRef.warning));
}));

app.post("/items/bulk", asyncHandler(async (req: any, res: any) => {
  console.log(`[API_DEBUG] POST /items/bulk processing ${req.body?.items?.length} items`);
  const { items } = req.body;
  if (!Array.isArray(items)) {
    return res.status(400).json({ error: "Expected items array" });
  }

  // Same rules as PUT /items/:id (CGLAB-377): the internal token exempts
  // nothing, and a forward move is the board's alone, recorded on the card.
  const fromBoard = req.headers['x-agenfk-ui'] === '1';
  const results = [];
  // Rejected entries are reported back rather than silently dropped — the route
  // already `continue`s past unknown ids, which hides mistakes.
  const skipped: Array<{ id: string; error: string }> = [];
  // Separate from `skipped`: these entries DID apply, with a caveat.
  const warnings: Array<{ id: string; warning: string }> = [];
  const parentIdsToSync = new Set<string>();
  const projectIds = new Set<string>();

  for (const { id, updates: bodyUpdates } of items) {
    const currentItem = await storage.getItem(id);
    if (!currentItem) continue;

    const { title, description, status, parentId, context, implementationPlan, reviews, comments, sortOrder } = bodyUpdates;

    // The bulk route applied NO flow validation, so it was a way around the
    // per-item gate: one request could move any number of items any distance
    // forward. Same rule as PUT /items/:id, reported per entry rather than
    // failing the whole batch.
    let bulkPreviousAfter: string | undefined;
    let bulkMoveComment: ReturnType<typeof statusMoveComment> | undefined;
    let bulkRolledBack: any[] | undefined;
    const bulkFlow = status !== undefined && status !== currentItem.status
      ? getActiveFlow((await storage.getProject(currentItem.projectId) as any)?.flowId, await storage.listFlows())
      : undefined;
    if (bulkFlow) bulkPreviousAfter = previousStatusAfter(currentItem.status, status, bulkFlow, currentItem.previousStatus);
    if (bulkFlow && !PLATFORM_STATUSES.has(status as Status)) {
      if (isCompletionStep(status, bulkFlow)) {
        skipped.push({ id, error: completionRefusal(status) });
        continue;
      }
      const bulkAllowed = buildAllowedTransitions(currentItem.status, bulkFlow, currentItem.previousStatus);
      if (!bulkAllowed.has(status)) {
        skipped.push({ id, error: `FLOW VIOLATION: Cannot transition from '${currentItem.status}' to '${status}' in flow '${bulkFlow.name}'.` });
        continue;
      }
      const move = classifyStatusMove(id, currentItem.status, status, bulkFlow, fromBoard, currentItem.previousStatus);
      if ('refusal' in move) {
        skipped.push({ id, error: move.refusal });
        continue;
      }
      bulkMoveComment = move.comment;
      if (isMoveBack(currentItem.status, currentItem.previousStatus, status, bulkFlow)) {
        bulkRolledBack = recordsAfterRollback((currentItem as any).stepRecords, status, bulkFlow);
      } else if (fromBoard && isForwardMove(currentItem.status, status, bulkFlow, currentItem.previousStatus)) {
        bulkRolledBack = [...((currentItem as any).stepRecords ?? []), manualAdvanceRecord(currentItem.status, status)];
      }
    }

    // Resolved ABOVE the archive/unarchive `continue`s below. Those branches
    // skip the rest of the loop, so a reference resolved after them was dropped
    // on exactly those entries — a 200 with no link written and nothing in
    // `skipped`, and a MALFORMED key accepted in silence. This is the same
    // mistake PUT /items/:id had, so it gets the same fix.
    const bulkRef = await buildExternalRefUpdates(bodyUpdates, currentItem as any);
    if ('error' in bulkRef) {
      skipped.push({ id, error: bulkRef.error });
      continue;
    }
    const bulkRefUpdates = bulkRef.updates as any;
    const hasBulkRef = Object.keys(bulkRefUpdates).length > 0;
    // A bulk link made while JIRA was unreachable is written UNVERIFIED, and the
    // caller has to be told. Reported through its OWN channel rather than
    // through `skipped`: an entry in `skipped` means "this did not happen", and
    // an unverified link DID happen. Emitted by noteUnverifiedLink() only after
    // the write commits — pushing it here would claim a link on the entries that
    // are later abandoned by the parent guard or by a failed write.
    const noteUnverifiedLink = () => {
      if (bulkRef.warning) warnings.push({ id, warning: bulkRef.warning });
    };

    if (status === Status.ARCHIVED && currentItem.status !== Status.ARCHIVED) {
      await archiveRecursively(id);
      if (hasBulkRef) await storage.updateItem(id, bulkRefUpdates);
      noteUnverifiedLink();
      if (currentItem.parentId) parentIdsToSync.add(currentItem.parentId);
      continue;
    }

    if (status !== undefined && status !== Status.ARCHIVED && currentItem.status === Status.ARCHIVED) {
      await unarchiveRecursively(id);
      await storage.updateItem(id, {
        status: status as Status, ...bulkRefUpdates,
        ...(bulkMoveComment ? { comments: [...(currentItem.comments ?? []), bulkMoveComment] } : {}),
        ...(bulkRolledBack ? { stepRecords: bulkRolledBack } : {}),
      } as any);
      noteUnverifiedLink();
      continue;
    }

    // Same guard as PUT /items/:id — this route is an update despite the POST
    // verb, so without it every state that guard forbids stays reachable here.
    const bulkParentError = await validateParentAssignment(id, currentItem.projectId, parentId);
    if (bulkParentError) {
      skipped.push({ id, error: bulkParentError });
      continue;
    }

    const updates: any = {};
    if (title !== undefined) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (status !== undefined) updates.status = status;
    if (parentId !== undefined) updates.parentId = parentId === '' ? null : parentId;
    if (context !== undefined) updates.context = context;
    if (implementationPlan !== undefined) updates.implementationPlan = implementationPlan;
    if (reviews !== undefined) updates.reviews = reviews;
    if (comments !== undefined) updates.comments = comments;
    if (bulkMoveComment) updates.comments = [...(comments ?? currentItem.comments ?? []), bulkMoveComment];
    if (bulkFlow) updates.previousStatus = bulkPreviousAfter;
    if (bulkRolledBack) updates.stepRecords = bulkRolledBack;
    if (bulkFlow) updates.lastChecks = null;
    if (sortOrder !== undefined) updates.sortOrder = sortOrder;

    Object.assign(updates, bulkRef.updates);

    try {
      const updated = await storage.updateItem(id, updates);
      results.push(updated);
      noteUnverifiedLink();
      projectIds.add(updated.projectId);

      if (updated.parentId) {
        parentIdsToSync.add(updated.parentId);
      }
      // A re-parent changes the child set of the old parent too, so it needs
      // re-deriving as well — otherwise it keeps a status computed from a child
      // it no longer has.
      if (currentItem.parentId && currentItem.parentId !== updated.parentId) {
        parentIdsToSync.add(currentItem.parentId);
      }
    } catch (e) {
      // Previously swallowed entirely, so a failed write looked like a success
      // to the caller. Reported now that there is a channel for it.
      // The id is user data; a format string built from it lets a caller plant
      // console directives (`%s`, `%o`). Passed as an argument instead.
      console.error('[API_BULK] Error updating %s:', id, e);
      skipped.push({ id, error: `Update failed: ${(e as any)?.message ?? 'unknown error'}` });
    }
  }

  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [API_BULK] Processed ${results.length} items. Broadcasting refresh...`);
  io.emit('items_updated');
  projectIds.forEach(projectId => io.emit('project_switched', { projectId }));

  for (const parentId of parentIdsToSync) {
    await syncParentStatus(parentId);
  }

  // `skipped` and `warnings` are both additive — existing callers read `results`
  // only. They mean different things: `skipped` did not apply, `warnings` did
  // apply but with a caveat (an unverified JIRA link).
  res.json({
    results,
    ...(skipped.length > 0 ? { skipped } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  });
}));

app.put("/items/:id", asyncHandler(async (req: any, res: any) => {
  console.log(`[API_DEBUG] PUT /items/${req.params.id} body keys: ${Object.keys(req.body).join(', ')}`);
  const { title, description, status, type, parentId, context, implementationPlan, reviews, tests, comments, sortOrder, branchName, prUrl, prNumber, prStatus, claims, externalId, externalUrl } = req.body;
  // BUG 93d9fbd0: a card's tests are a list of records; anything else is refused
  // before it is stored, where the verify path would trip over it.
  if (tests !== undefined && !Array.isArray(tests)) return res.status(400).json({ error: 'tests must be an array of test records' });

  const currentItem = await storage.getItem(req.params.id);
  if (!currentItem) {
    return res.status(404).json({ error: "Item not found" });
  }

  /*
   * What this card says it owns (819e7192), checked BEFORE it is stored.
   *
   * A claim that cannot be checked is worse than none: claims.ts compares a
   * glob as a literal, so a card believing it holds `packages/**` holds a file
   * with that name, and every collision check it takes part in comes back
   * clear. Storing one would hand out a guarantee nothing keeps.
   *
   * Refusing at DECLARATION rather than at every later edit is the point. A
   * lead cutting a fan-out finds out while it can still re-cut the split;
   * refusing later means each agent discovers the same overlap separately, one
   * gatekeeper call at a time, after the work is already assigned.
   */
  if (claims !== undefined) {
    if (!Array.isArray(claims)) {
      return res.status(400).json({ error: "claims must be an array of paths." });
    }
    const malformed = claims.filter((c: unknown) => !isWellFormedClaim(c));
    if (malformed.length) {
      return res.status(400).json({
        error: `Refusing these claims: ${malformed.map((c: unknown) => JSON.stringify(c)).join(', ')}. `
          + `A claim is a directory or an exact file, repository-relative. Globs are refused rather than `
          + `approximated, because whether two PATTERNS can ever match one path is a different and much `
          + `harder question than whether a path matches one - and a claim that cannot be checked reports `
          + `safety it has not established.`,
      });
    }
    // Per worktree (aaa01834): only cards in this card's tree can collide with it.
    const claimProject = await storage.getProject(currentItem.projectId);
    const { holders, treeOf } = await claimHoldersIn(currentItem.projectId, (claimProject as any)?.projectRoot);
    // A PUT that also re-parents is judged in the tree the card is moving TO.
    const movingTo = parentId !== undefined ? { ...currentItem, parentId: parentId === '' || parentId === null ? null : parentId } : currentItem;
    const gate = gateOnClaims({ id: currentItem.id, claims, tree: treeOf(movingTo) }, holders);
    if (!gate.authorized) {
      return res.status(409).json({ error: gate.message });
    }
  }

  // The internal token no longer exempts a status change from anything below
  // (CGLAB-377). It is a file any same-user agent can read, and nothing
  // legitimate sends it here: validate writes its own result through storage.
  // It still selects setup behaviour for the worktree hook further down.
  const isInternalVerify = req.headers['x-agenfk-internal'] === VERIFY_TOKEN;
  const fromBoard = req.headers['x-agenfk-ui'] === '1';

  // Flow-aware transition validation. This runs for EVERY project, not only
  // those with a custom flow assigned: the previous `if (projectFlowId)` guard
  // meant a project on the shipped default flow — the majority — got no
  // validation at all, so `--status TEST` straight from TODO was accepted.
  // getActiveFlow falls back to DEFAULT_FLOW when no custom flow is set.
  let moveComment: ReturnType<typeof statusMoveComment> | undefined;
  let previousAfter: string | undefined;
  let statusChanged = false;
  let rolledBackRecords: any[] | undefined;
  if (status !== undefined && status !== currentItem.status) {
    const project = await storage.getProject(currentItem.projectId);
    const projectFlows = await storage.listFlows();
    const activeFlow = getActiveFlow((project as any)?.flowId, projectFlows);
    if (isCompletionStep(status, activeFlow)) {
      return res.status(403).json({ error: completionRefusal(status) });
    }
    const allowed = buildAllowedTransitions(currentItem.status, activeFlow, currentItem.previousStatus);
    if (!allowed.has(status)) {
      return res.status(400).json({
        error: `FLOW VIOLATION: Cannot transition from '${currentItem.status}' to '${status}' in the active flow '${activeFlow.name}'. Allowed targets: ${[...allowed].join(', ')}. Forward transitions go through validate_progress, which records evidence and checks the step's exit criteria.`
      });
    }
    // Forward is the board's alone: the user chose to keep drag-and-drop, and
    // every such move is recorded. The header is forgeable until CGLAB-383.
    const move = classifyStatusMove(req.params.id, currentItem.status, status, activeFlow, fromBoard, currentItem.previousStatus);
    if ('refusal' in move) {
      return res.status(409).json({ error: move.refusal });
    }
    moveComment = move.comment;
    previousAfter = previousStatusAfter(currentItem.status, status, activeFlow, currentItem.previousStatus);
    if (isMoveBack(currentItem.status, currentItem.previousStatus, status, activeFlow)) {
      rolledBackRecords = recordsAfterRollback((currentItem as any).stepRecords, status, activeFlow);
    } else if (fromBoard && isForwardMove(currentItem.status, status, activeFlow, currentItem.previousStatus)) {
      rolledBackRecords = [...((currentItem as any).stepRecords ?? []), manualAdvanceRecord(currentItem.status, status)];
    }
    statusChanged = true;
  }

  // Validate type change
  if (type !== undefined) {
    const validTypes = Object.values(ItemType);
    if (!validTypes.includes(type)) {
      return res.status(400).json({ error: `Invalid type '${type}'. Must be one of: ${validTypes.join(', ')}` });
    }
    if (type !== currentItem.type) {
      // With sub-items, the ONLY allowed type change is EPIC -> STORY: an
      // epic's children are stories, so demoting the parent to a story keeps
      // the EPIC -> STORY -> TASK hierarchy coherent. Every other transition
      // on an item that has children would break the shape the board relies
      // on, so it stays blocked (CGLAB-86).
      const children = await storage.listChildren(req.params.id);
      const epicToStory = currentItem.type === ItemType.EPIC && type === ItemType.STORY;
      if (children.length > 0 && !epicToStory) {
        return res.status(400).json({ error: `Cannot change type of an item with children. Only EPIC -> STORY is allowed when the item has sub-items; for any other transition, remove or reassign the children first.` });
      }
    }
  }

  const parentError = await validateParentAssignment(req.params.id, currentItem.projectId, parentId);
  if (parentError) return res.status(400).json({ error: parentError });

  // Resolved AFTER the cheap local guards above, so a request already doomed by
  // a bad type or parent never spends a live JIRA round-trip, and ABOVE the
  // archive/unarchive early returns, because those returns used to skip the
  // reference entirely: `--status ARCHIVED --jira-item X`
  // answered 200 having written no link, and a MALFORMED key answered 200 instead
  // of 400. Validation has to happen on every path that can answer success.
  const externalRef = await buildExternalRefUpdates(req.body, currentItem as any);
  if ('error' in externalRef) return res.status(400).json({ error: externalRef.error });
  const hasExternalRefUpdate = Object.keys(externalRef.updates).length > 0;

  // Both archive branches answer with the freshly-read item plus any
  // unverified-link warning. Written once so the two cannot drift — the warning
  // was originally dropped on exactly these paths.
  const respondWithStoredItem = async () => {
    const stored = await storage.getItem(req.params.id);
    // Deleted between the archive write and this read: answer 404 rather than
    // spreading null into an object and returning a 200 carrying only a warning.
    if (!stored) return res.status(404).json({ error: "Item not found" });
    return res.json(withJiraWarning(stored as any, externalRef.warning));
  };

  if (status === Status.ARCHIVED && currentItem.status !== Status.ARCHIVED) {
    await archiveRecursively(req.params.id);
    if (hasExternalRefUpdate) await storage.updateItem(req.params.id, externalRef.updates as any);
    io.emit('items_updated');
    if (currentItem.parentId) await syncParentStatus(currentItem.parentId);
    return respondWithStoredItem();
  }

  if (status !== undefined && status !== Status.ARCHIVED && currentItem.status === Status.ARCHIVED) {
    await unarchiveRecursively(req.params.id);
    await storage.updateItem(req.params.id, {
      status: status as Status, ...(externalRef.updates as any),
      ...(moveComment ? { comments: [...(currentItem.comments ?? []), moveComment] } : {}),
      ...(rolledBackRecords ? { stepRecords: rolledBackRecords } : {}),
    } as any);
    io.emit('items_updated');
    return respondWithStoredItem();
  }

  const updates: any = {};
  if (title !== undefined) updates.title = title;
  if (description !== undefined) updates.description = description;
  if (status !== undefined) updates.status = status;
  if (type !== undefined) updates.type = type;
  // Normalize the detach forms ('' / null) to undefined-in-storage semantics.
  if (parentId !== undefined) updates.parentId = parentId === '' ? null : parentId;
  if (context !== undefined) updates.context = context;
  if (implementationPlan !== undefined) updates.implementationPlan = implementationPlan;
  if (reviews !== undefined) updates.reviews = reviews;
  if (tests !== undefined) updates.tests = sanitizeCallerTests(tests, currentItem.tests);
  // Which agent works this card. It belongs on the ITEM, not in a browser's
  // localStorage: it is the same fact the hub already records as `--model` /
  // `--harness` when a PR opens, it has to survive a machine change, and a
  // per-machine key made opening card B inherit card A's agent.
  //
  // Stored as an opaque string on purpose — the server has no agent registry
  // and should not grow one. A hostile value is inert: the desktop main process
  // resolves it by exact match against a closed set at spawn time, so anything
  // unknown is refused there rather than executed.
  if (typeof req.body?.agentId === 'string' && req.body.agentId.length <= 64) {
    updates.agentId = req.body.agentId;
  }
  if (comments !== undefined) updates.comments = comments;
  if (moveComment) updates.comments = [...(comments ?? currentItem.comments ?? []), moveComment];
  if (statusChanged) updates.previousStatus = previousAfter;
  if (rolledBackRecords) updates.stepRecords = rolledBackRecords;
  // The last verify's checks belong to the step the card just left (CGLAB-382 review).
  if (statusChanged) updates.lastChecks = null;
  if (sortOrder !== undefined) updates.sortOrder = sortOrder;
  if (branchName !== undefined) updates.branchName = branchName;
  if (prUrl !== undefined) updates.prUrl = prUrl;
  if (prNumber !== undefined) updates.prNumber = prNumber;
  if (prStatus !== undefined) updates.prStatus = prStatus;
  if (claims !== undefined) updates.claims = claims;
  // The JIRA link (main's mechanism, and it is the newer one).
  Object.assign(updates, externalRef.updates);
  /*
   * The link to an issue in another tracker (af47b248).
   *
   * Declared in types.ts since before this route existed and dropped by the
   * destructure ever since, so not one item in the database carried one - the
   * same shape as `claims`: a field complete at both ends with nothing joining
   * them. Absence of a mention leaves it alone, because renaming a card must
   * not unpair it.
   */
  if (externalId !== undefined) updates.externalId = externalId;
  if (externalUrl !== undefined) updates.externalUrl = externalUrl;

  try {
    const updated = await storage.updateItem(req.params.id, updates);

    /*
     * A status change through this route is a route INTO WORK, and it had no
     * worktree hook at all — only the validate paths did.
     *
     * The consequence was not subtle: turning autoWorktree on in a project
     * whose items had already left TODO meant those items might never get one.
     * The setting reads as enabled and does nothing, and the agent edits the
     * main checkout believing it has its own tree.
     *
     * Only when the status actually MOVED and the new step is real work: TODO
     * is not work, and cutting a tree for it would put one on every card the
     * moment a project turns the setting on. shouldAutoWorktree still decides
     * who qualifies, so EPICs and children are refused here exactly as they
     * are everywhere else.
     */
    if (status !== undefined && updated.status !== currentItem.status && updated.status !== Status.TODO) {
      await ensureWorktreeForItem(updated, isInternalVerify);
    }

    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [API_UPDATE] Item ${updated.id} status: ${updated.status}. Broadcasting refresh...`);
    io.emit('items_updated');
    io.emit('project_switched', { projectId: updated.projectId });

    if (updated.parentId) {
      await syncParentStatus(updated.parentId);
    }
    // A re-parent changes the child set of BOTH parents. Without this the old
    // parent keeps a status derived from a child it no longer has — e.g. it sat
    // at IN_PROGRESS only because of the child that just moved away, and should
    // now roll up to DONE.
    if (currentItem.parentId && currentItem.parentId !== updated.parentId) {
      await syncParentStatus(currentItem.parentId);
    }

    if (status !== undefined && status !== currentItem.status) {
      telemetry.capture('item_status_changed', {
        fromStatus: currentItem.status,
        toStatus: status,
        itemType: updated.type,
        flow_name: await resolveFlowName(updated.projectId),
      });
      recordHubEvent({
        type: 'step.transitioned',
        projectId: updated.projectId,
        itemId: updated.id,
        payload: { fromStatus: currentItem.status, toStatus: status, itemType: updated.type },
      });
    } else {
      recordHubEvent({
        type: 'item.updated',
        projectId: updated.projectId,
        itemId: updated.id,
        payload: { changedFields: Object.keys(updates) },
      });
    }
    if (Array.isArray(comments) && comments.length > (currentItem.comments?.length ?? 0)) {
      const newest = comments[comments.length - 1];
      recordHubEvent({
        type: 'comment.added',
        projectId: updated.projectId,
        itemId: updated.id,
        payload: { author: newest?.author, content: newest?.content, step: newest?.step },
      });
    }

    // No close handling here: PUT refuses every route into DONE (CGLAB-377), so it
    // can never close a card. The routes that can - verify, sibling propagation,
    // the parent roll-up - all report it through recordMoveEvents.
    res.json(withJiraWarning(updated, externalRef.warning));
  } catch (error) {
    res.status(404).json({ error: "Item not found" });
  }
}));

app.delete("/items/:id", asyncHandler(async (req: any, res: any) => {
  const itemToDelete = await storage.getItem(req.params.id);
  if (!itemToDelete) {
    return res.status(404).json({ error: "Item not found" });
  }

  const success = await trashRecursively(req.params.id);
  if (success) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [API_TRASH] Item trashed: ${req.params.id}. Broadcasting refresh...`);
    io.emit('items_updated');

    if (itemToDelete.parentId) {
      await syncParentStatus(itemToDelete.parentId);
    }

    res.status(204).send();
  } else {
    res.status(500).json({ error: "Failed to delete item" });
  }
}));

// ── Move item (and children) to another project ──────────────────────────────

const moveToProjectRecursively = async (id: string, targetProjectId: string): Promise<number> => {
  await storage.updateItem(id, { projectId: targetProjectId });
  const children = await storage.listItems({ parentId: id });
  let count = 1;
  for (const child of children) {
    count += await moveToProjectRecursively(child.id, targetProjectId);
  }
  return count;
};

app.post("/items/:id/move", asyncHandler(async (req: any, res: any) => {
  const { targetProjectId } = req.body;
  if (!targetProjectId) {
    return res.status(400).json({ error: "Missing required field: targetProjectId" });
  }

  const item = await storage.getItem(req.params.id);
  if (!item) {
    return res.status(404).json({ error: "Item not found" });
  }

  const targetProject = await storage.getProject(targetProjectId);
  if (!targetProject) {
    return res.status(404).json({ error: "Target project not found" });
  }

  const sourceProjectId = item.projectId;
  const movedCount = await moveToProjectRecursively(req.params.id, targetProjectId);

  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [API_MOVE] Moved ${movedCount} item(s) from project ${sourceProjectId} to ${targetProjectId}`);

  recordHubEvent({
    type: 'item.moved',
    projectId: targetProjectId,
    itemId: req.params.id,
    payload: { fromProjectId: sourceProjectId, toProjectId: targetProjectId, movedCount },
  });

  // Notify both source and target project boards
  io.emit('items_updated');

  const moved = await storage.getItem(req.params.id);
  res.json({ item: moved, movedCount });
}));

// ── Verify Endpoints ─────────────────────────────────────────────────────────

// ── Async validate runs (CGLAB-10) ───────────────────────────────────────────
// A verifyCommand can legitimately run for many minutes; holding the HTTP
// response open for its whole lifetime meant clients timed out while the
// server finished anyway (and agents misread slow success as failure). With
// `async: true`, the validate endpoint answers 202 + runId as soon as a
// command must execute, runs it in the background, and exposes live status
// and output at GET /items/validate-runs/:runId. Outcomes are additionally
// persisted through the normal comment/transition path, so a lost run record
// (server restart) never loses the result itself.
export interface ValidateRun {
  runId: string;
  itemId: string;
  status: 'running' | 'passed' | 'failed';
  output: string;
  message?: string;
  itemStatus?: string;
  /** Per-check results when the step's checks refused or ran (CGLAB-380). */
  checks?: CheckResult[];
  startedAt: Date;
  finishedAt?: Date;
  /** Answered 202 and running in the background; a sync fast path never sets it. */
  started?: boolean;
  /** The step the card was leaving when the run started (9569b4d7). */
  step?: string;
  /** The last few KiB of what the run printed, for the board (9569b4d7); `output` is the bounded head followers stream. */
  tail?: string;
}
const validateRuns = new Map<string, ValidateRun>();
/** 9569b4d7: how much of a run's latest output the board is shown. */
const RUN_TAIL_BYTES = 8192;
/** Append to a run's output: the bounded head for followers, and the rolling tail for the board. */
function appendRunOutput(run: ValidateRun, chunk: string, headCap = 256 * 1024): void {
  if (run.output.length < headCap) run.output += chunk.slice(0, headCap - run.output.length);
  run.tail = ((run.tail ?? '') + chunk).slice(-RUN_TAIL_BYTES);
}
/** 9569b4d7: a run has started in the background - the board shows it on the card. */
function markRunStarted(run: ValidateRun, step: string): void {
  run.started = true;
  run.step = step;
  io.emit('items_updated');
}
/** The verify running on a card now, as item responses carry it; undefined when none runs. */
function activeRunOf(itemId: string): { runId: string; step: string; startedAt: string } | undefined {
  const runId = activeValidateRunByItem.get(itemId);
  const run = runId ? validateRuns.get(runId) : undefined;
  if (!run || run.status !== 'running' || !run.started) return undefined;
  return { runId: run.runId, step: run.step ?? '', startedAt: new Date(run.startedAt).toISOString() };
}
const withActiveRun = <T extends { id: string }>(item: T): T => {
  const activeRun = activeRunOf(item.id);
  return activeRun ? { ...item, activeRun } : item;
};
const activeValidateRunByItem = new Map<string, string>();
const VALIDATE_RUN_TTL_MS = 60 * 60 * 1000;
// Prune on creation instead of timers — keeps tests deterministic and the map bounded.
function pruneValidateRuns() {
  const now = Date.now();
  for (const [id, run] of validateRuns) {
    if (run.finishedAt && now - run.finishedAt.getTime() > VALIDATE_RUN_TTL_MS) validateRuns.delete(id);
  }
}

// ── validate_progress: unified exit-criteria gate (flow-aware) ───────────────
// On a step that needs a command (the final step, or any boundary step) the
// server runs project.verifyCommand and ignores a caller's (CGLAB-378); on an
// intermediate step a caller's command is optional and runs as an extra check.

/**
 * The `tests` array a caller sends through PUT /items/:id (log-test re-sends
 * the whole list with one record appended). A record the SERVER wrote is kept
 * exactly as stored, matched by id, so it can be neither lost nor rewritten; a
 * new record loses `commit`, which is what makes a green spendable by sibling
 * propagation. Without this, anyone could write a PASSED record for the
 * project's command at HEAD onto a DONE sibling and land a red card on DONE
 * (CGLAB-378 review).
 */
/**
 * A card's stored test records, whatever was stored (BUG 93d9fbd0). Before PUT
 * sanitised them, any value could land in `tests`: an object, a string, a list
 * with nulls. Every reader on the verify path goes through this.
 */
function testRecords(x: unknown): any[] {
  return Array.isArray(x) ? x.filter(t => !!t && typeof t === 'object' && !Array.isArray(t)) : [];
}

function sanitizeCallerTests(incoming: unknown, stored: any[] | undefined): any {
  if (!Array.isArray(incoming)) return incoming;
  const byId = new Map((stored ?? []).filter(t => t && t.id).map(t => [t.id, t]));
  // A record is an object; null, numbers and strings are dropped (BUG 93d9fbd0).
  return incoming.filter((t: any) => !!t && typeof t === 'object' && !Array.isArray(t)).map((t: any) => {
    if (byId.has(t.id)) return byId.get(t.id);
    const { commit: _dropped, commitRoot: _droppedRoot, ...rest } = t;
    return rest;
  });
}

/** What a verify reply says when it ignored the caller's command (CGLAB-378). */
function ignoredCommandNote(ignored: string, projectCommand?: string): string {
  return `⚠️ The command you passed (\`${ignored}\`) was ignored: on this step the server runs the project's own verify command${projectCommand ? ` (\`${projectCommand}\`)` : ''}. If that command is wrong, change it with \`agenfk update-project <id> --verify-command "<cmd>"\`.`;
}

/**
 * A response (or the async run's recorder) whose every JSON reply carries
 * `note`: as a `warning` field, and at the head of `message`, which is what
 * older CLIs print. One wrapper rather than an edit at each of validate's
 * many reply sites, so a new reply cannot forget it.
 */
export function withNote<T extends { status: (code: number) => any; json: (body: any) => any }>(res: T, note: string): T {
  // Clients print `message || error`, so a reply that only had an error gets a
  // message too, or the note would travel in a field nobody shows.
  const add = (body: any) => (body && typeof body === 'object')
    ? {
        ...body, warning: note,
        message: typeof body.message === 'string' ? `${note}\n\n${body.message}`
          : typeof body.error === 'string' ? `${note}\n\n${body.error}` : note,
      }
    : body;
  const proxy: T = new Proxy(res, {
    get(target, key) {
      if (key === 'json') return (body: any) => target.json(add(body));
      if (key === 'status') return (code: number) => { target.status(code); return proxy; };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return proxy;
}
/** Trailing line of every verify response that reports a step outcome. The
 *  transition line sits at the top and the next step's criteria banner pushes
 *  it out of a `| tail`; the LAST line must always say where the card is
 *  (CGLAB-275). `nowOn` after a move, `staysOn` after a refused advance. */
/** The exit criteria of the step an item just entered, as the agent's next
 *  work definition. It NAMES the step: an unnamed banner was read as the
 *  criteria of the step the agent believed it was on (CGLAB-275). */
const criteriaBanner = (step: string, criteria: string) =>
  `\n\n⚠️ MANDATORY EXIT CRITERIA for ${step} — the step this item is now on. You MUST satisfy ALL of the following before calling validate_progress again:\n\n${criteria}`;
const nowOn = (status: string) => `\n\nItem is now on ${status}.`;
const staysOn = (status: string) => `\n\nThe advance was refused. Item stays on ${status}.`;

// Advances item to the next flow step. On failure the advance is refused and the item stays put (CGLAB-275).
// `asyncRun` (pre-reserved by the route so the concurrency guard has no
// check-then-set window) only changes behaviour when a command actually
// executes; every other path (anchor advance, sibling propagation, no-command
// step, errors) responds synchronously as before — the route discards the
// unused reservation in that case.
/** What the step's checks decided (CGLAB-380), carried into the transition that follows them. */
interface StepGate {
  results: CheckResult[];
  blocked: boolean;
  /** 281adef0: the parent this gate judged the card's suite as deferred to; the close follows it. */
  deferredTo?: string;
}

/** The branch a card works on: its own, else its nearest ancestor's (branches live on top-level items). */
async function branchOfCard(item: any): Promise<string | null> {
  let cur: any = item;
  for (let depth = 0; cur && depth < 16; depth++) {
    if (typeof cur.branchName === 'string' && cur.branchName.trim()) return cur.branchName.trim();
    cur = cur.parentId ? await storage.getItem(cur.parentId) : null;
  }
  return null;
}

/**
 * What the review-record check needs (CGLAB-381): the card's place in its
 * tree, its review records, every author identity on it and its descendants,
 * where its work began, and its descendants' close commits.
 */
async function reviewEvidence(item: any, root: string | null, depth = 0): Promise<any> {
  const descendants: any[] = [];
  const queue = [item.id];
  while (queue.length && descendants.length < 5000) {
    const kids: any[] = (await storage.listItems({ parentId: queue.shift() } as any)) as any;
    for (const k of kids) { descendants.push(k); queue.push(k.id); }
  }
  const children = descendants.filter(d => d.parentId === item.id);
  const authors: Array<{ client: string; sessionId: string; agentId: string | null }> = [];
  for (const c of [item, ...descendants]) {
    for (const r of c.stepRecords ?? []) {
      const a = r?.actor;
      if (a && typeof a.sessionId === 'string' && !authors.some(x => x.sessionId === a.sessionId && x.agentId === (a.agentId ?? null))) {
        authors.push({ client: String(a.client), sessionId: a.sessionId, agentId: a.agentId ?? null });
      }
    }
  }
  const firstExit = (item.stepRecords ?? []).find((r: any) => r?.kind === 'exit' && typeof r.head === 'string');
  const descendantCommits: string[] = [];
  if (root) {
    for (const d of descendants) {
      try {
        const out = gitRun.run(['-C', root, 'log', '--format=%H', '--fixed-strings', `--grep=[${d.id}]`]).trim();
        for (const sha of out.split('\n').filter(Boolean)) if (!descendantCommits.includes(sha)) descendantCommits.push(sha);
      } catch { /* no history to read: nothing to require */ }
    }
  }
  const evidence = {
    hasParent: !!item.parentId,
    childCount: children.length,
    childrenReviewed: 0,
    records: Array.isArray(item.reviewRecords) ? item.reviewRecords : [],
    authors,
    startHead: firstExit?.head ?? null,
    descendantCommits,
    currentTree: root && depth === 0 ? treeContentState(root, null) : null,
  };
  // A child counts only when its OWN latest review passes the same test, over
  // its own authors and commits - having a record is not enough (CGLAB-381
  // review). Its tree has moved on since, so the tree is not compared.
  for (const c of children) {
    if (!Array.isArray(c.reviewRecords) || !c.reviewRecords.length) continue;
    const e = await reviewEvidence(c, root, depth + 1);
    e.descendantCommits = [...new Set([...e.descendantCommits, ...ownCloseCommits(c.id, root)])];
    if (judgeReview(e, root, args => gitRun.run(args), { bindTree: false }).outcome === 'pass') evidence.childrenReviewed++;
  }
  return evidence;
}

/** The close commits of one card, found by the `[<id>]` its close commit message carries. */
function ownCloseCommits(id: string, root: string | null): string[] {
  if (!root) return [];
  try { return gitRun.run(['-C', root, 'log', '--format=%H', '--fixed-strings', `--grep=[${id}]`]).trim().split('\n').filter(Boolean); } catch { return []; }
}

/** JIRA keys on a card and its ancestors, nearest first. */
async function keysOfCard(item: any): Promise<string[]> {
  const keys: string[] = [];
  let cur: any = item;
  for (let depth = 0; cur && depth < 16; depth++) {
    if (typeof cur.externalId === 'string' && cur.externalId.trim()) keys.push(cur.externalId.trim());
    cur = cur.parentId ? await storage.getItem(cur.parentId) : null;
  }
  return keys;
}

/**
 * Run the checks for leaving the card's current step (CGLAB-380), and record
 * the outcome on the card (`lastChecks`) and, when they pass, the records they
 * produced (step records of kind 'record', which a rollback over this step
 * drops like any other). A test report is captured only when a check of THIS
 * step needs per-test results, or the NEXT step reads its entry record - that
 * capture is then the next step's entry, so no suite runs just to snapshot.
 */
/**
 * Checks the project verify command settles on this transition. On the one
 * that ends the flow the command runs anyway, so with no per-test report a
 * `suite-green` capture would only run the same suite twice.
 */
function deferredToCommand(flow: { steps: any[] }, status: string, project: any, toParent?: unknown): string[] {
  // 281adef0: deferred to the parent, the suite runs nowhere on this card - not
  // as a capture, not as the command - so whatever it would settle is deferred.
  if (toParent) return ['suite-green'];
  const sorted = sortedFlowSteps(flow as any);
  const next = sorted[sorted.findIndex(st => st.name === status) + 1];
  const final = !next || next.name === Status.DONE || isBoundaryStep(next);
  return final && !project?.testReport && project?.verifyCommand ? ['suite-green'] : [];
}

/**
 * The parent a card's close defers the project's suite to (281adef0), or null
 * when the card must run it itself. One answer for the step gate and the close:
 *  - the flow says verifyAt 'parent', and this move ENDS the flow (a mid-flow
 *    boundary still runs the command it requires);
 *  - the parent is in the SAME project (a moved card keeps a parentId into its
 *    old project, whose verify runs a different command in a different tree);
 *  - the parent is still open: not released, not on its flow's exit step;
 *  - and no verify of the parent is running now: that run may not see this
 *    card's close commit, so the card runs its own.
 * The roll-up never walks such a parent onto its exit step (syncParentStatus),
 * so its own final verify - the one run - always happens.
 */
async function parentToDeferTo(item: any, flow: { steps: any[]; verifyAt?: unknown }): Promise<any | null> {
  if (flowVerifyAt(flow) !== 'parent' || !item?.parentId) return null;
  const sorted = sortedFlowSteps(flow as any);
  const index = sorted.findIndex(st => st.name === item.status);
  if (index < 0 || !leavingEndsFlow(sorted as any, index)) return null;
  const parent: any = await storage.getItem(item.parentId);
  if (!parent || parent.projectId !== item.projectId) return null;
  // Open AND being worked: a paused or blocked parent may never come back to run it.
  if (!stillHolds(String(parent.status)) || INACTIVE_STATUSES.has(String(parent.status).toUpperCase()) || parent.status === sorted[sorted.length - 1]?.name) return null;
  if (activeValidateRunByItem.has(parent.id)) return null;
  // The parent's verify tests the PARENT's tree: a child whose work lives in another one runs its own.
  const project: any = await storage.getProject(item.projectId);
  const childRoot = resolveCommitRoot(await withEffectiveWorktree(item), project?.projectRoot).root;
  const parentRoot = resolveCommitRoot(await withEffectiveWorktree(parent), project?.projectRoot).root;
  if (!childRoot || childRoot !== parentRoot) return null;
  return parent;
}

/**
 * 961f301d — approval first. While the step still waits for a person (its own
 * approval, or a command waiting for theirs), nothing a capture or a command
 * run could find lets the card go, and the person is not shown the card until
 * the refusal comes back. So the gate then skips the slow work - reported as
 * deferred to the verify after the approval - and answers inline. The cheap
 * checks still run, so a person approving can see (and override) them at once.
 */
async function waitsOnPerson(item: any, flow: { steps: any[] }, project: any): Promise<boolean> {
  const resolved = resolveStepChecks(flow.steps, item.status).filter(c => c.severity === 'block');
  const records: any[] = ((await storage.getItem(item.id)) as any)?.stepRecords ?? [];
  const here = records.filter(r => r?.step === item.status);
  // Only an override the gate would honour lifts a check: on a passkey step, a signed one.
  const signedOnly = stepWantsPasskey(flow as Flow, item.status);
  const overridden = new Set(here.filter(r => r.kind === 'override' && typeof r.check === 'string' && (!signedOnly || r.authority === 'passkey')).map(r => r.check));
  if (awaitingPersonCommands(resolved, flow, project).some(c => !overridden.has(c.id))) return true;
  const approval = resolved.find(c => c.applicable && c.id === 'human-approval');
  if (!approval || overridden.has('human-approval')) return false;
  const inherited = approval.params.appliesTo === 'every-card' ? [] : await ancestorApprovals(item, item.status);
  const { own, up } = countedApproval(approval.params, approvalsAt({ stepRecords: here }, item.status), inherited);
  return !own && !up;
}

/** The step's command checks that wait for a person to approve their command: never run. */
function awaitingPersonCommands(resolved: ReturnType<typeof resolveStepChecks>, flow: any, project: any): ReturnType<typeof resolveStepChecks> {
  if (flow?.origin === 'registry') return [];
  const approvals: CommandApproval[] = Array.isArray(project?.commandApprovals) ? project.commandApprovals : [];
  return resolved.filter(c => c.applicable && c.id.startsWith('command-check:') && awaitsPersonApproval(c, approvals));
}

/** 5a8d22e6: the server's own hold for a per-test entry baseline the project cannot record. */
const ENTRY_BASELINE = 'entry-baseline';

async function runStepGate(item: any, flow: { steps: any[] }, root: string | null, actor?: { client: string; sessionId: string; agentId: string | null } | null, agentReports?: Record<string, AgentReport>, opts?: { personFirst?: boolean; run?: ValidateRun }): Promise<StepGate> {
  const sorted = sortedFlowSteps(flow as any);
  const index = sorted.findIndex(st => st.name === item.status);
  const next = sorted[index + 1];
  const project: any = await storage.getProject(item.projectId);
  const toParent = await parentToDeferTo(item, flow);
  const deferToCommand = deferredToCommand(flow, item.status, project, toParent);
  const resolved = resolveStepChecks(flow.steps, item.status);
  let capture: any = null;
  let captureError: string | undefined;
  // 961f301d: waiting on a person, the slow checks wait too (see waitsOnPerson).
  const waitingOn = opts?.personFirst ? awaitingPersonCommands(resolved, flow, project) : [];
  const deferToApproval = opts?.personFirst
    ? resolved.filter(c => c.applicable && (needsCapture([c]) || (c.id.startsWith('command-check:') && !waitingOn.includes(c)))).map(c => c.id)
    : [];
  if (!opts?.personFirst && (needsCapture(resolved.filter(c => !deferToCommand.includes(c.id))) || (next && needsEntryRecord(resolveStepChecks(flow.steps, next.name))))) {
    const run = opts?.run;
    const out = await captureStepRecord(item, run ? { onOutput: chunk => appendRunOutput(run, chunk) } : undefined);
    if ('error' in out) captureError = out.message; else capture = out.record;
  }
  const records: any[] = ((await storage.getItem(item.id)) as any)?.stepRecords ?? [];
  const lastOf = (pred: (r: any) => boolean) => [...records].reverse().find(pred) ?? null;
  const prev = sorted[index - 1];
  const earlier = new Set(sorted.slice(0, Math.max(index, 0)).map(st => st.name));
  const produced: Record<string, unknown> = {};
  for (const r of records) if (r?.kind === 'record' && earlier.has(r.step) && typeof r.name === 'string') produced[r.name] = r.value;

  // In a shared worktree the tree holds other cards' work too (MULTI_AGENT.md):
  // what another active card has claimed is theirs, not this card's change.
  // Only cards in THIS tree (aaa01834): a claim in another worktree says nothing about files here.
  const { holders: claimHolders, treeOf: claimTree } = await claimHoldersIn(item.projectId, (project as any)?.projectRoot);
  const hereTree = claimTree(item);
  const foreignClaims = claimHolders
    .filter(o => o.id !== item.id && Array.isArray(o.claims) && stillHolds(o.status) && sameClaimTree(hereTree, o.tree))
    .flatMap(o => o.claims as string[]);
  const reportPath = typeof project?.testReport?.reportPath === 'string' ? project.testReport.reportPath : null;
  // People's approvals and overrides of THIS step (CGLAB-382); a rollback over it dropped older ones.
  const here = records.filter(r => r?.step === item.status);
  const approvals = approvalsAt({ stepRecords: here }, item.status);
  const inheritedApprovals = resolved.some(c => c.id === 'human-approval' && c.applicable) ? await ancestorApprovals(item, item.status) : [];
  const overrides: Record<string, { id: string; by: string; at: string; reason: string; detail?: string }> = {};
  // On a step that asks for a passkey, only signed overrides lift a check.
  const signedOnly = stepWantsPasskey(flow as Flow, item.status);
  for (const r of here) if (r.kind === 'override' && typeof r.check === 'string' && (!signedOnly || r.authority === 'passkey')) overrides[r.check] = { id: String(r.id), by: String(r.by ?? 'board'), at: String(r.at), reason: String(r.reason ?? ''), ...(typeof r.detail === 'string' ? { detail: r.detail } : {}) };
  const review = resolved.some(c => c.id === 'review-record' && c.applicable) ? { ...(await reviewEvidence(item, root)), agenfkVersion: getCurrentVersion() } : undefined;
  // Whoever is advancing the card now is an author too, though no step record carries them yet.
  if (review && actor && !review.authors.some((a: any) => a.sessionId === actor.sessionId && a.agentId === (actor.agentId ?? null))) {
    review.authors.push({ client: actor.client, sessionId: actor.sessionId, agentId: actor.agentId ?? null });
  }
  // efcacdeb: command checks run here, before the engine, in the card's tree.
  const commandChecks = resolved.filter(c => c.applicable && c.id.startsWith('command-check:') && !deferToApproval.includes(c.id));
  const commandResults = commandChecks.length
    ? await judgeCommandChecks(commandChecks, { root, origin: (flow as any).origin, approvals: Array.isArray(project?.commandApprovals) ? project.commandApprovals : [], timeoutMs: verifyMaxMs() })
    : undefined;
  const outcome = evaluateChecks(resolved, {
    ...(commandResults ? { commandResults } : {}),
    ...(agentReports ? { agentReports } : {}),
    review,
    root,
    git: args => gitRun.run(args),
    item,
    cardBranch: await branchOfCard(item),
    cardKeys: await keysOfCard(item),
    testPaths: Array.isArray(project?.testReport?.surface) ? project.testReport.surface : [],
    ignoredPaths: reportPath && root ? [insideRoot(root, path.resolve(root, reportPath)) ?? reportPath] : [],
    foreignClaims,
    deferToCommand,
    ...(deferToApproval.length ? { deferToApproval } : {}),
    ...(toParent ? { deferredToParent: { id: toParent.id, title: toParent.title } } : {}),
    children: (await storage.listItems({ parentId: item.id } as any)) as any,
    capture,
    captureError,
    entry: prev ? lastOf(r => r?.kind === 'capture' && r.step === prev.name) : null,
    // A step that committed on leaving (CGLAB-388) hands the next step its
    // commit as the baseline: its own work is not this step's change.
    entryHead: prev ? (() => { const x = lastOf(r => r?.kind === 'exit' && r.step === prev.name); return x?.commit ?? x?.head ?? null; })() : null,
    records: produced,
    approvals,
    inheritedApprovals,
    overrides,
  });
  /*
   * 5a8d22e6 review: the step being ENTERED judges its tests against the
   * per-test results recorded now. With no test report there are none, and
   * setting one later cannot bring them back - those checks would only ever
   * warn on this card. So the card is held HERE, where setting the report and
   * verifying again records a baseline its next step can use.
   */
  // Only for checks that would BLOCK there: a warn-only one never held a card (review).
  if (!opts?.personFirst && next && capture && capture.available === false && !capture.parseError && !project?.testReport
    && needsEntryRecord(resolveStepChecks(flow.steps, next.name).filter(c => c.severity === 'block'))) {
    const detail = `${next.name} judges its tests against the per-test results recorded as the card enters it, and this project records none`;
    // A person can still pass it with a reason (a runner that cannot write a report): no card is stranded.
    const o = overrides[ENTRY_BASELINE];
    const overridden = o && (o.detail === undefined || o.detail === detail) ? o : undefined;
    outcome.results.push({
      id: ENTRY_BASELINE, step: item.status, source: 'universal', severity: 'block', params: {}, outcome: 'unavailable', blocking: !overridden, detail,
      ...(overridden ? { overridden } : { meta: { code: 'NO_TEST_REPORT' } }),
    } as any);
    if (!overridden) outcome.blocked = true;
  }
  const at = new Date().toISOString();
  const latest: any = await storage.getItem(item.id);
  const made = outcome.blocked ? [] : Object.entries(outcome.produced).map(([name, value]) => ({ step: item.status, kind: 'record', name, value, at, head: null, clean: false }));
  await storage.updateItem(item.id, {
    lastChecks: { step: item.status, at, blocked: outcome.blocked, results: outcome.results },
    checkHistory: withHistory(latest, {
      kind: 'verify', step: item.status, at, blocked: outcome.blocked,
      results: outcome.results.map(r => ({ id: r.id, outcome: r.outcome, blocking: r.blocking, severity: r.severity, detail: String(r.detail ?? '').slice(0, 500), ...(r.overridden ? { overridden: true } : {}), ...(r.agentReported ? { agentReported: true } : {}) })),
    }),
    ...(made.length ? { stepRecords: [...(latest?.stepRecords ?? []), ...made] } : {}),
  } as any);
  return { results: outcome.results, blocked: outcome.blocked, ...(toParent ? { deferredTo: toParent.id } : {}) };
}

/** Refuse a transition on the step's checks, in verify's failure shape plus `checks[]`. */
/**
 * 5a8d22e6 — checks held up only because the project records no per-test
 * results: the agent's to fix, not a person's to override. One line, with the
 * command that fixes it where the project's runner makes it certain.
 */
async function noTestReportFix(item: any, gate: StepGate): Promise<{ line: string; fix: string | null } | null> {
  if (!gate.results.some(r => r.blocking && (r as any).meta?.code === 'NO_TEST_REPORT')) return null;
  const project: any = await storage.getProject(item.projectId);
  const root = resolveCommitRoot(await withEffectiveWorktree(item), project?.projectRoot).root;
  let scripts: Record<string, string> = {};
  try { if (root) scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts ?? {}; } catch { /* not a node project */ }
  const s = suggestTestReport(String(project?.verifyCommand ?? ''), scripts);
  const fix = s ? `agenfk update-project ${item.projectId} --test-report-format ${s.format} --test-report-command "${s.command.replace(/(["\\$`])/g, '\\$1')}" --test-report-path ${s.reportPath}` : null;
  // check-ignore exits 1 for "not ignored"; anything else (not a repository, git failed) says nothing.
  const ignored = !(s && root) || spawnSync('git', ['-C', root, 'check-ignore', '-q', s.reportPath], { stdio: 'ignore', timeout: 5000 }).status !== 1;
  const line = fix
    ? `🔧 NO_TEST_REPORT: per-test results are needed (by these checks, or by the step the card is entering) and this project records none. Set a test report, then run the same agenfk verify again:\n   ${fix}${ignored ? '' : `\n   ⚠️ ${s!.reportPath} is not ignored by git: add it to .gitignore, or every report leaves the tree dirty.`}`
    : `🔧 NO_TEST_REPORT: per-test results are needed (by these checks, or by the step the card is entering) and this project records none. Set a test report for its runner - agenfk update-project ${item.projectId} --test-report-format vitest-json|junit-xml --test-report-command "<a command that writes the report>" --test-report-path <where it is written> - then run the same agenfk verify again.`;
  return { line, fix };
}

async function refuseOnChecks(res: any, item: any, gate: StepGate) {
  const text = formatCheckResults(gate.results);
  const noReport = await noTestReportFix(item, gate);
  const fresh: any = await storage.getItem(item.id);
  await storage.updateItem(item.id, { comments: [...(fresh?.comments ?? []), { id: uuidv4(), author: 'ValidateTool', content: `### Checks FAILED\n\n**Step**: ${item.status} (advance refused — the card stays here)\n\n${text}`, timestamp: new Date() }] });
  io.emit('items_updated');
  recordHubEvent({
    type: 'validate.failed',
    projectId: item.projectId,
    itemId: item.id,
    payload: { fromStatus: item.status, stayedOn: item.status, command: null, checks: gate.results.map(r => ({ id: r.id, outcome: r.outcome, blocking: r.blocking })) },
  });
  return res.status(422).json({
    status: item.status,
    message: `❌ Checks failed: the card cannot leave ${item.status} yet.\n\n${noReport ? `${noReport.line}\n\n` : ''}${text}${staysOn(item.status)}`,
    checks: gate.results,
    ...(noReport ? { error: 'NO_TEST_REPORT', fix: noReport.fix } : {}),
  });
}

/** A response stand-in that writes a verify reply into a background run. */
function runRecorder(run: ValidateRun) {
  return {
    _code: 200,
    status(code: number) { this._code = code; return this; },
    json(payload: any) {
      run.status = this._code === 200 ? 'passed' : 'failed';
      run.itemStatus = payload?.status;
      run.message = payload?.message;
      if (Array.isArray(payload?.checks)) run.checks = payload.checks;
      // 5a8d22e6: a named cause and its fix reach whoever follows the run, not only a sync caller.
      if (typeof payload?.error === 'string') (run as any).error = payload.error;
      if (payload && 'fix' in payload) (run as any).fix = payload.fix;
      // Keep the live full output when we have it; fall back to the preview.
      if (!run.output && payload?.output) run.output = payload.output;
      run.finishedAt = new Date();
      return this;
    },
  };
}

async function handleValidateProgress(itemId: string, command: string | undefined, res: any, evidence?: string, asyncRun?: ValidateRun, opts?: { gate?: StepGate; run?: ValidateRun; actor?: ReturnType<typeof parseActor>; agentReports?: Record<string, AgentReport> }) {
  const item = await storage.getItem(itemId);
  if (!item) return res.status(404).json({ error: "Item not found" });

  if (!opts?.gate) recordHubEvent({
    type: 'validate.invoked',
    projectId: item.projectId,
    itemId,
    payload: { command: command ?? null, fromStatus: item.status, hasEvidence: !!evidence },
  });

  if (evidence) {
    const evidenceComment = { id: uuidv4(), author: 'agent', content: `**Evidence [${item.status}]:** ${evidence}`, timestamp: new Date(), step: item.status };
    await storage.updateItem(itemId, { comments: [...(item.comments || []), evidenceComment] });
    // Reload item so subsequent comment appends don't lose the evidence comment
    const refreshed = await storage.getItem(itemId);
    if (refreshed) Object.assign(item, refreshed);
  }

  const project = await storage.getProject(item.projectId);
  // The tree this card's verify tests AND its close commit lands in: its own
  // worktree, else its top-level ancestor's, else projectRoot. Computed once so
  // the sibling gate, the spawn and the pre-run capture cannot drift apart
  // (CGLAB-366).
  const effectiveRoot = resolveCommitRoot(await withEffectiveWorktree(item), (project as any)?.projectRoot).root;
  const projectFlows = await storage.listFlows();
  const activeFlow = getActiveFlow((project as any)?.flowId, projectFlows);
  const sorted = sortedFlowSteps(activeFlow);
  /*
   * CGLAB-379: what the tree looked like when the card asked to leave this
   * step - the step, HEAD, and whether it was clean. Cheap, so every advance
   * records it; per-test results are captured only when a check asks. Read
   * here, before any command runs, because that is the tree it ran against.
   */
  const exitRecord = {
    step: item.status, kind: 'exit' as const, at: new Date().toISOString(),
    head: effectiveRoot ? readHead(effectiveRoot, gitRun) : null,
    clean: effectiveRoot ? readCleanTreeSha(effectiveRoot, gitRun) !== null : false,
    // Who advanced the card, as its harness reports it (CGLAB-381): the review
    // check tells the reviewer apart from every author by this.
    ...(opts?.actor ? { actor: opts.actor } : {}),
  };
  /** The card's records plus this one; built at write time, after any re-read. */
  const withExitRecord = () => [...((item as any).stepRecords ?? []), exitRecord];
  const codingStep = getCodingStep(sorted);
  const currentFlowStep = findCurrentFlowStep(sorted, item.status);

  if (!currentFlowStep) {
    return res.status(400).json({ error: `validate_progress requires item to be in a flow step. Current status '${item.status}' is not part of the active flow '${activeFlow.name}'.` });
  }

  // efcacdeb: a report must name one of THIS step's agent checks.
  const reported = Object.keys(opts?.agentReports ?? {});
  if (reported.length && !opts?.gate) {
    const here = resolveStepChecks(activeFlow.steps, item.status).filter(c => c.id.startsWith('agent-check:')).map(c => c.params.name);
    const unknown = reported.filter(n => !here.includes(n));
    if (unknown.length) {
      return res.status(400).json({ error: `Step ${item.status} has no agent check named ${unknown.map(n => `'${n}'`).join(', ')}. Its agent checks: ${here.length ? here.join(', ') : 'none'}.` });
    }
  }

  /*
   * CGLAB-380: the step's checks, before anything moves. A capture runs a
   * whole suite, so an async verify answers 202 first and runs the checks -
   * and then the transition - in the background run, exactly as it does the
   * command; a check that needs no capture only reads git and runs inline.
   */
  /*
   * aaa01834: the move that ENDS the flow is refused while staged files lie
   * outside the card's claims and no other card in this tree claims them. The
   * close commit takes only claimed files, so they would stay staged after
   * DONE with nobody owning them. Refused with the card where it is.
   *
   * Unless a WORKING card in the same tree claims nothing (review): it is
   * authorized everywhere, so the file may be its work, and both remedies the
   * refusal offers would take that work from it. Then it is a note.
   *
   * Checked first - before the step's checks, which may run a whole suite -
   * and again just before the move, because the index can change meanwhile.
   */
  const anchorNames = new Set(sorted.filter((st: any) => st.isAnchor).map((st: any) => String(st.name)));
  const isWorkingStatus = (st: string) => !anchorNames.has(st);
  const endsFlowHere = leavingEndsFlow(sorted as any, currentFlowStep.index);
  const checkStrays = async (r0: any): Promise<{ refused: true } | { refused: false; res: any }> => {
    if (!endsFlowHere) return { refused: false, res: r0 };
    const { strays, claimless } = await strayStagedFor(item, (project as any)?.projectRoot, isWorkingStatus);
    if (!strays.length) return { refused: false, res: r0 };
    if (claimless.length) return { refused: false, res: withNote(r0, `⚠️ ${describeUnowned(strays, claimless)}`) };
    r0.status(422).json({ status: item.status, message: `❌ The card cannot close yet. ${describeStrays(item, strays)}${staysOn(item.status)}` });
    return { refused: true };
  };
  if (!opts?.gate) {
    const early = await checkStrays(res);
    if (early.refused) return;
    res = early.res;
  }

  let gate = opts?.gate;
  if (!gate && !(currentFlowStep.step.isAnchor && currentFlowStep.index !== 0)) {
    // 961f301d: a person's missing approval is answered first, inline, before anything slow.
    if (await waitsOnPerson(item, activeFlow, project)) {
      const waiting = await runStepGate(item, activeFlow, effectiveRoot ?? null, opts?.actor, opts?.agentReports, { personFirst: true });
      if (waiting.blocked) return refuseOnChecks(res, item, waiting);
    }
    const nextName = sorted[currentFlowStep.index + 1]?.name;
    const deferred = deferredToCommand(activeFlow, item.status, project);
    const slow = needsCapture(resolveStepChecks(activeFlow.steps, item.status).filter(c => !deferred.includes(c.id)))
      || (!!nextName && needsEntryRecord(resolveStepChecks(activeFlow.steps, nextName)))
      // A command check may run for minutes: never inside the request (efcacdeb).
      || resolveStepChecks(activeFlow.steps, item.status).some(c => c.applicable && c.id.startsWith('command-check:'));
    if (slow && asyncRun) {
      const run = asyncRun;
      res.status(202).json({
        runId: run.runId,
        command: null,
        message: `⏳ Step checks and validation running in background (run ${run.runId.slice(0, 8)}…). Follow with GET /items/validate-runs/${run.runId}.`,
      });
      markRunStarted(run, item.status);
      const recorder = runRecorder(run);
      void (async () => {
        const fresh: any = await storage.getItem(itemId);
        if (!fresh) return recorder.status(404).json({ status: item.status, message: '❌ Item was deleted while the checks ran.' });
        const g = await runStepGate(fresh, activeFlow, effectiveRoot ?? null, opts?.actor, opts?.agentReports, { run });
        if (g.blocked) return refuseOnChecks(recorder, fresh, g);
        return handleValidateProgress(itemId, command, recorder, undefined, undefined, { gate: g, run, actor: opts?.actor, agentReports: opts?.agentReports });
      })()
        .catch((err: any) => {
          run.status = 'failed';
          run.message = `Internal error during background validation: ${err?.message || err}`;
          run.finishedAt = new Date();
        })
        .finally(() => {
          if (activeValidateRunByItem.get(itemId) === run.runId) activeValidateRunByItem.delete(itemId);
          io.emit('items_updated');
        });
      return;
    }
    gate = await runStepGate(item, activeFlow, effectiveRoot ?? null, opts?.actor, opts?.agentReports);
    if (gate.blocked) return refuseOnChecks(res, item, gate);
    // The gate may have written a capture and produced records: build the
    // exit record on top of what is stored now, not on the copy read above.
    const refreshed = await storage.getItem(itemId);
    if (refreshed) Object.assign(item, refreshed);
  }
  if (gate) {
    (exitRecord as any).checks = gate.results;
    const warned = gate.results.filter(r => !r.blocking && (r.outcome === 'fail' || r.outcome === 'unavailable'));
    if (warned.length) res = withNote(res, `⚠️ Check warnings (not blocking):\n${formatCheckResults(warned)}`);
  }

  /*
   * CGLAB-388: a step with autoCommit commits the card's work as the card
   * leaves it - only what is staged, only the card's claimed files, the same
   * commit the close makes, named for the step. Called on each path that
   * ADVANCES the card, just before it moves, never before: a refused advance
   * (a failing command, a stale step) must leave the work staged, or a
   * requireCommit step could never be left again. Not on the move that ends
   * the flow: the close commit covers that. A missing commit is a note,
   * unless the step requires one, which answers 422 and moves nothing.
   */
  const commitOnLeave = async (r0: any): Promise<{ res: any; refused?: false } | { refused: true }> => {
    const mode = stepCommitsOnLeave(sorted as any, item.status);
    if (!mode) return { res: r0 };
    const stepMessage = `step(${item.status}): ${item.title} [${item.id}]`;
    // Read before the commit: afterwards the claimed files are gone from the index.
    const { strays, claimless } = await strayStagedFor(item, (project as any)?.projectRoot, isWorkingStatus);
    if (strays.length && !claimless.length && mode === 'required') {
      r0.status(422).json({ status: item.status, message: `❌ This step requires a commit of the card's work when it leaves. ${describeStrays(item, strays)}${staysOn(item.status)}` });
      return { refused: true };
    }
    const strayNote = strays.length ? `\n⚠️ ${claimless.length ? describeUnowned(strays, claimless) : describeStrays(item, strays)}` : '';
    const r = await autoGitCommit(item as any, (project as any)?.projectRoot, { message: stepMessage });
    const SHOWN = 20;
    const loose = r.unstaged.length
      ? `\nNot staged, so not committed: ${r.unstaged.slice(0, SHOWN).map(f => `\`${f}\``).join(', ')}${r.unstaged.length > SHOWN ? ` and ${r.unstaged.length - SHOWN} more` : ''}.`
      : '';
    if (r.committed) {
      (exitRecord as any).commit = r.sha ?? null;
      return { res: withNote(r0, `📌 Step commit ${r.sha ? r.sha.slice(0, 12) : ''}: "${stepMessage}".${loose}${strayNote}`) };
    }
    // Worded like the close commit's outcomes, about the step.
    const why = r.outcome === 'nothing-staged'
      ? `nothing was staged for this card, so the work of ${item.status} is not committed. Stage the files this card changed before leaving a step that commits.`
      : r.outcome === 'declined' ? `the server made NO step commit: ${r.detail}.`
      : `the step commit FAILED: ${r.detail}. Nothing was committed.`;
    if (mode === 'required') {
      r0.status(422).json({ status: item.status, message: `❌ This step requires a commit of the card's work when it leaves, and none was made: ${why}${loose}${staysOn(item.status)}` });
      return { refused: true };
    }
    return { res: withNote(r0, `${r.outcome === 'failed' ? '❌' : '⚠️'} No step commit: ${why}${loose}${strayNote}`) };
  };

  if (currentFlowStep.step.isAnchor) {
    if (currentFlowStep.index !== 0) {
      return res.status(400).json({ error: `validate_progress requires item to be in an intermediate flow step, not an anchor. Current status: ${item.status}` });
    }
    // First anchor (TODO): advance to coding step without running a command.
    if (!codingStep) {
      return res.status(400).json({ error: `Cannot advance from ${item.status}: no coding step found in flow.` });
    }
    const exitCriteria = (currentFlowStep.step as any).exitCriteria as string | undefined;
    const exitNote = exitCriteria ? `\n**Exit criteria acknowledged**: ${exitCriteria}` : '';
    const comment = { id: uuidv4(), author: 'ValidateTool', content: `### Validation PASSED\n\n**Step**: ${item.status} → ${codingStep.name}${exitNote}`, timestamp: new Date() };
    const leftTodo = await commitOnLeave(res);
    if (leftTodo.refused) return;
    res = leftTodo.res;
    const movedToCoding = await storage.updateItem(itemId, { status: codingStep.name as Status, stepRecords: withExitRecord(), comments: [...(item.comments || []), comment] } as any);
    recordMoveEvents({ id: itemId, projectId: item.projectId, type: item.type }, item.status, codingStep.name, activeFlow);
    // Entering the first working step is where a worktree earns its keep.
    await ensureWorktreeForItem(movedToCoding, true);
    io.emit('items_updated');
    const codingStepCriteria = (codingStep as any).exitCriteria as string | undefined;
    const codingCommitNote = commitOnLeaveNote(codingStep.name, stepCommitsOnLeave(sorted as any, codingStep.name));
    const mandatoryNote = (codingStepCriteria ? criteriaBanner(codingStep.name, codingStepCriteria) : '') + (codingCommitNote ? `\n\n${codingCommitNote}` : '');
    return res.json({ status: codingStep.name, message: `✅ Validation Passed!\n\nItem moved to ${codingStep.name}.${mandatoryNote}${nowOn(codingStep.name)}` });
  }

  const nextStep = sorted[currentFlowStep.index + 1];
  const nextStatus = (nextStep?.name ?? Status.DONE) as Status;
  // A failed command REFUSES the advance; it moves the card nowhere (CGLAB-275).
  // It used to roll the card back to the flow's first non-anchor step, computed
  // by position. On a TDD flow that step is DISCOVERY, so an agent that passed
  // pytest on a red-tests step — doing exactly what the step asked — was sent two
  // steps backwards, and the response never said so. The server cannot judge
  // prose criteria, so a non-zero exit from an optional command is not evidence
  // the step failed; on the final step the command IS the gate, and there too the
  // right answer is "not DONE", not "back to the coding step".
  const failureStatus = item.status as Status;
  // Exit criteria of the step the item is moving INTO — returned as mandatory agent instructions
  const nextStepCriteria = (nextStep as any)?.exitCriteria as string | undefined;
  const nextCommitNote = commitOnLeaveNote(nextStatus, stepCommitsOnLeave(sorted as any, nextStatus));
  const mandatoryInstructions = ((nextStatus !== Status.DONE && nextStepCriteria)
    ? criteriaBanner(nextStatus, nextStepCriteria)
    : '') + (nextCommitNote ? `\n\n${nextCommitNote}` : '');
  const branchRef = (item as any).branchName || 'HEAD';
  /**
  /**
   * What to tell the agent after DONE.
   *
   * It used to say flatly that "the server has auto-committed the changes",
   * which stopped being true the moment the close commit stopped staging for
   * you (BUG 315edc11): a file the author never staged does not land, and an
   * agent told otherwise pushes and leaves it behind. Built from what the
   * commit ACTUALLY did — including, load-bearingly, the case where it FAILED,
   * which an earlier version reported as "nothing was staged" and thereby sent
   * the agent to push a branch with none of its work on it.
   */
  const UNSTAGED_SHOWN = 20;
  const describePush = (result?: AutoGitCommitResult): string => {
    if (nextStatus !== Status.DONE) return '';
    const paths = result?.unstaged ?? [];
    const shown = paths.slice(0, UNSTAGED_SHOWN);
    const left = paths.length
      ? `\n\n⚠️ **Not committed** — these were not staged, so the close commit did not carry them:\n`
        + shown.map(f => `- \`${f}\``).join('\n')
        + (paths.length > shown.length ? `\n- …and ${paths.length - shown.length} more` : '')
        + `\nStage and commit them yourself if they belong to this item.`
      : '';
    const made = !result
      ? 'The server commits whatever you have staged.'
      : result.outcome === 'committed' ? 'The server committed what you had staged.'
      : result.outcome === 'nothing-staged' ? 'Nothing was staged, so the server made no close commit.'
      : result.outcome === 'declined' ? `The server made NO close commit: ${result.detail}. Commit your work yourself.`
      : `❌ The close commit FAILED: ${result.detail}. Nothing was committed — fix this before pushing.`;
    return `${left}\n\n🚀 **Push your branch**: ${made} Run:\n\`\`\`\ngit push -u origin ${branchRef}\n\`\`\``;
  };

  // A command is only required for the final step. For intermediate steps it is
  // optional — omitting it advances without running anything.
  //
  // "Final" cannot be the literal name DONE. resolveStepContract tells the agent
  // "Final step (omit the command here; ...): X", and on a flow whose exit
  // step is named anything else — which is every flow `agenfk flow create`
  // produces — X is the last REAL step while this test said DONE. The agent
  // dutifully omitted the command, this took the intermediate path, and the
  // item advanced into the terminal step having run no verification at all.
  // The two must agree, or the gate silently does not exist.
  const isFinalStep = nextStatus === Status.DONE || !nextStep || isBoundaryStep(nextStep);
  /*
   * The EXIT step, which is not the same question as `isFinalStep`.
   *
   * `isFinalStep` also means "any boundary step", because that is the right
   * predicate for whether a command is required. It is wrong for the breaker
   * clear: a flow may hold at a mid-flow special step (BLOCKED, say), and
   * clearing there would hand a card one failure from the open breaker a clean
   * slate just for being parked. So the clear asks about the flow's LAST step
   * by position, not about a word.
   */
  const exitStep = sorted[sorted.length - 1];
  const isExitStep = nextStatus === Status.DONE || !nextStep || nextStep.name === exitStep?.name;
  /*
   * Does this transition END the flow? Not the same question as `isExitStep`,
   * which is positional. `agenfk flow create` produces flows with no boundary
   * step, and there the last step by position is not terminal - treating it as
   * the end fires the close commit one transition early, committing a shared
   * index while the card still has a step to work. Only a boundary last step,
   * or no next step at all, ends the flow.
   */
  const endsFlow = !nextStep
    || nextStatus === Status.DONE
    || (nextStep.name === exitStep?.name && isBoundaryStep(nextStep));
  /*
   * CGLAB-378: where a command is required, it is the PROJECT's. A caller's
   * command used to win here, so `agenfk verify <id> --evidence x "true"`
   * landed DONE with a red suite. It is now ignored - with a warning on every
   * reply, never a 400, because older skills still pass one - and it cannot
   * stand in for a missing project command either. Intermediate steps keep
   * the optional caller command: there it can only add a check.
   */
  const projectVerifyCommand = (project as any)?.verifyCommand as string | undefined;
  const resolvedCommand = isFinalStep ? projectVerifyCommand : command;
  const ignoredCommand = isFinalStep && command && command !== projectVerifyCommand ? command : undefined;
  const commandNote = ignoredCommand ? ignoredCommandNote(ignoredCommand, projectVerifyCommand) : undefined;
  // The async 202 is sent on the bare response: the run's outcome carries the
  // note, and the CLI prints both.
  const bareRes = res;
  if (commandNote) res = withNote(res, commandNote);
  /*
   * 281adef0: a flow with verifyAt 'parent' runs the project's suite once, at
   * the top-level card. A card whose parent is still OPEN closes here without
   * it - the parent's own final verify runs the suite over everything its
   * children did. A card whose parent has already finished runs its own:
   * nobody else would, and nothing may land unverified. No PASSED test is
   * recorded for a run that did not happen.
   */
  // The gate's decision stands: if it judged the suite as the card's own, the close runs it.
  // Asked again even when it deferred - the parent may have started its own verify since.
  const deferTo = isFinalStep && (!gate || gate.deferredTo) ? await parentToDeferTo(item, activeFlow) : null;
  if (deferTo) {
    // The re-entry from a background gate skipped the early stray check: ask here too.
    const strays = await checkStrays(res);
    if (strays.refused) return;
    res = strays.res;
    const note = `The project's suite was not run for this card: the flow runs it once, at the top-level card, and [${deferTo.id.substring(0, 8)}] "${deferTo.title}" is still open. Its verify runs the suite over everything its children did, or defers it again to its own parent.`;
    const comment = { id: uuidv4(), author: 'ValidateTool', content: `### Validation PASSED (suite deferred to the parent)\n\n**Step**: ${item.status} → ${nextStatus}\n\n${note}`, timestamp: new Date() };
    const left = await commitOnLeave(res);
    if (left.refused) return;
    res = left.res;
    // The marker the roll-up reads: this parent owes a suite run, whatever its flow says later.
    const updated = await storage.updateItem(itemId, { status: nextStatus, stepRecords: withExitRecord(), comments: [...(item.comments || []), comment], suiteDeferredTo: deferTo.id, ...(isExitStep ? { failureCount: 0 } : {}) } as any);
    recordMoveEvents({ id: itemId, projectId: item.projectId, type: item.type }, item.status, nextStatus, activeFlow);
    io.emit('items_updated');
    if (updated.parentId) await syncParentStatus(updated.parentId);
    const gitResult = process.env.NODE_ENV !== 'test' && !process.env.VITEST
      ? await autoGitCommit(updated, (project as any)?.projectRoot)
      : undefined;
    return res.json({ status: nextStatus, message: `✅ Validation Passed (suite deferred to the parent)!\n\n${note}\nItem moved to ${nextStatus}.${describePush(gitResult)}${nowOn(nextStatus)}` });
  }

  if (isFinalStep && !resolvedCommand) {
    return res.status(400).json({
      error: "NO_VERIFY_COMMAND",
      message: "No verifyCommand is configured for this project, and on this step the server runs only the project's own. Set one with update_project({ id, verifyCommand }) or `agenfk update-project <id> --verify-command \"<cmd>\"`."
    });
  }
  const exitCriteria = (currentFlowStep.step as any).exitCriteria as string | undefined;

  // ── Sibling propagation ───────────────────────────────────────────────────
  if (item.parentId) {
    const siblings = await storage.listItems({ parentId: item.parentId });
    // For final step (→ DONE), check siblings already DONE with same verifyCommand
    if (endsFlow) {
      /*
       * THE GREEN MUST BELONG TO THIS TREE (b29a8b3a). A sibling's suite ran
       * against the shared tree at some commit, and other agents may have
       * moved it since - committed OR edited - and propagating then spends a
       * stale green as proof of work never run here. SDLC.md names the
       * precondition ("same branch/workspace"); this is the first code to
       * check it.
       *
       * EVERY candidate is asked, not just the first: a stale older sibling
       * must not shadow a younger one still green at this commit.
       *
       * A refusal falls through to RUNNING the command - the whole direction.
       * A command run is cheap; a claim the tree cannot back is not.
       */
      /*
       * THE ROOT THE COMMAND RUNS IN, which is the card's effective worktree
       * (its own, else its top-level ancestor's) and otherwise projectRoot. The
       * command and the close commit resolve it the same way, so a SHA read
       * here describes the tree the suite opened. A sibling's green transfers
       * only when it resolves to this same root - one root or no claim
       * (CGLAB-366).
       */
      const gateRoot = effectiveRoot;
      const sharesRoot = !!gateRoot;
      const treeSha = sharesRoot ? readCleanTreeSha(gateRoot, gitRun) : null;
      let pass: { sibling: any; test: any } | null = null;
      let refusal = treeSha
        ? 'no sibling green is tied to this commit'
        : 'this tree is not clean at a commit, so no sibling green can be tied to it';
      for (const s of siblings) {
        if (pass || s.id === item.id || s.status !== Status.DONE) continue;
        // Same checkout as the one the command runs in, or nothing transfers.
        if (!sharesRoot || resolveCommitRoot(await withEffectiveWorktree(s), (project as any)?.projectRoot).root !== gateRoot) continue;
        // EVERY matching test, not the first: a sibling re-verified after a
        // rollback has an older record that must not shadow the current one.
        for (const test of testRecords(s.tests)) {
          if (pass || test.status !== 'PASSED' || test.command !== resolvedCommand) continue;
          const gate = mayPropagate(treeSha, test);
          if (gate.allowed) pass = { sibling: s, test };
          else refusal = gate.reason ?? refusal;
        }
      }
      if (pass) {
        const { sibling: passedSibling, test: siblingTest } = pass;
        const sibComment = { id: uuidv4(), author: 'ValidateTool', content: `### Validation PASSED (sibling propagation)\n\nSkipped — already verified by sibling \`${passedSibling.id.slice(0, 8)}\` (${passedSibling.title}).\n**Command**: \`${resolvedCommand}\` at \`${String(siblingTest.commit).slice(0, 12)}\``, timestamp: new Date() };
        const updates: any = { status: nextStatus, stepRecords: withExitRecord(), comments: [...(item.comments || []), sibComment], tests: [...testRecords(item.tests), { id: uuidv4(), command: resolvedCommand, output: `Sibling propagation: verified by ${passedSibling.id}`, status: 'PASSED', executedAt: new Date(), commit: siblingTest.commit }], ...(isExitStep ? { failureCount: 0 } : {}) };
        const updated = await storage.updateItem(itemId, updates);
        io.emit('items_updated');
        recordMoveEvents({ id: itemId, projectId: item.projectId, type: item.type }, item.status, nextStatus, activeFlow);
        if (updated.parentId) await syncParentStatus(updated.parentId);
        // Awaited, unlike before: the response describes what the commit did,
        // so it cannot be written before the commit has been attempted. No
        // `|| findProjectRoot(process.cwd())`: that made a long-lived daemon
        // commit into whatever repository it was launched from.
        const gitResult = (process.env.NODE_ENV !== 'test' && !process.env.VITEST)
          ? await autoGitCommit(updated, (project as any)?.projectRoot)
          : undefined;
        return res.json({ status: nextStatus, message: `✅ Validation Passed (sibling propagation)!\n\nItem moved to ${nextStatus}.${describePush(gitResult)}${nowOn(nextStatus)}`, output: 'Sibling propagation' });
      }
      console.warn(`[VALIDATE] Sibling propagation refused for ${itemId}: ${refusal}`);
    } else if (!isFinalStep) {
      // "A sibling is further along" runs nothing, so it may only carry a step
      // that needs no command. On a boundary step mid-flow the project's
      // command is required, and it runs (CGLAB-378 review).
      const passedSibling = siblings.find(s => {
        if (s.id === item.id) return false;
        if (s.status === Status.DONE) return true;
        const sibStep = findCurrentFlowStep(sorted, s.status);
        return sibStep !== undefined && sibStep.index > currentFlowStep.index;
      });
      if (passedSibling) {
        const sibComment = { id: uuidv4(), author: 'ValidateTool', content: `### Validation PASSED (sibling propagation)\n\nSkipped — already verified by sibling \`${passedSibling.id.slice(0, 8)}\` (${passedSibling.title}).`, timestamp: new Date() };
        const left = await commitOnLeave(res);
        if (left.refused) return;
        res = left.res;
        const updated = await storage.updateItem(itemId, { status: nextStatus, stepRecords: withExitRecord(), comments: [...(item.comments || []), sibComment], ...(isExitStep ? { failureCount: 0 } : {}) } as any);
        recordMoveEvents({ id: itemId, projectId: item.projectId, type: item.type }, item.status, nextStatus, activeFlow);
        // Sibling propagation moves the item into a working step exactly like
        // a verify does. It is the same transition; only the reason differs.
        await ensureWorktreeForItem(updated, true);
        io.emit('items_updated');
        if (updated.parentId) await syncParentStatus(updated.parentId);
        return res.json({ status: nextStatus, message: `✅ Validation Passed (sibling propagation)!\n\nItem moved to ${nextStatus}.${mandatoryInstructions}${nowOn(nextStatus)}`, output: 'Sibling propagation' });
      }
    }
  }

  // No command on an intermediate step — advance directly without running anything.
  if (!resolvedCommand) {
    const exitNote = exitCriteria ? `\n**Exit criteria acknowledged**: ${exitCriteria}` : '';
    const comment = { id: uuidv4(), author: 'ValidateTool', content: `### Validation PASSED\n\n**Step**: ${item.status} → ${nextStatus}${exitNote}`, timestamp: new Date() };
    const left = await commitOnLeave(res);
    if (left.refused) return;
    res = left.res;
    const updated = await storage.updateItem(itemId, { status: nextStatus, stepRecords: withExitRecord(), comments: [...(item.comments || []), comment] } as any);
    recordMoveEvents({ id: itemId, projectId: item.projectId, type: item.type }, item.status, nextStatus, activeFlow);
    await ensureWorktreeForItem(updated, true);
    io.emit('items_updated');
    if (updated.parentId) await syncParentStatus(updated.parentId);
    return res.json({ status: nextStatus, message: `✅ Validation Passed!\n\nItem moved to ${nextStatus}.${mandatoryInstructions}${nowOn(nextStatus)}` });
  }

  // See above: declining beats committing somewhere plausible.
  const projectRoot = (project as any)?.projectRoot;
  // The tree the command runs in AND the close commit lands in: the card's
  // effective worktree, else projectRoot. One root, so a green is recorded
  // against the tree it actually tested. It used to be projectRoot always,
  // which validated somebody else's checkout for any card with a worktree
  // (CGLAB-366).
  const runRoot: string | undefined = effectiveRoot ?? projectRoot;
  // A worktree deleted by hand used to surface as `spawn /bin/sh ENOENT`,
  // blaming the shell. Name the actual problem, and run nothing.
  if (runRoot && !fs.existsSync(runRoot)) {
    return res.status(409).json({
      error: `The tree this card is verified in, ${runRoot}, no longer exists - its worktree was removed. `
        + 'Recreate it with `agenfk worktree create <top-level item id>`, or clear the stale link with '
        + '`agenfk worktree prune`. Nothing was run.',
    });
  }

  // Runs the command and applies the pass/fail side effects, reporting through
  // `res2` — the real HTTP response on the sync path, or a recorder that
  // captures the outcome into a ValidateRun on the async path.
  const runCommandAndFinalize = async (res2: any, run?: ValidateRun) => {
  // Read once, so the cap reported in the failure message is the cap that was
  // actually enforced even if the environment moves underneath us.
  const maxMs = verifyMaxMs();
  // Opened BEFORE the spawn, so the command's output can be streamed straight to
  // disk. The whole stream is never held in memory (BUG 24c679df); the id has to
  // be minted here rather than after the run for the same reason. Keyed by the
  // id AS STORED, so the value reaching mkdir / open / unlink is one the server
  // minted and an id that does not exist cannot create a directory at all.
  const testId = uuidv4();
  const storedItem = await storage.getItem(itemId);
  const logHandle = storedItem ? openValidationLog(storedItem.id, testId) : null;
  const capture = createOutputCapture({ fd: logHandle?.fd ?? null });

  // The commit and the working-tree state the command actually ran against,
  // captured BEFORE the spawn. A long run during which another agent commits
  // OR stages work must not let this green be recorded against a tree it never
  // saw. The command and the close commit share runRoot, so it is the root to
  // record against.
  const gateRoot = runRoot ?? null;
  const headBeforeRun = gateRoot ? readHead(gateRoot, gitRun) : null;
  const statusBeforeRun = gateRoot ? readTreeStatus(gateRoot, gitRun) : null;

  // try/finally around the spawn, not just the awaited result: spawn() throws
  // SYNCHRONOUSLY on a bad argument (a NUL byte in the command, a non-string
  // cwd from a hand-edited project record). Without this the promise rejects
  // with the log fd still open, and that is one leaked descriptor per
  // occurrence with no recovery short of a restart. capture.end() is idempotent
  // and owns the close.
  let settledCapture: CapturedOutput | null = null;
  const { captured, code, timedOut, signal, spawnError } = await (async () => {
   try {
    return await new Promise<{
      captured: CapturedOutput; code: number | null; timedOut?: boolean; signal?: NodeJS.Signals | null; spawnError?: string;
    }>((resolve) => {
    const child = spawn(resolvedCommand, { shell: true, cwd: runRoot, env: { ...process.env, FORCE_COLOR: '1' } });
    let killed = false;
    let settled = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    // Exactly one resolution, whichever signal arrives first.
    const finish = (c: number | null, sig?: NodeJS.Signals | null, spawnErr?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      if (grace) clearTimeout(grace);
      settledCapture = capture.end();
      resolve({ captured: settledCapture, code: killed ? 124 : c, timedOut: killed, signal: sig, spawnError: spawnErr });
    };
    // Hard runtime cap: without it a hung verifyCommand (e.g. a test suite
    // waiting on stdin) would leave an async run 'running' forever, and the
    // 409 guard would lock the item's verify verb until a server restart.
    const killer = setTimeout(() => {
      killed = true;
      capture.note(`\n[agenfk] verifyCommand exceeded the ${Math.round(maxMs / 60000)}min cap (AGENFK_VERIFY_MAX_MS) and was killed.\n`);
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      // SIGKILL reaches the SHELL only. Grandchildren — vitest workers, npm
      // lifecycle scripts — survive it and hold the inherited stdio pipes open,
      // and 'close' waits for those pipes. Resolving only on 'close' meant the
      // cap did not bound the run at all: the promise settled whenever an
      // orphan happened to exit, the run stayed 'running' and
      // activeValidateRunByItem stayed held, so every later verify on the item
      // got VALIDATE_RUN_ACTIVE — the exact lock this cap exists to prevent.
      // Once 'exit' has fired the process is gone; give stdio a moment to drain,
      // then answer.
      grace = setTimeout(() => finish(124), KILL_GRACE_MS);
      if (typeof grace.unref === 'function') grace.unref();
    }, maxMs);
    if (typeof killer.unref === 'function') killer.unref();
    // Live output for run followers is the capture's bounded head, so a verbose
    // command can't pin hundreds of MB in the run map — and now cannot pin them
    // anywhere else either. The full output is on disk, not in this process.
    // What the run already streamed (a capture's output, 9569b4d7) stays in front: followers read by offset.
    const runBase = run?.output ?? '';
    const onData = (d: Buffer) => { capture.write(d); if (run) { run.output = runBase + capture.live(); run.tail = ((run.tail ?? '') + d.toString()).slice(-RUN_TAIL_BYTES); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (c, sig) => { if (killed) finish(124, sig); });
    child.on('close', (c, sig) => finish(c, sig));
    // Keep whatever the command already printed — discarding it loses the only
    // evidence of why the spawn failed.
    child.on('error', (err) => finish(1, null, err.message));
    });
   } finally {
     if (!settledCapture) capture.end();
   }
  })();

  const logPath = closeValidationLog(logHandle);
  const logVanished = !!logHandle && logPath === null;
  const preview = buildOutputPreview(captured, logPath, logVanished);
  const passed = code === 0 && !timedOut;
  const exitNote = exitCriteria ? `\n**Exit criteria**: ${exitCriteria}` : '';

  // The command may have run for a long time — re-read the item so we merge
  // comments added meanwhile instead of clobbering them, and refuse to apply a
  // transition computed from a flow position the item no longer occupies
  // (e.g. someone rolled it back mid-run).
  const freshItem = await storage.getItem(itemId);
  if (!freshItem) {
    return res2.status(404).json({ status: item.status, message: `❌ Item was deleted while the validation command ran.`, output: preview });
  }
  if (freshItem.status !== item.status) {
    const staleComment = { id: uuidv4(), author: 'ValidateTool', content: `### Validation ${passed ? 'PASSED' : 'FAILED'} (not applied)\n\nItem moved ${item.status} → ${freshItem.status} while the command ran; the computed transition is stale and was NOT applied. Re-run verify from the current step.\n**Command**: \`${resolvedCommand}\`\n\n**Output**:\n\`\`\`\n${preview}\n\`\`\``, timestamp: new Date() };
    await storage.updateItem(itemId, { comments: [...(freshItem.comments || []), staleComment] });
    io.emit('items_updated');
    return res2.status(409).json({ status: freshItem.status, message: `⚠️ Validation ${passed ? 'passed' : 'failed'}, but the item changed step (${item.status} → ${freshItem.status}) while the command ran — no transition applied. Re-run verify from the current step.${nowOn(freshItem.status)}`, output: preview });
  }
  Object.assign(item, freshItem);

  const comments = [...(item.comments || []), {
    id: uuidv4(),
    author: 'ValidateTool',
    content: `### Validation ${passed ? 'PASSED' : 'FAILED'}\n\n**Step**: ${passed ? `${item.status} → ${nextStatus}` : `${item.status} (advance refused — the card stays here)`}${exitNote}\n**Command**: \`${resolvedCommand}\`\n\n**Output**:\n\`\`\`\n${preview}\n\`\`\``,
    timestamp: new Date(),
  }];

    if (passed) {
      // The index may have changed while the command ran: ask again.
      if ((await checkStrays(res2)).refused) return;
      const left = await commitOnLeave(res2);
      if (left.refused) return;
      res2 = left.res;
      const updates: any = { status: nextStatus, comments, stepRecords: withExitRecord() };
      /*
       * The flow's OWN exit step is rarely named DONE, so the storage clear
       * keyed on the literal word misses every custom flow - leaving the count
       * at three forever on a card that finished, breaker open with no route
       * to reset it (review finding on CGLAB-202). Here the flow is resolved,
       * so the clear can be about landing on the FINAL step, not a name.
       */
      if (isExitStep) updates.failureCount = 0;
      if (endsFlow) {
        // The commit is attached AFTER the close commit below - the state a
        // later card inherits is the one the sibling LEFT BEHIND, not the one
        // it started from.
        updates.tests = [...testRecords(item.tests), { id: testId, command: resolvedCommand, output: preview, status: 'PASSED', executedAt: new Date() }];
      }
      const updated = await storage.updateItem(itemId, updates);
      io.emit('items_updated');
      // Before the roll-up: the child's move is recorded ahead of the parent's.
      recordMoveEvents({ id: itemId, projectId: item.projectId, type: item.type }, item.status, nextStatus, activeFlow);
      if (updated.parentId) await syncParentStatus(updated.parentId);
      // HEAD just before our own close commit. If it moved during the run,
      // another agent landed work this green never covered, so no commit is
      // recorded and no card may inherit it.
      const preCommitSha = endsFlow && gateRoot ? readHead(gateRoot, gitRun) : null;
      const preCommitStatus = endsFlow && gateRoot ? readTreeStatus(gateRoot, gitRun) : null;
      let gitResult: AutoGitCommitResult | undefined;
      if (endsFlow && process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
        // Advisory: a git-commit failure must not report a PASSED validation
        // (whose transition already landed) as failed to the run follower. The
        // catch is belt-and-braces — autoGitCommit resolves rather than throws,
        // reporting a refusal as outcome 'failed' — but exec's callback is not
        // the only way this can go wrong, and the transition must survive all
        // of them. The outcome is KEPT, not discarded: it is what the response
        // reports, so the agent learns the commit declined or failed.
        try { gitResult = await autoGitCommit(updated, projectRoot); }
        catch (e: any) { console.error(`[validate] autoGitCommit failed after DONE: ${e?.message || e}`); }
      }
      /*
       * Record WHERE this green was earned (b29a8b3a), now that the close
       * commit has moved HEAD. Two guards, both fail closed:
       *  - the run must not have outlived the tree it started on; and
       *  - the tree must be CLEAN, because uncommitted work is content the
       *    green never saw (see readCleanTreeSha).
       * Where either fails, the record carries no commit and no card inherits
       * this green - the honest direction is a command run, not a claim.
       */
      if (
        endsFlow &&
        gateRoot &&
        preCommitSha === headBeforeRun &&
        // A staged edit during the run would be swept into OUR close commit,
        // stamping this green on content it never ran against. HEAD does not
        // see that; the porcelain does.
        preCommitStatus === statusBeforeRun
      ) {
        const verifiedSha = readCleanTreeSha(gateRoot, gitRun);
        if (verifiedSha) {
          const current = await storage.getItem(itemId);
          const tests = testRecords(current?.tests).map((t: any) =>
            t.id === testId ? { ...t, commit: verifiedSha, commitRoot: gateRoot } : t,
          );
          await storage.updateItem(itemId, { tests });
          noteGreen(item.projectId, gateRoot, verifiedSha, itemId);
          io.emit('items_updated');
        }
      }
      recordHubEvent({
      type: 'validate.passed',
      projectId: item.projectId,
      itemId,
      payload: { fromStatus: item.status, toStatus: nextStatus, command: resolvedCommand },
    });
    recordHubEvent({
      type: 'test.logged',
      projectId: item.projectId,
      itemId,
      payload: { command: resolvedCommand, status: 'PASSED', testId },
    });
    return res2.json({ status: nextStatus, message: `✅ Validation Passed!\n\nCommand: \`${resolvedCommand}\`\nItem moved to ${nextStatus}.${mandatoryInstructions}${describePush(gitResult)}${nowOn(nextStatus)}`, output: preview });
  } else {
    const updates: any = { status: failureStatus, comments };
    // Same positional predicate as the PASSED record above: a red final gate on
    // a flow whose exit step is not named DONE must still leave a FAILED record.
    if (endsFlow) {
      updates.tests = [...testRecords(item.tests), { id: testId, command: resolvedCommand, output: preview, status: 'FAILED', executedAt: new Date() }];
    }
    await storage.updateItem(itemId, updates);
    io.emit('items_updated');
    recordHubEvent({
      type: 'validate.failed',
      projectId: item.projectId,
      itemId,
      payload: { fromStatus: item.status, stayedOn: failureStatus, command: resolvedCommand },
    });
    recordHubEvent({
      type: 'test.logged',
      projectId: item.projectId,
      itemId,
      payload: { command: resolvedCommand, status: 'FAILED', testId },
    });
    return res2.status(422).json({
      status: failureStatus,
      // The outcome first, then the tail, then where the whole thing is. The
      // exit code used to be computed and thrown away, so a red suite, a
      // cap-kill and a command that never started were indistinguishable
      // (BUG b233143b).
      message: `❌ Validation Failed!\n\nCommand: \`${resolvedCommand}\`\nRoot: \`${runRoot}\`\nResult: ${describeExit({ code, timedOut, signal, spawnError }, maxMs)}\n\nOutput: ${formatBytes(captured.totalBytes)}\n\nLast ${FAILURE_TAIL_LINES} lines of output:\n${tailLines(captured.tail, FAILURE_TAIL_LINES)}\n\n${describeLog(captured, logPath, logVanished)}${staysOn(failureStatus)}`,
      output: preview,
    });
  }
  }; // end runCommandAndFinalize

  if (asyncRun) {
    const run = asyncRun;
    const runId = run.runId;
    // Answer immediately — the client follows the run instead of holding this
    // request open for the command's whole lifetime.
    bareRes.status(202).json({
      runId,
      command: resolvedCommand,
      message: `⏳ Validation running in background (run ${runId.slice(0, 8)}…). Follow with GET /items/validate-runs/${runId}.`,
    });
    markRunStarted(run, item.status);
    const recorder = runRecorder(run);
    void runCommandAndFinalize(commandNote ? withNote(recorder, commandNote) : recorder, run)
      .catch((err: any) => {
        run.status = 'failed';
        run.message = `Internal error during background validation: ${err?.message || err}`;
        run.finishedAt = new Date();
      })
      .finally(() => {
        if (activeValidateRunByItem.get(itemId) === runId) activeValidateRunByItem.delete(itemId);
        io.emit('items_updated');
      });
    return;
  }

  // `opts.run`: the background run a slow gate already answered 202 for, so
  // the command's output still streams to whoever follows it.
  return runCommandAndFinalize(res, opts?.run);
}

// Live status/output of a background validate run. Registered before use in
// the CLI follow loop; unknown ids 404 (a restarted server forgets runs — the
// outcome itself is persisted on the item regardless).
app.get("/items/validate-runs/:runId", asyncHandler(async (req: any, res: any) => {
  if (req.headers['x-agenfk-internal'] !== VERIFY_TOKEN) {
    return res.status(403).json({ error: "Forbidden: validate-runs endpoint requires internal token." });
  }
  const run = validateRuns.get(req.params.runId);
  if (!run) return res.status(404).json({ error: 'RUN_NOT_FOUND', message: 'Unknown or expired validation run. If the server restarted, check the item\'s comments — the outcome is persisted there.' });
  return res.json(run);
}));

/**
 * Give an item its own worktree as it enters a working step (CGLAB-166).
 *
 * Opt-in per project: creating directories on someone's disk because they
 * advanced a card is not a reasonable default. Never throws — the transition
 * is the user's intent and the worktree is a convenience on top of it, so a
 * broken git setup must not block the workflow.
 */
/**
 * Is this an item that should get its own worktree?
 *
 * Exported because the rule is the interesting part and it disagreed with
 * `agenfk branch create`, which refuses children outright while this path
 * happily made worktrees for them — and for EPICs.
 *
 * An EPIC is a container with no code of its own: a checkout for it is a full
 * copy of the repository that nobody will ever type in, and one per epic is
 * how ~/.agenfk-worktrees grows without anybody noticing. A child shares its
 * parent's branch by design, which is exactly why the CLI refuses it.
 */
export function shouldAutoWorktree(item: any): boolean {
  if (!item?.projectId || item.worktreePath) return false;
  if (item.type === 'EPIC') return false;
  if (item.parentId) return false;
  return true;
}

/**
 * Say on the ITEM that the worktree could not be made.
 *
 * The agent receives a 200 whatever happens here, so without a mark it assumes
 * it has a worktree and edits the MAIN tree — the precise collision this
 * feature exists to prevent. A console warning is somewhere the agent never
 * looks; a comment on the item is somewhere it already reads.
 */
export async function noteOnItem(itemId: string, content: string): Promise<void> {
  try {
    const item: any = await storage.getItem(itemId);
    if (!item) return;
    /*
     * `content` and `timestamp`, which is what CommentRecord declares and what
     * CardDetailModal renders.
     *
     * This function exists because the worktree-failure note did NOT use them:
     * it wrote `text` and `createdAt`, so the comment arrived with an empty
     * body and the modal drew a blank. The docblock above says "somewhere it
     * already reads" and that was true - the comment was there, saying nothing.
     * Nothing failed: the write succeeded, the record was stored, and the one
     * channel warning an agent that it has no worktree and is about to collide
     * with whatever else is using the tree was silent.
     *
     * One writer now, so the next note cannot pick the wrong pair of names.
     */
    const comment = {
      id: crypto.randomUUID(),
      author: 'agenfk',
      content,
      timestamp: new Date(),
    };
    await storage.updateItem(itemId, { comments: [...(item.comments || []), comment] } as any);
  } catch (e: any) {
    // The comment is the signal; failing to write it must not also take down
    // the request that was only trying to be helpful.
    console.warn(`[WORKTREE] could not record a note on ${itemId}:`, e?.message);
  }
}

export async function noteWorktreeFailure(itemId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[WORKTREE] auto-create failed for ${itemId}:`, message);
  await noteOnItem(
    itemId,
    `Worktree could not be created automatically: ${message}\n\n` +
    `This item has NO worktree of its own, so work on it happens in the main ` +
    `checkout. Create one with \`agenfk branch create ${itemId}\` before editing, ` +
    `or expect to collide with whatever else is using that tree.`,
  );
}

/**
 * `refs/remotes/origin/<branch>` when the repository has it, otherwise nothing.
 *
 * Cheap and total: a repo with no origin, no such branch, or no git at all
 * answers "no start point", which is the behaviour that existed before.
 */
function remoteRefFor(repoRoot: string, branchName: string): string | undefined {
  const ref = `refs/remotes/origin/${branchName}`;
  try {
    execFileSync('git', ['-C', repoRoot, 'rev-parse', '--verify', '--quiet', ref],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    return ref;
  } catch {
    return undefined;
  }
}

/**
 * Start a worktree's dependency install in the BACKGROUND (712a4752).
 *
 * Orca runs `scripts.setup` in every new worktree and pays the install, and we
 * do the same - but NOT inside the status transition that created the worktree.
 * A dependency install takes minutes, and blocking the event loop for it would
 * make the server serve nothing else: the same rule that runs `verify` behind a
 * 202. So it is fire-and-forget, and the outcome is posted on the card when it
 * lands, which is where an agent already looks.
 *
 * DETACHED, so the command is its own process-group leader: the shell is the
 * direct child, and a compound setup (a bootstrap script plus the package
 * manager, exactly what Orca's `scripts.setup` is) would otherwise survive the
 * timeout in its children while the card says the install failed. The kill
 * targets the group.
 */
function startWorktreeSetup(item: any, decision: SetupDecision, worktreePath: string): void {
  if (!decision.command) {
    if (!decision.ready) void noteOnItem(item.id, decision.notice);
    return;
  }
  const child = spawn(decision.command, {
    shell: true,
    cwd: worktreePath,
    detached: true,
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  let output = '';
  let timedOut = false;
  // A ROLLING TAIL, not a head. The diagnosis is at the END of an install log,
  // and the notice quotes the tail - a head buffer would throw away exactly
  // the part it shows. Bounded, so a verbose install cannot pin memory.
  const collect = (d: Buffer): void => {
    output += d.toString();
    if (output.length > 16_000) output = output.slice(-16_000);
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  // A stream error with no listener is an uncaught exception in a long-lived
  // server; the close handler still reports the outcome.
  child.stdout?.on('error', () => { /* reported by the run's close */ });
  child.stderr?.on('error', () => { /* reported by the run's close */ });
  const killer = setTimeout(() => {
    timedOut = true;
    try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
    catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  }, SETUP_TIMEOUT_MS);
  if (typeof killer.unref === 'function') killer.unref();
  let settled = false;
  const settle = (result: SetupRun): void => {
    // `error` and `close` both fire on a failed spawn; one note per attempt.
    if (settled) return;
    settled = true;
    clearTimeout(killer);
    void noteOnItem(item.id, applySetupResult(decision, result).notice);
  };
  child.on('error', err => settle({ ok: false, output: `${output}${err.message}`, timedOut: false }));
  child.on('close', code => settle({ ok: code === 0 && !timedOut, output, timedOut }));
}

async function ensureWorktreeForItem(item: any, allowSetup = false): Promise<void> {
  if (!shouldAutoWorktree(item)) return;
  const project: any = await storage.getProject(item.projectId);
  if (!project?.autoWorktree || !project.projectRoot) return;

  const branchName = item.branchName || buildBranchName(item.type, item.title);
  try {
    const result = createWorktree({
      repoRoot: project.projectRoot,
      root: defaultWorktreeRoot(),
      branchName,
      /*
       * If origin already has this branch, start there rather than at local
       * HEAD. Raised by review against the PR import: a card whose branch
       * exists on the remote but not locally got a directory named after that
       * branch holding local main instead — so this route would quietly undo
       * the import's own care a status change later. The rule is general
       * enough to belong here rather than only on that one path: a branch name
       * the remote already knows means the remote's commits.
       */
      startPoint: remoteRefFor(project.projectRoot, branchName),
      setupCommand: project.setupCommand,
    });
    await storage.updateItem(item.id, { worktreePath: result.path, branchName } as any);
    /*
     * The setup notice goes on the CARD, next to the failure notice, and for
     * the same reason (CGLAB-203): this path runs with nobody watching, so a
     * decision returned to a caller that is a status-change handler is a
     * decision nobody reads. An agent starting work in a worktree with no
     * dependencies fails on an import and goes looking at its own change,
     * which is the wrong afternoon.
     *
     * Only when it is NOT ready. A worktree that needs nothing is the common
     * case, and a comment saying so on every transition is noise that teaches
     * people to skim the comments where the real warnings live.
     */
    if (allowSetup && result.created) {
      // The CALLER started this worktree on a token-gated path; running an
      // arbitrary project shell string is at least as privileged as
      // `verifyCommand`, which refuses without one. `created` because an
      // ADOPTED worktree is never re-installed - the plan says so, and this
      // must agree with it.
      startWorktreeSetup(item, result.setup, result.path);
    } else if (!result.setup.ready) {
      await noteOnItem(item.id, result.setup.notice);
    }
  } catch (e: any) {
    // Recorded where the agent will see it, not swallowed into the log.
    await noteWorktreeFailure(item.id, e);
  }
}

app.post("/items/:id/validate", limitExpensive, asyncHandler(async (req: any, res: any) => {
  if (req.headers['x-agenfk-internal'] !== VERIFY_TOKEN) {
    return res.status(403).json({ error: "Forbidden: validate endpoint requires internal token." });
  }
  const cwd: string | undefined = typeof req.body.cwd === 'string' && req.body.cwd ? req.body.cwd : undefined;
  const cwdItem = cwd ? await storage.getItem(req.params.id) : null;
  if (cwd && cwdItem) {
    const item = cwdItem;
    const projRoot = (await storage.getProject(item.projectId) as any)?.projectRoot as string | undefined;
    const worktree = await effectiveWorktreePath(item);
    /*
     * Whether the RECORDED root can be trusted, judged from the stored value
     * alone. One that is missing, is $HOME or ~/.agenfk, or is a linked
     * worktree (recorded before CGLAB-366, or set by hand) is replaced from
     * this caller below; anything else is kept, whatever directory the caller
     * reports.
     */
    const rootUsable = !!projRoot && fs.existsSync(projRoot)
      && isPersistableProjectRoot(projRoot, os.homedir())
      && (await checkoutKind(projRoot)) !== 'linked';
    const tested = worktree ?? (rootUsable ? projRoot : undefined);
    /*
     * REFUSE A VERIFY THAT WOULD TEST A DIFFERENT CHECKOUT (CGLAB-366). The
     * tree a verify tests is the card's effective worktree (its own, else its
     * top-level ancestor's), else projectRoot. When the caller is working in
     * ANOTHER CHECKOUT OF THE SAME REPOSITORY, that run tests code the caller
     * is not editing, and the close commit reads an index that is not theirs -
     * in either direction: caller in a worktree while the card has none, or
     * caller in the main checkout while the card's tree is a worktree.
     *
     * Deliberately narrow. Checkouts are compared by git TOP-LEVEL, never
     * against projectRoot itself: a project's `.agenfk` may sit in a
     * subdirectory of its repo. A different repository (a submodule, or a
     * verify issued from some other project) is not one of the tested
     * repository's checkouts and is not refused. No cwd, or a cwd outside any
     * checkout, is unaffected. See placeCaller for why the caller's path is
     * matched against git's list rather than handed to git.
     *
     * NOTHING IS LEARNED FROM A CALLER ONCE THE PROJECT HAS A ROOT. Learning
     * from any marked directory re-recorded ANOTHER project's checkout as this
     * one's root whenever a verify came from there, and every later run and
     * close aimed at somebody else's repository. The root is learned below
     * only when the recorded one is absent or fails rootUsable.
     */
    if (tested && fs.existsSync(tested)) {
      const place = await placeCaller(cwd, tested);
      if (place.kind === 'other') {
        const what = worktree
          ? `its worktree ${worktree} (the card's own, or its top-level item's)`
          : `projectRoot ${projRoot} - the card has no worktree, nor does its top-level item`;
        return res.status(409).json({
          error: `Refusing to verify: you are working in ${place.checkout}, but card ${item.id} is verified in `
            + `${what}. That is a different checkout of the same repository, so the run would test `
            + 'code you are not editing and the close commit would read an index that is not yours. '
            + `Run agenfk verify from ${place.testedTop}, with your changes there.`
            + (worktree ? '' : ' To give the card a tree of its own, run `agenfk worktree create <top-level item id>` and work in the directory it prints.'),
          callerRoot: place.checkout,
          testedRoot: place.testedTop,
        });
      }
    }
    if (!rootUsable) {
      // No root yet, or the recorded one cannot be trusted: learn it.
      // Resolve the caller's cwd UP to the project root (nearest `.agenfk` ancestor)
      // so the verifyCommand always runs at the repo root — even when `agenfk verify`
      // was invoked from a subdirectory — and never in the daemon's own dir (CGLAB-13).
      const resolvedRoot = path.isAbsolute(cwd) ? findProjectRoot(cwd) : null;
      // Refused, not corrected. findProjectRoot walks up for a `.agenfk`
      // directory and `~/.agenfk` exists, so a verify run from anywhere under
      // $HOME with no closer `.agenfk` resolves to the HOME DIRECTORY — which is
      // how four projects on one machine came to share it. projectRoot is the
      // directory a worktree is cut from and the cwd `git add -A && git commit`
      // runs in, so recording $HOME points both at the user's private files.
      // Keeping whatever was there is strictly better than overwriting it with
      // that.
      /*
       * THE MARKER IS THE PROOF. findProjectRoot returns its STARTING directory
       * when the walk finds no `.agenfk` ancestor - which is a FAILURE, not an
       * answer, and the two are indistinguishable by looking at the string.
       *
       * It is not hypothetical: `.agenfk/` is gitignored, so a worktree has
       * none, and a verify run from one used to record that worktree as the
       * project's own root. Every later operation that resolves through
       * projectRoot - autoGitCommit above all - then aimed at a directory
       * belonging to ONE card, permanently, with no message. Checking for the
       * marker is what tells a real found root from a fallback.
       */
      /*
       * `findProjectRoot` now ANSWER whether it found anything: null is the walk
       * reaching the filesystem root without a `.agenfk` marker, which is what a
       * buggy expression used to record as the project's root.
       */
      /*
       * A LINKED WORKTREE IS NEVER THE PROJECT'S ROOT (CGLAB-366). "A worktree
       * has no .agenfk" was the only thing keeping one out, and it is a
       * convention rather than a check: `.agenfk/` is gitignored, and one
       * hand-made marker inside a worktree recorded that card's tree as the
       * root of the whole project - every other card's verify and close then
       * aimed at it. Ask git, which knows.
       */
      const kind = resolvedRoot ? await checkoutKind(resolvedRoot) : 'unknown';
      if (resolvedRoot && (kind === 'main' || kind === 'none') && isPersistableProjectRoot(resolvedRoot, os.homedir())) {
        await storage.updateProject(item.projectId, { projectRoot: resolvedRoot });
      } else {
        const why = resolvedRoot === null
          ? 'no .agenfk marker above it (a worktree has none) - it is not a project root'
          : kind === 'linked'
            ? 'it is a linked git worktree - one card\'s tree, never the project\'s root'
            : kind === 'unknown'
              ? 'git could not say whether it is a linked worktree, and guessing wrong repoints the whole project'
              : 'it is not a persistable project root';
        console.warn(`[PROJECT_ROOT] Refusing to record ${resolvedRoot ?? cwd} as a project root (item ${item.id}): ${why}`);
      }
    }
  }
  // One active run per item — a second verify while one runs is almost always
  // an agent misreading slowness as failure. Applies to sync requests too so
  // an old client can't race a background run on the same item.
  const activeGuard = rejectIfRunActive(req.params.id, res);
  if (activeGuard) return;
  // efcacdeb: the coding agent's reports of the step's agent checks.
  const parsedReports = parseAgentReports(req.body.agentChecks);
  if ('error' in parsedReports) return res.status(400).json({ error: parsedReports.error });
  const agentReports = parsedReports.reports;
  const asyncMode = req.body.async === true || req.body.async === 'true';
  if (asyncMode) {
    // Reserve the run in the SAME tick as the guard — a check-then-set gap
    // spanning the handler's awaits would let a double-submit spawn twice.
    pruneValidateRuns();
    const run: ValidateRun = { runId: uuidv4(), itemId: req.params.id, status: 'running', output: '', startedAt: new Date() };
    validateRuns.set(run.runId, run);
    activeValidateRunByItem.set(req.params.id, run.runId);
    try {
      return await handleValidateProgress(req.params.id, req.body.command || undefined, res, req.body.evidence || undefined, run, { actor: parseActor(req.body.actor), agentReports });
    } finally {
      // A sync fast-path (anchor, sibling propagation, no-command, error)
      // responded without ever starting the command — discard the reservation.
      if (!run.started) {
        validateRuns.delete(run.runId);
        if (activeValidateRunByItem.get(req.params.id) === run.runId) activeValidateRunByItem.delete(req.params.id);
      }
    }
  }
  return handleValidateProgress(req.params.id, req.body.command || undefined, res, req.body.evidence || undefined, undefined, { actor: parseActor(req.body.actor), agentReports });
}));

/** 409 if the item already has a live background validate run. Returns true when it responded. */
function rejectIfRunActive(itemId: string, res: any): boolean {
  const activeRunId = activeValidateRunByItem.get(itemId);
  if (activeRunId && validateRuns.get(activeRunId)?.status === 'running') {
    res.status(409).json({
      error: 'VALIDATE_RUN_ACTIVE',
      runId: activeRunId,
      message: `A validation run is already active for this item. Follow it with GET /items/validate-runs/${activeRunId} instead of starting another.`,
    });
    return true;
  }
  return false;
}

// ── review_changes: DEPRECATED — delegates to validate_progress ──────────────
app.post("/items/:id/review", asyncHandler(async (req: any, res: any) => {
  if (req.headers['x-agenfk-internal'] !== VERIFY_TOKEN) {
    return res.status(403).json({ error: "Forbidden: review endpoint requires internal token." });
  }
  if (!req.body.command || typeof req.body.command !== 'string') {
    return res.status(400).json({ error: "Missing required field: command" });
  }
  if (rejectIfRunActive(req.params.id, res)) return;
  return handleValidateProgress(req.params.id, req.body.command, res);
}));

// ── test_changes: DEPRECATED — delegates to validate_progress (no command = uses verifyCommand)
app.post("/items/:id/test", asyncHandler(async (req: any, res: any) => {
  if (req.headers['x-agenfk-internal'] !== VERIFY_TOKEN) {
    return res.status(403).json({ error: "Forbidden: test endpoint requires internal token." });
  }
  if (rejectIfRunActive(req.params.id, res)) return;
  return handleValidateProgress(req.params.id, undefined, res);
}));

// ── Hub flush (manual trigger; used by `agenfk hub flush`) ───────────────────

app.post('/internal/hub/flush', asyncHandler(async (req: any, res: any) => {
  if (req.headers['x-agenfk-internal'] !== VERIFY_TOKEN) {
    return res.status(403).json({ error: 'Forbidden: hub flush requires internal token.' });
  }
  if (!hubFlusher) {
    return res.status(400).json({ error: 'Hub not configured. Run `agenfk hub login` first.' });
  }
  await hubFlusher.flush();
  res.json(hubFlusher.getStatus());
}));

// ── Hub config reload (used by `agenfk hub login` / `join` / `repoint`) ──────
// The Flusher and both reconcilers capture their credential and base URL when
// they are constructed, so a freshly-written ~/.agenfk/hub.json had no effect
// until the server restarted. That made a halted flusher unrecoverable in the
// one case that actually happens — a revoked token — because its recovery probe
// kept presenting the same dead credential. Re-read the file and restart the
// hub subsystems in place; the outbox lives in SQLite, so nothing is lost.
app.post('/internal/hub/reload', asyncHandler(async (req: any, res: any) => {
  if (req.headers['x-agenfk-internal'] !== VERIFY_TOKEN) {
    return res.status(403).json({ error: 'Forbidden: hub reload requires internal token.' });
  }
  const changed = hubClient.reloadConfig();
  if (changed) startHubSubsystems();
  // A rejoin or repoint may change which org's JIRA this installation sees.
  clearHubJiraStatusCache();
  res.json({
    ok: true,
    changed,
    enabled: hubClient.isEnabled,
    url: hubClient.hubConfig?.url ?? null,
    orgId: hubClient.hubConfig?.orgId ?? null,
    status: hubFlusher ? hubFlusher.getStatus() : { enabled: false },
  });
}));

app.get('/internal/hub/status', asyncHandler(async (req: any, res: any) => {
  if (req.headers['x-agenfk-internal'] !== VERIFY_TOKEN) {
    return res.status(403).json({ error: 'Forbidden: hub status requires internal token.' });
  }
  // orgs (per-org outbox summaries, CGLAB-117) is present even when the hub
  // is NOT configured: a stale-org install is exactly when `hub carry-over`
  // needs to read it. Guarded for the pre-initStorage/shutdown window where
  // the provider is not (or no longer) open.
  const orgs = typeof (storage as any)?.hubOutboxOrgSummaries === 'function'
    ? (storage as any).hubOutboxOrgSummaries()
    : {};
  if (!hubFlusher) {
    return res.json({ enabled: false, orgs });
  }
  res.json({ ...hubFlusher.getStatus(), orgs });
}));

// ── Hub outbox org rewrite (used by `agenfk hub carry-over`, `hub repoint
// --carry-over`, and login's pre-login sentinel stamp) ─────────────────────
// When the hub admin renames the org (e.g. staging→cglab), every queued event
// in the local outbox still has the old orgId baked into its JSON. The
// renamed hub rejects them on orgId mismatch. This endpoint rewrites them in
// place, atomically, via the storage layer's json1-backed UPDATE.
app.post('/internal/hub/rewrite-outbox-org', asyncHandler(async (req: any, res: any) => {
  if (req.headers['x-agenfk-internal'] !== VERIFY_TOKEN) {
    return res.status(403).json({ error: 'Forbidden: hub outbox rewrite requires internal token.' });
  }
  const from = req.body?.from;
  const to = req.body?.to;
  // `from` may be '' — the pending-org sentinel for events queued before
  // `agenfk hub login` (stamped here and at boot). `to` must be a real org.
  if (typeof from !== 'string' || typeof to !== 'string' || !to) {
    return res.status(400).json({ error: 'Body must be { from: string, to: string } with a non-empty target.' });
  }
  const rewritten = (storage as any).hubOutboxRewriteOrgId(from, to);
  res.json({ ok: true, rewritten });
}));

// ── Pause / Resume ───────────────────────────────────────────────────────────

app.post("/items/:id/pause", asyncHandler(async (req: any, res: any) => {
  const item = await storage.getItem(req.params.id);
  if (!item) return res.status(404).json({ error: "Item not found" });

  // Flow-aware: an item is pausable when it sits in an active working step of
  // its project's active flow (any non-anchor, non-inactive step) — not a
  // hardcoded IN_PROGRESS/REVIEW/TEST set, which excluded custom-flow steps
  // like DISCOVERY / CREATE_UNIT_TESTS.
  const pauseProject = await storage.getProject(item.projectId);
  const pauseFlows = await storage.listFlows();
  const pauseActiveFlow = getActiveFlow((pauseProject as any)?.flowId, pauseFlows);
  const pausable = getActiveStepItems([item as any], pauseActiveFlow as any).length > 0;
  if (!pausable) {
    return res.status(400).json({ error: `Cannot pause item in ${item.status} status — it must be in an active working step of its flow (not an anchor like TODO/DONE, and not already BLOCKED/PAUSED).` });
  }

  const { summary, filesModified, resumeInstructions, gitDiff } = req.body;
  if (!summary || !resumeInstructions) {
    return res.status(400).json({ error: "summary and resumeInstructions are required." });
  }

  const snapshot = {
    id: uuidv4(),
    itemId: item.id,
    projectId: item.projectId,
    status: item.status,
    summary,
    filesModified: filesModified || [],
    branchName: item.branchName,
    gitDiff: gitDiff || undefined,
    resumeInstructions,
    pausedAt: new Date(),
  };

  await storage.createSnapshot(snapshot);

  const comments = [...(item.comments || []), {
    id: uuidv4(),
    author: 'PauseTool',
    content: `### Work Paused\n\n**Previous status**: ${item.status}\n\n**Summary**: ${summary}\n\n**Resume instructions**: ${resumeInstructions}`,
    timestamp: new Date(),
  }];

  // The pause snapshot is how this card comes back; a remembered step from an
  // earlier stay must not also be honoured (CGLAB-377).
  await storage.updateItem(req.params.id, { status: Status.PAUSED, comments, previousStatus: undefined });
  io.emit('items_updated');

  res.json(snapshot);
}));

app.post("/items/:id/resume", asyncHandler(async (req: any, res: any) => {
  const item = await storage.getItem(req.params.id);
  if (!item) return res.status(404).json({ error: "Item not found" });

  if (item.status !== Status.PAUSED) {
    return res.status(400).json({ error: `Cannot resume item in ${item.status} status. Must be PAUSED.` });
  }

  const snapshot = await storage.getSnapshotByItemId(req.params.id);
  if (!snapshot) {
    return res.status(404).json({ error: "No pause snapshot found for this item." });
  }

  // A snapshot is a one-shot ticket back to where you paused, and it must be
  // spent here. Snapshots used to survive resume, and `PUT status=PAUSED`
  // reaches PAUSED without creating one — so any step an item had ever paused at
  // became a permanent teleport token: pause once at the last step, walk back,
  // set PAUSED directly, resume, and you are at the end again with no evidence.
  // Restoring is still allowed to move the item forward, which is why the ticket
  // has to be consumed rather than merely gated.
  const restoreTarget = snapshot.status;
  const currentFlow = getActiveFlow(
    (await storage.getProject(item.projectId) as any)?.flowId,
    await storage.listFlows(),
  );
  const restoreAllowed = buildAllowedTransitions(item.status, currentFlow);
  const restorable = currentFlow.steps.some(
    st => st.name.toUpperCase() === String(restoreTarget).toUpperCase());
  if (!restorable && !restoreAllowed.has(restoreTarget as Status)) {
    return res.status(400).json({
      error: `Cannot resume to '${restoreTarget}': it is not a step of the project's active flow.`,
    });
  }

  if (snapshot.resumedAt) {
    return res.status(400).json({
      error: "This pause snapshot has already been resumed. Pause again to create a new one.",
    });
  }

  // Restore item to its pre-pause status
  const comments = [...(item.comments || []), {
    id: uuidv4(),
    author: 'ResumeTool',
    content: `### Work Resumed\n\n**Restored status**: ${snapshot.status}`,
    timestamp: new Date(),
  }];

  await storage.updateItem(req.params.id, { status: snapshot.status, comments, previousStatus: undefined });

  // Mark the snapshot resumed AND spent. createSnapshot replaces the row for
  // this item, so writing resumedAt keeps the audit trail; the guard below is
  // what stops it being redeemed twice.
  snapshot.resumedAt = new Date();
  await storage.createSnapshot(snapshot);

  io.emit('items_updated');

  res.json({ snapshot, item: await storage.getItem(req.params.id) });
}));

app.get("/items/:id/snapshot", asyncHandler(async (req: any, res: any) => {
  const snapshot = await storage.getSnapshotByItemId(req.params.id);
  if (!snapshot) return res.status(404).json({ error: "No snapshot found for this item." });
  res.json(snapshot);
}));

// ── JIRA Integration ─────────────────────────────────────────────────────────

function jiraTokenPath(): string { return path.join(os.homedir(), '.agenfk', 'jira-token.json'); }

interface JiraTokenData {
  access_token: string;
  refresh_token: string;
  cloudId: string;
  cloudUrl: string;
  email?: string;
}

interface JiraConfig {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
}

// CSRF state nonces for the JIRA OAuth flow: state -> { expiresAt }.
// Single-use: the callback deletes an entry on lookup, and rejects one that is
// unknown or expired. (Was `oauthStateStore` until CGLAB-361 removed the PKCE half.)
export const oauthStateStore = new Map<string, { expiresAt: number }>();

const base64url = (buf: Buffer): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

/**
 * A single-use CSRF nonce for the authorize round trip.
 *
 * CGLAB-361: this used to also mint a PKCE verifier/challenge pair. Atlassian's
 * consent endpoint began returning HTTP 500
 * ({"failedToLoad":true,"error":{"category":"generic"}}, atl-traceid
 * 4477e8158284433a8af8ecf8974f56bc) for any authorize request carrying
 * code_challenge, which dead-ended "Connect JIRA" on their "Something went
 * wrong" page for every user.
 *
 * Measured 2026-09-22 by single-variable experiment against live Atlassian:
 * same client_id, scopes, redirect_uri and prompt=consent, with ONLY the PKCE
 * parameters removed, the consent screen returns 200 and renders, Accept issues
 * a code, and that code exchanges for an access_token + refresh_token with no
 * code_verifier sent. Our request shape had not changed since 456ed817
 * (2026-02-23), and Atlassian's docs still document PKCE S256 support for 3LO
 * alongside client authentication -- so this is a workaround for an
 * unconfirmed regression on their side, not a judgement that PKCE was wrong.
 *
 * This client is confidential (it holds client_secret), so PKCE was defence in
 * depth rather than load-bearing; the state nonce below is what actually
 * protects the callback. Do not restore PKCE without re-running that
 * experiment -- tests pin its absence so a silent restore fails loudly.
 */
const generateOAuthState = (): { state: string } => {
  const state = base64url(crypto.randomBytes(16));
  return { state };
};

const loadJiraConfig = (): JiraConfig => {
  const clientId = process.env.JIRA_CLIENT_ID;
  const clientSecret = process.env.JIRA_CLIENT_SECRET;
  const redirectUri = process.env.JIRA_REDIRECT_URI;
  if (clientId && clientSecret) return { clientId, clientSecret, redirectUri };

  try {
    const configPath = path.join(os.homedir(), '.agenfk', 'config.json');
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (cfg.jira) return cfg.jira as JiraConfig;
    }
  } catch { /* ignore */ }
  return {};
};

const loadJiraToken = (): JiraTokenData | null => {
  try {
    if (!fs.existsSync(jiraTokenPath())) return null;
    return JSON.parse(fs.readFileSync(jiraTokenPath(), 'utf8'));
  } catch { return null; }
};

// Cached token validation to avoid repeated Atlassian API calls
export let jiraValidationCache: { valid: boolean; checkedAt: number } | null = null;
const JIRA_VALIDATION_TTL = 60_000; // 60 seconds

const saveJiraToken = (data: JiraTokenData): void => {
  const dir = path.dirname(jiraTokenPath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(jiraTokenPath(), JSON.stringify(data, null, 2));
  jiraValidationCache = null;
};

const deleteJiraToken = (): void => {
  if (fs.existsSync(jiraTokenPath())) fs.unlinkSync(jiraTokenPath());
  jiraValidationCache = null;
};

export const clearJiraValidationCache = (): void => { jiraValidationCache = null; };

const validateJiraToken = async (tokenData: JiraTokenData): Promise<boolean> => {
  if (jiraValidationCache && Date.now() - jiraValidationCache.checkedAt < JIRA_VALIDATION_TTL) {
    return jiraValidationCache.valid;
  }
  try {
    // jiraApiRequest auto-refreshes on 401
    await jiraApiRequest(tokenData, 'get',
      `https://api.atlassian.com/ex/jira/${tokenData.cloudId}/rest/api/3/myself`);
    jiraValidationCache = { valid: true, checkedAt: Date.now() };
    return true;
  } catch (err: any) {
    if (err.response?.status === 401 || err.response?.status === 403) {
      jiraValidationCache = { valid: false, checkedAt: Date.now() };
      return false;
    }
    // Network errors (Atlassian down): assume still valid, don't cache failure
    return true;
  }
};

let refreshPromise: Promise<JiraTokenData | null> | null = null;

const refreshJiraToken = async (tokenData: JiraTokenData): Promise<JiraTokenData | null> => {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const { clientId, clientSecret } = loadJiraConfig();
    if (!clientId || !clientSecret) return null;
    try {
      console.log(`[JIRA] Refreshing access token...`);
      const { data } = await axios.post('https://auth.atlassian.com/oauth/token', {
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: tokenData.refresh_token,
      }, { timeout: JIRA_HTTP_TIMEOUT_MS });
      const updated: JiraTokenData = {
        ...tokenData,
        access_token: data.access_token,
        refresh_token: data.refresh_token || tokenData.refresh_token,
      };
      saveJiraToken(updated);
      console.log(`[JIRA] Token refreshed successfully.`);
      return updated;
    } catch (err: any) {
      console.error(`[JIRA] Token refresh failed:`, err.response?.data || err.message);
      return null;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
};

/** The hub this installation is joined to, or null. Joined means JIRA is the hub's. */
function joinedHub(): HubTarget | null {
  const cfg = hubClient.isEnabled ? hubClient.hubConfig : null;
  return cfg ? { url: cfg.url, token: cfg.token } : null;
}

/** A local `agenfk jira setup` connection as a JiraSession, or null. */
function localJiraSession(): JiraSession | null {
  const tokenData = loadJiraToken();
  if (!tokenData) return null;
  return {
    source: 'local',
    cloudId: tokenData.cloudId,
    cloudUrl: tokenData.cloudUrl,
    email: tokenData.email,
    async get(apiPath: string, timeoutMs?: number) {
      const { data } = await jiraApiRequest(
        tokenData,
        'get',
        `https://api.atlassian.com/ex/jira/${encodeURIComponent(tokenData.cloudId)}/rest/api/3/${apiPath}`,
        undefined,
        timeoutMs,
      );
      return { data };
    },
  };
}

/**
 * The JIRA connection to use (CGLAB-412): when joined, this user's own
 * connection held by the hub - with NO fallback to a local token or config,
 * so no JIRA credential is ever used from the laptop - else the local one.
 * Null when there is none; throws when the hub cannot say.
 */
async function openJiraSession(): Promise<JiraSession | null> {
  const hub = joinedHub();
  return hub ? openHubJiraSession(hub) : localJiraSession();
}

/**
 * Why a joined user has no connection, in terms of what fixes it: no app on
 * the hub is an admin's job; an app without this user's grant is theirs.
 */
async function hubNotConnectedMessage(hub: HubTarget): Promise<string> {
  try {
    return notConnectedMessageFor(await fetchHubJiraStatus(hub));
  } catch {
    return CONNECT_FROM_BOARD;
  }
}

function notConnectedMessageFor(status: { configured: boolean; lastError?: string | null }): string {
  if (!status.configured) return ASK_HUB_ADMIN;
  return status.lastError === 'refresh_rejected' ? JIRA_CONNECTION_EXPIRED : CONNECT_FROM_BOARD;
}

const JIRA_CONNECTION_EXPIRED = 'Your JIRA connection expired or was revoked. Use Connect JIRA on the board to reconnect.';

/**
 * When this server last sent a browser off to connect JIRA through the hub.
 * The callback accepts a completion code only while such a connect is
 * pending: a code minted for someone ELSE's flow, loaded into this user's
 * browser by a hostile page, must not bind the other person's JIRA account to
 * this installation.
 */
let hubJiraConnectStartedAt = 0;
const HUB_JIRA_CONNECT_WINDOW_MS = 15 * 60 * 1000;
const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** For routes that need a connection: the session, or a response saying why there is none. */
async function requireJiraSession(res: any): Promise<JiraSession | null> {
  let session: JiraSession | null;
  try {
    session = await openJiraSession();
  } catch (err: any) {
    res.status(502).json({ error: 'The hub could not be reached for JIRA.', detail: err?.message });
    return null;
  }
  if (session) return session;
  const hub = joinedHub();
  if (hub) res.status(409).json({ error: await hubNotConnectedMessage(hub) });
  else res.status(401).json({ error: 'Not connected to JIRA' });
  return null;
}

/** A card's browse link, or null when the site URL would not make a safe href. */
function safeBrowseUrl(cloudUrl: string, key: string): string | null {
  const url = `${cloudUrl}/browse/${key}`;
  return isSafeExternalUrl(url) ? url : null;
}

/**
 * Where the browser lands after a JIRA connect. When we serve the UI
 * ourselves there is nothing on 5173, so redirecting there would dump the user
 * on a connection-refused page after the connect succeeded; same origin means
 * a relative redirect works.
 */
function jiraUiBase(): string {
  return process.env.JIRA_UI_URL || (servedUiDir ? '/' : 'http://localhost:5173');
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * This server's own OAuth callback, as the browser reaches it - the hub sends
 * the browser back here with the completion code. Only a loopback origin
 * qualifies (the hub refuses anything else too): a code must never be handed
 * to a host that is not this machine.
 */
function loopbackCallbackUrl(req: any): string | null {
  const host = String(req.get?.('host') ?? '');
  let u: URL;
  try { u = new URL(`http://${host}`); } catch { return null; }
  return LOOPBACK_HOSTS.has(u.hostname) ? `http://${u.host}/jira/oauth/callback` : null;
}

const jiraApiRequest = async (
  tokenData: JiraTokenData,
  method: string,
  url: string,
  body?: any,
  timeoutMs?: number
): Promise<{ data: any; tokenData: JiraTokenData }> => {
  const makeRequest = (token: string) =>
    axios({
      method,
      url,
      data: body,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
    });

  try {
    const res = await makeRequest(tokenData.access_token);
    return { data: res.data, tokenData };
  } catch (err: any) {
    if (err.response?.status === 401) {
      // If a refresh is already in progress, wait for it
      // Otherwise start a new one using the LATEST token from disk (in case another request already refreshed it)
      const latestToken = loadJiraToken() || tokenData;
      const refreshed = await refreshJiraToken(latestToken);
      if (!refreshed) throw err;
      const res = await makeRequest(refreshed.access_token);
      return { data: res.data, tokenData: refreshed };
    }
    throw err;
  }
};

export const mapJiraTypeToAgEnFK = (issueTypeName: string): string => {
  const t = issueTypeName.toLowerCase();
  if (t === 'epic') return 'EPIC';
  if (t === 'story') return 'STORY';
  if (t === 'bug') return 'BUG';
  return 'TASK';
};

const adfToText = (node: any): string => {
  if (!node) return '';
  if (node.type === 'text') return node.text || '';
  if (Array.isArray(node.content)) return node.content.map(adfToText).join(' ');
  return '';
};

// JIRA Routes

// Both OAuth legs are bounded by the same per-route budget as the other routes
// that do real work per call: authorize reads the stored client config and
// mints state, callback exchanges a code with Atlassian (CodeQL #135).
app.get("/jira/oauth/authorize", limitExpensive, asyncHandler(async (req: any, res: any) => {
  const hub = joinedHub();
  if (hub) {
    // Joined: the user connects their own JIRA through the hub's app.
    const back = (reason: string) => res.redirect(`${jiraUiBase()}?jira=error&reason=${encodeURIComponent(reason)}`);
    const returnTo = loopbackCallbackUrl(req);
    if (!returnTo) return back('not_loopback');
    try {
      const authorizeUrl = await startHubJiraOAuth(hub, returnTo);
      hubJiraConnectStartedAt = Date.now();
      return res.redirect(authorizeUrl);
    } catch (err: any) {
      return back(err?.code || 'hub_unreachable');
    }
  }
  const jiraConfig = loadJiraConfig();
  if (!jiraConfig.clientId || !jiraConfig.clientSecret) {
    return res.status(503).json({
      error: "JIRA integration is not configured.",
      configured: false,
      message: "Run 'agenfk jira setup' in your terminal to configure JIRA integration.",
      command: "agenfk jira setup",
    });
  }
  const redirectUri = jiraConfig.redirectUri || `http://localhost:3000/jira/oauth/callback`;
  const { state } = generateOAuthState();
  oauthStateStore.set(state, { expiresAt: Date.now() + 10 * 60 * 1000 });
  const params = new URLSearchParams({
    audience: 'api.atlassian.com',
    client_id: jiraConfig.clientId,
    scope: 'read:jira-user read:jira-work offline_access',
    redirect_uri: redirectUri,
    state,
    response_type: 'code',
    prompt: 'consent',
  });
  res.redirect(`https://auth.atlassian.com/authorize?${params}`);
}));

app.get("/jira/oauth/callback", limitExpensive, asyncHandler(async (req: any, res: any) => {
  const { code, state, error, completion } = req.query;
  const uiBase = jiraUiBase();

  const hub = joinedHub();
  if (hub) {
    // Joined: the hub already exchanged the code and holds the token pending.
    // Redeeming the completion with THIS installation's key is what binds it.
    const back = (reason: string) => res.redirect(`${uiBase}?jira=error&reason=${encodeURIComponent(reason)}`);
    // The Host check on authorize is about the header; this is about who is
    // actually connected, which a proxied or 0.0.0.0-bound setup can differ on.
    // Checked BEFORE the pending connect is consumed, so a stray remote hit
    // cannot cancel the user's own connect.
    if (!LOOPBACK_PEERS.has(String(req.socket?.remoteAddress ?? ''))) return back('not_loopback');
    const pendingConnect = Date.now() - hubJiraConnectStartedAt < HUB_JIRA_CONNECT_WINDOW_MS;
    hubJiraConnectStartedAt = 0;
    if (error) return back(String(error));
    if (typeof completion !== 'string' || !completion) return back('missing_params');
    if (!pendingConnect) return back('no_pending_connect');
    try {
      await completeHubJiraOAuth(hub, completion);
    } catch (err: any) {
      return back(err?.code || 'hub_unreachable');
    }
    return res.redirect(`${uiBase}?jira=connected`);
  }

  if (error) {
    return res.redirect(`${uiBase}?jira=error&reason=${encodeURIComponent(String(error))}`);
  }
  if (!code || !state) {
    return res.redirect(`${uiBase}?jira=error&reason=missing_params`);
  }

  const stateEntry = oauthStateStore.get(String(state));
  if (!stateEntry || Date.now() > stateEntry.expiresAt) {
    oauthStateStore.delete(String(state));
    return res.redirect(`${uiBase}?jira=error&reason=invalid_state`);
  }
  oauthStateStore.delete(String(state));

  const jiraConfig = loadJiraConfig();
  if (!jiraConfig.clientId || !jiraConfig.clientSecret) {
    return res.redirect(`${uiBase}?jira=error&reason=server_misconfigured`);
  }
  const redirectUri = jiraConfig.redirectUri || `http://localhost:3000/jira/oauth/callback`;

  try {
    const { data: tokenResponse } = await axios.post('https://auth.atlassian.com/oauth/token', {
      grant_type: 'authorization_code',
      client_id: jiraConfig.clientId,
      client_secret: jiraConfig.clientSecret,
      code,
      redirect_uri: redirectUri,
    });

    const { data: resources } = await axios.get('https://api.atlassian.com/oauth/token/accessible-resources', {
      headers: { Authorization: `Bearer ${tokenResponse.access_token}` },
    });

    if (!resources || resources.length === 0) {
      return res.redirect(`${uiBase}?jira=error&reason=no_accessible_resources`);
    }

    const cloud = resources[0];
    const tokenData: JiraTokenData = {
      access_token: tokenResponse.access_token,
      refresh_token: tokenResponse.refresh_token,
      cloudId: cloud.id,
      cloudUrl: cloud.url,
      email: cloud.name,
    };

    try {
      const { data: myself } = await axios.get(
        `https://api.atlassian.com/ex/jira/${cloud.id}/rest/api/3/myself`,
        { headers: { Authorization: `Bearer ${tokenResponse.access_token}` } }
      );
      tokenData.email = myself.emailAddress || cloud.name;
    } catch { /* non-fatal */ }

    saveJiraToken(tokenData);
    res.redirect(`${uiBase}?jira=connected`);
  } catch (err: any) {
    console.error('[JIRA] OAuth callback error:', err.message);
    res.redirect(`${uiBase}?jira=error&reason=token_exchange_failed`);
  }
}));

app.get("/jira/status", asyncHandler(async (req: any, res: any) => {
  const hub = joinedHub();
  if (hub) {
    try {
      const status = await fetchHubJiraStatus(hub);
      return res.json({ ...status, ...(status.connected ? {} : { message: notConnectedMessageFor(status) }) });
    } catch (err: any) {
      return res.json({
        source: 'hub', configured: false, connected: false,
        reason: err?.code || 'hub_unreachable', message: err?.message,
      });
    }
  }
  const jiraConfig = loadJiraConfig();
  const configured = !!(jiraConfig.clientId && jiraConfig.clientSecret);
  const tokenData = loadJiraToken();
  if (!tokenData) {
    return res.json({
      source: 'local',
      configured,
      connected: false,
      ...(configured ? {} : { message: "Run 'agenfk jira setup' to configure JIRA integration." }),
    });
  }
  // Validate token against Atlassian (cached, ~60s TTL)
  if (configured) {
    const valid = await validateJiraToken(tokenData);
    if (!valid) {
      return res.json({ source: 'local', configured, connected: false, reason: 'token_expired' });
    }
  }
  res.json({ source: 'local', configured, connected: true, cloudId: tokenData.cloudId, cloudUrl: tokenData.cloudUrl, email: tokenData.email });
}));

app.get("/jira/projects", asyncHandler(async (req: any, res: any) => {
  const jira = await requireJiraSession(res);
  if (!jira) return;

  try {
    const { data } = await jira.get('project/search?maxResults=50');
    const projects = (data.values || []).map((p: any) => ({
      id: p.id,
      key: p.key,
      name: p.name,
      type: p.projectTypeKey,
    }));
    res.json(projects);
  } catch (err: any) {
    res.status(502).json({ error: "Failed to fetch JIRA projects", detail: err.message });
  }
}));

app.get("/jira/projects/:key/issues", asyncHandler(async (req: any, res: any) => {
  const jira = await requireJiraSession(res);
  if (!jira) return;

  const { key } = req.params;
  const { summary, statusCategory } = req.query;
  
  try {
    // Escape any user input placed inside a JQL double-quoted string so it
    // can't break out of the clause and read issues from other projects the
    // token can see. statusCategory is restricted to the known mapping rather
    // than passed through verbatim. (Security: bug 25f871be.)
    const jqlEsc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    let jqlParts = [`project = "${jqlEsc(key)}"`];

    if (summary && summary !== 'undefined') {
      const s = jqlEsc(String(summary));
      jqlParts.push(`(summary ~ "${s}*" OR issueKey = "${s}")`);
    }

    if (statusCategory && statusCategory !== 'undefined') {
      // Map UI category names to JQL statusCategory names or IDs
      const mapping: Record<string, string> = {
        'To Do': '"To Do"',
        'In Progress': '"In Progress"',
        'Done': '"Done"'
      };
      const categories = String(statusCategory).split(',')
        .map((s: string) => mapping[s.trim()])
        .filter((v): v is string => Boolean(v));
      if (categories.length === 0) {
        return res.status(400).json({ error: "statusCategory must be one or more of: To Do, In Progress, Done" });
      }
      jqlParts.push(`statusCategory in (${categories.join(',')})`);
    }
    
    const jql = encodeURIComponent(jqlParts.join(' AND ') + ' ORDER BY created DESC');
    const fields = 'summary,issuetype,status,priority';
    const apiPath = `search/jql?jql=${jql}&maxResults=50&fields=${fields}`;

    console.log(`[JIRA] Requesting (${jira.source}): ${apiPath}`);

    const { data } = await jira.get(apiPath);
    const issues = (data.issues || []).map((issue: any) => ({
      id: issue.id,
      key: issue.key,
      summary: issue.fields.summary,
      type: issue.fields.issuetype?.name || 'Task',
      mappedType: mapJiraTypeToAgEnFK(issue.fields.issuetype?.name || 'Task'),
      status: issue.fields.status?.name,
      statusCategory: issue.fields.status?.statusCategory?.name,
      priority: issue.fields.priority?.name,
    }));
    res.json(issues);
  } catch (err: any) {
    const detail = err.response?.data?.errorMessages?.[0] || err.message;
    console.error(`[JIRA] Failed to fetch issues for project ${key}:`, detail);
    res.status(502).json({ error: "Failed to fetch JIRA issues", detail });
  }
}));

app.post("/jira/import", asyncHandler(async (req: any, res: any) => {
  const jira = await requireJiraSession(res);
  if (!jira) return;

  const { projectId, items } = req.body;
  if (!projectId || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "projectId and items[] are required" });
  }

  const imported: any[] = [];
  const errors: any[] = [];

  for (const { issueKey, type: requestedType } of items) {
    /*
     * The key goes into a PATH segment of a request this server makes, so it
     * is validated as a JIRA key and then encoded. A fixed host does not make
     * an unvalidated path safe: `../../` or a `?`/`#` in the value changes
     * which resource is fetched, and CodeQL flags the URL as user-built.
     */
    if (typeof issueKey !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(issueKey)) {
      errors.push({ issueKey, error: 'Invalid JIRA issue key.' });
      continue;
    }
    try {
      // JIRA keys are case-insensitive, but the hub relay only accepts the
      // canonical upper-case form - normalise so a joined import of 'acme-7'
      // behaves like an unjoined one.
      const { data: issue } = await jira.get(`issue/${encodeURIComponent(issueKey.toUpperCase())}?fields=summary,description,issuetype`);
      const type = requestedType || mapJiraTypeToAgEnFK(issue.fields.issuetype?.name || 'Task');
      const description = adfToText(issue.fields.description);
      const externalUrl = safeBrowseUrl(jira.cloudUrl, issueKey);

      const newItem: any = {
        id: uuidv4(),
        projectId,
        type,
        title: `[${issueKey}] ${issue.fields.summary}`,
        description: description || `Imported from JIRA: ${issueKey}`,
        status: 'TODO',
        implementationPlan: '',
        externalId: issueKey,
        externalUrl,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const created = await storage.createItem(newItem);
      io.emit('items_updated');
      imported.push({ issueKey, itemId: created.id });

      // If this is an Epic, also import its child stories
      if (issue.fields.issuetype?.name?.toLowerCase() === 'epic') {
        try {
          const searchBase = 'search/jql';
          const childFields = 'summary,description,issuetype';

          // Try next-gen (team-managed) projects first: parent = KEY
          let childIssues: any[] = [];
          const jqlNextGen = encodeURIComponent(`parent = ${issueKey} ORDER BY created ASC`);
          console.log(`[JIRA] Fetching children of Epic ${issueKey} with JQL: parent = ${issueKey}`);
          const { data: nextGenData } = await jira.get(`${searchBase}?jql=${jqlNextGen}&maxResults=100&fields=${childFields}`);
          childIssues = nextGenData.issues || [];
          console.log(`[JIRA] next-gen child query returned ${childIssues.length} issues`);

          // Fallback for classic (company-managed) projects: "Epic Link" = KEY
          if (childIssues.length === 0) {
            const jqlClassic = encodeURIComponent(`"Epic Link" = ${issueKey} ORDER BY created ASC`);
            console.log(`[JIRA] Trying classic Epic Link fallback for ${issueKey}`);
            const { data: classicData } = await jira.get(`${searchBase}?jql=${jqlClassic}&maxResults=100&fields=${childFields}`);
            childIssues = classicData.issues || [];
            console.log(`[JIRA] classic Epic Link query returned ${childIssues.length} issues`);
          }

          for (const childIssue of childIssues) {
            const childKey = childIssue.key;
            const childType = mapJiraTypeToAgEnFK(childIssue.fields.issuetype?.name || 'Task');
            const childDescription = adfToText(childIssue.fields.description);

            const childItem: any = {
              id: uuidv4(),
              projectId,
              parentId: created.id,
              type: childType,
              title: `[${childKey}] ${childIssue.fields.summary}`,
              description: childDescription || `Imported from JIRA: ${childKey}`,
              status: 'TODO',
              implementationPlan: '',
              externalId: childKey,
              externalUrl: safeBrowseUrl(jira.cloudUrl, childKey),
              createdAt: new Date(),
              updatedAt: new Date(),
            };

            const createdChild = await storage.createItem(childItem);
            io.emit('items_updated');
            imported.push({ issueKey: childKey, itemId: createdChild.id, parentItemId: created.id });
          }
        } catch (childErr: any) {
          const detail = (childErr as any).response?.data?.errorMessages?.[0] || childErr.message;
          console.error(`[JIRA] Failed to fetch child issues for Epic ${issueKey}:`, detail);
          errors.push({ issueKey: `${issueKey} (children)`, error: detail });
        }
      }
    } catch (err: any) {
      errors.push({ issueKey, error: err.message });
    }
  }

  res.json({ imported, errors });
}));

app.post("/jira/disconnect", asyncHandler(async (req: any, res: any) => {
  const hub = joinedHub();
  if (hub) {
    // Joined: drop this user's connection on the hub; there is no local token to delete.
    try {
      await disconnectHubJira(hub);
    } catch (err: any) {
      return res.status(502).json({ error: 'The hub could not disconnect JIRA.', detail: err?.message });
    }
    return res.json({ disconnected: true });
  }
  deleteJiraToken();
  res.json({ disconnected: true });
}));

// ── GitHub Import Routes (read-only) ──────────────────────────────────────────

function loadGitHubConfig(projectId: string): { owner: string; repo: string } | null {
  try {
    const configPath = path.join(os.homedir(), '.agenfk', 'config.json');
    if (!fs.existsSync(configPath)) return null;
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return cfg.github?.repos?.[projectId] || null;
  } catch {
    return null;
  }
}

function verifyGhCli(): boolean {
  try {
    execSync('gh auth status', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * `gh`, run with an argument array and a deadline.
 *
 * argv rather than a shell string on principle: nothing interpolated from a
 * request reaches these calls today, and passing argv anyway is what keeps that
 * true after the next edit.
 *
 * The timeout is not decoration. `gh api user` goes to GitHub, and this is a
 * synchronous exec on Node's single thread — without a deadline, one request to
 * a settings screen behind a hanging proxy holds the entire server, board and
 * terminals included, for as long as the socket stays open.
 */
const runGh = (args: readonly string[]): string =>
  execFileSync('gh', args as string[], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 8000,
  });

/**
 * The account the machine is signed in to GitHub as.
 *
 * Deliberately NOT project-scoped, unlike `/github/status` below. That route
 * answers which repo a card maps to; this one answers who you are. Conflating
 * them is how a settings screen reports "not connected" because no project
 * happens to have a repo configured yet.
 */
app.get("/github/account", limitExpensive, (req: any, res: any) => {
  /*
   * Guarded like the WRITES below, which is unusual for a GET and deliberate.
   *
   * A simple GET is not gated by CORS: a foreign origin cannot READ the
   * response, but the request is still issued and still executed. Without a
   * header requirement, any page the user visits can drive this in a loop, and
   * each call spawns a `gh` process that blocks Node's single thread for up to
   * eight seconds on a round trip to GitHub - which wedges the board, the
   * terminals and the sockets along with it.
   *
   * The payload is the second reason: this answers with a login, a display name
   * and an EMAIL. The same sentence that justifies the guard on sign-out - "any
   * page open on the machine" - applies at least as strongly to reading the
   * user's identity out of the machine.
   *
   * The rate limit is belt and braces: the header stops a cross-origin caller,
   * and the limiter stops a same-origin one (another dev server, a preview, a
   * package that starts a localhost listener) doing the same thing.
   */
  if (!req.headers['x-agenfk-ui']) {
    return res.status(403).json({ error: "Forbidden: this route requires the x-agenfk-ui header." });
  }
  // Always 200 past the guard. "gh is not installed" is an answer about the
  // machine, not a server error, and the screen needs to read the reason to say
  // anything useful about it.
  res.json(readGitHubAccount(runGh));
});

/**
 * Log the GitHub CLI out.
 *
 * Guarded by the same custom-header preflight as POST /releases/update, and for
 * the same reason: this server is unauthenticated on loopback and its CORS
 * allowlist trusts any localhost origin, so without it any page open on the
 * machine could log the user out of `gh`. (Security: bug 968259c4.)
 *
 * The credential is the GitHub CLI's, shared with everything else on the
 * machine that uses `gh` — the UI says so rather than calling this "sign out of
 * AgEnFK", because it is not.
 */
app.post("/github/signout", limitExpensive, (req: any, res: any) => {
  // Rate-limited as well as header-guarded: this runs `gh` TWICE in sequence
  // (the account read, then the logout), so it can hold the event loop for
  // twice the single-call ceiling.
  if (!req.headers['x-agenfk-ui']) {
    return res.status(403).json({ error: "Forbidden: this route requires the x-agenfk-ui header." });
  }
  res.json(signOutGitHub(runGh, process.env));
});

app.get("/github/status", async (req: any, res: any) => {
  const projectId = req.query.projectId;
  if (!projectId) {
    return res.json({ configured: false, error: 'projectId query param required' });
  }
  const config = loadGitHubConfig(projectId);
  if (!config) {
    return res.json({ configured: false });
  }
  const ghAvailable = verifyGhCli();
  res.json({
    configured: true,
    owner: config.owner,
    repo: config.repo,
    ghCliAuthenticated: ghAvailable,
  });
});

app.get("/github/issues", async (req: any, res: any) => {
  try {
    const { projectId, state, search } = req.query;
    if (!projectId) return res.status(400).json({ error: 'projectId required' });

    const config = loadGitHubConfig(projectId as string);
    if (!config) return res.status(400).json({ error: 'GitHub not configured for this project.' });
    if (!verifyGhCli()) return res.status(400).json({ error: 'GitHub CLI not authenticated. Run: gh auth login' });

    // state and search are interpolated into a gh shellout. Allowlist state and
    // pass everything as argv (no shell) so search can't inject. (Security: bug f9380911.)
    const stateVal = String(state || 'open');
    if (!['open', 'closed', 'all'].includes(stateVal)) {
      return res.status(400).json({ error: "state must be one of: open, closed, all" });
    }
    const ghArgs = [
      'issue', 'list',
      '-R', `${config.owner}/${config.repo}`,
      '--state', stateVal,
      '--limit', '100',
    ];
    if (search) { ghArgs.push('--search', String(search)); }
    ghArgs.push('--json', 'number,title,state,labels,url,createdAt');

    const result = execFileSync('gh', ghArgs, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const issues = JSON.parse(result);
    res.json(issues.map((i: any) => ({
      number: i.number,
      title: i.title,
      state: i.state,
      labels: (i.labels || []).map((l: any) => l.name),
      url: i.url,
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.post("/github/import", async (req: any, res: any) => {
  try {
    const { projectId, items } = req.body;
    if (!projectId || !items?.length) return res.status(400).json({ error: 'projectId and items[] required' });

    const config = loadGitHubConfig(projectId);
    if (!config) return res.status(400).json({ error: 'GitHub not configured for this project.' });
    if (!verifyGhCli()) return res.status(400).json({ error: 'GitHub CLI not authenticated.' });

    const imported: Array<{ issueNumber: number; itemId: string }> = [];
    const errors: string[] = [];

    for (const { issueNumber, type } of items) {
      try {
        // issueNumber is interpolated into a gh shellout — require an integer
        // and pass via argv so it can't inject commands. (Security: bug 4c939916.)
        const issueNum = Number(issueNumber);
        if (!Number.isInteger(issueNum) || issueNum <= 0) {
          errors.push(`Issue #${issueNumber}: invalid issue number`);
          continue;
        }
        const result = execFileSync(
          'gh',
          ['issue', 'view', String(issueNum), '-R', `${config.owner}/${config.repo}`, '--json', 'number,title,body,state,url'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
        );
        const issue = JSON.parse(result);

        const newItem: AgEnFKItem = {
          id: uuidv4(),
          projectId,
          type: type || ItemType.TASK,
          title: issue.title,
          description: issue.body || '',
          status: Status.TODO,
          externalId: String(issue.number),
          externalUrl: issue.url,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as AgEnFKItem;
        await storage.createItem(newItem);
        imported.push({ issueNumber: issue.number, itemId: newItem.id });
      } catch (err: any) {
        errors.push(`Issue #${issueNumber}: ${err.message || String(err)}`);
      }
    }

    io.emit("items_updated");
    res.json({ imported, errors });
  } catch (err: any) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

/**
 * A card from an existing Pull Request (CGLAB-177).
 *
 * Sibling of `POST /projects/:id/tasks-from-branch`, and the differences
 * between them are the whole content of this route. That one starts from a
 * branch the user names; this one starts from a PR that already exists, which
 * brings three problems it does not have: the branch is REMOTE, the PR may come
 * from a fork, and a card for that branch may already be on the board.
 *
 * The decisions are in `planPrImport` in core, tested without a network or a
 * GitHub credential. What is left here is the part that genuinely needs the
 * outside world: asking `gh`, fetching the ref, making the worktree.
 */
app.post("/projects/:id/tasks-from-pr", limitExpensive, asyncHandler(async (req: any, res: any) => {
  const project: any = await storage.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const { prNumber, type, agentId } = req.body ?? {};
  // Validated before it can reach argv. The issue importer carries a comment
  // naming the bug this was (4c939916); the lesson is not that issues need it,
  // it is that anything reaching a shellout does.
  if (!isValidPrNumber(prNumber)) {
    return res.status(400).json({ error: "prNumber must be a positive integer" });
  }
  if (agentId !== undefined && !(TERMINAL_AGENT_IDS as readonly string[]).includes(agentId)) {
    return res.status(400).json({ error: `agentId must be one of: ${TERMINAL_AGENT_IDS.join(", ")}` });
  }

  const config = loadGitHubConfig(project.id);
  if (!config) return res.status(400).json({ error: "GitHub not configured for this project. Run `agenfk github setup`." });
  if (!verifyGhCli()) return res.status(400).json({ error: "GitHub CLI not authenticated. Run `gh auth login`." });

  let pr: any;
  try {
    const out = execFileSync(
      'gh',
      ['pr', 'view', String(Number(prNumber)), '-R', `${config.owner}/${config.repo}`,
       '--json', 'number,title,body,url,headRefName,state,isCrossRepository'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    pr = JSON.parse(out);
  } catch (e: any) {
    // A PR that is not there, or no access to the repo. Both are the user's to
    // fix and neither is a server fault.
    return res.status(404).json({ error: `Could not read PR #${prNumber} from ${config.owner}/${config.repo}: ${e?.message ?? String(e)}` });
  }

  /*
   * A parse that succeeded is not a PR. `gh` answering with an object missing
   * the fields asked for used to flow straight through: a titleless card, an
   * externalId of the string "undefined", a prNumber of NaN — and, worst,
   * `isCrossRepository` undefined, which is falsy, so the fork guard silently
   * disengaged and a fork PR got a fetch that could never work.
   */
  if (!pr || typeof pr !== 'object'
      || typeof pr.title !== 'string'
      || !isValidPrNumber(pr.number)
      || typeof pr.url !== 'string'
      || typeof pr.headRefName !== 'string'
      || typeof pr.isCrossRepository !== 'boolean') {
    return res.status(502).json({ error: `GitHub returned a pull request this cannot read: ${JSON.stringify(pr).slice(0, 200)}` });
  }

  /*
   * Only cards that are actually ON the board.
   *
   * `listItems` applies no status filter, and `DELETE /items/:id` does not
   * delete — it TRASHES, and the update is a spread-merge, so branchName
   * survives. Without this, importing a PR, deleting its card and importing
   * again answered "reused" pointing at the trashed card: nothing on the
   * board, no worktree, and no way to ever import that PR again.
   */
  const onTheBoard = (i: any) => i.status !== 'TRASHED' && i.status !== Status.ARCHIVED;
  const existing = await storage.listItems({ projectId: project.id, limit: 1_000_000 });
  const plan = planPrImport(pr, (existing as any[]).filter(onTheBoard).map(i => ({ id: i.id, title: i.title, branchName: i.branchName })));

  // Reuse, never duplicate. Git allows one worktree per branch, so a second
  // card on the same branch is a failure scheduled for later rather than a
  // duplicate to tidy up.
  if (plan.action === 'reuse') {
    const item = await storage.getItem(plan.itemId);
    // Gone between the read and now. Better a plain 404 than `{item: null}`
    // with a 200, which the CLI reads as success and then dereferences.
    if (!item) return res.status(404).json({ error: `Card ${plan.itemId} is no longer there.` });
    return res.status(200).json({ item, reused: true, reason: plan.reason });
  }

  const created: any = await storage.createItem({
    id: uuidv4(),
    projectId: project.id,
    type: (typeof type === 'string' && ['STORY', 'TASK', 'BUG'].includes(type) ? type : 'TASK') as ItemType,
    title: plan.title,
    description: plan.description,
    status: Status.TODO,
    parentId: undefined,
    implementationPlan: "",
    /*
     * A fork's head branch is a name in SOMEBODY ELSE'S repository, and it is
     * usually `patch-1` — GitHub names every web-UI edit that. Storing it here
     * put two unrelated contributors' PRs on the same branch name, so the
     * second import matched the first one's card and never got a card at all.
     * Nothing local can check that branch out, so it is not recorded.
     */
    branchName: plan.worktree.attempt ? plan.branchName : undefined,
    externalId: plan.externalId,
    externalUrl: plan.externalUrl,
    prUrl: plan.externalUrl,
    prNumber: Number(pr.number),
    ...(agentId ? { agentId } : {}),
    createdAt: new Date(),
    updatedAt: new Date(),
  } as any);

  /**
   * The worktree, and what happens when it cannot be made.
   *
   * Deliberately NOT the rollback `tasks-from-branch` does. There the item
   * exists only to hold a worktree; here it represents a PR that exists whether
   * or not this machine can reach the remote, and deleting the user's card
   * because a fetch failed would be the tool arguing with them.
   *
   * What must not happen is SILENCE — a card that looks ready and has no
   * worktree is the failure the rollback over there exists to prevent. So the
   * reason is both returned and written onto the card, where it will still be
   * when the response is long gone.
   */
  const noteOnCard = async (text: string) => {
    // The WHOLE body, not just the write. The failure path calls this from
    // inside a catch; a rejection from the READ escaped that catch, hit the
    // async handler and answered 500 — losing both the explanation and the
    // fact that a card had been created.
    try {
      const fresh: any = await storage.getItem(created.id);
      await storage.updateItem(created.id, {
        comments: [...(fresh?.comments ?? []), {
          id: uuidv4(), author: 'agenfk', timestamp: new Date(), content: text,
        }],
      } as any);
    } catch { /* a note is a nicety; failing to leave one must not fail the import */ }
  };

  if (!plan.worktree.attempt) {
    await noteOnCard(plan.worktree.reason);
    io.emit('items_updated');
    return res.status(201).json({ item: await storage.getItem(created.id) ?? created, worktree: null, worktreeSkipped: plan.worktree.reason });
  }

  try {
    if (!project.projectRoot) {
      throw new Error('Project has no projectRoot. Set it before creating a worktree.');
    }
    // The branch is remote, so it has to be here before a worktree can sit on
    // it. `--` and an argv array, because the ref came off an API rather than
    // out of thin air and that is exactly where "it is ours" stops holding.
    execFileSync('git', ['-C', project.projectRoot, 'fetch', 'origin', '--', `${plan.branchName}:refs/remotes/origin/${plan.branchName}`],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    const result = createWorktree({
      repoRoot: project.projectRoot,
      root: defaultWorktreeRoot(),
      branchName: plan.branchName,
      // FROM THE FETCHED REF. Without this the branch is cut from local HEAD:
      // a directory named after the PR, containing none of its commits, which
      // an agent then works in and pushes. Found in review, reproduced against
      // the test's own fixture.
      startPoint: `refs/remotes/origin/${plan.branchName}`,
      // Without this an imported PR whose project HAS a setup command was told
      // to go and set one - naming a value the user had already set.
      setupCommand: project.setupCommand,
    });
    const withWorktree = await storage.updateItem(created.id, { worktreePath: result.path } as any);
    if (!result.setup.ready) await noteOnCard(result.setup.notice);
    io.emit('items_updated');
    res.status(201).json({ item: withWorktree, worktree: result });
  } catch (e: any) {
    const why = `Card created, but the worktree was not: ${e?.message ?? String(e)}. The branch may have been deleted when the PR was merged.`;
    await noteOnCard(why);
    io.emit('items_updated');
    // 201: the card WAS created, which is what the caller asked for. A 4xx here
    // would say nothing happened, and something did.
    res.status(201).json({ item: await storage.getItem(created.id) ?? created, worktree: null, worktreeError: why });
  }
}));

// ── Release Check ─────────────────────────────────────────────────────────────

let releaseCache: { data: any; fetchedAt: number } | null = null;
const RELEASE_CACHE_TTL = 15 * 60 * 1000; // 15 minutes
export const clearReleaseCache = (): void => { releaseCache = null; };

const getCurrentVersion = (): string => {
  try {
    // Try multiple possible locations for package.json
    const paths = [
      path.join(__dirname, '../package.json'),      // Relative to dist/
      path.join(__dirname, '../../package.json'),   // Relative to dist/src/
      path.join(process.cwd(), 'package.json'),     // CWD
      path.join(process.cwd(), 'packages/server/package.json'),
    ];

    for (const p of paths) {
      if (fs.existsSync(p)) {
        const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (pkg.version && pkg.name === '@agenfk/server') {
          return pkg.version;
        }
      }
    }
    
    // Fallback to searching up from __dirname
    let currentDir = __dirname;
    while (currentDir !== path.parse(currentDir).root) {
      const p = path.join(currentDir, 'package.json');
      if (fs.existsSync(p)) {
        const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (pkg.name === '@agenfk/server') return pkg.version;
      }
      currentDir = path.dirname(currentDir);
    }

    return '0.1.29'; // Hardcoded fallback matching current known version if detection fails
  } catch { return '0.1.29'; }
};

const getGitHubRepo = (): string => 'cglab-public/agenfk';

const getGitHubToken = (): string | null => {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execSync('gh auth token 2>/dev/null', { encoding: 'utf8' }).trim() || null;
  } catch { return null; }
};

// In-memory update job store
interface UpdateJob {
  status: 'running' | 'success' | 'error';
  output: string[];
  exitCode?: number;
}
const updateJobs = new Map<string, UpdateJob>();

// Injectable exec for /releases/update so tests can swap out the real shellout.
// Without this, any test that hits POST /releases/update without mocking the
// `child_process` module would actually run `npx -y github:cglab-public/agenfk`
// on the developer's machine, downgrading ~/.agenfk-system/. (Bug 28635f38.)
//
// We resolve the default impl lazily (not at module load) so that other test
// files which partial-mock `child_process` without providing `exec` don't
// trigger vitest's strict missing-export error during server.ts import.
type ReleasesUpdateExecImpl = typeof exec;
let releasesUpdateExecImpl: ReleasesUpdateExecImpl | null = null;
export const setReleasesUpdateExecImpl = (impl: ReleasesUpdateExecImpl): void => {
  releasesUpdateExecImpl = impl;
};
export const resetReleasesUpdateExecImpl = (): void => {
  releasesUpdateExecImpl = null;
};

app.post("/releases/update", asyncHandler(async (req: any, res: any) => {
  // This route shells out (npx) and restarts the server — an RCE trigger. It is
  // only ever invoked by the local UI. Require a custom header: a cross-origin
  // browser request carrying it forces a CORS preflight, which the localhost
  // origin allowlist rejects; a no-preflight "simple" POST won't carry it and is
  // refused here. Together with loopback binding, that closes the CSRF/LAN
  // vector while keeping the in-app Update button working. (Security: bug 968259c4.)
  if (!req.headers['x-agenfk-ui']) {
    return res.status(403).json({ error: "Forbidden" });
  }
  const jobId = uuidv4();
  const job: UpdateJob = { status: 'running', output: [] };
  updateJobs.set(jobId, job);
  res.status(202).json({ jobId });

  const command = 'npx -y github:cglab-public/agenfk';
  const cwd = os.homedir();

  const child = (releasesUpdateExecImpl ?? exec)(command, { cwd, env: { ...process.env, FORCE_COLOR: '0' } });
  child.stdout?.on('data', (d) => job.output.push(d.toString()));
  child.stderr?.on('data', (d) => job.output.push(d.toString()));
  child.on('close', (code) => {
    job.status = code === 0 ? 'success' : 'error';
    job.exitCode = code ?? 1;
    setTimeout(() => updateJobs.delete(jobId), 5 * 60 * 1000);

    /* v8 ignore start */
    if (code === 0) {
      releaseCache = null; // Force fresh version read after update
      // Notify browser then restart server
      io.emit('server_restarting');
      const serverBin = path.join(findProjectRoot(process.cwd()) ?? process.cwd(), 'packages/server/dist/server.js');
      // Spawn a detached shell that waits for current process to exit, then starts new server
      const restarter = spawn('sh', ['-c', `sleep 2 && node ${JSON.stringify(serverBin)}`], {
        detached: true,
        stdio: 'ignore',
      });
      restarter.unref();
      setTimeout(() => process.exit(0), 5000);
    }
    /* v8 ignore stop */
  });
}));

app.get("/releases/update/:jobId", (req: any, res: any) => {
  const job = updateJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ status: job.status, output: job.output.join(''), exitCode: job.exitCode });
});

app.get("/releases/latest", asyncHandler(async (_req: any, res: any) => {
  const currentVersion = getCurrentVersion();

  if (releaseCache && (Date.now() - releaseCache.fetchedAt) < RELEASE_CACHE_TTL) {
    return res.json({ ...releaseCache.data, currentVersion });
  }

  const repo = getGitHubRepo();
  const token = getGitHubToken();
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const { data } = await axios.get(`https://api.github.com/repos/${repo}/releases/latest`, { headers });
    let tagName: string = data.tag_name;
    let meta: any = data;

    // A hub build (`hub-v*`, CGLAB-8) is not a framework release, and this
    // endpoint is what feeds the CLI's upgrade nag AND its tier gate. GitHub's
    // /releases/latest can hand one back: when hub-v1.1.19-beta.1 was created
    // without --prerelease it became GitHub's "latest stable", and every CLI
    // read version "hub-v1.1.19-beta.1" from here. Re-query the list and answer
    // with the newest real framework release.
    if (isHubRelease(tagName)) {
      const { data: list } = await axios.get(
        `https://api.github.com/repos/${repo}/releases?per_page=30`,
        { headers },
      );
      meta = ((Array.isArray(list) ? list : []) as any[])
        .filter((r) => typeof r?.tag_name === 'string' && r.tag_name && !isHubRelease(r.tag_name) && !r.prerelease)
        .sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime())[0];
      tagName = meta?.tag_name ?? '';
      if (!tagName) {
        // Nothing to report. An empty version is what the CLI reads as "no
        // upgrade available"; a hub tag must never reach it, and must never
        // arrive with a tier attached — `mandatory` exits(1) every CLI call.
        return res.json({
          version: '',
          tagName: null,
          name: null,
          body: '',
          publishedAt: null,
          url: null,
          upgradeTier: 'optional',
          currentVersion,
        });
      }
    }

    // Fetch upgradeTier from the raw CLI package.json for this tag
    let upgradeTier: 'mandatory' | 'recommended' | 'optional' = 'optional';
    try {
      const rawUrl = `https://raw.githubusercontent.com/${repo}/${tagName}/packages/cli/package.json`;
      const { data: cliPkg } = await axios.get(rawUrl, { timeout: 5000 });
      if (cliPkg?.agenfkUpgradeTier === 'mandatory' || cliPkg?.agenfkUpgradeTier === 'recommended') {
        upgradeTier = cliPkg.agenfkUpgradeTier;
      }
    } catch {
      // If fetch fails, default to optional — non-fatal
    }

    const releaseData = {
      version: tagName.replace(/^v/, ''),
      tagName,
      name: meta.name,
      body: meta.body || '',
      publishedAt: meta.published_at,
      url: meta.html_url,
      upgradeTier,
    };
    releaseCache = { data: releaseData, fetchedAt: Date.now() };
    res.json({ ...releaseData, currentVersion });
  } catch (err: any) {
    console.error('[RELEASE] Failed to fetch latest release:', err.message);
    res.status(502).json({ error: 'Failed to fetch release info', currentVersion });
  }
}));

// ── Static UI bundle (desktop mode) ──────────────────────────────────────────
// The `agenfk up` flow runs `vite preview` on its own port and this server
// stays a pure JSON/WS API. The Electron shell has no use for a second process,
// so it points AGENFK_SERVE_UI at packages/ui/dist and gets one origin for
// assets, REST and Socket.io — which also means the loopback CORS allowlist
// above never has to learn about app:// or file://.

/**
 * Does this directory look like a *built* bundle rather than a source tree?
 *
 * An index.html alone is not enough evidence, and the gap is dangerous:
 * packages/ui/index.html is Vite's entry template, so the one-token typo
 * `AGENFK_SERVE_UI=packages/ui` (for `packages/ui/dist`) would otherwise pass
 * and hand out src/, package.json and the whole node_modules tree over an
 * unauthenticated loopback port that trusts every localhost origin. A build
 * output never contains node_modules or src, so their presence is a reliable
 * "you pointed me at a source root" signal.
 */
const looksLikeUiBundle = (dir: string): boolean => {
  try {
    if (!fs.existsSync(path.join(dir, 'index.html'))) return false;
    return !['node_modules', 'src'].some(d => fs.existsSync(path.join(dir, d)));
  } catch {
    // Unreadable candidate (permissions, broken symlink) — treat as absent.
    return false;
  }
};

/** AGENFK_SERVE_UI values meaning "find the bundle yourself" rather than a path. */
const PROBE_SENTINELS = new Set(['1', 'true', 'auto', 'yes']);

/**
 * Locate a built UI bundle, or null when there isn't one — a bad path degrades
 * to "API only" rather than booting a server that 404s every asset.
 *
 * An `explicit` path is honoured or rejected, never quietly swapped for
 * another bundle: an operator who mistypes AGENFK_SERVE_UI must not end up
 * silently served a different (possibly stale) build than the one they named.
 * Probing the shipped layout happens only when no path is given, or when the
 * value is a sentinel like "1" — which is what someone who read the variable
 * as a boolean flag will actually set.
 */
export function resolveUiDir(explicit?: string | null): string | null {
  if (explicit && !PROBE_SENTINELS.has(explicit.trim().toLowerCase())) {
    return looksLikeUiBundle(explicit) ? explicit : null;
  }
  // One candidate, not two: in both real layouts — a source checkout and the
  // extracted dist tarball — __dirname is <root>/packages/server/dist, so
  // '../../ui/dist' and '../../../packages/ui/dist' name the same directory.
  const shipped = path.resolve(__dirname, '../../ui/dist');
  return looksLikeUiBundle(shipped) ? shipped : null;
}

/**
 * Paths that belong to the API, never to the SPA. Mirrors the proxy list in
 * packages/ui/vite.config.ts — keep the two in step when adding a namespace.
 * This is the belt; the Accept check below is the braces, so a drifted entry
 * costs a browser a JSON 404 rendered as the app shell, not a broken API.
 *
 * Exported so a test can assert it still covers every registered route.
 */
export const API_PATH_PREFIXES = [
  '/api', '/version', '/db', '/backup', '/projects', '/flows', '/prs',
  '/token-events', '/registry', '/items', '/internal', '/jira', '/github',
  '/releases', '/agent-runs', '/settings', '/terminal-sessions', '/socket.io', '/webauthn', '/webauthn',
];

/**
 * Serve `uiDir` as a static bundle with an SPA fallback. Must be called after
 * every API route is registered: unmatched paths are what reach the fallback,
 * so a route that already answered (including with its own 404) is never
 * shadowed by index.html.
 */
export function mountStaticUI(targetApp: express.Express, uiDir: string): void {
  // Read the shell once. Serving it from memory avoids res.sendFile()'s
  // "Not Found" 500s if the directory is swapped underneath a running server.
  // Done BEFORE anything is mounted: without a shell there is no SPA to serve,
  // and claiming otherwise would leave GET / with the banner suppressed and no
  // page to replace it — a permanent 404 on the app's front door.
  let indexHtml = '';
  try {
    indexHtml = fs.readFileSync(path.join(uiDir, 'index.html'), 'utf8');
  } catch (e) {
    console.warn(`[UI] Failed to read index.html in ${uiDir} — serving API only:`, (e as Error).message);
    return;
  }

  servedUiDir = uiDir;

  targetApp.use(express.static(uiDir, {
    // The shell is served from the snapshot below, on every path including "/".
    // Letting express.static answer "/" off disk too would mean one bundle
    // swap leaves "/" new and every other route old, pointing at deleted
    // hashed assets.
    index: false,
    dotfiles: 'deny',
    setHeaders: (res, filePath) => {
      // Vite content-hashes everything under assets/, so those are safe to
      // pin. Anything else (public/ favicons, manifests) may change in place.
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  }));

  targetApp.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) return next();
    // HEAD too: express.static answers HEAD for real files, so rejecting it
    // here would make HEAD and GET disagree on every SPA path.
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (API_PATH_PREFIXES.some(p => req.path === p || req.path.startsWith(p + '/'))) return next();
    // Only a client that actually wants a page gets one. An API client on an
    // unknown path still gets its 404 instead of a confusing blob of HTML.
    if (!wantsHtml(req)) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(indexHtml);
  });

  console.log(`[UI] Serving UI bundle from ${uiDir}`);
}

/* v8 ignore start */
if (process.env.AGENFK_SERVE_UI) {
  const dir = resolveUiDir(process.env.AGENFK_SERVE_UI);
  if (dir) mountStaticUI(app, dir);
  else console.warn(`[UI] AGENFK_SERVE_UI is set but no index.html was found — serving API only.`);
}
/* v8 ignore stop */

// ── WebSocket ────────────────────────────────────────────────────────────────
/* v8 ignore start */
io.on('connection', (socket) => {
  console.log('Client connected to WebSockets');
  socket.on('disconnect', () => {
    console.log('Client disconnected from WebSockets');
  });
});
/* v8 ignore stop */

// ── Init and Listen ──────────────────────────────────────────────────────────
/* v8 ignore start */

if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  initStorage().then(() => {
    // Periodic backup every 30 minutes
    setInterval(() => {
      performBackup().catch(e => console.error('[BACKUP] Periodic backup failed:', e.message));
    }, 30 * 60 * 1000);

    // Backup on clean shutdown
    const shutdown = async () => {
      console.log('[SHUTDOWN] Writing backup before exit...');
      removeServerPortFile();
      if (hubFlusher) {
        hubFlusher.stop();
        await hubFlusher.flush().catch(e => console.error('[HUB] Shutdown drain failed:', (e as Error).message));
      }
      await performBackup().catch(e => console.error('[BACKUP] Shutdown backup failed:', e.message));
      await telemetry.shutdown();
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    findAvailablePort(REQUESTED_PORT).then((port) => {
      httpServer.listen(port, BIND_HOST, () => {
        boundPort = port;
        writeServerPortFile(port);
        if (port !== REQUESTED_PORT) {
          console.log(`AgEnFK API Server: requested port ${REQUESTED_PORT} was in use, bound to ${port} instead`);
        }
        console.log(`AgEnFK API Server running on ${BIND_HOST}:${port} (with WebSockets)`);
        // Live Agent Runs: tail registered worker sessions → stream run:event.
        startRunTailer(storage, (b) => io.emit('run:event', b));
        telemetry.capture('server_started', {
          version: getCurrentVersion(),
          storageBackend: 'sqlite',
          nodeVersion: process.version,
          requestedPort: REQUESTED_PORT,
          boundPort: port,
        });
      });
    }).catch((err) => {
      console.error(`[SERVER_START] Could not find a free port starting at ${REQUESTED_PORT}:`, err.message);
      process.exit(1);
    });
  });
}

/* v8 ignore stop */

export { initStorage, storage, performBackup };
