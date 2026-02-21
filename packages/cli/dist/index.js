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
const API_URL = process.env.AGENFK_API_URL || "http://localhost:3000";
console.log(chalk_1.default.cyan(figlet_1.default.textSync('agenfk', { horizontalLayout: 'full' })));
program
    .version('0.1.0')
    .description('AgenFK Engineering CLI');
program
    .command('up')
    .description('Bootstrap and start AgenFK Engineering Framework')
    .action(async () => {
    const rootDir = path_1.default.resolve(__dirname, '../../..');
    console.log(chalk_1.default.blue('🚀 Bringing up AgenFK Engineering Framework (agenfk)...'));
    // Only bootstrap if start-services.sh or server dist is missing
    const startScript = path_1.default.join(rootDir, 'start-services.sh');
    const serverDist = path_1.default.join(rootDir, 'packages/server/dist/server.js');
    if (!fs_1.default.existsSync(startScript) || !fs_1.default.existsSync(serverDist)) {
        console.log(chalk_1.default.yellow('📦 Initial bootstrap required...'));
        try {
            (0, child_process_1.execSync)('./install.sh', { cwd: rootDir, stdio: 'inherit' });
        }
        catch (e) {
            console.error(chalk_1.default.red('Bootstrap failed.'));
            return;
        }
    }
    else {
        console.log(chalk_1.default.green('Build artifacts found, skipping rebuild.'));
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
    .command('down')
    .description('Stop all AgenFK services (API server and UI)')
    .action(() => {
    const rootDir = path_1.default.resolve(__dirname, '../../..');
    console.log(chalk_1.default.blue('🛑 Bringing down AgenFK services...'));
    let stopped = 0;
    // Stop API server — match the specific server.js path
    try {
        (0, child_process_1.execSync)(`pkill -f "packages/server/dist/server.js"`, { stdio: 'pipe' });
        console.log(chalk_1.default.green('  ✓ API server stopped'));
        stopped++;
    }
    catch {
        console.log(chalk_1.default.gray('  - API server was not running'));
    }
    // Stop UI dev server — match vite process rooted in packages/ui
    try {
        (0, child_process_1.execSync)(`pkill -f "packages/ui"`, { stdio: 'pipe' });
        console.log(chalk_1.default.green('  ✓ UI server stopped'));
        stopped++;
    }
    catch {
        console.log(chalk_1.default.gray('  - UI server was not running'));
    }
    if (stopped > 0) {
        console.log(chalk_1.default.green(`\n✅ Stopped ${stopped} service(s).`));
    }
    else {
        console.log(chalk_1.default.yellow('\nNo running services found.'));
    }
});
program
    .command('ui')
    .description('Show dashboard information and open in browser')
    .action(() => {
    console.log(chalk_1.default.cyan('🌐 Opening UI...'));
    let uiUrl = 'http://localhost:5173';
    try {
        const rootDir = path_1.default.resolve(__dirname, '../../..');
        const uiLogPath = path_1.default.join(rootDir, '.agenfk', 'ui.log');
        if (fs_1.default.existsSync(uiLogPath)) {
            const logContent = fs_1.default.readFileSync(uiLogPath, 'utf8');
            const match = logContent.match(/http:\/\/localhost:\d+/);
            if (match) {
                uiUrl = match[0];
            }
        }
    }
    catch (err) {
        // ignore parsing errors
    }
    console.log(chalk_1.default.white(`Dashboard: ${uiUrl}`));
    try {
        if (fs_1.default.existsSync('/proc/version') && fs_1.default.readFileSync('/proc/version', 'utf8').match(/(Microsoft|WSL)/i)) {
            (0, child_process_1.execSync)(`explorer.exe "${uiUrl}"`, { stdio: 'ignore' });
        }
        else if (process.platform === 'linux') {
            (0, child_process_1.execSync)(`xdg-open "${uiUrl}"`, { stdio: 'ignore' });
        }
        else if (process.platform === 'darwin') {
            (0, child_process_1.execSync)(`open "${uiUrl}"`, { stdio: 'ignore' });
        }
    }
    catch (e) {
        // Ignore errors if browser launch fails
    }
});
program
    .command('list-projects')
    .description('List all projects')
    .action(async () => {
    try {
        const { data: projects } = await axios_1.default.get(`${API_URL}/projects`);
        console.table(projects.map((p) => ({
            ID: p.id,
            Name: p.name,
            Created: new Date(p.createdAt).toLocaleDateString()
        })));
    }
    catch (error) {
        console.error(chalk_1.default.red('Error listing projects:'), error.message);
    }
});
program
    .command('create-project <name>')
    .description('Create a new project')
    .option('-d, --description <desc>', 'Project description', '')
    .action(async (name, options) => {
    try {
        const { data } = await axios_1.default.post(`${API_URL}/projects`, { name, description: options.description });
        console.log(chalk_1.default.green(`Created project: ${data.name} (ID: ${data.id})`));
    }
    catch (error) {
        console.error(chalk_1.default.red('Error creating project:'), error.message);
    }
});
program
    .command('init')
    .description('Initialize a new AgenFK project (Note: Ensure API server is running)')
    .action(async () => {
    try {
        const { data } = await axios_1.default.get(`${API_URL}/`);
        console.log(chalk_1.default.green('Connected to AgenFK API Server.'));
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
    .option('--project <id>', 'Project ID')
    .action(async (type, title, options) => {
    try {
        const itemType = type.toUpperCase();
        let projectId = options.project;
        if (!projectId) {
            // Try to find in .agenfk/project.json
            const rootDir = path_1.default.resolve(__dirname, '../../..');
            const projFile = path_1.default.join(rootDir, '.agenfk', 'project.json');
            if (fs_1.default.existsSync(projFile)) {
                projectId = JSON.parse(fs_1.default.readFileSync(projFile, 'utf8')).projectId;
            }
        }
        if (!projectId) {
            console.error(chalk_1.default.red('Error: Project ID is required. Use --project <id> or initialize with agenfk init.'));
            process.exit(1);
        }
        const payload = {
            type: itemType,
            title,
            description: options.description,
            parentId: options.parent,
            projectId
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
program
    .command('health')
    .description('Verify framework health and configuration')
    .action(async () => {
    console.log(chalk_1.default.blue('\n🔍 AgenFK Health Check\n'));
    let issues = 0;
    // 1. API Server Check
    process.stdout.write('Checking API Server... ');
    try {
        const { data } = await axios_1.default.get(`${API_URL}/`);
        console.log(chalk_1.default.green('OK'));
        console.log(chalk_1.default.gray(`   - Message: ${data.message}`));
    }
    catch (e) {
        console.log(chalk_1.default.red('FAILED'));
        console.log(chalk_1.default.yellow(`   - Error: Could not connect to ${API_URL}`));
        issues++;
    }
    // 2. Configuration & DB Check
    process.stdout.write('Checking Database... ');
    const rootDir = path_1.default.resolve(__dirname, '../../..');
    const dbPath = process.env.AGENFK_DB_PATH || path_1.default.join(rootDir, '.agenfk', 'db.json');
    if (fs_1.default.existsSync(dbPath)) {
        console.log(chalk_1.default.green('OK'));
        console.log(chalk_1.default.gray(`   - Path: ${dbPath}`));
        try {
            const db = JSON.parse(fs_1.default.readFileSync(dbPath, 'utf8'));
            console.log(chalk_1.default.gray(`   - Items: ${db.items.length}`));
        }
        catch (e) {
            console.log(chalk_1.default.red('   - Error: Could not parse db.json'));
            issues++;
        }
    }
    else {
        console.log(chalk_1.default.red('MISSING'));
        issues++;
    }
    // 3. MCP Config Check
    process.stdout.write('Checking Opencode MCP Config... ');
    const opencodeConfig = path_1.default.join(process.env.HOME || '', '.config', 'opencode', 'opencode.json');
    if (fs_1.default.existsSync(opencodeConfig)) {
        try {
            const config = JSON.parse(fs_1.default.readFileSync(opencodeConfig, 'utf8'));
            if (config.mcp && config.mcp.agenfk) {
                console.log(chalk_1.default.green('OK'));
                console.log(chalk_1.default.gray(`   - Enabled: ${config.mcp.agenfk.enabled}`));
            }
            else {
                console.log(chalk_1.default.yellow('NOT CONFIGURED'));
                issues++;
            }
        }
        catch (e) {
            console.log(chalk_1.default.red('ERROR READING CONFIG'));
            issues++;
        }
    }
    else {
        console.log(chalk_1.default.gray('N/A (Opencode not detected)'));
    }
    // 4. Skills Check
    process.stdout.write('Checking Global Skills... ');
    const skillPath = path_1.default.join(process.env.HOME || '', '.config', 'opencode', 'skills', 'agenfk', 'SKILL.md');
    if (fs_1.default.existsSync(skillPath)) {
        console.log(chalk_1.default.green('OK'));
    }
    else {
        console.log(chalk_1.default.yellow('MISSING'));
        issues++;
    }
    console.log('\n' + (issues === 0
        ? chalk_1.default.green('✨ All systems healthy!')
        : chalk_1.default.yellow(`⚠️ Found ${issues} potential issue(s). Run './agenfk up' to fix.`)) + '\n');
});
program.parse(process.argv);
