import { Command } from 'commander';
import chalk from 'chalk';
import figlet from 'figlet';
import axios from 'axios';
import { ItemType, Status } from '@agenfk/core';
import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const program = new Command();
const API_URL = process.env.AGENFK_API_URL || "http://localhost:3000";

/**
 * Cross-platform port killing logic
 */
function killPort(port: number) {
  try {
    if (process.platform === 'win32') {
      const output = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8' });
      const lines = output.split('\n').filter(l => l.includes('LISTENING'));
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid) execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
      }
    } else {
      try {
        const pid = execSync(`lsof -t -i:${port}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        if (pid) {
          process.kill(parseInt(pid, 10), 'SIGKILL');
        }
      } catch {
        // Fallback to cross-platform ps check if lsof fails
        try {
          const output = execSync('ps -ef', { encoding: 'utf8' });
          const lines = output.split('\n');
          for (const line of lines) {
            if (line.includes(`:${port}`) || line.includes(` ${port}`)) {
               const parts = line.trim().split(/\s+/);
               const pid = parts[1];
               if (pid && /^\d+$/.test(pid)) {
                 process.kill(parseInt(pid, 10), 'SIGKILL');
               }
            }
          }
        } catch {}
      }
    }
  } catch (e) {
    // Port might not be in use
  }
}

/**
 * Kill process by pattern (cross-platform)
 */
function killPattern(pattern: string) {
  try {
    if (process.platform === 'win32') {
      // Very basic pattern matching for Windows
      const output = execSync(`wmic process where "commandline like '%${pattern.replace(/\//g, '\\\\')}%'" get processid`, { encoding: 'utf8' });
      const pids = output.split('\n').map(l => l.trim()).filter(l => /^\d+$/.test(l));
      for (const pid of pids) {
        execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
      }
    } else {
      try {
        const output = execSync('ps -ef', { encoding: 'utf8' });
        const lines = output.split('\n');
        for (const line of lines) {
          if (line.includes(pattern) && !line.includes('ps -ef') && !line.includes('grep')) {
            const parts = line.trim().split(/\s+/);
            const pid = parts[1];
            if (pid && /^\d+$/.test(pid)) {
              process.kill(parseInt(pid, 10), 'SIGKILL');
            }
          }
        }
      } catch (e) {
        // Fallback to pgrep if ps fails
        try {
          const pids = execSync(`pgrep -f "${pattern}"`, { encoding: 'utf8' }).split('\n').filter(Boolean);
          for (const pid of pids) {
            process.kill(parseInt(pid, 10), 'SIGKILL');
          }
        } catch {}
      }
    }
  } catch (e) {}
}

if (process.env.NODE_ENV !== 'test' && !process.argv.includes('mcp')) {
  console.log(
    chalk.cyan(
      figlet.textSync('agenfk', { horizontalLayout: 'full' })
    )
  );
}

export { program };

let CURRENT_VERSION = '0.0.0'; // Fallback
try {
  const pkgPath = path.resolve(__dirname, '../package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    CURRENT_VERSION = pkg.version;
  }
} catch (e) {
  // In some environments this might fail
}

program
  .version(CURRENT_VERSION)
  .description('AgenFK Engineering CLI');

program
  .action(async () => {
    console.log(chalk.blue(`AgenFK CLI v${CURRENT_VERSION}`));
    
    // Check for updates silently
    try {
      const REPO = 'cglab-PRIVATE/agenfk';
      const latestTag = execSync(`gh release view --repo ${REPO} --json tagName --template '{{.tagName}}'`, { 
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'] 
      }).trim();
      const latestVersion = latestTag.replace(/^v/, '');
      
      if (latestVersion !== CURRENT_VERSION) {
        console.log(chalk.yellow(`\nUpdate available: ${latestVersion} (current: ${CURRENT_VERSION})`));
        console.log(chalk.gray(`Run 'agenfk upgrade' to update.`));
      }
    } catch (e) {
      // Silence errors for version check
    }
    
    program.help();
  });

program
  .command('mcp')
  .description('Start the AgenFK MCP server (Client stdio mode)')
  .action(() => {
    // Determine server path relative to this CLI file
    // CLI is in packages/cli/dist/index.js
    // Server is in packages/server/dist/index.js
    const serverPath = path.resolve(__dirname, '../../server/dist/index.js');
    
    if (!fs.existsSync(serverPath)) {
      console.error(chalk.red(`Error: MCP server not found at ${serverPath}.`));
      console.error(chalk.yellow('Please ensure the project is built: npm run build'));
      process.exit(1);
    }

    // Pass environment variables to the spawned server
    const env = { ...process.env };
    
    // Spawn the server process and pipe stdio for MCP communication
    const serverProcess = spawn('node', [serverPath], {
      stdio: 'inherit',
      env
    });

    serverProcess.on('exit', (code) => {
      process.exit(code || 0);
    });
  });

program
  .command('upgrade')
  .description('Check for updates and upgrade to the latest version if available')
  .option('-f, --force', 'Force upgrade even if versions match')
  .option('-b, --beta', 'Include beta/pre-release versions')
  .action(async (options) => {
    const REPO = 'cglab-PRIVATE/agenfk';
    console.log(chalk.blue(`Checking for updates from https://github.com/${REPO}${options.beta ? ' (including betas)' : ''}...`));
    console.log(chalk.gray(`Local version: ${CURRENT_VERSION}`));

    try {
      // Check if services are currently running
      let servicesRunning = false;
      try {
        await axios.get(`${API_URL}/`, { timeout: 2000 });
        servicesRunning = true;
      } catch (e) {
        // Services not running
      }

      // Use gh CLI to fetch the latest release tag
      let latestTag = '';
      try {
        if (options.beta) {
          // Get the most recent release (could be a pre-release)
          latestTag = execSync(`gh release list --repo ${REPO} --limit 1 --json tagName --template '{{range .}}{{.tagName}}{{end}}'`, { 
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'] 
          }).trim();
        } else {
          // Get the latest stable release
          latestTag = execSync(`gh release view --repo ${REPO} --json tagName --template '{{.tagName}}'`, { 
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'] 
          }).trim();
        }
      } catch (e) {
        throw new Error(`Failed to fetch latest ${options.beta ? 'beta ' : ''}release from GitHub. Ensure "gh" CLI is authenticated.`);
      }
      
      const latestVersion = latestTag.replace(/^v/, '');
      console.log(chalk.gray(`Remote version: ${latestVersion}`));
      
      if (latestVersion !== CURRENT_VERSION || options.force) {
        if (options.force && latestVersion === CURRENT_VERSION) {
          console.log(chalk.yellow('Versions match, but --force was specified. Proceeding with upgrade...'));
        } else {
          console.log(chalk.yellow(`New version available: ${latestVersion} (current: ${CURRENT_VERSION})`));
        }
        
        console.log(chalk.blue('Upgrading...'));
        
        const rootDir = path.resolve(__dirname, '../../..');
        const installScript = path.join(rootDir, 'scripts', 'install.mjs');
        
        if (fs.existsSync(installScript)) {
          console.log(chalk.gray('Running install script...'));
          try {
            execSync('node scripts/install.mjs', { cwd: rootDir, stdio: 'inherit' });
            console.log(chalk.green(`Successfully upgraded to ${latestVersion}`));

            if (servicesRunning) {
              console.log(chalk.blue('Restarting services...'));
              try {
                execSync('node packages/cli/bin/agenfk.js restart', { cwd: rootDir, stdio: 'inherit' });
              } catch (e) {
                console.error(chalk.red('Auto-restart failed. Please run "agenfk up" manually.'));
              }
            }
          } catch (e) {
            console.error(chalk.red('Upgrade failed during installation.'));
          }
        } else {
          console.log(chalk.red('Install script not found. Please upgrade manually from GitHub.'));
        }
      } else {
        console.log(chalk.green('You are already on the latest version. Use --force to reinstall.'));
      }
    } catch (error: any) {
      console.error(chalk.red(`Error checking for updates: ${error.message}`));
      console.error(chalk.gray(`Repo: ${REPO}`));
    }
  });

program
  .command('up')
  .description('Bootstrap and start AgenFK Engineering Framework')
  .action(async () => {
    const rootDir = path.resolve(__dirname, '../../..');
    console.log(chalk.blue('🚀 Bringing up AgenFK Engineering Framework (agenfk)...'));

    // 0. Cleanup zombies
    console.log(chalk.gray('🧹 Cleaning up zombie processes...'));
    killPort(3000); // API
    killPort(5173); // UI default
    killPattern('packages/server/dist/server.js');
    killPattern('packages/ui');

    // 1. Only bootstrap if start-services.mjs or server dist is missing
    const startScript = path.join(rootDir, 'scripts', 'start-services.mjs');
    const serverDist = path.join(rootDir, 'packages/server/dist/server.js');

    if (!fs.existsSync(startScript) || !fs.existsSync(serverDist)) {
        console.log(chalk.yellow('📦 Initial bootstrap required...'));
        try {
            execSync('node scripts/install.mjs', { cwd: rootDir, stdio: 'inherit' });
        } catch (e) {
            console.error(chalk.red('Bootstrap failed.'));
            return;
        }
    } else {
        console.log(chalk.green('Build artifacts found, skipping rebuild.'));
    }
    
    console.log(chalk.blue('⚡ Starting agenfk services...'));
    try {
        const start = spawn('node', ['scripts/start-services.mjs'], { cwd: rootDir, stdio: 'inherit' });
        start.on('close', (code) => {
            process.exit(code || 0);
        });
    } catch (e) {
        console.error(chalk.red('Failed to start services.'));
    }
  });

program
  .command('down')
  .description('Stop all AgenFK services (API server and UI)')
  .action(() => {
    const rootDir = path.resolve(__dirname, '../../..');
    console.log(chalk.blue('🛑 Bringing down AgenFK services...'));

    let stopped = 0;

    // Stop API server — match the specific server.js path
    try {
      killPattern('packages/server/dist/server.js');
      console.log(chalk.green('  ✓ API server stopped'));
      stopped++;
    } catch {
      console.log(chalk.gray('  - API server was not running'));
    }

    // Stop UI dev server — match vite process rooted in packages/ui
    try {
      killPattern('packages/ui');
      console.log(chalk.green('  ✓ UI server stopped'));
      stopped++;
    } catch {
      console.log(chalk.gray('  - UI server was not running'));
    }

    if (stopped > 0) {
      console.log(chalk.green(`\n✅ Stopped ${stopped} service(s).`));
    } else {
      console.log(chalk.yellow('\nNo running services found.'));
    }
  });

program
  .command('restart')
  .description('Restart all AgenFK services')
  .action(async () => {
    const rootDir = path.resolve(__dirname, '../../..');
    console.log(chalk.blue('🔄 Restarting AgenFK services...'));
    
    // Call 'down'
    try {
      execSync('node packages/cli/bin/agenfk.js down', { cwd: rootDir, stdio: 'inherit' });
    } catch (e) {}

    // Call 'up'
    // Note: 'up' might keep the terminal open if it doesn't detach.
    // However, the 'up' command in index.ts spawns start-services.mjs which waits.
    // For auto-restart, maybe we want it to run in background?
    // But 'up' is designed to be interactive usually.
    // If called from upgrade, it might be better to start them in background.
    // However, start-services.mjs handles backgrounding itself inside.
    
    try {
      const start = spawn('node', ['packages/cli/bin/agenfk.js', 'up'], { 
        cwd: rootDir, 
        stdio: 'inherit',
        detached: true
      });
      start.unref();
      console.log(chalk.green('🚀 Services restart initiated in background.'));
      // Give it a second to show initial output before exiting the CLI
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (e) {
      console.error(chalk.red('Failed to initiate restart.'));
    }
  });

program
  .command('ui')
  .description('Show dashboard information and open in browser')
  .action(() => {
    console.log(chalk.cyan('🌐 Opening UI...'));
    
    let uiUrl = 'http://localhost:5173';
    try {
      const rootDir = path.resolve(__dirname, '../../..');
      const uiLogPath = path.join(rootDir, '.agenfk', 'ui.log');
      if (fs.existsSync(uiLogPath)) {
        const logContent = fs.readFileSync(uiLogPath, 'utf8');
        const match = logContent.match(/http:\/\/localhost:\d+/);
        if (match) {
          uiUrl = match[0];
        }
      }
    } catch (err) {
      // ignore parsing errors
    }

    console.log(chalk.white(`Dashboard: ${uiUrl}`));
    
    try {
      if (fs.existsSync('/proc/version') && fs.readFileSync('/proc/version', 'utf8').match(/(Microsoft|WSL)/i)) {
        execSync(`cmd.exe /c start "${uiUrl}"`, { stdio: 'ignore' });
      } else if (process.platform === 'linux') {
        execSync(`xdg-open "${uiUrl}"`, { stdio: 'ignore' });
      } else if (process.platform === 'darwin') {
        execSync(`open "${uiUrl}"`, { stdio: 'ignore' });
      }
    } catch (e) {
      // Ignore errors if browser launch fails
    }
  });

program
  .command('list-projects')
  .description('List all projects')
  .action(async () => {
    try {
      const { data: projects } = await axios.get(`${API_URL}/projects`);
      console.table(projects.map((p: any) => ({
        ID: p.id,
        Name: p.name,
        Created: new Date(p.createdAt).toLocaleDateString()
      })));
    } catch (error: any) {
      console.error(chalk.red('Error listing projects:'), error.message);
    }
  });

program
  .command('create-project <name>')
  .description('Create a new project')
  .option('-d, --description <desc>', 'Project description', '')
  .action(async (name, options) => {
    try {
      const { data } = await axios.post(`${API_URL}/projects`, { name, description: options.description });
      console.log(chalk.green(`Created project: ${data.name} (ID: ${data.id})`));
    } catch (error: any) {
      console.error(chalk.red('Error creating project:'), error.message);
    }
  });

program
  .command('init [name]')
  .description('Initialize a new AgenFK project (Note: Ensure API server is running)')
  .option('-d, --description <desc>', 'Project description', '')
  .action(async (name, options) => {
    try {
        const { data: serverInfo } = await axios.get(`${API_URL}/`);
        console.log(chalk.green('Connected to AgenFK API Server.'));

        const rootDir = process.cwd();
        const agenfkDir = path.join(rootDir, '.agenfk');
        const projFile = path.join(agenfkDir, 'project.json');

        if (fs.existsSync(projFile)) {
            const currentProj = JSON.parse(fs.readFileSync(projFile, 'utf8'));
            console.log(chalk.yellow(`Current directory is already initialized with Project ID: ${currentProj.projectId}`));
            return;
        }

        let projectId: string;
        let projectName: string;

        if (name) {
            console.log(chalk.blue(`Creating new project: ${name}...`));
            const { data: newProj } = await axios.post(`${API_URL}/projects`, { 
                name, 
                description: options.description 
            });
            projectId = newProj.id;
            projectName = newProj.name;
            console.log(chalk.green(`Created project: ${projectName} (ID: ${projectId})`));
        } else {
            console.log(chalk.blue('\nListing existing projects:'));
            const { data: projects } = await axios.get(`${API_URL}/projects`);
            console.table(projects.map((p: any) => ({
              ID: p.id.substring(0, 8),
              Name: p.name,
              Created: new Date(p.createdAt).toLocaleDateString()
            })));
            
            console.log(chalk.yellow('\nTo initialize this directory, use:'));
            console.log(chalk.white('  agenfk init <project-name>'));
            console.log(chalk.white('\nOr to link to an existing project, create .agenfk/project.json manually:'));
            console.log(chalk.white('  { "projectId": "EXISTING_ID" }'));
            return;
        }

        if (!fs.existsSync(agenfkDir)) {
            fs.mkdirSync(agenfkDir, { recursive: true });
        }

        fs.writeFileSync(projFile, JSON.stringify({ projectId }, null, 2), 'utf8');
        console.log(chalk.green(`\n✨ Initialized project in ${projFile}`));
        console.log(chalk.gray('You can now start creating items with "agenfk create <type> [title]"'));

        // Configure Claude Code project-level settings to ensure MCP server is available.
        // Claude Code masks global mcpServers when a project has its own .claude/settings.json
        // without a mcpServers key. Writing it to settings.local.json at init time fixes this.
        const globalSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
        let mcpConfig: any = null;
        if (fs.existsSync(globalSettingsPath)) {
            try {
                const globalSettings = JSON.parse(fs.readFileSync(globalSettingsPath, 'utf8'));
                mcpConfig = (globalSettings.mcpServers && globalSettings.mcpServers.agenfk) || null;
            } catch (e) {}
        }
        if (mcpConfig) {
            const claudeDir = path.join(rootDir, '.claude');
            const localSettingsPath = path.join(claudeDir, 'settings.local.json');
            let localSettings: any = {};
            if (fs.existsSync(localSettingsPath)) {
                try {
                    localSettings = JSON.parse(fs.readFileSync(localSettingsPath, 'utf8'));
                } catch (e) {}
            }
            if (!localSettings.mcpServers) localSettings.mcpServers = {};
            localSettings.mcpServers.agenfk = mcpConfig;
            if (!localSettings.permissions) localSettings.permissions = {};
            if (!localSettings.permissions.allow) localSettings.permissions.allow = [];
            const mcpPermissions = [
                'mcp__agenfk__list_projects', 'mcp__agenfk__list_items',
                'mcp__agenfk__get_item', 'mcp__agenfk__create_item',
                'mcp__agenfk__update_item', 'mcp__agenfk__add_comment',
                'mcp__agenfk__workflow_gatekeeper', 'mcp__agenfk__verify_changes',
                'mcp__agenfk__log_token_usage', 'mcp__agenfk__analyze_request',
                'mcp__agenfk__get_server_info', 'mcp__agenfk__add_context',
            ];
            for (const perm of mcpPermissions) {
                if (!localSettings.permissions.allow.includes(perm)) {
                    localSettings.permissions.allow.push(perm);
                }
            }
            if (!fs.existsSync(claudeDir)) {
                fs.mkdirSync(claudeDir, { recursive: true });
            }
            fs.writeFileSync(localSettingsPath, JSON.stringify(localSettings, null, 2), 'utf8');
            console.log(chalk.green(`✓ Configured Claude Code MCP in ${localSettingsPath}`));
        }

    } catch (e: any) {
        console.error(chalk.red('Could not connect to API server. Is it running on port 3000?'));
        if (e.response) {
            console.error(chalk.red(`Server Error: ${e.response.data.error || e.message}`));
        }
    }
  });

/**
 * Find project ID by searching upwards for .agenfk/project.json
 */
function findProjectId(startDir: string): string | null {
  let currentDir = startDir;
  while (currentDir !== path.parse(currentDir).root) {
    const projFile = path.join(currentDir, '.agenfk', 'project.json');
    if (fs.existsSync(projFile)) {
      try {
        const config = JSON.parse(fs.readFileSync(projFile, 'utf8'));
        return config.projectId || null;
      } catch {
        return null;
      }
    }
    currentDir = path.dirname(currentDir);
  }
  return null;
}

program
  .command('create <type> [title]')
  .description('Create a new item (epic, story, task, bug)')
  .option('-d, --description <desc>', 'Description of the item', '')
  .option('-p, --parent <id>', 'Parent ID')
  .option('--project <id>', 'Project ID')
  .action(async (type, title, options) => {
    try {
      const itemType = type.toUpperCase() as ItemType;
      
      let projectId = options.project || findProjectId(process.cwd());

      if (!projectId) {
        console.error(chalk.red('Error: Project ID is required. Use --project <id> or initialize with agenfk init.'));
        process.exit(1);
      }

      const payload = {
        type: itemType,
        title,
        description: options.description,
        parentId: options.parent,
        projectId
      };

      const { data } = await axios.post(`${API_URL}/items`, payload);
      console.log(chalk.green(`Created ${type}: ${data.title} (ID: ${data.id})`));
    } catch (error: any) {
      console.error(chalk.red('Error creating item:'), error.response?.data?.error || error.message);
    }
  });

program
  .command('list')
  .description('List items')
  .option('-t, --type <type>', 'Filter by type')
  .option('-s, --status <status>', 'Filter by status')
  .option('--project <id>', 'Filter by project ID')
  .option('--all', 'Show all projects (bypass local project filter)')
  .action(async (options) => {
    try {
      const query: any = {};
      if (options.type) query.type = options.type.toUpperCase();
      if (options.status) query.status = options.status.toUpperCase();
      
      let projectId = options.project || (options.all ? undefined : findProjectId(process.cwd()));
      if (projectId) query.projectId = projectId;

      const { data: items } = await axios.get(`${API_URL}/items`, { params: query });
      
      if (items.length === 0) {
        console.log(chalk.yellow('No items found.'));
        return;
      }

      console.table(items.map((i: any) => ({
        ID: i.id.substring(0, 8),
        Type: i.type,
        Title: i.title.substring(0, 50),
        Status: i.status,
        Parent: i.parentId ? i.parentId.substring(0, 8) : '-'
      })));
    } catch (error: any) {
      console.error(chalk.red('Error listing items:'), error.response?.data?.error || error.message);
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
        const { data: allItems } = await axios.get(`${API_URL}/items`);
        const found = allItems.filter((i: any) => i.id.startsWith(id));
        if (found.length === 0) {
           console.error(chalk.red(`Item starting with ${id} not found.`));
           return;
        }
        if (found.length > 1) {
           console.error(chalk.red(`Ambiguous ID ${id}, matches multiple items.`));
           return;
        }
        targetId = found[0].id;
      }

      const updates: any = {};
      if (options.status) updates.status = options.status.toUpperCase();
      if (options.title) updates.title = options.title;
      if (options.description) updates.description = options.description;

      const { data: updated } = await axios.put(`${API_URL}/items/${targetId}`, updates);
      console.log(chalk.green(`Updated item: ${updated.title} (${updated.status})`));
    } catch (error: any) {
      console.error(chalk.red('Error updating item:'), error.response?.data?.error || error.message);
    }
  });

program
  .command('delete <id>')
  .description('Delete an item')
  .action(async (id) => {
    try {
      let targetId = id;
      if (id.length < 36) {
        const { data: allItems } = await axios.get(`${API_URL}/items`);
        const found = allItems.filter((i: any) => i.id.startsWith(id));
        if (found.length === 0) {
           console.error(chalk.red(`Item starting with ${id} not found.`));
           return;
        }
        targetId = found[0].id;
      }

      await axios.delete(`${API_URL}/items/${targetId}`);
      console.log(chalk.green(`Deleted item ${targetId}`));
    } catch (error: any) {
      console.error(chalk.red('Error deleting item:'), error.response?.data?.error || error.message);
    }
  });

program
  .command('health')
  .description('Verify framework health and configuration')
  .action(async () => {
    console.log(chalk.blue('\n🔍 AgenFK Health Check\n'));
    let issues = 0;

    // 1. API Server Check
    process.stdout.write('Checking API Server... ');
    try {
      const { data } = await axios.get(`${API_URL}/`);
      console.log(chalk.green('OK'));
      console.log(chalk.gray(`   - Message: ${data.message}`));
    } catch (e: any) {
      console.log(chalk.red('FAILED'));
      console.log(chalk.yellow(`   - Error: Could not connect to ${API_URL}`));
      issues++;
    }

    // 2. Configuration & DB Check
    process.stdout.write('Checking Database... ');
    const rootDir = path.resolve(__dirname, '../../..');
    const dbPath = process.env.AGENFK_DB_PATH || path.join(rootDir, '.agenfk', 'db.json');
    if (fs.existsSync(dbPath)) {
      console.log(chalk.green('OK'));
      console.log(chalk.gray(`   - Path: ${dbPath}`));
      try {
        const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
        console.log(chalk.gray(`   - Items: ${db.items.length}`));
      } catch (e) {
        console.log(chalk.red('   - Error: Could not parse db.json'));
        issues++;
      }
    } else {
      console.log(chalk.red('MISSING'));
      issues++;
    }

    // 3. MCP Config Check
    process.stdout.write('Checking Opencode MCP Config... ');
    const opencodeConfig = path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
    if (fs.existsSync(opencodeConfig)) {
      try {
        const config = JSON.parse(fs.readFileSync(opencodeConfig, 'utf8'));
        if (config.mcp && config.mcp.agenfk) {
          console.log(chalk.green('OK'));
          console.log(chalk.gray(`   - Enabled: ${config.mcp.agenfk.enabled}`));
        } else {
          console.log(chalk.yellow('NOT CONFIGURED'));
          issues++;
        }
      } catch (e) {
        console.log(chalk.red('ERROR READING CONFIG'));
        issues++;
      }
    } else {
      console.log(chalk.gray('N/A (Opencode not detected)'));
    }

    // 4. Skills Check
    process.stdout.write('Checking Global Skills... ');
    const skillPath = path.join(os.homedir(), '.config', 'opencode', 'skills', 'agenfk', 'SKILL.md');
    if (fs.existsSync(skillPath)) {
      console.log(chalk.green('OK'));
    } else {
      console.log(chalk.yellow('MISSING'));
      issues++;
    }

    console.log('\n' + (issues === 0 
      ? chalk.green('✨ All systems healthy!') 
      : chalk.yellow(`⚠️ Found ${issues} potential issue(s). Run './agenfk up' to fix.`)) + '\n');
  });

if (process.env.NODE_ENV !== 'test') {
  program.parse(process.argv);
}
