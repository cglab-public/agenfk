import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { JSONStorageProvider } from "@agentic/storage-json";
import { ItemType, Status, AgenticItem } from "@agentic/core";
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

const findProjectRoot = (startDir: string): string => {
  let currentDir = startDir;
  while (currentDir !== path.parse(currentDir).root) {
    if (fs.existsSync(path.join(currentDir, ".agentic"))) {
      return currentDir;
    }
    currentDir = path.dirname(currentDir);
  }
  return startDir;
};

const initStorage = async () => {
  const envPath = process.env.AGENTIC_DB_PATH;
  if (envPath) {
    dbPath = envPath;
  } else {
    const root = findProjectRoot(process.cwd());
    dbPath = path.join(root, ".agentic", "db.json");
  }
  console.log(`[SERVER_START] Using Database: ${dbPath}`);
  await storage.init({ path: dbPath });

  // Watch for changes to db.json to notify clients (e.g. from MCP or CLI)
  fs.watch(dbPath, (event) => {
    if (event === 'change') {
      console.log(`[DISK_CHANGE] Database file ${dbPath} modified. Broadcasting refresh to UI...`);
      io.emit('items_updated');
    }
  });
};

// Error handler wrapper
const asyncHandler = (fn: any) => (req: any, res: any, next: any) =>
  Promise.resolve(fn(req, res, next)).catch(next);

app.get("/", (req, res) => {
  res.json({
    message: "Agentic Framework API is running",
    endpoints: {
      items: "/items",
      ui: "http://localhost:5173"
    }
  });
});

app.get("/items", asyncHandler(async (req: any, res: any) => {
  const { type, status, parentId } = req.query;
  const query: any = {};
  if (type) query.type = type;
  if (status) query.status = status;
  if (parentId) query.parentId = parentId;

  const items = await storage.listItems(query);
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
  const { type, title, description, parentId, status, implementationPlan } = req.body;
  
  if (!type || !title) {
    return res.status(400).json({ error: "Type and Title are required" });
  }

  const newItem: AgenticItem = {
    id: uuidv4(),
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
  console.log(`[API_CREATE] Item created: ${created.id} (${created.title}). Broadcasting refresh...`);
  io.emit('items_updated');
  res.status(201).json(created);
}));

app.put("/items/:id", asyncHandler(async (req: any, res: any) => {
  const { title, description, status, parentId, tokenUsage, context, implementationPlan } = req.body;
  const updates: any = {};
  if (title !== undefined) updates.title = title;
  if (description !== undefined) updates.description = description;
  if (status !== undefined) updates.status = status;
  if (parentId !== undefined) updates.parentId = parentId;
  if (tokenUsage !== undefined) updates.tokenUsage = tokenUsage;
  if (context !== undefined) updates.context = context;
  if (implementationPlan !== undefined) updates.implementationPlan = implementationPlan;
  
  try {
    const updated = await storage.updateItem(req.params.id, updates);
    console.log(`[API_UPDATE] Item updated: ${updated.id} (${updated.title}). Broadcasting refresh...`);
    io.emit('items_updated');
    res.json(updated);
  } catch (error) {
    res.status(404).json({ error: "Item not found" });
  }
}));

app.delete("/items/:id", asyncHandler(async (req: any, res: any) => {
  const success = await storage.deleteItem(req.params.id);
  if (success) {
    console.log(`[API_DELETE] Item deleted: ${req.params.id}. Broadcasting refresh...`);
    io.emit('items_updated');
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
    console.log(`Agentic API Server running on port ${PORT} (with WebSockets)`);
  });
});
