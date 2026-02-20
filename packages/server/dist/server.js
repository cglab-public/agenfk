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
const storage_json_1 = require("@agentic/storage-json");
const core_1 = require("@agentic/core");
const uuid_1 = require("uuid");
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
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
const findProjectRoot = (startDir) => {
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
    }
    else {
        const root = findProjectRoot(process.cwd());
        dbPath = path.join(root, ".agentic", "db.json");
    }
    console.log(`[SERVER_START] Using Database: ${dbPath}`);
    await storage.init({ path: dbPath });
    // Watch for changes to db.json to notify clients (e.g. from MCP or CLI)
    fs.watch(dbPath, (event) => {
        if (event === 'change') {
            console.log('Database file changed on disk, notifying clients...');
            io.emit('items_updated');
        }
    });
};
// Error handler wrapper
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
app.get("/", (req, res) => {
    res.json({
        message: "Agentic Framework API is running",
        endpoints: {
            items: "/items",
            ui: "http://localhost:5173"
        }
    });
});
app.get("/items", asyncHandler(async (req, res) => {
    const { type, status, parentId } = req.query;
    const query = {};
    if (type)
        query.type = type;
    if (status)
        query.status = status;
    if (parentId)
        query.parentId = parentId;
    const items = await storage.listItems(query);
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
    const { type, title, description, parentId, status, implementationPlan } = req.body;
    if (!type || !title) {
        return res.status(400).json({ error: "Type and Title are required" });
    }
    const newItem = {
        id: (0, uuid_1.v4)(),
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
    io.emit('items_updated');
    res.status(201).json(created);
}));
app.put("/items/:id", asyncHandler(async (req, res) => {
    const { title, description, status, parentId, tokenUsage, context, implementationPlan } = req.body;
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
    try {
        const updated = await storage.updateItem(req.params.id, updates);
        io.emit('items_updated');
        res.json(updated);
    }
    catch (error) {
        res.status(404).json({ error: "Item not found" });
    }
}));
app.delete("/items/:id", asyncHandler(async (req, res) => {
    const success = await storage.deleteItem(req.params.id);
    if (success) {
        io.emit('items_updated');
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
        console.log(`Agentic API Server running on port ${PORT} (with WebSockets)`);
    });
});
