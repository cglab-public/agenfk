import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { JSONStorageProvider } from "@agenfk/storage-json";
import { ItemType, Status, AgenFKItem, Project } from "@agenfk/core";
import { v4 as uuidv4 } from "uuid";
import * as path from "path";
import * as fs from "fs";
import { createServer } from "http";
import { Server } from "socket.io";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});
const PORT = 3000;

app.use(cors({
  origin: "*", // Allow all origins for dev simplicity
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(bodyParser.json());

const storage = new JSONStorageProvider();
let dbPath: string = "";

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
    // Only unarchive children that were archived
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
  const anyInProgress = children.some(c => c.status === Status.IN_PROGRESS || c.status === Status.REVIEW);
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

const initStorage = async () => {
  const envPath = process.env.AGENFK_DB_PATH;
  if (envPath) {
    dbPath = envPath;
  } else {
    const root = findProjectRoot(process.cwd());
    dbPath = path.join(root, ".agenfk", "db.json");
  }
  console.log(`[SERVER_START] Using Database: ${dbPath}`);
  await storage.init({ path: dbPath });

  // Watch for changes to db.json to notify clients (e.g. from MCP or CLI)
  fs.watch(dbPath, (event) => {
    if (event === 'change') {
      const timestamp = new Date().toISOString();
      console.log(`[${timestamp}] [DISK_CHANGE] Database file ${dbPath} modified. Broadcasting refresh to UI...`);
      io.emit('items_updated');
    }
  });
};

// Error handler wrapper
const asyncHandler = (fn: any) => (req: any, res: any, next: any) =>
  Promise.resolve(fn(req, res, next)).catch(next);

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
  const updated = await storage.updateProject(req.params.id, req.body);
  io.emit('items_updated');
  res.json(updated);
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
  
  // Filter out archived items by default unless explicitly requested or filtering by status
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
  const { title, description, status, parentId, tokenUsage, context, implementationPlan, reviews } = req.body;
  
  const currentItem = await storage.getItem(req.params.id);
  if (!currentItem) {
    return res.status(404).json({ error: "Item not found" });
  }

  // Handle Archival
  if (status === Status.ARCHIVED && currentItem.status !== Status.ARCHIVED) {
    await archiveRecursively(req.params.id);
    io.emit('items_updated');
    return res.json(await storage.getItem(req.params.id));
  }

  // Handle Unarchival
  if (status !== undefined && status !== Status.ARCHIVED && currentItem.status === Status.ARCHIVED) {
    await unarchiveRecursively(req.params.id);
    // If they provided a status other than ARCHIVED, use it instead of previousStatus?
    // User said "Unarchival will restore item previous statuses", so we usually favor previousStatus.
    // But if they specifically requested a new status, let's honor it for the target item.
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
  
  try {
    const updated = await storage.updateItem(req.params.id, updates);
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [API_UPDATE] Item ${updated.id} status: ${updated.status}. Broadcasting refresh...`);
    io.emit('items_updated');
    io.emit('project_switched', { projectId: updated.projectId });

    if (updated.parentId && updated.status !== Status.ARCHIVED) {
      await syncParentStatus(updated.parentId);
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

// Socket.io connection logging
io.on('connection', (socket) => {
  console.log('Client connected to WebSockets');
  socket.on('disconnect', () => {
    console.log('Client disconnected from WebSockets');
  });
});

// Init and Listen
initStorage().then(() => {
  httpServer.listen(PORT, () => {
    console.log(`AgenFK API Server running on port ${PORT} (with WebSockets)`);
  });
});
