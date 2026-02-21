"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const body_parser_1 = __importDefault(require("body-parser"));
const storage_json_1 = require("@agenfk/storage-json");
const core_1 = require("@agenfk/core");
const uuid_1 = require("uuid");
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const crypto = __importStar(require("crypto"));
// Load the install-time secret token used to authenticate verify_changes transitions.
// Generated at install time and stored in ~/.agenfk/verify-token — not in the codebase.
const VERIFY_TOKEN = (() => {
    const tokenPath = path.join(os.homedir(), '.agenfk', 'verify-token');
    try {
        return fs.readFileSync(tokenPath, 'utf8').trim();
    }
    catch {
        const ephemeral = crypto.randomBytes(32).toString('hex');
        console.warn(`[SERVER_START] Warning: ~/.agenfk/verify-token not found. Run install.sh to generate it. Using ephemeral token for this session.`);
        return ephemeral;
    }
})();
const child_process_1 = require("child_process");
const http_1 = require("http");
const socket_io_1 = require("socket.io");
const app = (0, express_1.default)();
const httpServer = (0, http_1.createServer)(app);
const io = new socket_io_1.Server(httpServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});
const PORT = 3000;
app.use((0, cors_1.default)({
    origin: "*", // Allow all origins for dev simplicity
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(body_parser_1.default.json());
const storage = new storage_json_1.JSONStorageProvider();
let dbPath = "";
const archiveRecursively = async (id) => {
    const item = await storage.getItem(id);
    if (!item || item.status === core_1.Status.ARCHIVED)
        return;
    console.log(`[AUTO_ARCHIVE] Archiving ${item.id} (${item.title})`);
    await storage.updateItem(id, {
        previousStatus: item.status,
        status: core_1.Status.ARCHIVED
    });
    const children = await storage.listItems({ parentId: id });
    for (const child of children) {
        await archiveRecursively(child.id);
    }
};
const unarchiveRecursively = async (id) => {
    const item = await storage.getItem(id);
    if (!item || item.status !== core_1.Status.ARCHIVED)
        return;
    const targetStatus = item.previousStatus || core_1.Status.TODO;
    console.log(`[AUTO_UNARCHIVE] Restoring ${item.id} (${item.title}) to ${targetStatus}`);
    await storage.updateItem(id, {
        status: targetStatus,
        previousStatus: undefined
    });
    const children = await storage.listItems({ parentId: id });
    for (const child of children) {
        // Only unarchive children that were archived
        if (child.status === core_1.Status.ARCHIVED) {
            await unarchiveRecursively(child.id);
        }
    }
};
const syncParentStatus = async (parentId) => {
    const parent = await storage.getItem(parentId);
    if (!parent)
        return;
    const children = await storage.listItems({ parentId });
    if (children.length === 0)
        return;
    const allDone = children.every(c => c.status === core_1.Status.DONE);
    const anyInProgress = children.some(c => c.status === core_1.Status.IN_PROGRESS || c.status === core_1.Status.REVIEW);
    const anyDone = children.some(c => c.status === core_1.Status.DONE);
    let newStatus = null;
    if (allDone) {
        if (parent.status !== core_1.Status.DONE)
            newStatus = core_1.Status.DONE;
    }
    else if (anyInProgress || anyDone) {
        if (parent.status !== core_1.Status.IN_PROGRESS)
            newStatus = core_1.Status.IN_PROGRESS;
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
const findProjectRoot = (startDir) => {
    let currentDir = startDir;
    while (currentDir !== path.parse(currentDir).root) {
        if (fs.existsSync(path.join(currentDir, ".agenfk"))) {
            return currentDir;
        }
        currentDir = path.dirname(currentDir);
    }
    return startDir;
};
const autoGitCommit = (item, projectRoot) => {
    const message = `close(${item.type.toLowerCase()}): ${item.title} [${item.id}]`;
    const cmd = `git add -A && git commit -m ${JSON.stringify(message)}`;
    (0, child_process_1.exec)(cmd, { cwd: projectRoot }, (err, stdout, stderr) => {
        const timestamp = new Date().toISOString();
        if (err) {
            console.log(`[${timestamp}] [AUTO_GIT] Commit skipped: ${err.message.trim()}`);
        }
        else {
            console.log(`[${timestamp}] [AUTO_GIT] Committed: "${message}"\n${stdout.trim()}`);
        }
    });
};
const initStorage = async () => {
    const envPath = process.env.AGENFK_DB_PATH;
    if (envPath) {
        dbPath = envPath;
    }
    else {
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
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
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
app.get("/projects", asyncHandler(async (req, res) => {
    const projects = await storage.listProjects();
    res.json(projects);
}));
app.post("/projects", asyncHandler(async (req, res) => {
    const { name, description } = req.body;
    if (!name)
        return res.status(400).json({ error: "Name is required" });
    const project = {
        id: (0, uuid_1.v4)(),
        name,
        description: description || "",
        createdAt: new Date(),
        updatedAt: new Date()
    };
    const created = await storage.createProject(project);
    io.emit('items_updated');
    res.status(201).json(created);
}));
app.get("/projects/:id", asyncHandler(async (req, res) => {
    const project = await storage.getProject(req.params.id);
    if (!project)
        return res.status(404).json({ error: "Project not found" });
    res.json(project);
}));
app.put("/projects/:id", asyncHandler(async (req, res) => {
    const updated = await storage.updateProject(req.params.id, req.body);
    io.emit('items_updated');
    res.json(updated);
}));
app.delete("/projects/:id", asyncHandler(async (req, res) => {
    await storage.deleteProject(req.params.id);
    io.emit('items_updated');
    res.status(204).send();
}));
// Items API
app.get("/items", asyncHandler(async (req, res) => {
    const { type, status, parentId, includeArchived, projectId } = req.query;
    const query = {};
    if (type)
        query.type = type;
    if (status)
        query.status = status;
    if (parentId)
        query.parentId = parentId;
    if (projectId)
        query.projectId = projectId;
    let items = await storage.listItems(query);
    // Filter out archived items by default unless explicitly requested or filtering by status
    if (includeArchived !== 'true' && !status) {
        items = items.filter(i => i.status !== core_1.Status.ARCHIVED);
    }
    res.json(items);
}));
app.get("/items/:id", asyncHandler(async (req, res) => {
    const item = await storage.getItem(req.params.id);
    if (!item) {
        return res.status(404).json({ error: "Item not found" });
    }
    res.json(item);
}));
app.post("/items", asyncHandler(async (req, res) => {
    console.log(`[API_DEBUG] POST /items body keys: ${Object.keys(req.body).join(', ')}`);
    const { type, title, description, parentId, status, implementationPlan, projectId } = req.body;
    if (!type || !title) {
        return res.status(400).json({ error: "Type and Title are required" });
    }
    if (!projectId) {
        return res.status(400).json({ error: "ProjectId is required" });
    }
    const newItem = {
        id: (0, uuid_1.v4)(),
        projectId,
        type: type,
        title,
        description: description || "",
        status: status || core_1.Status.TODO,
        parentId: parentId,
        implementationPlan: implementationPlan || "",
        createdAt: new Date(),
        updatedAt: new Date(),
    };
    if (newItem.type === core_1.ItemType.BUG) {
        newItem.severity = "LOW";
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
app.put("/items/:id", asyncHandler(async (req, res) => {
    console.log(`[API_DEBUG] PUT /items/${req.params.id} body keys: ${Object.keys(req.body).join(', ')}`);
    const { title, description, status, parentId, tokenUsage, context, implementationPlan, reviews } = req.body;
    const currentItem = await storage.getItem(req.params.id);
    if (!currentItem) {
        return res.status(404).json({ error: "Item not found" });
    }
    // Enforce REVIEW/DONE transition guard — only verify_changes may set these
    const isInternalVerify = req.headers['x-agenfk-internal'] === VERIFY_TOKEN;
    if (!isInternalVerify && status === core_1.Status.DONE) {
        return res.status(403).json({
            error: "WORKFLOW VIOLATION: Cannot set status to DONE directly. Use verify_changes via MCP to validate work before completion."
        });
    }
    if (!isInternalVerify && status === core_1.Status.REVIEW) {
        return res.status(403).json({
            error: "WORKFLOW VIOLATION: Cannot set status to REVIEW directly. The REVIEW state is managed automatically by verify_changes via MCP."
        });
    }
    // Handle Archival
    if (status === core_1.Status.ARCHIVED && currentItem.status !== core_1.Status.ARCHIVED) {
        await archiveRecursively(req.params.id);
        io.emit('items_updated');
        return res.json(await storage.getItem(req.params.id));
    }
    // Handle Unarchival
    if (status !== undefined && status !== core_1.Status.ARCHIVED && currentItem.status === core_1.Status.ARCHIVED) {
        await unarchiveRecursively(req.params.id);
        // If they provided a status other than ARCHIVED, use it instead of previousStatus?
        // User said "Unarchival will restore item previous statuses", so we usually favor previousStatus.
        // But if they specifically requested a new status, let's honor it for the target item.
        await storage.updateItem(req.params.id, { status: status });
        io.emit('items_updated');
        return res.json(await storage.getItem(req.params.id));
    }
    const updates = {};
    if (title !== undefined)
        updates.title = title;
    if (description !== undefined)
        updates.description = description;
    if (status !== undefined)
        updates.status = status;
    if (parentId !== undefined)
        updates.parentId = parentId;
    if (tokenUsage !== undefined)
        updates.tokenUsage = tokenUsage;
    if (context !== undefined)
        updates.context = context;
    if (implementationPlan !== undefined)
        updates.implementationPlan = implementationPlan;
    if (reviews !== undefined)
        updates.reviews = reviews;
    try {
        const updated = await storage.updateItem(req.params.id, updates);
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] [API_UPDATE] Item ${updated.id} status: ${updated.status}. Broadcasting refresh...`);
        io.emit('items_updated');
        io.emit('project_switched', { projectId: updated.projectId });
        if (updated.parentId && updated.status !== core_1.Status.ARCHIVED) {
            await syncParentStatus(updated.parentId);
        }
        if (updated.status === core_1.Status.DONE && currentItem.status !== core_1.Status.DONE) {
            const projectRoot = findProjectRoot(process.cwd());
            autoGitCommit(updated, projectRoot);
        }
        res.json(updated);
    }
    catch (error) {
        res.status(404).json({ error: "Item not found" });
    }
}));
app.delete("/items/:id", asyncHandler(async (req, res) => {
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
    }
    else {
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
