import { StorageProvider, PluginConfig, StorageQuery, AgenFKItem, Project } from "@agenfk/core";
export declare class JSONStorageProvider implements StorageProvider {
    name: string;
    version: string;
    dbPath: string;
    private data;
    private lock;
    init(config: PluginConfig): Promise<void>;
    private runLocked;
    private load;
    private save;
    createProject(project: Project): Promise<Project>;
    updateProject(id: string, updates: Partial<Project>): Promise<Project>;
    deleteProject(id: string): Promise<boolean>;
    getProject(id: string): Promise<Project | null>;
    listProjects(): Promise<Project[]>;
    createItem(item: AgenFKItem): Promise<AgenFKItem>;
    updateItem(id: string, updates: Partial<AgenFKItem>): Promise<AgenFKItem>;
    deleteItem(id: string): Promise<boolean>;
    getItem(id: string): Promise<AgenFKItem | null>;
    listItems(query?: StorageQuery): Promise<AgenFKItem[]>;
    listChildren(parentId: string): Promise<AgenFKItem[]>;
}
