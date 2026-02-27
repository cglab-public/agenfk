import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { JSONStorageProvider } from "@agenfk/storage-json";
import { SQLiteStorageProvider } from "@agenfk/storage-sqlite";
import { StorageProvider, ItemType, Status, AgenFKItem, Project, ReviewRecord } from "@agenfk/core";
import { TelemetryClient, getInstallationId, isTelemetryEnabled } from "@agenfk/telemetry";
import { v4 as uuidv4 } from "uuid";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as crypto from "crypto";
import axios from "axios";

// Load the install-time secret token used to authenticate verify_changes transitions.
// Generated at install time and stored in ~/.agenfk/verify-token — not in the codebase.
const VERIFY_TOKEN = (() => {
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
const PORT = process.env.AGENFK_PORT || process.env.PORT || 3000;

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
  const dbType = dbPath.endsWith('.sqlite') ? 'sqlite' : 'json';
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

  const children = await storage.listItems({ parentId: id });
  for (const child of children) {
    await trashRecursively(child.id);
  }

  return true;
};

const syncParentStatus = async (parentId: string) => {
  const parent = await storage.getItem(parentId);
  if (!parent) return;

  const children = await storage.listItems({ parentId });
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

const autoGitCommit = (item: AgenFKItem, projectRoot: string): void => {
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
      dbPath = path.join(root, ".agenfk", "db.json");
    }
  }

  // Select provider by file extension
  storage = dbPath.endsWith('.sqlite')
    ? new SQLiteStorageProvider()
    : new JSONStorageProvider();

  console.log(`[SERVER_START] Using Database: ${dbPath} (${dbPath.endsWith('.sqlite') ? 'SQLite' : 'JSON'})`);
  await storage.init({ path: dbPath });

  // Apply pending migration (written by `agenfk db switch` or install restore)
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

  // For JSON: watch for external direct edits and broadcast to UI.
  // For SQLite: all writes go through the REST API which already emits
  // 'items_updated' after every mutation. WAL mode makes fs.watch() on the
  // main .sqlite file unreliable, so we skip it.
  if (!dbPath.endsWith('.sqlite')) {
    fs.watch(dbPath, (event) => {
      if (event === 'change') {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] [DISK_CHANGE] Database file ${dbPath} modified. Broadcasting refresh to UI...`);
        io.emit('items_updated');
      }
    });
  }
};

// ── Error handler wrapper ────────────────────────────────────────────────────

const asyncHandler = (fn: any) => (req: any, res: any, next: any) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// ── Routes ───────────────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.json({
    message: "AgenFK Framework API is running",
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
  const dbType = dbPath.endsWith('.sqlite') ? 'sqlite' : 'json';
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
    telemetry.capture('project_created', { storageBackend: dbPath.endsWith('.sqlite') ? 'sqlite' : 'json' });
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

  const newItem: AgenFKItem = {
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
  telemetry.capture('item_created', { itemType: created.type });

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
    if (!isInternalVerify && status === Status.REVIEW) continue;

    if (status === Status.ARCHIVED && currentItem.status !== Status.ARCHIVED) {
      await archiveRecursively(id);
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

      if (updated.parentId && updated.status !== Status.ARCHIVED) {
        parentIdsToSync.add(updated.parentId);
      }

      if (updated.status === Status.DONE && currentItem.status !== Status.DONE) {
        if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
          const projectRoot = findProjectRoot(process.cwd());
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
  const { title, description, status, parentId, tokenUsage, context, implementationPlan, reviews, tests, comments, sortOrder } = req.body;

  const currentItem = await storage.getItem(req.params.id);
  if (!currentItem) {
    return res.status(404).json({ error: "Item not found" });
  }

  const isInternalVerify = req.headers['x-agenfk-internal'] === VERIFY_TOKEN;
  if (!isInternalVerify && status === Status.DONE) {
    return res.status(403).json({
      error: "WORKFLOW VIOLATION: Cannot set status to DONE directly. Use verify_changes via MCP to validate work before completion."
    });
  }
  if (!isInternalVerify && status === Status.REVIEW) {
    return res.status(403).json({
      error: "WORKFLOW VIOLATION: Cannot set status to REVIEW directly. The REVIEW state is managed automatically by verify_changes via MCP."
    });
  }

  if (status === Status.ARCHIVED && currentItem.status !== Status.ARCHIVED) {
    await archiveRecursively(req.params.id);
    io.emit('items_updated');
    return res.json(await storage.getItem(req.params.id));
  }

  if (status !== undefined && status !== Status.ARCHIVED && currentItem.status === Status.ARCHIVED) {
    await unarchiveRecursively(req.params.id);
    await storage.updateItem(req.params.id, { status: status as Status });
    io.emit('items_updated');
    return res.json(await storage.getItem(req.params.id));
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
  if (tests !== undefined) updates.tests = tests;
  if (comments !== undefined) updates.comments = comments;
  if (sortOrder !== undefined) updates.sortOrder = sortOrder;

  try {
    const updated = await storage.updateItem(req.params.id, updates);
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [API_UPDATE] Item ${updated.id} status: ${updated.status}. Broadcasting refresh...`);
    io.emit('items_updated');
    io.emit('project_switched', { projectId: updated.projectId });

    if (updated.parentId && updated.status !== Status.ARCHIVED) {
      await syncParentStatus(updated.parentId);
    }

    if (status !== undefined && status !== currentItem.status) {
      telemetry.capture('item_status_changed', {
        fromStatus: currentItem.status,
        toStatus: status,
        itemType: updated.type,
      });
    }

    if (updated.status === Status.DONE && currentItem.status !== Status.DONE) {
      if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
        const projectRoot = findProjectRoot(process.cwd());
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

// ── Verify Endpoint ──────────────────────────────────────────────────────────

app.post("/items/:id/verify", asyncHandler(async (req: any, res: any) => {
  const isInternalVerify = req.headers['x-agenfk-internal'] === VERIFY_TOKEN;
  if (!isInternalVerify) {
    return res.status(403).json({ error: "Forbidden: verify endpoint requires internal token." });
  }

  const { command } = req.body;
  if (!command || typeof command !== 'string') {
    return res.status(400).json({ error: "Missing required field: command" });
  }

  const item = await storage.getItem(req.params.id);
  if (!item) {
    return res.status(404).json({ error: "Item not found" });
  }

  const isTestPhase = item.status === Status.TEST;
  const projectRoot = findProjectRoot(process.cwd());

  const { output, code } = await new Promise<{ output: string; code: number | null }>((resolve) => {
    const child = spawn(command, { shell: true, cwd: projectRoot, env: { ...process.env, FORCE_COLOR: '1' } });
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { out += d.toString(); });
    child.on('close', (c) => resolve({ output: out, code: c }));
    child.on('error', (err) => resolve({ output: err.message, code: 1 }));
  });

  const truncated = output.substring(0, 2000) + (output.length > 2000 ? '\n... (truncated)' : '');
  const verifyLabel = isTestPhase ? 'Final Verification' : 'Initial Verification';
  const passed = code === 0;

  const comments = [...(item.comments || []), {
    id: uuidv4(),
    author: 'VerifyTool',
    content: `### ${verifyLabel} ${passed ? 'PASSED' : 'FAILED'}\n\n**Command**: \`${command}\`\n\n**Output**:\n\`\`\`\n${truncated}\n\`\`\``,
    timestamp: new Date(),
  }];

  if (passed) {
    const targetStatus = isTestPhase ? Status.DONE : Status.REVIEW;
    const updates: any = { status: targetStatus, comments };
    if (isTestPhase) {
      updates.tests = [...(item.tests || []), {
        id: uuidv4(), command, output: truncated, status: 'PASSED', executedAt: new Date(),
      }];
    }
    const updated = await storage.updateItem(req.params.id, updates);
    io.emit('items_updated');
    if (updated.parentId) await syncParentStatus(updated.parentId);
    if (process.env.NODE_ENV !== 'test' && !process.env.VITEST && isTestPhase) {
      autoGitCommit(updated, projectRoot);
    }
    const message = isTestPhase
      ? `✅ Final Verification Successful!\n\nCommand: \`${command}\`\nItem moved to DONE.`
      : `✅ Initial Verification Successful!\n\nCommand: \`${command}\`\nItem moved to REVIEW column.\n\nREMINDER: A Review Agent will now be spawned to audit your changes before testing begins.`;
    return res.json({ status: targetStatus, message, output: truncated });
  } else {
    const updates: any = { status: Status.IN_PROGRESS, comments };
    if (isTestPhase) {
      updates.tests = [...(item.tests || []), {
        id: uuidv4(), command, output: truncated, status: 'FAILED', executedAt: new Date(),
      }];
    }
    await storage.updateItem(req.params.id, updates);
    io.emit('items_updated');
    const message = `❌ Verification Failed!\n\nCommand: \`${command}\`\nRoot: \`${projectRoot}\`\n\nOutput:\n${truncated}`;
    return res.status(422).json({ status: Status.IN_PROGRESS, message, output: truncated });
  }
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

const saveJiraToken = (data: JiraTokenData): void => {
  const dir = path.dirname(JIRA_TOKEN_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(JIRA_TOKEN_PATH, JSON.stringify(data, null, 2));
};

const deleteJiraToken = (): void => {
  if (fs.existsSync(JIRA_TOKEN_PATH)) fs.unlinkSync(JIRA_TOKEN_PATH);
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

export const mapJiraTypeToAgenFK = (issueTypeName: string): string => {
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

app.get("/jira/status", (req: any, res: any) => {
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
  res.json({ configured, connected: true, cloudId: tokenData.cloudId, email: tokenData.email });
});

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
      jqlParts.push(`summary ~ "${summary}*"`);
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
      mappedType: mapJiraTypeToAgenFK(issue.fields.issuetype?.name || 'Task'),
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
      const type = requestedType || mapJiraTypeToAgenFK(issue.fields.issuetype?.name || 'Task');
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

// ── Release Check ─────────────────────────────────────────────────────────────

let releaseCache: { data: any; fetchedAt: number } | null = null;
const RELEASE_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

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

const getGitHubRepo = (): string => 'cglab-PRIVATE/agenfk';

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

app.post("/releases/update", asyncHandler(async (_req: any, res: any) => {
  const jobId = uuidv4();
  const job: UpdateJob = { status: 'running', output: [] };
  updateJobs.set(jobId, job);
  res.status(202).json({ jobId });

  const command = 'npx -y github:cglab-PRIVATE/agenfk';
  const cwd = os.homedir();

  const child = exec(command, { cwd, env: { ...process.env, FORCE_COLOR: '0' } });
  child.stdout?.on('data', (d) => job.output.push(d.toString()));
  child.stderr?.on('data', (d) => job.output.push(d.toString()));
  child.on('close', (code) => {
    job.status = code === 0 ? 'success' : 'error';
    job.exitCode = code ?? 1;
    setTimeout(() => updateJobs.delete(jobId), 5 * 60 * 1000);

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
      setTimeout(() => process.exit(0), 500);
    }
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
    const releaseData = {
      version: data.tag_name.replace(/^v/, ''),
      tagName: data.tag_name,
      name: data.name,
      body: data.body || '',
      publishedAt: data.published_at,
      url: data.html_url,
    };
    releaseCache = { data: releaseData, fetchedAt: Date.now() };
    res.json({ ...releaseData, currentVersion });
  } catch (err: any) {
    console.error('[RELEASE] Failed to fetch latest release:', err.message);
    res.status(502).json({ error: 'Failed to fetch release info', currentVersion });
  }
}));

// ── WebSocket ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log('Client connected to WebSockets');
  socket.on('disconnect', () => {
    console.log('Client disconnected from WebSockets');
  });
});

// ── Opencode Token Scraper ────────────────────────────────────────────────────

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

const isAgenFKDir = (dir: string): boolean => {
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
    if (!isAgenFKDir(session.directory)) continue;

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

// ── Init and Listen ──────────────────────────────────────────────────────────

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
      await performBackup().catch(e => console.error('[BACKUP] Shutdown backup failed:', e.message));
      await telemetry.shutdown();
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    httpServer.listen(PORT, () => {
      console.log(`AgenFK API Server running on port ${PORT} (with WebSockets)`);
      telemetry.capture('server_started', {
        version: getCurrentVersion(),
        storageBackend: dbPath.endsWith('.sqlite') ? 'sqlite' : 'json',
        nodeVersion: process.version,
      });
    });
  });
}

export { initStorage, storage, performBackup };
