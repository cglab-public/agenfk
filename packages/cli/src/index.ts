import { Command } from 'commander';
import chalk from 'chalk';
import figlet from 'figlet';
import axios from 'axios';
import { ItemType, Status } from '@agenfk/core';
import { TelemetryClient } from '@agenfk/telemetry';
import { execSync, spawn, spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

const program = new Command();
const API_URL = process.env.AGENFK_API_URL || "http://localhost:3000";

const telemetry = new TelemetryClient();

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

if (process.env.NODE_ENV !== 'test' && !process.argv.includes('mcp') && !process.argv.includes('--json')) {
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

// Fire-and-forget telemetry for every command invocation (command name only — no args).
program.hook('preAction', (thisCommand, actionCommand) => {
  telemetry.capture('cli_command', {
    command: actionCommand.name(),
    version: CURRENT_VERSION,
  });
});

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
  .option('--rebuild', 'Force a full build from source after upgrading')
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
        const isGitRepo = fs.existsSync(path.join(rootDir, '.git'));
        
        if (!isGitRepo) {
          console.log(chalk.gray(`Downloading pre-built binary for ${latestTag}...`));
          try {
            const tempDir = path.join(os.tmpdir(), `agenfk-upgrade-${Date.now()}`);
            fs.mkdirSync(tempDir, { recursive: true });
            
            // Download the tarball
            execSync(`gh release download ${latestTag} --repo ${REPO} --pattern 'agenfk-dist.tar.gz' --output "${path.join(tempDir, 'agenfk-dist.tar.gz')}"`, { stdio: 'inherit' });
            
            // Extract the tarball
            console.log(chalk.gray('Extracting update...'));
            // Use --strip-components=0 or just extract normally since package-dist.mjs doesn't seem to add a root folder
            execSync(`tar -xzf "${path.join(tempDir, 'agenfk-dist.tar.gz')}" -C "${rootDir}"`, { stdio: 'inherit' });
            
            // Clean up temp dir
            fs.rmSync(tempDir, { recursive: true, force: true });
            
            console.log(chalk.gray(`Running install script${options.rebuild ? ' (rebuild mode)' : ' (pre-built mode)'}...`));
            execSync(`node scripts/install.mjs${options.rebuild ? ' --rebuild' : ''}`, { cwd: rootDir, stdio: 'inherit' });
            console.log(chalk.green(`Successfully upgraded to ${latestVersion}`));

            if (servicesRunning) {
              console.log(chalk.blue('Restarting services...'));
              try {
                execSync('node packages/cli/bin/agenfk.js restart', { cwd: rootDir, stdio: 'inherit' });
              } catch (e) {
                console.error(chalk.red('Auto-restart failed. Please run "agenfk up" manually.'));
              }
            }
          } catch (e: any) {
            console.error(chalk.red(`Upgrade failed: ${e.message}`));
            return;
          }
        } else {
          const installScript = path.join(rootDir, 'scripts', 'install.mjs');
          
          if (fs.existsSync(installScript)) {
            console.log(chalk.gray(`Running install script${options.rebuild ? ' --rebuild' : ''}...`));
            try {
              execSync(`node scripts/install.mjs${options.rebuild ? ' --rebuild' : ''}`, { cwd: rootDir, stdio: 'inherit' });
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
  .option('--rebuild', 'Force a full build from source during bootstrap')
  .action(async (options) => {
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

    if (!fs.existsSync(startScript) || !fs.existsSync(serverDist) || options.rebuild) {
        console.log(chalk.yellow(options.rebuild ? '📦 Rebuild requested...' : '📦 Initial bootstrap required...'));
        try {
            execSync(`node scripts/install.mjs${options.rebuild ? ' --rebuild' : ''}`, { cwd: rootDir, stdio: 'inherit' });
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
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      const { data: projects } = await axios.get(`${API_URL}/projects`);
      if (options.json) {
        console.log(JSON.stringify(projects, null, 2));
        return;
      }
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

/**
 * Configure Claude Code IDE integration for an AgenFK project directory.
 * Registers the agenfk MCP server via `claude mcp add --scope user` (the official
 * Claude Code CLI approach) and updates permissions in settings.local.json.
 * Safe to re-run — removes any existing registration before adding.
 *
 * Returns true on success, false if claude CLI is unavailable or dbPath cannot
 * be determined.
 */
function configureClaudeCodeIde(rootDir: string): boolean {
    // Require the claude CLI
    try {
        execSync('claude --version', { stdio: 'ignore' });
    } catch {
        console.error(chalk.red('Error: claude CLI not found in PATH.'));
        console.error(chalk.gray('Install Claude Code from https://claude.ai/download and try again.'));
        return false;
    }

    // Resolve dbPath: ~/.agenfk/config.json → legacy mcpServers in settings.json
    let dbPath = '';
    const agenfkConfigPath = path.join(os.homedir(), '.agenfk', 'config.json');
    if (fs.existsSync(agenfkConfigPath)) {
        try {
            const cfg = JSON.parse(fs.readFileSync(agenfkConfigPath, 'utf8'));
            dbPath = cfg.dbPath || '';
        } catch {}
    }
    if (!dbPath) {
        // Fall back to legacy mcpServers entry
        const globalSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
        if (fs.existsSync(globalSettingsPath)) {
            try {
                const s = JSON.parse(fs.readFileSync(globalSettingsPath, 'utf8'));
                dbPath = s.mcpServers?.agenfk?.env?.AGENFK_DB_PATH || '';
            } catch {}
        }
    }
    if (!dbPath) {
        console.error(chalk.red('Could not determine AGENFK_DB_PATH.'));
        console.error(chalk.gray('Run "agenfk up" first to complete the installation.'));
        return false;
    }

    // The agenfk bin installed by the framework (symlink in ~/.local/bin)
    const agenfkBin = path.join(os.homedir(), '.local', 'bin', 'agenfk');

    // Remove any existing registration (idempotent)
    try {
        execSync('claude mcp remove agenfk', { stdio: 'ignore' });
    } catch {}

    // Register via the official claude mcp add CLI (user scope = available in all projects)
    const result = spawnSync('claude', [
        'mcp', 'add',
        '--transport', 'stdio',
        '--scope', 'user',
        '-e', `AGENFK_DB_PATH=${dbPath}`,
        '--',
        'agenfk',
        agenfkBin, 'mcp'
    ], { stdio: 'inherit' });

    if (result.status !== 0) {
        console.error(chalk.red('claude mcp add failed. Run "claude mcp get agenfk" to check the current state.'));
        return false;
    }
    console.log(chalk.green('✓ Registered agenfk MCP server (user scope) via claude mcp add'));

    // Clean up legacy mcpServers key from ~/.claude/settings.json if present
    const globalSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    if (fs.existsSync(globalSettingsPath)) {
        try {
            const s = JSON.parse(fs.readFileSync(globalSettingsPath, 'utf8'));
            if (s.mcpServers) {
                delete s.mcpServers;
                fs.writeFileSync(globalSettingsPath, JSON.stringify(s, null, 2), 'utf8');
                console.log(chalk.gray('  Removed legacy mcpServers from ~/.claude/settings.json'));
            }
        } catch {}
    }

    // Clean up legacy .mcp.json and enabledMcpjsonServers from .claude/settings.json
    const mcpJsonPath = path.join(rootDir, '.mcp.json');
    if (fs.existsSync(mcpJsonPath)) {
        try {
            const mcpJson = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
            if (mcpJson.mcpServers?.agenfk) {
                delete mcpJson.mcpServers.agenfk;
                if (Object.keys(mcpJson.mcpServers).length === 0) {
                    fs.unlinkSync(mcpJsonPath);
                    console.log(chalk.gray('  Removed legacy .mcp.json'));
                } else {
                    fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpJson, null, 2), 'utf8');
                }
            }
        } catch {}
    }
    const claudeDir = path.join(rootDir, '.claude');
    const projectSettingsPath = path.join(claudeDir, 'settings.json');
    if (fs.existsSync(projectSettingsPath)) {
        try {
            const ps = JSON.parse(fs.readFileSync(projectSettingsPath, 'utf8'));
            if (ps.enabledMcpjsonServers || ps.mcpServers) {
                delete ps.enabledMcpjsonServers;
                delete ps.mcpServers;
                if (Object.keys(ps).length === 0) {
                    fs.unlinkSync(projectSettingsPath);
                    console.log(chalk.gray('  Removed empty .claude/settings.json'));
                } else {
                    fs.writeFileSync(projectSettingsPath, JSON.stringify(ps, null, 2), 'utf8');
                    console.log(chalk.gray('  Cleaned up .claude/settings.json'));
                }
            }
        } catch {}
    }

    // Write MCP tool permissions to settings.local.json (machine-specific, not committed)
    if (!fs.existsSync(claudeDir)) {
        fs.mkdirSync(claudeDir, { recursive: true });
    }
    const localSettingsPath = path.join(claudeDir, 'settings.local.json');
    let localSettings: any = {};
    if (fs.existsSync(localSettingsPath)) {
        try {
            localSettings = JSON.parse(fs.readFileSync(localSettingsPath, 'utf8'));
        } catch {}
    }
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
        'mcp__agenfk__delete_item', 'mcp__agenfk__log_test_result',
    ];
    for (const perm of mcpPermissions) {
        if (!localSettings.permissions.allow.includes(perm)) {
            localSettings.permissions.allow.push(perm);
        }
    }
    fs.writeFileSync(localSettingsPath, JSON.stringify(localSettings, null, 2), 'utf8');
    console.log(chalk.green(`✓ Updated MCP tool permissions in ${localSettingsPath}`));

    return true;
}

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

        configureClaudeCodeIde(rootDir);

    } catch (e: any) {
        console.error(chalk.red('Could not connect to API server. Is it running on port 3000?'));
        if (e.response) {
            console.error(chalk.red(`Server Error: ${e.response.data.error || e.message}`));
        }
    }
  });

program
  .command('configure-ide')
  .description('Fix Claude Code MCP integration for an already-initialized project. Creates .mcp.json and updates .claude/settings.json. Safe to re-run.')
  .action(() => {
    const rootDir = process.cwd();
    const projFile = path.join(rootDir, '.agenfk', 'project.json');

    if (!fs.existsSync(projFile)) {
        console.error(chalk.red('Error: No AgenFK project found in the current directory.'));
        console.error(chalk.gray('Run "agenfk init" first to initialize a project here.'));
        process.exit(1);
    }

    console.log(chalk.blue('Configuring Claude Code IDE integration...'));
    const ok = configureClaudeCodeIde(rootDir);

    if (!ok) {
        console.error(chalk.red('Could not find agenfk MCP config in ~/.claude/settings.json.'));
        console.error(chalk.gray('The agenfk MCP server must be registered in ~/.claude/settings.json under mcpServers.'));
        process.exit(1);
    }

    console.log(chalk.green('\n✓ IDE configuration complete.'));
    console.log(chalk.gray('Restart Claude Code for the changes to take effect.'));
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
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      const query: any = {};
      if (options.type) query.type = options.type.toUpperCase();
      if (options.status) query.status = options.status.toUpperCase();

      let projectId = options.project || (options.all ? undefined : findProjectId(process.cwd()));
      if (projectId) query.projectId = projectId;

      const { data: items } = await axios.get(`${API_URL}/items`, { params: query });

      if (options.json) {
        console.log(JSON.stringify(items, null, 2));
        return;
      }

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

    telemetry.capture('cli_db_switch', { to: targetType });
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

// ── agenfk config ─────────────────────────────────────────────────────────────

const configCommand = program
  .command('config')
  .description('Manage AgenFK configuration');

const configSetCommand = configCommand
  .command('set')
  .description('Set a configuration value');

configSetCommand
  .command('telemetry <value>')
  .description('Enable or disable anonymous usage telemetry (true/false)')
  .action((value: string) => {
    const normalised = value.trim().toLowerCase();
    if (normalised !== 'true' && normalised !== 'false') {
      console.error(chalk.red('Error: value must be "true" or "false"'));
      process.exit(1);
    }
    const enabled = normalised === 'true';
    const configPath = path.join(os.homedir(), '.agenfk', 'config.json');
    try {
      let config: Record<string, unknown> = {};
      if (fs.existsSync(configPath)) {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      }
      config.telemetry = enabled;
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
      if (enabled) {
        console.log(chalk.green('Telemetry enabled.') + ' Anonymous usage data will be sent to help improve AgenFK.');
        console.log(chalk.gray('  To opt out at any time: agenfk config set telemetry false'));
      } else {
        console.log(chalk.green('Telemetry disabled.') + ' No usage data will be sent.');
        console.log(chalk.gray('  To re-enable at any time: agenfk config set telemetry true'));
      }
    } catch (err: any) {
      console.error(chalk.red('Error updating config:'), err.message);
      process.exit(1);
    }
  });

// ── MCP FALLBACK COMMANDS ─────────────────────────────────────────────────────
// These commands provide CLI parity with MCP tools for use when MCP is unavailable.

program
  .command('get <id>')
  .description('Get details of a specific item (MCP fallback: get_item)')
  .option('--json', 'Output as JSON')
  .action(async (id, options) => {
    try {
      let targetId = id;
      if (id.length < 36) {
        const { data: allItems } = await axios.get(`${API_URL}/items`);
        const found = allItems.filter((i: any) => i.id.startsWith(id));
        if (found.length === 0) { console.error(chalk.red(`No item found starting with ${id}`)); process.exit(1); }
        if (found.length > 1) { console.error(chalk.red(`Ambiguous ID ${id}, matches multiple items`)); process.exit(1); }
        targetId = found[0].id;
      }
      const { data: item } = await axios.get(`${API_URL}/items/${targetId}`);
      if (options.json) {
        console.log(JSON.stringify(item, null, 2));
      } else {
        console.log(chalk.blue(`[${item.id.substring(0,8)}] ${item.title}`));
        console.log(`  Type:        ${item.type}`);
        console.log(`  Status:      ${item.status}`);
        console.log(`  Project:     ${item.projectId}`);
        if (item.parentId) console.log(`  Parent:      ${item.parentId}`);
        if (item.description) console.log(`  Description: ${item.description}`);
        if (item.comments?.length) console.log(`  Comments:    ${item.comments.length}`);
        if (item.tokenUsage?.length) console.log(`  Token logs:  ${item.tokenUsage.length}`);
      }
    } catch (error: any) {
      console.error(chalk.red('Error fetching item:'), error.response?.data?.error || error.message);
      process.exit(1);
    }
  });

program
  .command('comment <id> <content>')
  .description('Add a comment to an item (MCP fallback: add_comment)')
  .option('--author <author>', 'Comment author', 'agent')
  .action(async (id, content, options) => {
    try {
      const { data: item } = await axios.get(`${API_URL}/items/${id}`);
      const comments = item.comments || [];
      comments.push({ id: randomUUID(), content, author: options.author, timestamp: new Date() });
      await axios.put(`${API_URL}/items/${id}`, { comments });
      console.log(chalk.green('Comment added.'));
    } catch (error: any) {
      console.error(chalk.red('Error adding comment:'), error.response?.data?.error || error.message);
      process.exit(1);
    }
  });

program
  .command('log-tokens <id>')
  .description('Log token usage for an item (MCP fallback: log_token_usage)')
  .requiredOption('--input <n>', 'Input tokens', parseInt)
  .requiredOption('--output <n>', 'Output tokens', parseInt)
  .requiredOption('--model <model>', 'Model name')
  .option('--cost <c>', 'Cost in USD', parseFloat)
  .option('--session <id>', 'Session ID for deduplication')
  .action(async (id, options) => {
    try {
      const { data: item } = await axios.get(`${API_URL}/items/${id}`);
      const tokenUsage = item.tokenUsage || [];
      const entry: any = {
        input: options.input,
        output: options.output,
        model: options.model,
        timestamp: new Date().toISOString(),
      };
      if (options.cost !== undefined) entry.cost = options.cost;
      if (options.session) entry.sessionId = options.session;
      tokenUsage.push(entry);
      await axios.put(`${API_URL}/items/${id}`, { tokenUsage });
      console.log(chalk.green('Token usage logged.'));
    } catch (error: any) {
      console.error(chalk.red('Error logging tokens:'), error.response?.data?.error || error.message);
      process.exit(1);
    }
  });

program
  .command('log-test <id>')
  .description('Log a test result for an item (MCP fallback: log_test_result)')
  .requiredOption('--command <cmd>', 'Test command that was run')
  .requiredOption('--output <text>', 'Test output')
  .requiredOption('--status <status>', 'Result status: PASSED or FAILED')
  .action(async (id, options) => {
    const status = options.status.toUpperCase();
    if (status !== 'PASSED' && status !== 'FAILED') {
      console.error(chalk.red('--status must be PASSED or FAILED'));
      process.exit(1);
    }
    try {
      const { data: item } = await axios.get(`${API_URL}/items/${id}`);
      const tests = item.tests || [];
      tests.push({ id: randomUUID(), command: options.command, output: options.output, status, executedAt: new Date() });
      await axios.put(`${API_URL}/items/${id}`, { tests });
      console.log(chalk.green(`Test result logged: ${status}`));
    } catch (error: any) {
      console.error(chalk.red('Error logging test result:'), error.response?.data?.error || error.message);
      process.exit(1);
    }
  });

program
  .command('gatekeeper')
  .description('Check workflow authorization before making changes (MCP fallback: workflow_gatekeeper)')
  .option('--intent <text>', 'Description of what you intend to do')
  .option('--role <role>', 'Role: planning|coding|review|testing|closing', 'coding')
  .option('--item-id <id>', 'Specific item ID to check against')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      const { data: items } = await axios.get(`${API_URL}/items`);
      const projectId = findProjectId(process.cwd());
      const projectItems = projectId ? items.filter((i: any) => i.projectId === projectId) : items;

      const activeItems = projectItems.filter((i: any) =>
        i.status !== 'DONE' && i.status !== 'ARCHIVED' && i.status !== 'TRASHED'
      );
      const inProgressItems = activeItems.filter((i: any) => i.status === 'IN_PROGRESS');
      const reviewItems = activeItems.filter((i: any) => i.status === 'REVIEW');
      const testItems = activeItems.filter((i: any) => i.status === 'TEST');

      const role = (options.role || 'coding').toLowerCase();
      const intent = options.intent || '(no intent provided)';
      let authorized = false;
      let message = '';
      let task: any = null;

      if (role === 'coding') {
        if (inProgressItems.length === 0) {
          message = `❌ WORKFLOW BREACH: No task is IN_PROGRESS. Create a task and set it to IN_PROGRESS first.`;
        } else if (options.itemId) {
          task = inProgressItems.find((i: any) => i.id === options.itemId || i.id.startsWith(options.itemId));
          if (!task) { message = `❌ WORKFLOW BREACH: Item [${options.itemId}] is not IN_PROGRESS.`; }
          else { authorized = true; message = `✅ AUTHORIZED (CODING).\n\nTask: [${task.id.substring(0,8)}] ${task.title}\nIntent: "${intent}"`; }
        } else if (inProgressItems.length > 1) {
          message = `⚠️ AMBIGUOUS: Multiple tasks are IN_PROGRESS. Provide --item-id to disambiguate.\n${inProgressItems.map((i: any) => `  [${i.id.substring(0,8)}] ${i.title}`).join('\n')}`;
        } else {
          task = inProgressItems[0];
          authorized = true;
          message = `✅ AUTHORIZED (CODING).\n\nTask: [${task.id.substring(0,8)}] ${task.title}\nIntent: "${intent}"`;
        }
      } else if (role === 'review') {
        const target = options.itemId ? reviewItems.find((i: any) => i.id === options.itemId || i.id.startsWith(options.itemId)) : reviewItems[0];
        if (!target) { message = `❌ WORKFLOW BREACH: No task is in REVIEW status.`; }
        else { authorized = true; task = target; message = `✅ AUTHORIZED (REVIEW).\n\nTask: [${task.id.substring(0,8)}] ${task.title}\nIntent: "${intent}"`; }
      } else if (role === 'testing') {
        const target = options.itemId ? testItems.find((i: any) => i.id === options.itemId || i.id.startsWith(options.itemId)) : testItems[0];
        if (!target) { message = `❌ WORKFLOW BREACH: No task is in TEST status.`; }
        else { authorized = true; task = target; message = `✅ AUTHORIZED (TESTING).\n\nTask: [${task.id.substring(0,8)}] ${task.title}\nIntent: "${intent}"`; }
      } else {
        // Generic: just check for IN_PROGRESS
        if (inProgressItems.length === 0) { message = `❌ WORKFLOW BREACH: No task is IN_PROGRESS.`; }
        else { authorized = true; task = inProgressItems[0]; message = `✅ WORKFLOW VALIDATED.\n\nActive Item: [${task.id.substring(0,8)}] ${task.title}\nIntent: "${intent}"`; }
      }

      if (options.json) {
        console.log(JSON.stringify({ authorized, message, task: task ? { id: task.id, title: task.title, status: task.status } : null }));
      } else {
        console.log(authorized ? chalk.green(message) : chalk.red(message));
      }
      process.exit(authorized ? 0 : 1);
    } catch (error: any) {
      console.error(chalk.red('Error checking workflow:'), error.response?.data?.error || error.message);
      process.exit(1);
    }
  });

program
  .command('verify <id> <command>')
  .description('Run verification command and transition item to REVIEW (or DONE if status is TEST). MCP fallback: verify_changes')
  .action(async (id, command) => {
    const tokenPath = path.join(os.homedir(), '.agenfk', 'verify-token');
    if (!fs.existsSync(tokenPath)) {
      console.error(chalk.red('Error: ~/.agenfk/verify-token not found.'));
      process.exit(1);
    }
    const verifyToken = fs.readFileSync(tokenPath, 'utf8').trim();
    const verifyHeaders = { 'x-agenfk-internal': verifyToken };

    let targetId = id;
    if (id.length < 36) {
      try {
        const { data: allItems } = await axios.get(`${API_URL}/items`);
        const found = allItems.filter((i: any) => i.id.startsWith(id));
        if (found.length === 0) { console.error(chalk.red(`No item found starting with ${id}`)); process.exit(1); }
        if (found.length > 1) { console.error(chalk.red(`Ambiguous ID ${id}`)); process.exit(1); }
        targetId = found[0].id;
      } catch (e: any) {
        console.error(chalk.red('Error resolving item:'), e.response?.data?.error || e.message);
        process.exit(1);
      }
    }

    console.log(chalk.blue(`Running verification: ${command}`));
    const projectRoot = process.cwd();

    const { status: exitCode, output } = await new Promise<{ status: number | null; output: string }>((resolve) => {
      const child = spawn(command, { shell: true, cwd: projectRoot, env: { ...process.env, FORCE_COLOR: '1' } });
      let out = '';
      child.stdout.on('data', (d: Buffer) => { process.stdout.write(d); out += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { process.stderr.write(d); out += d.toString(); });
      child.on('close', (code) => resolve({ status: code, output: out }));
    });

    try {
      const { data: item } = await axios.get(`${API_URL}/items/${targetId}`);
      const comments = item.comments || [];

      if (exitCode === 0) {
        const targetStatus = item.status === 'TEST' ? 'DONE' : 'REVIEW';
        const verifyLabel = item.status === 'TEST' ? 'Final Verification' : 'Initial Verification';
        comments.push({
          id: randomUUID(),
          author: 'VerifyTool',
          content: `### ${verifyLabel} PASSED\n\n**Command**: \`${command}\`\n\n**Output**:\n\`\`\`\n${output.substring(0, 2000)}${output.length > 2000 ? '\n... (truncated)' : ''}\n\`\`\``,
          timestamp: new Date()
        });
        await axios.put(`${API_URL}/items/${targetId}`, { status: targetStatus, comments }, { headers: verifyHeaders });
        console.log(chalk.green(`\n✅ Verification passed. Item moved to ${targetStatus}.`));
      } else {
        comments.push({
          id: randomUUID(),
          author: 'VerifyTool',
          content: `### Initial Verification FAILED\n\n**Command**: \`${command}\`\n\n**Output**:\n\`\`\`\n${output.substring(0, 2000)}${output.length > 2000 ? '\n... (truncated)' : ''}\n\`\`\``,
          timestamp: new Date()
        });
        await axios.put(`${API_URL}/items/${targetId}`, { status: 'IN_PROGRESS', comments });
        console.error(chalk.red('\n❌ Verification failed. Item returned to IN_PROGRESS.'));
        process.exit(1);
      }
    } catch (error: any) {
      console.error(chalk.red('Error updating item:'), error.response?.data?.error || error.message);
      process.exit(1);
    }
  });

if (process.env.NODE_ENV !== 'test') {
  program.parse(process.argv);
}
