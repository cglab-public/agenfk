import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { SQLiteStorageProvider } from "@agenfk/storage-sqlite";
import { StorageProvider, ItemType, Status, AgEnFKItem, Project, ReviewRecord, migrateCardsToFlow, Flow, DEFAULT_FLOW, getActiveFlow } from "@agenfk/core";
import { TelemetryClient, getInstallationId, isTelemetryEnabled, findAvailablePort, writeServerPortFile, removeServerPortFile, DEFAULT_API_PORT } from "@agenfk/telemetry";
import { HubClient, Flusher, loadHubConfig } from "./hub/index.js";
import type { RecordEventInput } from "./hub/index.js";
import { startFlowSync, type FlowSyncHandle } from "./hub/flowSync.js";
import { startUpgradeSync, replayPendingUpgradeOutcome, type UpgradeSyncHandle } from "./hub/upgradeSync.js";
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
import { exec, execSync, execFileSync, spawn } from "child_process";
import { createServer } from "http";
import { Server } from "socket.io";

export const app = express();
export const httpServer = createServer(app);
export const io = new Server(httpServer, {
  cors: {
    origin: "*",
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

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
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
let upgradeSyncHandle: UpgradeSyncHandle | null = null;

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
  if (!hubClient.isEnabled) return;
  const payload: any = input.payload ?? {};
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

  hubClient.recordEvent({ ...input, itemType, remoteUrl, itemTitle, externalId } as RecordEventInput);
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
    const { execSync } = await import('child_process');
    try {
      const out = execSync('git remote get-url origin', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      projectRemoteCache.set(projectId, out || '');
    } catch {
      projectRemoteCache.set(projectId, '');
    }
  } catch {
    projectRemoteCache.set(projectId, '');
  }
}

// ── Validation log persistence ───────────────────────────────────────────────
// Full command output from validate_progress is written to
// <dbDir>/logs/<itemId>/<testId>.log. The HTTP response, comment, and tests[]
// record carry only a head+tail truncated preview plus the log file path, so
// MCP payloads stay small while full logs remain available on disk.
const MAX_LOGS_PER_ITEM = 3;
const PREVIEW_HEAD_BYTES = 1024;
const PREVIEW_TAIL_BYTES = 1024;

const getItemLogDir = (itemId: string): string =>
  path.join(path.dirname(dbPath), 'logs', itemId);

const writeValidationLog = (itemId: string, testId: string, output: string): string => {
  const dir = getItemLogDir(itemId);
  fs.mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, `${testId}.log`);
  fs.writeFileSync(logPath, output);
  // Prune to newest MAX_LOGS_PER_ITEM by mtime.
  const entries = fs.readdirSync(dir)
    .map(name => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const old of entries.slice(MAX_LOGS_PER_ITEM)) {
    try { fs.unlinkSync(path.join(dir, old.name)); } catch { /* ignore */ }
  }
  return logPath;
};

const buildOutputPreview = (output: string, logPath: string): string => {
  const headTailBudget = PREVIEW_HEAD_BYTES + PREVIEW_TAIL_BYTES;
  let body: string;
  if (output.length <= headTailBudget) {
    body = output;
  } else {
    const head = output.substring(0, PREVIEW_HEAD_BYTES);
    const tail = output.substring(output.length - PREVIEW_TAIL_BYTES);
    const omitted = output.length - headTailBudget;
    body = `${head}\n... (${omitted} bytes truncated) ...\n${tail}`;
  }
  return `${body}\n[Full log: ${logPath}]`;
};

const purgeItemLogs = (itemId: string): void => {
  const dir = getItemLogDir(itemId);
  if (fs.existsSync(dir)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
};

// ── Backup ───────────────────────────────────────────────────────────────────

const BACKUP_DIR = path.join(os.homedir(), '.agenfk', 'backup');
const MAX_BACKUPS = 10;

const performBackup = async (): Promise<string> => {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const [projects, items] = await Promise.all([
    storage.listProjects(),
    storage.listItems({ limit: 1_000_000 }),  // all items including archived
  ]);

  const timestamp = new Date().toISOString().replace(/:/g, '-');
  const dbType = 'sqlite';
  const backupFile = path.join(BACKUP_DIR, `agenfk-backup-${timestamp}.json`);

  fs.writeFileSync(backupFile, JSON.stringify({ version: '1', backupDate: new Date().toISOString(), dbType, projects, items }, null, 2));

  // Rotate — keep only the MAX_BACKUPS most recent files
  const existing = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('agenfk-backup-') && f.endsWith('.json'))
    .sort();
  for (const old of existing.slice(0, Math.max(0, existing.length - MAX_BACKUPS))) {
    fs.unlinkSync(path.join(BACKUP_DIR, old));
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

const syncParentStatus = async (parentId: string) => {
  const parent = await storage.getItem(parentId);
  if (!parent) return;

  const allChildren = await storage.listItems({ parentId });
  const children = allChildren.filter(c => c.status !== Status.TRASHED && c.status !== Status.ARCHIVED);
  if (children.length === 0) return;

  const allDone = children.every(c => c.status === Status.DONE);
  const allTestOrFurther = children.every(c => c.status === Status.TEST || c.status === Status.DONE);
  const allReviewOrFurther = children.every(c => c.status === Status.REVIEW || c.status === Status.TEST || c.status === Status.DONE);
  const anyInProgress = children.some(c => c.status === Status.IN_PROGRESS || c.status === Status.TEST || c.status === Status.REVIEW || c.status === Status.DONE);

  let newStatus: Status | null = null;

  if (allDone) {
    if (parent.status !== Status.DONE) newStatus = Status.DONE;
  } else if (allTestOrFurther) {
    if (parent.status !== Status.TEST) newStatus = Status.TEST;
  } else if (allReviewOrFurther) {
    if (parent.status !== Status.REVIEW) newStatus = Status.REVIEW;
  } else if (anyInProgress) {
    if (parent.status !== Status.IN_PROGRESS) newStatus = Status.IN_PROGRESS;
  }

  if (newStatus) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [AUTO_SYNC] Updating parent ${parent.id} (${parent.title}) to ${newStatus}`);
    await storage.updateItem(parent.id, { status: newStatus });
    io.emit('items_updated');

    if (parent.parentId) {
      await syncParentStatus(parent.parentId);
    }
  }
};

const findProjectRoot = (startDir: string): string => {
  let currentDir = startDir;
  while (currentDir !== path.parse(currentDir).root) {
    if (fs.existsSync(path.join(currentDir, ".agenfk"))) {
      return currentDir;
    }
    currentDir = path.dirname(currentDir);
  }
  return startDir;
};

const autoGitCommit = (item: AgEnFKItem, projectRoot: string): void => {
  const message = `close(${item.type.toLowerCase()}): ${item.title} [${item.id}]`;
  const cmd = `git add -A && git commit -m ${JSON.stringify(message)}`;
  exec(cmd, { cwd: projectRoot }, (err, stdout) => {
    const timestamp = new Date().toISOString();
    if (err) {
      console.log(`[${timestamp}] [AUTO_GIT] Commit skipped: ${err.message.trim()}`);
    } else {
      console.log(`[${timestamp}] [AUTO_GIT] Committed: "${message}"\n${stdout.trim()}`);
    }
  });
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
      const root = findProjectRoot(process.cwd());
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
  hubClient.attachStorage(storage as SQLiteStorageProvider);
  if (hubClient.isEnabled && hubClient.hubConfig) {
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
      emit: (event, payload) => io.emit(event, payload),
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
      spawnImpl: (cmd, args) => {
        const r = spawnSync(cmd, args, { encoding: 'utf8' });
        return { exitCode: r.status, stdout: r.stdout ?? '' };
      },
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
 * Build the set of statuses reachable from `fromStatus` given the active Flow.
 * Rules:
 *  - PLATFORM_STATUSES (BLOCKED, PAUSED, ARCHIVED, TRASHED, IDEAS) are always reachable
 *    from any status, and any flow step is reachable from them (bidirectional).
 *  - Flow steps define the main progression: each step can move to the adjacent step.
 *  - TODO (order 0, anchor) → first non-anchor step is always allowed.
 *  - Last non-anchor step → DONE (highest order, anchor) is always allowed.
 */
function buildAllowedTransitions(fromStatus: string, flow: { steps: Array<{ name: string; order: number; isSpecial?: boolean; isAnchor?: boolean }> }): Set<string> {
  const allowed = new Set<string>();

  // Platform statuses are always reachable from any step
  for (const s of PLATFORM_STATUSES) {
    allowed.add(s);
  }

  // If coming from a platform status, allow transitioning to any flow step
  if (PLATFORM_STATUSES.has(fromStatus as Status)) {
    for (const step of flow.steps) {
      allowed.add(step.name);
    }
    return allowed;
  }

  // Sort flow steps by order
  const sorted = [...flow.steps].sort((a, b) => a.order - b.order);
  const currentIdx = sorted.findIndex(s => s.name === fromStatus);

  if (currentIdx === -1) {
    // Unknown status in this flow: allow all steps
    for (const step of sorted) allowed.add(step.name);
    return allowed;
  }

  // Allow forward and backward one step
  if (currentIdx > 0) allowed.add(sorted[currentIdx - 1].name);
  if (currentIdx < sorted.length - 1) allowed.add(sorted[currentIdx + 1].name);
  // Also allow staying in the same status (idempotent updates)
  allowed.add(fromStatus);

  return allowed;
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
  return sorted.find(s => !s.isAnchor);
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

app.get("/", (req, res) => {
  res.json({
    message: "AgEnFK Framework API is running",
    endpoints: {
      projects: "/projects",
      items: "/items",
      ui: `http://localhost:${process.env.VITE_PORT || 5173}`
    }
  });
});

