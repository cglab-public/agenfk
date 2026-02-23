import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { JSONStorageProvider } from "@agenfk/storage-json";
import { SQLiteStorageProvider } from "@agenfk/storage-sqlite";
import { StorageProvider, ItemType, Status, AgenFKItem, Project, ReviewRecord } from "@agenfk/core";
import { v4 as uuidv4 } from "uuid";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as crypto from "crypto";

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
import { exec } from "child_process";
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
const PORT = 3000;

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

const syncParentStatus = async (parentId: string) => {
  const parent = await storage.getItem(parentId);
  if (!parent) return;

  const children = await storage.listItems({ parentId });
  if (children.length === 0) return;

  const allDone = children.every(c => c.status === Status.DONE);
  const anyInProgress = children.some(c => c.status === Status.IN_PROGRESS || c.status === Status.TEST || c.status === Status.REVIEW);
  const anyDone = children.some(c => c.status === Status.DONE);

  let newStatus: Status | null = null;

  if (allDone) {
    if (parent.status !== Status.DONE) newStatus = Status.DONE;
  } else if (anyInProgress || anyDone) {
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
      ui: "http://localhost:5173"
    }
  });
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

  const project: Project = {
    id: uuidv4(),
    name,
    description: description || "",
    createdAt: new Date(),
    updatedAt: new Date()
  };

  const created = await storage.createProject(project);
  io.emit('items_updated');
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
    items = items.filter(i => i.status !== Status.ARCHIVED);
  }

  res.json(items);
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

  if (created.parentId) {
    await syncParentStatus(created.parentId);
  }

  res.status(201).json(created);
}));

app.put("/items/:id", asyncHandler(async (req: any, res: any) => {
  console.log(`[API_DEBUG] PUT /items/${req.params.id} body keys: ${Object.keys(req.body).join(', ')}`);
  const { title, description, status, parentId, tokenUsage, context, implementationPlan, reviews, comments } = req.body;

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
  if (comments !== undefined) updates.comments = comments;

  try {
    const updated = await storage.updateItem(req.params.id, updates);
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [API_UPDATE] Item ${updated.id} status: ${updated.status}. Broadcasting refresh...`);
    io.emit('items_updated');
    io.emit('project_switched', { projectId: updated.projectId });

    if (updated.parentId && updated.status !== Status.ARCHIVED) {
      await syncParentStatus(updated.parentId);
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
  const success = await storage.deleteItem(req.params.id);
  if (success) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [API_DELETE] Item deleted: ${req.params.id}. Broadcasting refresh...`);
    io.emit('items_updated');

    if (itemToDelete?.parentId) {
      await syncParentStatus(itemToDelete.parentId);
    }

    res.status(204).send();
  } else {
    res.status(404).json({ error: "Item not found" });
  }
}));

// ── WebSocket ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log('Client connected to WebSockets');
  socket.on('disconnect', () => {
    console.log('Client disconnected from WebSockets');
  });
});

// ── Init and Listen ──────────────────────────────────────────────────────────

if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  initStorage().then(() => {
    // Periodic backup every 30 minutes
    setInterval(() => {
      performBackup().catch(e => console.error('[BACKUP] Periodic backup failed:', e.message));
    }, 30 * 60 * 1000);

    // Backup on clean shutdown
    const shutdown = async () => {
      console.log('[SHUTDOWN] Writing backup before exit...');
      await performBackup().catch(e => console.error('[BACKUP] Shutdown backup failed:', e.message));
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    httpServer.listen(PORT, () => {
      console.log(`AgenFK API Server running on port ${PORT} (with WebSockets)`);
    });
  });
}

export { initStorage, storage, performBackup };
