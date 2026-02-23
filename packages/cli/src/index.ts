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

function isMinGW() {
  return !!(process.env.MSYSTEM || process.env.MINGW_PREFIX);
}

/**
 * Cross-platform port killing logic
 */
function killPort(port: number) {
  try {
    if (process.platform === 'win32' && !isMinGW()) {
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
    if (process.platform === 'win32' && !isMinGW()) {
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
      if (isMinGW()) {
        try {
          execSync(`cygstart "${uiUrl}"`, { stdio: 'ignore' });
        } catch {
          execSync(`start "${uiUrl}"`, { stdio: 'ignore' });
        }
      } else if (fs.existsSync('/proc/version') && fs.readFileSync('/proc/version', 'utf8').match(/(Microsoft|WSL)/i)) {
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
        // When a project has .claude/settings.json, Claude Code masks the global
        // ~/.claude/settings.json mcpServers. The fix is:
        //   1. Write server config to .mcp.json at the project root (Claude Code's
        //      project-scoped MCP config file; mcpServers is not valid in settings.json).
        //   2. Add enabledMcpjsonServers to .claude/settings.json to auto-approve it.
        //   3. Write MCP tool permissions to settings.local.json (user/machine-specific).
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
            if (!fs.existsSync(claudeDir)) {
                fs.mkdirSync(claudeDir, { recursive: true });
            }

            // Write to .mcp.json at the project root (Claude Code's project-scoped MCP file)
            const mcpJsonPath = path.join(rootDir, '.mcp.json');
            let mcpJson: any = { mcpServers: {} };
            if (fs.existsSync(mcpJsonPath)) {
                try {
                    mcpJson = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
                    if (!mcpJson.mcpServers) mcpJson.mcpServers = {};
                } catch (e) {}
            }
            mcpJson.mcpServers.agenfk = mcpConfig;
            fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpJson, null, 2), 'utf8');
            console.log(chalk.green(`✓ Configured Claude Code MCP in ${mcpJsonPath}`));

            // Add enabledMcpjsonServers to .claude/settings.json to auto-approve without prompt
            const projectSettingsPath = path.join(claudeDir, 'settings.json');
            let projectSettings: any = {};
            if (fs.existsSync(projectSettingsPath)) {
                try {
                    projectSettings = JSON.parse(fs.readFileSync(projectSettingsPath, 'utf8'));
                } catch (e) {}
            }
            if (!projectSettings.enabledMcpjsonServers) projectSettings.enabledMcpjsonServers = [];
            if (!projectSettings.enabledMcpjsonServers.includes('agenfk')) {
                projectSettings.enabledMcpjsonServers.push('agenfk');
            }
            // Remove mcpServers if previously written there by an older agenfk init
            delete projectSettings.mcpServers;
            fs.writeFileSync(projectSettingsPath, JSON.stringify(projectSettings, null, 2), 'utf8');

            // Write MCP tool permissions to settings.local.json (user/machine-specific, not committed)
            const localSettingsPath = path.join(claudeDir, 'settings.local.json');
            let localSettings: any = {};
            if (fs.existsSync(localSettingsPath)) {
                try {
                    localSettings = JSON.parse(fs.readFileSync(localSettingsPath, 'utf8'));
                } catch (e) {}
            }
            // Remove mcpServers if previously written there by an older agenfk init
            delete localSettings.mcpServers;
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
            fs.writeFileSync(localSettingsPath, JSON.stringify(localSettings, null, 2), 'utf8');
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

// ── agenfk backup ────────────────────────────────────────────────────────────

program
  .command('backup')
  .description('Create a manual backup of the database to ~/.agenfk/backup/')
  .action(async () => {
    const tokenPath = path.join(os.homedir(), '.agenfk', 'verify-token');
    if (!fs.existsSync(tokenPath)) {
      console.error(chalk.red('Error: ~/.agenfk/verify-token not found. Run npm run install:framework first.'));
      process.exit(1);
    }
    const token = fs.readFileSync(tokenPath, 'utf8').trim();
    try {
      const { data } = await axios.post(`${API_URL}/backup`, {}, {
        headers: { 'x-agenfk-internal': token }
      });
      console.log(chalk.green(`Backup created: ${data.backupPath}`));
    } catch (error: any) {
      if (error.response?.status === 401) {
        console.error(chalk.red('Error: Invalid verify token.'));
      } else {
        console.error(chalk.red('Error creating backup:'), error.response?.data?.error || error.message);
        console.error(chalk.yellow('Is the API server running? Try: agenfk up'));
      }
    }
  });

// ── agenfk db ────────────────────────────────────────────────────────────────

const dbCommand = program
  .command('db')
  .description('Database management commands');

dbCommand
  .command('status')
  .description('Show current database type, path, and backup information')
  .action(async () => {
    try {
      const { data } = await axios.get(`${API_URL}/db/status`);
      console.log(chalk.blue('\nDatabase Status'));
      console.log(chalk.white(`  Type:          ${data.dbType.toUpperCase()}`));
      console.log(chalk.white(`  Path:          ${data.dbPath}`));
      console.log(chalk.white(`  Backup Dir:    ${data.backupDir}`));
      console.log(chalk.white(`  Backups:       ${data.backupCount}`));
      console.log(chalk.white(`  Latest Backup: ${data.latestBackup || 'none'}\n`));
    } catch (error: any) {
      console.error(chalk.red('Error fetching DB status:'), error.response?.data?.error || error.message);
      console.error(chalk.yellow('Is the API server running? Try: agenfk up'));
    }
  });

dbCommand
  .command('switch <type>')
  .description('Switch database type (json or sqlite) — migrates all data automatically')
  .action(async (type: string) => {
    const targetType = type.toLowerCase();
    if (targetType !== 'json' && targetType !== 'sqlite') {
      console.error(chalk.red('Error: type must be "json" or "sqlite"'));
      process.exit(1);
    }

    // 1. Verify server is running and check current type
    let currentStatus: any;
    try {
      const { data } = await axios.get(`${API_URL}/db/status`);
      currentStatus = data;
    } catch (error: any) {
      console.error(chalk.red('Cannot connect to API server. Is it running? Try: agenfk up'));
      process.exit(1);
    }

    const currentType = currentStatus.dbType;
    if (currentType === targetType) {
      console.log(chalk.yellow(`Already using ${targetType.toUpperCase()} storage. No change needed.`));
      return;
    }

    console.log(chalk.blue(`Switching from ${currentType.toUpperCase()} → ${targetType.toUpperCase()}...`));

    // 2. Export all data
    console.log(chalk.gray('  Exporting data...'));
    const [{ data: projects }, { data: items }] = await Promise.all([
      axios.get(`${API_URL}/projects`),
      axios.get(`${API_URL}/items`, { params: { includeArchived: 'true' } }),
    ]);

    const exportData = {
      version: '1',
      backupDate: new Date().toISOString(),
      dbType: currentType,
      projects,
      items,
    };

    // 3. Write local backup to ~/.agenfk/backup/
    const backupDir = path.join(os.homedir(), '.agenfk', 'backup');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const backupFile = path.join(backupDir, `agenfk-backup-${new Date().toISOString().replace(/:/g, '-')}.json`);
    fs.writeFileSync(backupFile, JSON.stringify(exportData, null, 2));
    console.log(chalk.gray(`  Backup saved: ${backupFile}`));

    // 4. Write migration.json — picked up by server on next start
    const agenfkHome = path.join(os.homedir(), '.agenfk');
    fs.writeFileSync(path.join(agenfkHome, 'migration.json'), JSON.stringify(exportData, null, 2));
    console.log(chalk.gray('  Migration file written.'));

    // 5. Compute new dbPath (same directory, new extension)
    const currentDbPath: string = currentStatus.dbPath;
    const newDbPath = currentDbPath.replace(/\.(json|sqlite)$/, `.${targetType === 'sqlite' ? 'sqlite' : 'json'}`);

    // 6. Update ~/.agenfk/config.json
    const configPath = path.join(agenfkHome, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ dbPath: newDbPath }, null, 2));
    console.log(chalk.gray(`  Config updated: ${configPath}`));

    // 7. Update AGENFK_DB_PATH in ~/.claude/settings.json
    const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    if (fs.existsSync(claudeSettingsPath)) {
      try {
        const settings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8'));
        if (settings.mcpServers?.agenfk?.env) {
          settings.mcpServers.agenfk.env.AGENFK_DB_PATH = newDbPath;
          fs.writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 2));
          console.log(chalk.gray(`  Updated Claude settings: ${claudeSettingsPath}`));
        }
      } catch { /* ignore */ }
    }

    // 8. Update AGENFK_DB_PATH in ~/.config/opencode/opencode.json
    const opencodeConfigPath = path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
    if (fs.existsSync(opencodeConfigPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(opencodeConfigPath, 'utf8'));
        if (config.mcp?.agenfk?.environment) {
          config.mcp.agenfk.environment.AGENFK_DB_PATH = newDbPath;
          fs.writeFileSync(opencodeConfigPath, JSON.stringify(config, null, 2));
          console.log(chalk.gray(`  Updated Opencode config: ${opencodeConfigPath}`));
        }
      } catch { /* ignore */ }
    }

    // 9. Restart services so server picks up new provider + imports migration.json
    console.log(chalk.blue('\nRestarting services...'));
    const rootDir = path.resolve(__dirname, '../../..');
    try {
      const { execSync } = await import('child_process');
      execSync('node packages/cli/bin/agenfk.js restart', { cwd: rootDir, stdio: 'inherit' });
    } catch { /* restart is best-effort */ }

    console.log(chalk.green(`\nDone. Now using ${targetType.toUpperCase()} storage at: ${newDbPath}`));
    console.log(chalk.gray('Restart your AI editor to reload the MCP server with the new DB path.'));
  });

