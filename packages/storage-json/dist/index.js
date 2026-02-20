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
Object.defineProperty(exports, "__esModule", { value: true });
exports.JSONStorageProvider = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
class JSONStorageProvider {
    name = "json-storage";
    version = "1.0.0";
    dbPath = "";
    data = { projects: [], items: [] };
    lock = Promise.resolve();
    async init(config) {
        this.dbPath = config.path || ".agenfk/db.json";
        const dir = path.dirname(this.dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        return this.runLocked(() => {
            this.load();
        });
    }
    runLocked(fn) {
        const operation = this.lock.then(async () => {
            try {
                return await fn();
            }
            catch (e) {
                throw e;
            }
        });
        this.lock = operation.catch(() => { }); // Prevent chain break on error
        return operation;
    }
    load() {
        if (fs.existsSync(this.dbPath)) {
            try {
                const content = fs.readFileSync(this.dbPath, 'utf-8');
                if (!content.trim()) {
                    console.warn(`[STORAGE] Warning: ${this.dbPath} is empty. Skipping load.`);
                    return;
                }
                const parsed = JSON.parse(content);
                // Handle migration if projects missing
                this.data.projects = (parsed.projects || []).map((p) => ({
                    ...p,
                    createdAt: new Date(p.createdAt),
                    updatedAt: new Date(p.updatedAt)
                }));
                this.data.items = (parsed.items || []).map((item) => ({
                    ...item,
                    createdAt: new Date(item.createdAt),
                    updatedAt: new Date(item.updatedAt)
                }));
            }
            catch (e) {
                console.error(`[STORAGE] Error parsing ${this.dbPath}. Keeping current in-memory state.`, e);
            }
        }
        else {
            this.save();
        }
    }
    save() {
        const tempPath = `${this.dbPath}.${Math.random().toString(36).substring(7)}.tmp`;
        try {
            fs.writeFileSync(tempPath, JSON.stringify(this.data, null, 2));
            fs.renameSync(tempPath, this.dbPath);
        }
        catch (e) {
            console.error(`[STORAGE] Critical Error saving to ${this.dbPath}`, e);
            if (fs.existsSync(tempPath))
                fs.unlinkSync(tempPath);
        }
    }
    // Project Methods
    async createProject(project) {
        return this.runLocked(() => {
            this.load();
            this.data.projects.push(project);
            this.save();
            return project;
        });
    }
    async updateProject(id, updates) {
        return this.runLocked(() => {
            this.load();
            const index = this.data.projects.findIndex(p => p.id === id);
            if (index === -1)
                throw new Error(`Project ${id} not found`);
            const updated = { ...this.data.projects[index], ...updates, updatedAt: new Date() };
            this.data.projects[index] = updated;
            this.save();
            return updated;
        });
    }
    async deleteProject(id) {
        return this.runLocked(() => {
            this.load();
            const index = this.data.projects.findIndex(p => p.id === id);
            if (index === -1)
                return false;
            this.data.projects.splice(index, 1);
            // Optional: Delete items belonging to project
            this.data.items = this.data.items.filter(i => i.projectId !== id);
            this.save();
            return true;
        });
    }
    async getProject(id) {
        return this.runLocked(() => {
            this.load();
            return this.data.projects.find(p => p.id === id) || null;
        });
    }
    async listProjects() {
        return this.runLocked(() => {
            this.load();
            return [...this.data.projects];
        });
    }
    // Item Methods
    async createItem(item) {
        return this.runLocked(() => {
            this.load();
            this.data.items.push(item);
            this.save();
            return item;
        });
    }
    async updateItem(id, updates) {
        return this.runLocked(() => {
            this.load();
            const index = this.data.items.findIndex(i => i.id === id);
            if (index === -1)
                throw new Error(`Item ${id} not found`);
            const currentItem = this.data.items[index];
            const updatedItem = { ...currentItem, ...updates, updatedAt: new Date() };
            this.data.items[index] = updatedItem;
            this.save();
            return updatedItem;
        });
    }
    async deleteItem(id) {
        return this.runLocked(() => {
            this.load();
            const index = this.data.items.findIndex(i => i.id === id);
            if (index === -1)
                return false;
            this.data.items.splice(index, 1);
            this.save();
            return true;
        });
    }
    async getItem(id) {
        return this.runLocked(() => {
            this.load();
            const item = this.data.items.find(i => i.id === id);
            return item || null;
        });
    }
    async listItems(query) {
        return this.runLocked(() => {
            this.load();
            let items = this.data.items;
            if (query?.projectId) {
                items = items.filter(i => i.projectId === query.projectId);
            }
            if (query?.type) {
                items = items.filter(i => i.type === query.type);
            }
            if (query?.status) {
                items = items.filter(i => i.status === query.status);
            }
            if (query?.parentId) {
                items = items.filter(i => i.parentId === query.parentId);
            }
            // Pagination
            if (query?.offset !== undefined) {
                items = items.slice(query.offset);
            }
            if (query?.limit !== undefined) {
                items = items.slice(0, query.limit);
            }
            return [...items]; // Return copy to prevent external mutation before save
        });
    }
    async listChildren(parentId) {
        return this.listItems({ parentId });
    }
}
exports.JSONStorageProvider = JSONStorageProvider;
