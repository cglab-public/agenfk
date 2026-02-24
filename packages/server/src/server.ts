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

const deleteRecursively = async (id: string): Promise<boolean> => {
  const item = await storage.getItem(id);
  if (!item) return false;

  console.log(`[AUTO_DELETE] Deleting ${item.id} (${item.title}) and its children`);
  
  const children = await storage.listItems({ parentId: id });
  for (const child of children) {
    await deleteRecursively(child.id);
  }

  return await storage.deleteItem(id);
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
  const { title, description, status, parentId, tokenUsage, context, implementationPlan, reviews, comments, sortOrder } = req.body;

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

  const success = await deleteRecursively(req.params.id);
  if (success) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [API_DELETE] Item deleted: ${req.params.id}. Broadcasting refresh...`);
    io.emit('items_updated');

    if (itemToDelete.parentId) {
      await syncParentStatus(itemToDelete.parentId);
    }

    res.status(204).send();
  } else {
    res.status(500).json({ error: "Failed to delete item" });
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
    
    if (summary) {
      jqlParts.push(`summary ~ "${summary}*"`);
    }
    
    if (statusCategory) {
      const categories = statusCategory.split(',').map((s: string) => `"${s.trim()}"`).join(',');
      jqlParts.push(`statusCategory in (${categories})`);
    }
    
    const jql = encodeURIComponent(jqlParts.join(' AND ') + ' ORDER BY created DESC');
    const fields = 'summary,issuetype,status,priority';
    
    const { data } = await jiraApiRequest(
      tokenData,
      'get',
      `https://api.atlassian.com/ex/jira/${tokenData.cloudId}/rest/api/3/search/jql?jql=${jql}&maxResults=50&fields=${fields}`
    );
    const issues = (data.issues || []).map((issue: any) => ({
      id: issue.id,
      key: issue.key,
      summary: issue.fields.summary,
      type: issue.fields.issuetype?.name || 'Task',
      mappedType: mapJiraTypeToAgenFK(issue.fields.issuetype?.name || 'Task'),
      status: issue.fields.status?.name,
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

  for (const { issueKey } of items) {
    try {
      const { data: issue } = await jiraApiRequest(
        tokenData,
        'get',
        `https://api.atlassian.com/ex/jira/${tokenData.cloudId}/rest/api/3/issue/${issueKey}?fields=summary,description,issuetype`
      );
      const type = mapJiraTypeToAgenFK(issue.fields.issuetype?.name || 'Task');
      const description = adfToText(issue.fields.description);

      const newItem: any = {
        id: uuidv4(),
        projectId,
        type,
        title: `[${issueKey}] ${issue.fields.summary}`,
        description: description || `Imported from JIRA: ${issueKey}`,
        status: 'TODO',
        implementationPlan: '',
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