app.get("/api/readme", asyncHandler(async (_req: any, res: any) => {
  const root = findProjectRoot(process.cwd());
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

// DB status & backup endpoints

app.get("/db/status", asyncHandler(async (_req: any, res: any) => {
  const dbType = 'sqlite';
  let backupCount = 0;
  let latestBackup: string | null = null;
  if (fs.existsSync(BACKUP_DIR)) {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('agenfk-backup-') && f.endsWith('.json'))
      .sort();
    backupCount = files.length;
    latestBackup = files.length > 0 ? files[files.length - 1] : null;
  }
  res.json({ dbType, dbPath, backupDir: BACKUP_DIR, backupCount, latestBackup });
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

app.get("/projects/:id", asyncHandler(async (req: any, res: any) => {
  const project = await storage.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: "Project not found" });
  res.json(project);
}));

app.put("/projects/:id", asyncHandler(async (req: any, res: any) => {
  try {
    const updated = await storage.updateProject(req.params.id, req.body);
    io.emit('items_updated');
    res.json(updated);
  } catch (error) {
    res.status(404).json({ error: "Project not found" });
  }
}));

app.delete("/projects/:id", asyncHandler(async (req: any, res: any) => {
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
    for (const plan of migrationPlan) {
      if (plan.oldStatus !== plan.newStatus) {
        await storage.updateItem(plan.itemId, { status: plan.newStatus as Status });
      }
    }
  }

  io.emit('flow:updated', { projectId: req.params.id, flowId: flowId || null });
  io.emit('items_updated');
  res.json(updated);
}));

app.get("/projects/:id/flow", asyncHandler(async (req: any, res: any) => {
  const project = await storage.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: "Project not found" });

  if (!(project as any).flowId) {
    return res.json(DEFAULT_FLOW);
  }

  const flows = await storage.listFlows();
  const activeFlow = getActiveFlow((project as any).flowId, flows);
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

const HUB_MANAGED_FLOW_MSG = "Flow is managed by your organization's Hub and cannot be modified locally";

app.post("/flows", asyncHandler(async (req: any, res: any) => {
  const { name, description, version, steps } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });

  // Always force `source = 'local'` on REST-driven creation. The reconciler
  // writes hub-managed rows directly via storage.createFlow(); this route is
  // for user/admin-driven local flow authoring only.
  const flow: Flow = {
    id: uuidv4(),
    name,
    description: description || "",
    version: version || "1.0.0",
    steps: steps || [],
    createdAt: new Date(),
    updatedAt: new Date(),
    source: 'local',
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

app.put("/flows/:id", asyncHandler(async (req: any, res: any) => {
  const existing = await storage.getFlow(req.params.id);
  if (!existing) return res.status(404).json({ error: "Flow not found" });
  if (existing.source === 'hub') {
    return res.status(409).json({ error: HUB_MANAGED_FLOW_MSG });
  }
  try {
    const { name, description, version, steps } = req.body;
    const updates: Partial<Flow> = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (version !== undefined) updates.version = version;
    if (steps !== undefined) updates.steps = steps;

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

app.post("/registry/flows/install", asyncHandler(async (req: any, res: any) => {
  const { filename } = req.body;
  if (!filename) return res.status(400).json({ error: 'filename is required' });

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

    // Build steps: strip anchor steps from the registry JSON and add fresh standard anchors.
    const rawSteps: any[] = Array.isArray(flowData.steps) ? flowData.steps : [];
    const middle = rawSteps
      .filter((s: any) => !s.isAnchor && s.name?.toUpperCase() !== 'TODO' && s.name?.toUpperCase() !== 'DONE')
      .map((s: any, i: number) => ({
        id: uuidv4(),
        name: s.name ?? `step-${i}`,
        label: s.label ?? s.name ?? `Step ${i + 1}`,
        order: i + 1,
        exitCriteria: s.exitCriteria ?? '',
        isSpecial: s.isSpecial ?? false,
      }));
    const steps = [
      { id: uuidv4(), name: 'TODO', label: 'To Do', order: 0, exitCriteria: '', isAnchor: true },
      ...middle,
      { id: uuidv4(), name: 'DONE', label: 'Done', order: middle.length + 1, exitCriteria: '', isAnchor: true },
    ];

    // Create flow in local storage (no projectId — registry flows are global)
    const newFlow = await storage.createFlow({
      id: uuidv4(),
      name: flowData.name ?? filename.replace('.json', ''),
      description: flowData.description,
      steps,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    res.json(newFlow);
  } catch (e: any) {
    const status = e?.response?.status ?? 502;
    res.status(status).json({ error: 'Failed to install flow', detail: e?.message });
  }
}));

app.post("/registry/flows/publish", asyncHandler(async (req: any, res: any) => {
  const { flowId, registry } = req.body;
  if (!flowId) return res.status(400).json({ error: 'flowId is required' });

  const flow = await storage.getFlow(flowId);
  if (!flow) return res.status(404).json({ error: 'Flow not found' });

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

  const slug = flow.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const filename = `${slug}.json`;

  const isOwner = ghUser === registryOwner;

  // Non-owners publish via a fork; owners push directly
  if (!isOwner) {
    execSync(`gh repo fork ${registryOwner}/${registryRepo} --clone=false`, { stdio: 'pipe' });
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-registry-'));
  try {
    // Shallow-clone the upstream to check for name clashes
    execSync(`git clone --depth 1 --quiet https://oauth2:${ghToken}@github.com/${registryOwner}/${registryRepo}.git ${tmpDir}`, { stdio: 'pipe' });

    // Non-owners switch the push remote to their fork
    if (!isOwner) {
      execSync(`git -C ${tmpDir} remote set-url origin https://oauth2:${ghToken}@github.com/${ghUser}/${registryRepo}.git`, { stdio: 'pipe' });
    }

    const flowsDir = path.join(tmpDir, 'flows');
    if (!fs.existsSync(flowsDir)) fs.mkdirSync(flowsDir, { recursive: true });

    const targetPath = path.join(flowsDir, filename);
    const fileExists = fs.existsSync(targetPath);

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
        steps: flow.steps
          .sort((a: any, b: any) => a.order - b.order)
          .map((s: any) => ({
            name: s.name,
            label: s.label,
            exitCriteria: s.exitCriteria,
            isSpecial: s.isSpecial,
            isAnchor: s.isAnchor,
            order: s.order,
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
        execSync(`git -C ${tmpDir} checkout -b ${branchName}`, { stdio: 'pipe' });
      }

      fs.writeFileSync(targetPath, content + '\n');
      execSync(`git -C ${tmpDir} add flows/${filename}`, { stdio: 'pipe' });
      execSync(`git -C ${tmpDir} commit -m "${commitMsg}"`, { stdio: 'pipe' });

      if (isOwner) {
        execSync(`git -C ${tmpDir} push origin main`, { stdio: 'pipe' });
        const fileUrl = `https://github.com/${registryOwner}/${registryRepo}/blob/main/flows/${filename}`;
        return res.json({ url: fileUrl, kind: 'direct', version });
      } else {
        execSync(`git -C ${tmpDir} push origin ${branchName}`, { stdio: 'pipe' });
        const prBody = [`Published from AgEnFK Flow Editor.`, '', `**Flow**: ${flow.name}`, flow.description ? `**Description**: ${flow.description}` : ''].filter(Boolean).join('\n');
        const prUrl = execSync(
          `gh pr create --repo ${registryOwner}/${registryRepo} --head ${ghUser}:${branchName} --base main --title "${commitMsg}" --body "${prBody.replace(/"/g, '\\"')}"`,
          { stdio: 'pipe' }
        ).toString().trim();
        return res.json({ url: prUrl, kind: 'pr', version });
      }
    }

    return res.json({
      url: `https://github.com/${registryOwner}/${registryRepo}/blob/main/flows/${filename}`,
      kind: 'existing',
      note: 'Already published — no changes detected.',
      version,
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
  const { type, status, parentId, includeArchived, projectId } = req.query;
  const query: any = {};
  if (type) query.type = type;
  if (status) query.status = status;
  if (parentId) query.parentId = parentId;
  if (projectId) query.projectId = projectId;

  let items = await storage.listItems(query);

  if (includeArchived !== 'true' && !status) {
    items = items.filter(i => i.status !== Status.ARCHIVED && i.status !== Status.TRASHED);
  }

  res.json(items);
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
  res.json(item);
}));

app.post("/items", asyncHandler(async (req: any, res: any) => {
  console.log(`[API_DEBUG] POST /items body keys: ${Object.keys(req.body).join(', ')}`);
  const { type, title, description, parentId, status, implementationPlan, projectId } = req.body;

  if (!type || !title) {
    return res.status(400).json({ error: "Type and Title are required" });
  }

  if (!projectId) {
    return res.status(400).json({ error: "ProjectId is required" });
  }

  const newItem: AgEnFKItem = {
    id: uuidv4(),
    projectId,
    type: type as ItemType,
    title,
    description: description || "",
    status: (status as Status) || Status.TODO,
    parentId: parentId,
    implementationPlan: implementationPlan || "",
    createdAt: new Date(),
    updatedAt: new Date(),
  } as any;

  if (newItem.type === ItemType.BUG) {
    (newItem as any).severity = "LOW";
  }

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

  res.status(201).json(created);
}));

app.post("/items/bulk", asyncHandler(async (req: any, res: any) => {
  console.log(`[API_DEBUG] POST /items/bulk processing ${req.body?.items?.length} items`);
  const { items } = req.body;
  if (!Array.isArray(items)) {
    return res.status(400).json({ error: "Expected items array" });
  }

  const isInternalVerify = req.headers['x-agenfk-internal'] === VERIFY_TOKEN;
  const results = [];
  const parentIdsToSync = new Set<string>();
  const projectIds = new Set<string>();

  for (const { id, updates: bodyUpdates } of items) {
    const currentItem = await storage.getItem(id);
    if (!currentItem) continue;

    const { title, description, status, parentId, tokenUsage, context, implementationPlan, reviews, comments, sortOrder } = bodyUpdates;

    if (!isInternalVerify && status === Status.DONE) continue;

    if (status === Status.ARCHIVED && currentItem.status !== Status.ARCHIVED) {
      await archiveRecursively(id);
      if (currentItem.parentId) parentIdsToSync.add(currentItem.parentId);
      continue;
    }

    if (status !== undefined && status !== Status.ARCHIVED && currentItem.status === Status.ARCHIVED) {
      await unarchiveRecursively(id);
      await storage.updateItem(id, { status: status as Status });
      continue;
    }

    const updates: any = {};
    if (title !== undefined) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (status !== undefined) updates.status = status;
    if (parentId !== undefined) updates.parentId = parentId;
    if (tokenUsage !== undefined) updates.tokenUsage = tokenUsage;
    if (context !== undefined) updates.context = context;
    if (implementationPlan !== undefined) updates.implementationPlan = implementationPlan;
    if (reviews !== undefined) updates.reviews = reviews;
    if (comments !== undefined) updates.comments = comments;
    if (sortOrder !== undefined) updates.sortOrder = sortOrder;

    try {
      const updated = await storage.updateItem(id, updates);
      results.push(updated);
      projectIds.add(updated.projectId);

      if (updated.parentId) {
        parentIdsToSync.add(updated.parentId);
      }

      if (tokenUsage !== undefined) {
        recordHubEvent({
          type: 'tokens.logged',
          projectId: updated.projectId,
          itemId: updated.id,
          payload: { tokenUsage },
        });
      }
      if (updated.status === Status.DONE && currentItem.status !== Status.DONE) {
        if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
          const proj = await storage.getProject(updated.projectId);
          const projectRoot = (proj as any)?.projectRoot || findProjectRoot(process.cwd());
          autoGitCommit(updated, projectRoot);
        }
      }
    } catch (e) {
      console.error(`[API_BULK] Error updating ${id}:`, e);
    }
  }

  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [API_BULK] Processed ${results.length} items. Broadcasting refresh...`);
  io.emit('items_updated');
  projectIds.forEach(projectId => io.emit('project_switched', { projectId }));

  for (const parentId of parentIdsToSync) {
    await syncParentStatus(parentId);
  }

  res.json({ results });
}));

app.put("/items/:id", asyncHandler(async (req: any, res: any) => {
  console.log(`[API_DEBUG] PUT /items/${req.params.id} body keys: ${Object.keys(req.body).join(', ')}`);
  const { title, description, status, type, parentId, tokenUsage, context, implementationPlan, reviews, tests, comments, sortOrder, branchName, prUrl, prNumber, prStatus } = req.body;

  const currentItem = await storage.getItem(req.params.id);
  if (!currentItem) {
    return res.status(404).json({ error: "Item not found" });
  }

  const isInternalVerify = req.headers['x-agenfk-internal'] === VERIFY_TOKEN;
  if (!isInternalVerify && status === Status.DONE) {
    return res.status(403).json({
      error: "WORKFLOW VIOLATION: Cannot set status to DONE directly. Move the item to TEST, then call test_changes(itemId) to run the project's test suite."
    });
  }

  // Flow-aware transition validation (only active when a custom flow is assigned)
  if (status !== undefined && status !== currentItem.status && !isInternalVerify) {
    const project = await storage.getProject(currentItem.projectId);
    const projectFlowId = (project as any)?.flowId as string | undefined;
    // Only enforce flow transitions when a custom (non-default) flow is set
    if (projectFlowId) {
      const projectFlows = await storage.listFlows();
      const activeFlow = getActiveFlow(projectFlowId, projectFlows);
      const allowed = buildAllowedTransitions(currentItem.status, activeFlow);
      if (!allowed.has(status)) {
        return res.status(400).json({
          error: `FLOW VIOLATION: Cannot transition from '${currentItem.status}' to '${status}' in the active flow '${activeFlow.name}'. Allowed targets: ${[...allowed].join(', ')}.`
        });
      }
    }
  }

  if (status === Status.ARCHIVED && currentItem.status !== Status.ARCHIVED) {
    await archiveRecursively(req.params.id);
    io.emit('items_updated');
    if (currentItem.parentId) await syncParentStatus(currentItem.parentId);
    return res.json(await storage.getItem(req.params.id));
  }

  if (status !== undefined && status !== Status.ARCHIVED && currentItem.status === Status.ARCHIVED) {
    await unarchiveRecursively(req.params.id);
    await storage.updateItem(req.params.id, { status: status as Status });
    io.emit('items_updated');
    return res.json(await storage.getItem(req.params.id));
  }

  // Validate type change
  if (type !== undefined) {
    const validTypes = Object.values(ItemType);
    if (!validTypes.includes(type)) {
      return res.status(400).json({ error: `Invalid type '${type}'. Must be one of: ${validTypes.join(', ')}` });
    }
    // Prevent type change on items with children
    const children = await storage.listChildren(req.params.id);
    if (children.length > 0 && type !== currentItem.type) {
      return res.status(400).json({ error: `Cannot change type of item with children. Remove or reassign children first.` });
    }
  }

  const updates: any = {};
  if (title !== undefined) updates.title = title;
  if (description !== undefined) updates.description = description;
  if (status !== undefined) updates.status = status;
  if (type !== undefined) updates.type = type;
  if (parentId !== undefined) updates.parentId = parentId;
  if (tokenUsage !== undefined) updates.tokenUsage = tokenUsage;
  if (context !== undefined) updates.context = context;
  if (implementationPlan !== undefined) updates.implementationPlan = implementationPlan;
  if (reviews !== undefined) updates.reviews = reviews;
  if (tests !== undefined) updates.tests = tests;
  if (comments !== undefined) updates.comments = comments;
  if (sortOrder !== undefined) updates.sortOrder = sortOrder;
  if (branchName !== undefined) updates.branchName = branchName;
  if (prUrl !== undefined) updates.prUrl = prUrl;
  if (prNumber !== undefined) updates.prNumber = prNumber;
  if (prStatus !== undefined) updates.prStatus = prStatus;

  try {
    const updated = await storage.updateItem(req.params.id, updates);
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [API_UPDATE] Item ${updated.id} status: ${updated.status}. Broadcasting refresh...`);
    io.emit('items_updated');
    io.emit('project_switched', { projectId: updated.projectId });

    if (updated.parentId) {
      await syncParentStatus(updated.parentId);
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
    if (tokenUsage !== undefined) {
      recordHubEvent({
        type: 'tokens.logged',
        projectId: updated.projectId,
        itemId: updated.id,
        payload: { tokenUsage },
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

    if (updated.status === Status.DONE && currentItem.status !== Status.DONE) {
      recordHubEvent({
        type: 'item.closed',
        projectId: updated.projectId,
        itemId: updated.id,
        payload: { fromStatus: currentItem.status, toStatus: Status.DONE, itemType: updated.type },
      });
      if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
        const proj = await storage.getProject(updated.projectId);
        const projectRoot = (proj as any)?.projectRoot || findProjectRoot(process.cwd());
        autoGitCommit(updated, projectRoot);
      } else {
        console.log(`[TEST_MODE] Skipping auto-git commit for item ${updated.id}`);
      }
    }

    res.json(updated);
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

// ── validate_progress: unified exit-criteria gate (flow-aware) ───────────────
// command is optional; if omitted, project.verifyCommand is used.
// Advances item to the next flow step. On failure, moves back to the coding step.
async function handleValidateProgress(itemId: string, command: string | undefined, res: any, evidence?: string) {
  const item = await storage.getItem(itemId);
  if (!item) return res.status(404).json({ error: "Item not found" });

  recordHubEvent({
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
  const projectFlows = await storage.listFlows();
  const activeFlow = getActiveFlow((project as any)?.flowId, projectFlows);
  const sorted = sortedFlowSteps(activeFlow);
  const codingStep = getCodingStep(sorted);
  const currentFlowStep = findCurrentFlowStep(sorted, item.status);

  if (!currentFlowStep) {
    return res.status(400).json({ error: `validate_progress requires item to be in a flow step. Current status '${item.status}' is not part of the active flow '${activeFlow.name}'.` });
  }
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
    await storage.updateItem(itemId, { status: codingStep.name as Status, comments: [...(item.comments || []), comment] });
    io.emit('items_updated');
    const codingStepCriteria = (codingStep as any).exitCriteria as string | undefined;
    const mandatoryNote = codingStepCriteria ? `\n\n⚠️ MANDATORY EXIT CRITERIA — you MUST satisfy ALL of the following before calling validate_progress again:\n\n${codingStepCriteria}` : '';
    return res.json({ status: codingStep.name, message: `✅ Validation Passed!\n\nItem moved to ${codingStep.name}.${mandatoryNote}` });
  }

  const nextStep = sorted[currentFlowStep.index + 1];
  const nextStatus = (nextStep?.name ?? Status.DONE) as Status;
  const failureStatus = (codingStep?.name ?? Status.IN_PROGRESS) as Status;
  // Exit criteria of the step the item is moving INTO — returned as mandatory agent instructions
  const nextStepCriteria = (nextStep as any)?.exitCriteria as string | undefined;
  const mandatoryInstructions = (nextStatus !== Status.DONE && nextStepCriteria)
    ? `\n\n⚠️ MANDATORY EXIT CRITERIA — you MUST satisfy ALL of the following before calling validate_progress again:\n\n${nextStepCriteria}`
    : '';
  const branchRef = (item as any).branchName || 'HEAD';
  const pushInstruction = nextStatus === Status.DONE
    ? `\n\n🚀 **Push your branch**: The server has auto-committed the changes. Run:\n\`\`\`\ngit push -u origin ${branchRef}\n\`\`\``
    : '';

  // A command is only required for the final step (→ DONE). For intermediate
  // steps the command is optional — omitting it advances without running anything.
  const isFinalStep = nextStatus === Status.DONE;
  const resolvedCommand = command || ((isFinalStep ? (project as any)?.verifyCommand : undefined));
  if (isFinalStep && !resolvedCommand) {
    return res.status(400).json({
      error: "NO_VERIFY_COMMAND",
      message: "No command provided and no verifyCommand configured for this project. Provide a command or set one with update_project({ id, verifyCommand })."
    });
  }
  const exitCriteria = (currentFlowStep.step as any).exitCriteria as string | undefined;

  // ── Sibling propagation ───────────────────────────────────────────────────
  if (item.parentId) {
    const siblings = await storage.listItems({ parentId: item.parentId });
    // For final step (→ DONE), check siblings already DONE with same verifyCommand
    if (nextStatus === Status.DONE) {
      const passedSibling = siblings.find(s =>
        s.id !== item.id &&
        s.status === Status.DONE &&
        s.tests?.some((t: any) => t.status === 'PASSED' && t.command === resolvedCommand)
      );
      if (passedSibling) {
        const sibComment = { id: uuidv4(), author: 'ValidateTool', content: `### Validation PASSED (sibling propagation)\n\nSkipped — already verified by sibling \`${passedSibling.id.slice(0, 8)}\` (${passedSibling.title}).`, timestamp: new Date() };
        const updates: any = { status: Status.DONE, comments: [...(item.comments || []), sibComment], tests: [...(item.tests || []), { id: uuidv4(), command: resolvedCommand, output: `Sibling propagation: verified by ${passedSibling.id}`, status: 'PASSED', executedAt: new Date() }] };
        const updated = await storage.updateItem(itemId, updates);
        io.emit('items_updated');
        if (updated.parentId) await syncParentStatus(updated.parentId);
        if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) autoGitCommit(updated, (project as any)?.projectRoot || findProjectRoot(process.cwd()));
        return res.json({ status: Status.DONE, message: `✅ Validation Passed (sibling propagation)!\n\nItem moved to DONE.${pushInstruction}`, output: 'Sibling propagation' });
      }
    } else {
      const passedSibling = siblings.find(s => {
        if (s.id === item.id) return false;
        if (s.status === Status.DONE) return true;
        const sibStep = findCurrentFlowStep(sorted, s.status);
        return sibStep !== undefined && sibStep.index > currentFlowStep.index;
      });
      if (passedSibling) {
        const sibComment = { id: uuidv4(), author: 'ValidateTool', content: `### Validation PASSED (sibling propagation)\n\nSkipped — already verified by sibling \`${passedSibling.id.slice(0, 8)}\` (${passedSibling.title}).`, timestamp: new Date() };
        const updated = await storage.updateItem(itemId, { status: nextStatus, comments: [...(item.comments || []), sibComment] });
        io.emit('items_updated');
        if (updated.parentId) await syncParentStatus(updated.parentId);
        return res.json({ status: nextStatus, message: `✅ Validation Passed (sibling propagation)!\n\nItem moved to ${nextStatus}.${mandatoryInstructions}`, output: 'Sibling propagation' });
      }
    }
  }

  // No command on an intermediate step — advance directly without running anything.
  if (!resolvedCommand) {
    const exitNote = exitCriteria ? `\n**Exit criteria acknowledged**: ${exitCriteria}` : '';
    const comment = { id: uuidv4(), author: 'ValidateTool', content: `### Validation PASSED\n\n**Step**: ${item.status} → ${nextStatus}${exitNote}`, timestamp: new Date() };
    const updated = await storage.updateItem(itemId, { status: nextStatus, comments: [...(item.comments || []), comment] });
    io.emit('items_updated');
    if (updated.parentId) await syncParentStatus(updated.parentId);
    return res.json({ status: nextStatus, message: `✅ Validation Passed!\n\nItem moved to ${nextStatus}.${mandatoryInstructions}` });
  }

  const projectRoot = (project as any)?.projectRoot || findProjectRoot(process.cwd());
  const { output, code } = await new Promise<{ output: string; code: number | null }>((resolve) => {
    const child = spawn(resolvedCommand, { shell: true, cwd: projectRoot, env: { ...process.env, FORCE_COLOR: '1' } });
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { out += d.toString(); });
    child.on('close', (c) => resolve({ output: out, code: c }));
    child.on('error', (err) => resolve({ output: err.message, code: 1 }));
  });

  const testId = uuidv4();
  const logPath = writeValidationLog(itemId, testId, output);
  const preview = buildOutputPreview(output, logPath);
  const passed = code === 0;
  const exitNote = exitCriteria ? `\n**Exit criteria**: ${exitCriteria}` : '';

  const comments = [...(item.comments || []), {
    id: uuidv4(),
    author: 'ValidateTool',
    content: `### Validation ${passed ? 'PASSED' : 'FAILED'}\n\n**Step**: ${item.status} → ${passed ? nextStatus : failureStatus}${exitNote}\n**Command**: \`${resolvedCommand}\`\n\n**Output**:\n\`\`\`\n${preview}\n\`\`\``,
    timestamp: new Date(),
  }];

  if (passed) {
    const updates: any = { status: nextStatus, comments };
    if (nextStatus === Status.DONE) {
      updates.tests = [...(item.tests || []), { id: testId, command: resolvedCommand, output: preview, status: 'PASSED', executedAt: new Date() }];
    }
    const updated = await storage.updateItem(itemId, updates);
    io.emit('items_updated');
    if (updated.parentId) await syncParentStatus(updated.parentId);
    if (nextStatus === Status.DONE && process.env.NODE_ENV !== 'test' && !process.env.VITEST) autoGitCommit(updated, projectRoot);
    recordHubEvent({
      type: 'validate.passed',
      projectId: item.projectId,
      itemId,
      payload: { fromStatus: item.status, toStatus: nextStatus, command: resolvedCommand },
    });
    if (nextStatus !== item.status) {
      recordHubEvent({
        type: 'step.transitioned',
        projectId: item.projectId,
        itemId,
        payload: { fromStatus: item.status, toStatus: nextStatus, itemType: item.type },
      });
      if (nextStatus === Status.DONE && item.status !== Status.DONE) {
        recordHubEvent({
          type: 'item.closed',
          projectId: item.projectId,
          itemId,
          payload: { fromStatus: item.status, toStatus: Status.DONE, itemType: item.type },
        });
      }
    }
    recordHubEvent({
      type: 'test.logged',
      projectId: item.projectId,
      itemId,
      payload: { command: resolvedCommand, status: 'PASSED', testId },
    });
    return res.json({ status: nextStatus, message: `✅ Validation Passed!\n\nCommand: \`${resolvedCommand}\`\nItem moved to ${nextStatus}.${mandatoryInstructions}${pushInstruction}`, output: preview });
  } else {
    const updates: any = { status: failureStatus, comments };
    if (nextStatus === Status.DONE) {
      updates.tests = [...(item.tests || []), { id: testId, command: resolvedCommand, output: preview, status: 'FAILED', executedAt: new Date() }];
    }
    await storage.updateItem(itemId, updates);
    io.emit('items_updated');
    recordHubEvent({
      type: 'validate.failed',
      projectId: item.projectId,
      itemId,
      payload: { fromStatus: item.status, fellBackTo: failureStatus, command: resolvedCommand },
    });
    recordHubEvent({
      type: 'test.logged',
      projectId: item.projectId,
      itemId,
      payload: { command: resolvedCommand, status: 'FAILED', testId },
    });
    return res.status(422).json({ status: failureStatus, message: `❌ Validation Failed!\n\nCommand: \`${resolvedCommand}\`\nRoot: \`${projectRoot}\`\n\nOutput:\n${preview}`, output: preview });
  }
}

app.post("/items/:id/validate", asyncHandler(async (req: any, res: any) => {
  if (req.headers['x-agenfk-internal'] !== VERIFY_TOKEN) {
    return res.status(403).json({ error: "Forbidden: validate endpoint requires internal token." });
  }
  const cwd: string | undefined = typeof req.body.cwd === 'string' && req.body.cwd ? req.body.cwd : undefined;
  if (cwd) {
    const item = await storage.getItem(req.params.id);
    if (item) await storage.updateProject(item.projectId, { projectRoot: cwd });
  }
  return handleValidateProgress(req.params.id, req.body.command || undefined, res, req.body.evidence || undefined);
}));

// ── review_changes: DEPRECATED — delegates to validate_progress ──────────────
app.post("/items/:id/review", asyncHandler(async (req: any, res: any) => {
  if (req.headers['x-agenfk-internal'] !== VERIFY_TOKEN) {
    return res.status(403).json({ error: "Forbidden: review endpoint requires internal token." });
  }
  if (!req.body.command || typeof req.body.command !== 'string') {
    return res.status(400).json({ error: "Missing required field: command" });
  }
  return handleValidateProgress(req.params.id, req.body.command, res);
}));

// ── test_changes: DEPRECATED — delegates to validate_progress (no command = uses verifyCommand)
app.post("/items/:id/test", asyncHandler(async (req: any, res: any) => {
  if (req.headers['x-agenfk-internal'] !== VERIFY_TOKEN) {
    return res.status(403).json({ error: "Forbidden: test endpoint requires internal token." });
  }
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

app.get('/internal/hub/status', asyncHandler(async (req: any, res: any) => {
  if (req.headers['x-agenfk-internal'] !== VERIFY_TOKEN) {
    return res.status(403).json({ error: 'Forbidden: hub status requires internal token.' });
  }
  if (!hubFlusher) {
    return res.json({ enabled: false });
  }
  res.json(hubFlusher.getStatus());
}));

// ── Pause / Resume ───────────────────────────────────────────────────────────

app.post("/items/:id/pause", asyncHandler(async (req: any, res: any) => {
  const item = await storage.getItem(req.params.id);
  if (!item) return res.status(404).json({ error: "Item not found" });

  const pausable = [Status.IN_PROGRESS, Status.REVIEW, Status.TEST];
  if (!pausable.includes(item.status)) {
    return res.status(400).json({ error: `Cannot pause item in ${item.status} status. Must be IN_PROGRESS, REVIEW, or TEST.` });
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

  await storage.updateItem(req.params.id, { status: Status.PAUSED, comments });
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

  // Restore item to its pre-pause status
  const comments = [...(item.comments || []), {
    id: uuidv4(),
    author: 'ResumeTool',
    content: `### Work Resumed\n\n**Restored status**: ${snapshot.status}`,
    timestamp: new Date(),
  }];

  await storage.updateItem(req.params.id, { status: snapshot.status, comments });

  // Mark snapshot as resumed
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

const JIRA_TOKEN_PATH = path.join(os.homedir(), '.agenfk', 'jira-token.json');

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

// In-memory PKCE state store: state → { codeVerifier, expiresAt }
export const pkceStore = new Map<string, { codeVerifier: string; expiresAt: number }>();

const base64url = (buf: Buffer): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

const generatePKCE = (): { codeVerifier: string; codeChallenge: string; state: string } => {
  const codeVerifier = base64url(crypto.randomBytes(32));
  const codeChallenge = base64url(
    Buffer.from(crypto.createHash('sha256').update(codeVerifier).digest())
  );
  const state = base64url(crypto.randomBytes(16));
  return { codeVerifier, codeChallenge, state };
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
    if (!fs.existsSync(JIRA_TOKEN_PATH)) return null;
    return JSON.parse(fs.readFileSync(JIRA_TOKEN_PATH, 'utf8'));
  } catch { return null; }
};

// Cached token validation to avoid repeated Atlassian API calls
export let jiraValidationCache: { valid: boolean; checkedAt: number } | null = null;
const JIRA_VALIDATION_TTL = 60_000; // 60 seconds

const saveJiraToken = (data: JiraTokenData): void => {
  const dir = path.dirname(JIRA_TOKEN_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(JIRA_TOKEN_PATH, JSON.stringify(data, null, 2));
  jiraValidationCache = null;
};

const deleteJiraToken = (): void => {
  if (fs.existsSync(JIRA_TOKEN_PATH)) fs.unlinkSync(JIRA_TOKEN_PATH);
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
      });
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

const jiraApiRequest = async (
  tokenData: JiraTokenData,
  method: string,
  url: string,
  body?: any
): Promise<{ data: any; tokenData: JiraTokenData }> => {
  const makeRequest = (token: string) =>
    axios({ method, url, data: body, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });

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

app.get("/jira/oauth/authorize", (req: any, res: any) => {
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
  const { codeVerifier, codeChallenge, state } = generatePKCE();
  pkceStore.set(state, { codeVerifier, expiresAt: Date.now() + 10 * 60 * 1000 });
  const params = new URLSearchParams({
    audience: 'api.atlassian.com',
    client_id: jiraConfig.clientId,
    scope: 'read:jira-user read:jira-work offline_access',
    redirect_uri: redirectUri,
    state,
    response_type: 'code',
    prompt: 'consent',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  res.redirect(`https://auth.atlassian.com/authorize?${params}`);
});

app.get("/jira/oauth/callback", asyncHandler(async (req: any, res: any) => {
  const { code, state, error } = req.query;
  const uiBase = process.env.JIRA_UI_URL || 'http://localhost:5173';

  if (error) {
    return res.redirect(`${uiBase}?jira=error&reason=${encodeURIComponent(String(error))}`);
  }
  if (!code || !state) {
    return res.redirect(`${uiBase}?jira=error&reason=missing_params`);
  }

  const pkceEntry = pkceStore.get(String(state));
  if (!pkceEntry || Date.now() > pkceEntry.expiresAt) {
    pkceStore.delete(String(state));
    return res.redirect(`${uiBase}?jira=error&reason=invalid_state`);
  }
  pkceStore.delete(String(state));

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
      code_verifier: pkceEntry.codeVerifier,
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
  const jiraConfig = loadJiraConfig();
  const configured = !!(jiraConfig.clientId && jiraConfig.clientSecret);
  const tokenData = loadJiraToken();
  if (!tokenData) {
    return res.json({
      configured,
      connected: false,
      ...(configured ? {} : { message: "Run 'agenfk jira setup' to configure JIRA integration." }),
    });
  }
  // Validate token against Atlassian (cached, ~60s TTL)
  if (configured) {
    const valid = await validateJiraToken(tokenData);
    if (!valid) {
      return res.json({ configured, connected: false, reason: 'token_expired' });
    }
  }
  res.json({ configured, connected: true, cloudId: tokenData.cloudId, email: tokenData.email });
}));

app.get("/jira/projects", asyncHandler(async (req: any, res: any) => {
  const tokenData = loadJiraToken();
  if (!tokenData) return res.status(401).json({ error: "Not connected to JIRA" });

  try {
    const { data } = await jiraApiRequest(
      tokenData,
      'get',
      `https://api.atlassian.com/ex/jira/${tokenData.cloudId}/rest/api/3/project/search?maxResults=50`
    );
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
  const tokenData = loadJiraToken();
  if (!tokenData) return res.status(401).json({ error: "Not connected to JIRA" });

  const { key } = req.params;
  const { summary, statusCategory } = req.query;
  
  try {
    let jqlParts = [`project = "${key}"`];
    
    if (summary && summary !== 'undefined') {
      jqlParts.push(`(summary ~ "${summary}*" OR issueKey = "${summary}")`);
    }
    
    if (statusCategory && statusCategory !== 'undefined') {
      // Map UI category names to JQL statusCategory names or IDs
      const mapping: Record<string, string> = {
        'To Do': '"To Do"',
        'In Progress': '"In Progress"',
        'Done': '"Done"'
      };
      const categories = String(statusCategory).split(',').map((s: string) => mapping[s.trim()] || `"${s.trim()}"`).join(',');
      jqlParts.push(`statusCategory in (${categories})`);
    }
    
    const jql = encodeURIComponent(jqlParts.join(' AND ') + ' ORDER BY created DESC');
    const fields = 'summary,issuetype,status,priority';
    const apiUrl = `https://api.atlassian.com/ex/jira/${tokenData.cloudId}/rest/api/3/search/jql?jql=${jql}&maxResults=50&fields=${fields}`;
    
    console.log(`[JIRA] Requesting: ${apiUrl}`);
    
    const { data } = await jiraApiRequest(
      tokenData,
      'get',
      apiUrl
    );
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
  const tokenData = loadJiraToken();
  if (!tokenData) return res.status(401).json({ error: "Not connected to JIRA" });

  const { projectId, items } = req.body;
  if (!projectId || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "projectId and items[] are required" });
  }

  const imported: any[] = [];
  const errors: any[] = [];

  for (const { issueKey, type: requestedType } of items) {
    try {
      const { data: issue } = await jiraApiRequest(
        tokenData,
        'get',
        `https://api.atlassian.com/ex/jira/${tokenData.cloudId}/rest/api/3/issue/${issueKey}?fields=summary,description,issuetype`
      );
      const type = requestedType || mapJiraTypeToAgEnFK(issue.fields.issuetype?.name || 'Task');
      const description = adfToText(issue.fields.description);
      const externalUrl = `${tokenData.cloudUrl}/browse/${issueKey}`;

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
          const searchBase = `https://api.atlassian.com/ex/jira/${tokenData.cloudId}/rest/api/3/search/jql`;
          const childFields = 'summary,description,issuetype';

          // Try next-gen (team-managed) projects first: parent = KEY
          let childIssues: any[] = [];
          const jqlNextGen = encodeURIComponent(`parent = ${issueKey} ORDER BY created ASC`);
          console.log(`[JIRA] Fetching children of Epic ${issueKey} with JQL: parent = ${issueKey}`);
          const { data: nextGenData } = await jiraApiRequest(tokenData, 'get', `${searchBase}?jql=${jqlNextGen}&maxResults=100&fields=${childFields}`);
          childIssues = nextGenData.issues || [];
          console.log(`[JIRA] next-gen child query returned ${childIssues.length} issues`);

          // Fallback for classic (company-managed) projects: "Epic Link" = KEY
          if (childIssues.length === 0) {
            const jqlClassic = encodeURIComponent(`"Epic Link" = ${issueKey} ORDER BY created ASC`);
            console.log(`[JIRA] Trying classic Epic Link fallback for ${issueKey}`);
            const { data: classicData } = await jiraApiRequest(tokenData, 'get', `${searchBase}?jql=${jqlClassic}&maxResults=100&fields=${childFields}`);
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
              externalUrl: `${tokenData.cloudUrl}/browse/${childKey}`,
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

app.post("/jira/disconnect", (req: any, res: any) => {
  deleteJiraToken();
  res.json({ disconnected: true });
});

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

    const args = [`-R ${config.owner}/${config.repo}`];
    args.push(`--state ${state || 'open'}`);
    args.push('--limit 100');
    if (search) args.push(`--search "${(search as string).replace(/"/g, '\\"')}"`);
    args.push('--json number,title,state,labels,url,createdAt');

    const result = execSync(`gh issue list ${args.join(' ')}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
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
        const result = execSync(
          `gh issue view ${issueNumber} -R ${config.owner}/${config.repo} --json number,title,body,state,url`,
          { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
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

app.post("/releases/update", asyncHandler(async (_req: any, res: any) => {
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
      const serverBin = path.join(findProjectRoot(process.cwd()), 'packages/server/dist/server.js');
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
    const tagName: string = data.tag_name;

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
      name: data.name,
      body: data.body || '',
      publishedAt: data.published_at,
      url: data.html_url,
      upgradeTier,
    };
    releaseCache = { data: releaseData, fetchedAt: Date.now() };
    res.json({ ...releaseData, currentVersion });
  } catch (err: any) {
    console.error('[RELEASE] Failed to fetch latest release:', err.message);
    res.status(502).json({ error: 'Failed to fetch release info', currentVersion });
  }
}));

// ── WebSocket ────────────────────────────────────────────────────────────────
/* v8 ignore start */
io.on('connection', (socket) => {
  console.log('Client connected to WebSockets');
  socket.on('disconnect', () => {
    console.log('Client disconnected from WebSockets');
  });
});
/* v8 ignore stop */

// ── Opencode Token Scraper ────────────────────────────────────────────────────
/* v8 ignore start */

const OPENCODE_DB = path.join(os.homedir(), '.local/share/opencode/opencode.db');
const OPENCODE_SCRAPE_INTERVAL = 5 * 60 * 1000; // 5 minutes

const PRICING: Record<string, { input: number; output: number; cacheRead: number }> = {
  'claude-opus-4-6':            { input: 15.0,  output: 75.0,  cacheRead: 1.5  },
  'claude-sonnet-4-6':          { input: 3.0,   output: 15.0,  cacheRead: 0.3  },
  'claude-sonnet-4-5-20250929': { input: 3.0,   output: 15.0,  cacheRead: 0.3  },
  'claude-haiku-4-5-20251001':  { input: 0.8,   output: 4.0,   cacheRead: 0.08 },
  'gemini-3-flash-preview':     { input: 0.15,  output: 0.60,  cacheRead: 0.02 },
  'gemini-3-pro-preview':       { input: 1.25,  output: 5.0,   cacheRead: 0.31 },
  'gemini-3.1-pro-preview':     { input: 1.25,  output: 5.0,   cacheRead: 0.31 },
};
const DEFAULT_RATES = PRICING['claude-sonnet-4-6'];

const calcTokenCost = (model: string, input: number, output: number, cacheRead: number): number => {
  const rates = PRICING[model] || DEFAULT_RATES;
  return Math.round((input / 1e6 * rates.input + cacheRead / 1e6 * rates.cacheRead + output / 1e6 * rates.output) * 1e6) / 1e6;
};

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const sqlite3Query = (db: string, query: string): any[] => {
  try {
    const result = execFileSync('sqlite3', ['-json', db, query], { encoding: 'utf8', timeout: 5000 });
    return JSON.parse(result || '[]');
  } catch { return []; }
};

const isAgEnFKDir = (dir: string): boolean => {
  if (!dir) return false;
  let d = path.isAbsolute(dir) ? dir : path.resolve(dir);
  const root = path.parse(d).root;
  while (d !== root) {
    if (fs.existsSync(path.join(d, '.agenfk', 'project.json'))) return true;
    d = path.dirname(d);
  }
  return false;
};

const scrapeOpencodeSessions = async () => {
  if (!fs.existsSync(OPENCODE_DB)) return;

  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const sessions = sqlite3Query(OPENCODE_DB, `SELECT id, directory FROM session WHERE time_created > ${cutoff}`);

  for (const session of sessions) {
    if (!isAgEnFKDir(session.directory)) continue;

    // Build task switch timeline from tool call parts, ordered by time
    const allParts = sqlite3Query(OPENCODE_DB, `
      SELECT json_extract(data, '$.tool') as tool,
             json_extract(data, '$.state.input') as input_data,
             json_extract(data, '$.state.output') as output_data,
             time_created
      FROM part WHERE session_id = '${session.id}'
        AND json_extract(data, '$.tool') IN ('agenfk_update_item', 'agenfk_workflow_gatekeeper')
      ORDER BY time_created ASC
    `);

    const taskSwitches: { time: number; taskId: string }[] = [];
    for (const part of allParts) {
      let taskId: string | null = null;
      if (part.tool === 'agenfk_update_item') {
        try {
          const inp = JSON.parse(part.input_data || '{}');
          if (inp.id && inp.status === 'IN_PROGRESS') taskId = inp.id;
        } catch { /* skip */ }
      }
      if (part.tool === 'agenfk_workflow_gatekeeper') {
        try {
          const inp = JSON.parse(part.input_data || '{}');
          if (inp.itemId) taskId = inp.itemId;
        } catch { /* skip */ }
        if (!taskId) {
          const matches = (part.output_data || '').match(UUID_RE);
          if (matches && matches.length > 0) taskId = matches[0];
        }
      }
      if (taskId) taskSwitches.push({ time: part.time_created, taskId });
    }

    if (taskSwitches.length === 0) continue;

    // Get all assistant messages ordered by time
    const messages = sqlite3Query(OPENCODE_DB, `
      SELECT json_extract(data, '$.modelID') as model,
             json_extract(data, '$.tokens.input') as inp,
             json_extract(data, '$.tokens.output') as outp,
             json_extract(data, '$.tokens.cache.read') as cr,
             json_extract(data, '$.cost') as cost,
             time_created
      FROM message WHERE session_id = '${session.id}'
        AND json_extract(data, '$.role') = 'assistant'
      ORDER BY time_created ASC
    `);

    // Attribute each message to the most recent task switch before it
    const perTask: Record<string, Record<string, { input: number; output: number; cacheRead: number; cost: number }>> = {};
    for (const m of messages) {
      let activeTask: string | null = null;
      for (const sw of taskSwitches) {
        if (sw.time <= m.time_created) activeTask = sw.taskId;
        else break;
      }
      if (!activeTask) activeTask = taskSwitches[0].taskId;

      const model = m.model || 'unknown';
      if (!perTask[activeTask]) perTask[activeTask] = {};
      if (!perTask[activeTask][model]) perTask[activeTask][model] = { input: 0, output: 0, cacheRead: 0, cost: 0 };
      perTask[activeTask][model].input += m.inp || 0;
      perTask[activeTask][model].output += m.outp || 0;
      perTask[activeTask][model].cacheRead += m.cr || 0;
      perTask[activeTask][model].cost += m.cost || 0;
    }

    if (Object.keys(perTask).length === 0) continue;

    const now = new Date().toISOString();

    for (const [taskId, tokensByModel] of Object.entries(perTask)) {
      try {
        const item = await storage.getItem(taskId);
        if (!item) continue;

        const existing = item.tokenUsage || [];
        let added = 0;

        for (const [model, tokens] of Object.entries(tokensByModel)) {
          const isDup = existing.some((u: any) => u.sessionId === session.id && u.source === 'opencode' && u.model === model);
          if (isDup) continue;

          const cost = tokens.cost > 0
            ? Math.round(tokens.cost * 1e6) / 1e6
            : calcTokenCost(model, tokens.input, tokens.output, tokens.cacheRead);

          existing.push({
            input: tokens.input + tokens.cacheRead,
            output: tokens.output,
            model,
            cost,
            sessionId: session.id,
            source: 'opencode',
            timestamp: now,
          });
          added++;
        }

        if (added > 0) {
          await storage.updateItem(taskId, { tokenUsage: existing });
          console.log(`[OPENCODE_SCRAPER] Logged ${added} record(s) for task ${taskId} from session ${session.id}`);
          io.emit('items_updated');
        }
      } catch { /* skip unreachable items */ }
    }
  }
};

/* v8 ignore stop */

// ── Init and Listen ──────────────────────────────────────────────────────────
/* v8 ignore start */

if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  initStorage().then(() => {
    // Periodic backup every 30 minutes
    setInterval(() => {
      performBackup().catch(e => console.error('[BACKUP] Periodic backup failed:', e.message));
    }, 30 * 60 * 1000);

    // Periodic Opencode token scraping every 5 minutes
    scrapeOpencodeSessions().catch(e => console.error('[OPENCODE_SCRAPER] Initial scrape failed:', e.message));
    setInterval(() => {
      scrapeOpencodeSessions().catch(e => console.error('[OPENCODE_SCRAPER] Periodic scrape failed:', e.message));
    }, OPENCODE_SCRAPE_INTERVAL);

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
      httpServer.listen(port, () => {
        writeServerPortFile(port);
        if (port !== REQUESTED_PORT) {
          console.log(`AgEnFK API Server: requested port ${REQUESTED_PORT} was in use, bound to ${port} instead`);
        }
        console.log(`AgEnFK API Server running on port ${port} (with WebSockets)`);
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