// ── agenfk jira ──────────────────────────────────────────────────────────────

const jiraCommand = program
  .command('jira')
  .description('JIRA integration commands');

jiraCommand
  .command('setup')
  .description('Configure JIRA OAuth integration (Client ID & Secret)')
  .action(async () => {
    const readline = await import('readline');

    const ask = (rl: any, question: string, hidden = false): Promise<string> => {
      return new Promise((resolve) => {
        if (hidden && process.stdout.isTTY) {
          process.stdout.write(question);
          // Disable echo for secret input
          if ((process.stdin as any).setRawMode) {
            (process.stdin as any).setRawMode(true);
          }
          let input = '';
          const onData = (char: Buffer) => {
            const c = char.toString();
            if (c === '\n' || c === '\r' || c === '\u0003') {
              process.stdout.write('\n');
              process.stdin.removeListener('data', onData);
              process.stdin.setEncoding('utf8');
              if ((process.stdin as any).setRawMode) (process.stdin as any).setRawMode(false);
              resolve(input);
            } else if (c === '\u007f' || c === '\b') {
              if (input.length > 0) {
                input = input.slice(0, -1);
                process.stdout.write('\b \b');
              }
            } else {
              input += c;
              process.stdout.write('*');
            }
          };
          process.stdin.setEncoding('utf8' as any);
          process.stdin.on('data', onData);
          process.stdin.resume();
        } else {
          rl.question(question, (answer: string) => resolve(answer.trim()));
        }
      });
    };

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    console.log(chalk.blue('\nJIRA OAuth 2.0 Setup'));
    console.log(chalk.gray('Create an OAuth 2.0 app at: https://developer.atlassian.com/console/myapps/\n'));
    console.log(chalk.gray('Required callback URL to add in Atlassian app settings:'));
    console.log(chalk.white('  http://localhost:3000/jira/oauth/callback\n'));

    const clientId = await ask(rl, chalk.white('Client ID: '));
    const clientSecret = await ask(rl, chalk.white('Client Secret: '), true);
    rl.question(
      chalk.white(`Redirect URI [http://localhost:3000/jira/oauth/callback]: `),
      async (redirectUriInput: string) => {
        rl.close();
        const redirectUri = redirectUriInput.trim() || 'http://localhost:3000/jira/oauth/callback';

        if (!clientId || !clientSecret) {
          console.error(chalk.red('\nError: Client ID and Client Secret are required.'));
          process.exit(1);
        }

        const configPath = path.join(os.homedir(), '.agenfk', 'config.json');
        let config: any = {};
        if (fs.existsSync(configPath)) {
          try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { /* ignore */ }
        }

        config.jira = { clientId, clientSecret, redirectUri };
        const agenfkDir = path.join(os.homedir(), '.agenfk');
        if (!fs.existsSync(agenfkDir)) fs.mkdirSync(agenfkDir, { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

        console.log(chalk.green('\nJIRA integration configured successfully!'));
        console.log(chalk.gray(`  Client ID:    ${clientId}`));
        console.log(chalk.gray(`  Client Secret: ${'*'.repeat(Math.min(clientSecret.length, 8))}...`));
        console.log(chalk.gray(`  Redirect URI:  ${redirectUri}`));
        console.log(chalk.blue('\nNext steps:'));
        console.log(chalk.white('  1. Restart AgenFK services: agenfk restart'));
        console.log(chalk.white('  2. Open the Kanban UI and click "Connect JIRA" in the toolbar'));
      }
    );
  });

jiraCommand
  .command('status')
  .description('Show JIRA configuration and connection status')
  .action(async () => {
    console.log(chalk.blue('\nJIRA Integration Status\n'));

    // Config check
    const configPath = path.join(os.homedir(), '.agenfk', 'config.json');
    let jiraConfig: any = null;
    if (fs.existsSync(configPath)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        jiraConfig = cfg.jira || null;
      } catch { /* ignore */ }
    }

    if (jiraConfig?.clientId) {
      console.log(chalk.green('  Configuration: ✓ Configured'));
      console.log(chalk.gray(`    Client ID:    ${jiraConfig.clientId}`));
      console.log(chalk.gray(`    Client Secret: ${'*'.repeat(8)}...`));
      console.log(chalk.gray(`    Redirect URI:  ${jiraConfig.redirectUri || 'http://localhost:3000/jira/oauth/callback'}`));
    } else {
      console.log(chalk.yellow('  Configuration: ✗ Not configured'));
      console.log(chalk.white('    Run: agenfk jira setup'));
    }

    // Token check
    const tokenPath = path.join(os.homedir(), '.agenfk', 'jira-token.json');
    if (fs.existsSync(tokenPath)) {
      try {
        const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
        console.log(chalk.green('\n  OAuth Token:   ✓ Connected'));
        console.log(chalk.gray(`    Cloud ID:  ${token.cloudId}`));
        console.log(chalk.gray(`    Account:   ${token.email || 'unknown'}`));
      } catch {
        console.log(chalk.yellow('\n  OAuth Token:   ✗ Token file is corrupted'));
      }
    } else {
      console.log(chalk.yellow('\n  OAuth Token:   ✗ Not connected'));
      if (jiraConfig?.clientId) {
        console.log(chalk.white('    Open the Kanban UI and click "Connect JIRA" to authenticate'));
      }
    }

    // Live server status
    try {
      const { data } = await axios.get(`${API_URL}/jira/status`, { timeout: 2000 });
      console.log(chalk.blue(`\n  Live Server:   ${data.connected ? chalk.green('✓ Connected') : chalk.yellow('✗ Not connected')}`));
    } catch {
      console.log(chalk.gray('\n  Live Server:   (server not reachable)'));
    }

    console.log('');
  });

jiraCommand
  .command('disconnect')
  .description('Remove stored JIRA OAuth token')
  .action(async () => {
    const tokenPath = path.join(os.homedir(), '.agenfk', 'jira-token.json');
    if (!fs.existsSync(tokenPath)) {
      console.log(chalk.yellow('No JIRA token found — already disconnected.'));
      return;
    }

    fs.unlinkSync(tokenPath);
    console.log(chalk.green('JIRA token removed. You are now disconnected from JIRA.'));

    // Best-effort: also tell the server
    try {
      await axios.post(`${API_URL}/jira/disconnect`, {}, { timeout: 2000 });
    } catch { /* server may not be running */ }
  });

if (process.env.NODE_ENV !== 'test') {
  program.parse(process.argv);
}
