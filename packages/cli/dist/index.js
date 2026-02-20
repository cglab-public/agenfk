"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const commander_1 = require("commander");
const chalk_1 = __importDefault(require("chalk"));
const figlet_1 = __importDefault(require("figlet"));
const axios_1 = __importDefault(require("axios"));
const child_process_1 = require("child_process");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const program = new commander_1.Command();
const API_URL = process.env.AGENTIC_API_URL || "http://localhost:3000";
console.log(chalk_1.default.cyan(figlet_1.default.textSync('agenfk', { horizontalLayout: 'full' })));
program
    .version('0.1.0')
    .description('Agentic Engineering CLI');
program
    .command('up')
    .description('Bootstrap and start Agentic Engineering Framework')
    .action(async () => {
    const rootDir = path_1.default.resolve(__dirname, '../../..');
    console.log(chalk_1.default.blue('🚀 Bringing up Agentic Engineering Framework (agenfk)...'));
    // Check if bootstrap required
    const agenticDir = path_1.default.join(rootDir, '.agentic');
    const serverDist = path_1.default.join(rootDir, 'packages/server/dist/server.js');
    if (!fs_1.default.existsSync(agenticDir) || !fs_1.default.existsSync(serverDist)) {
        console.log(chalk_1.default.yellow('📦 Initial bootstrap required...'));
        try {
            (0, child_process_1.execSync)('./integrate_opencode.sh', { cwd: rootDir, stdio: 'inherit' });
        }
        catch (e) {
            console.error(chalk_1.default.red('Bootstrap failed.'));
            return;
        }
    }
    console.log(chalk_1.default.blue('⚡ Starting agenfk services...'));
    try {
        const start = (0, child_process_1.spawn)('./start-services.sh', { cwd: rootDir, stdio: 'inherit' });
        start.on('close', (code) => {
            process.exit(code || 0);
        });
    }
    catch (e) {
        console.error(chalk_1.default.red('Failed to start services.'));
    }
});
program
    .command('ui')
    .description('Show dashboard information')
    .action(() => {
    console.log(chalk_1.default.cyan('🌐 Opening UI...'));
    console.log(chalk_1.default.white('Dashboard: http://localhost:5173'));
});
program
    .command('init')
    .description('Initialize a new Agentic project (Note: Ensure API server is running)')
    .action(async () => {
    try {
        const { data } = await axios_1.default.get(`${API_URL}/`);
        console.log(chalk_1.default.green('Connected to Agentic API Server.'));
        console.log(JSON.stringify(data, null, 2));
    }
    catch (e) {
        console.error(chalk_1.default.red('Could not connect to API server. Is it running on port 3000?'));
    }
});
program
    .command('create <type> <title>')
    .description('Create a new item (epic, story, task, bug)')
    .option('-d, --description <desc>', 'Description of the item', '')
    .option('-p, --parent <id>', 'Parent ID')
    .action(async (type, title, options) => {
    try {
        const itemType = type.toUpperCase();
        const payload = {
            type: itemType,
            title,
            description: options.description,
            parentId: options.parent
        };
        const { data } = await axios_1.default.post(`${API_URL}/items`, payload);
        console.log(chalk_1.default.green(`Created ${type}: ${data.title} (ID: ${data.id})`));
    }
    catch (error) {
        console.error(chalk_1.default.red('Error creating item:'), error.response?.data?.error || error.message);
    }
});
program
    .command('list')
    .description('List items')
    .option('-t, --type <type>', 'Filter by type')
    .option('-s, --status <status>', 'Filter by status')
    .action(async (options) => {
    try {
        const query = {};
        if (options.type)
            query.type = options.type.toUpperCase();
        if (options.status)
            query.status = options.status.toUpperCase();
        const { data: items } = await axios_1.default.get(`${API_URL}/items`, { params: query });
        if (items.length === 0) {
            console.log(chalk_1.default.yellow('No items found.'));
            return;
        }
        console.table(items.map((i) => ({
            ID: i.id.substring(0, 8),
            Type: i.type,
            Title: i.title.substring(0, 50),
            Status: i.status,
            Parent: i.parentId ? i.parentId.substring(0, 8) : '-'
        })));
    }
    catch (error) {
        console.error(chalk_1.default.red('Error listing items:'), error.response?.data?.error || error.message);
    }
});
program
    .command('update <id>')
    .description('Update an item')
    .option('-s, --status <status>', 'New status (TODO, IN_PROGRESS, REVIEW, DONE, BLOCKED)')
    .option('-t, --title <title>', 'New title')
    .option('-d, --description <desc>', 'New description')
    .action(async (id, options) => {
    try {
        // Handle short ID
        let targetId = id;
        if (id.length < 36) {
            const { data: allItems } = await axios_1.default.get(`${API_URL}/items`);
            const found = allItems.filter((i) => i.id.startsWith(id));
            if (found.length === 0) {
                console.error(chalk_1.default.red(`Item starting with ${id} not found.`));
                return;
            }
            if (found.length > 1) {
                console.error(chalk_1.default.red(`Ambiguous ID ${id}, matches multiple items.`));
                return;
            }
            targetId = found[0].id;
        }
        const updates = {};
        if (options.status)
            updates.status = options.status.toUpperCase();
        if (options.title)
            updates.title = options.title;
        if (options.description)
            updates.description = options.description;
        const { data: updated } = await axios_1.default.put(`${API_URL}/items/${targetId}`, updates);
        console.log(chalk_1.default.green(`Updated item: ${updated.title} (${updated.status})`));
    }
    catch (error) {
        console.error(chalk_1.default.red('Error updating item:'), error.response?.data?.error || error.message);
    }
});
program
    .command('delete <id>')
    .description('Delete an item')
    .action(async (id) => {
    try {
        let targetId = id;
        if (id.length < 36) {
            const { data: allItems } = await axios_1.default.get(`${API_URL}/items`);
            const found = allItems.filter((i) => i.id.startsWith(id));
            if (found.length === 0) {
                console.error(chalk_1.default.red(`Item starting with ${id} not found.`));
                return;
            }
            targetId = found[0].id;
        }
        await axios_1.default.delete(`${API_URL}/items/${targetId}`);
        console.log(chalk_1.default.green(`Deleted item ${targetId}`));
    }
    catch (error) {
        console.error(chalk_1.default.red('Error deleting item:'), error.response?.data?.error || error.message);
    }
});
program.parse(process.argv);
