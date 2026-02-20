import { StorageProvider, PluginConfig, StorageQuery, AgenticItem } from "@agentic/core";
export declare class JSONStorageProvider implements StorageProvider {
    name: string;
    version: string;
    dbPath: string;
    private data;
    init(config: PluginConfig): Promise<void>;
    private load;
    private save;
    createItem(item: AgenticItem): Promise<AgenticItem>;
    updateItem(id: string, updates: Partial<AgenticItem>): Promise<AgenticItem>;
    deleteItem(id: string): Promise<boolean>;
    getItem(id: string): Promise<AgenticItem | null>;
    listItems(query?: StorageQuery): Promise<AgenticItem[]>;
    listChildren(parentId: string): Promise<AgenticItem[]>;
}
