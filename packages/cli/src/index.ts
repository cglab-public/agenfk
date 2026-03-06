import { Command } from 'commander';
import chalk from 'chalk';
import figlet from 'figlet';
import axios from 'axios';
import { ItemType, Status, slugifyTitle } from '@agenfk/core';
import { TelemetryClient } from '@agenfk/telemetry';
import { execSync, spawn, spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

const program = new Command();
const API_URL = process.env.AGENFK_API_URL || "http://localhost:3000";
const INTEGRATION_ALIASES: Record<string, string> = {
  claude: 'claude',
  'claude-code': 'claude',
  opencode: 'opencode',
  cursor: 'cursor',
  codex: 'codex',
  gemini: 'gemini',
  'gemini-cli': 'gemini',
};
const INTEGRATION_LABELS: Record<string, string> = {
  claude: 'Claude Code',
  opencode: 'Opencode',
  cursor: 'Cursor',
  codex: 'Codex',
  gemini: 'Gemini CLI',
};

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

function resolveIntegrationPlatform(platform: string): string {
  const normalized = platform.trim().toLowerCase();
  const resolved = INTEGRATION_ALIASES[normalized];

  if (!resolved) {
    console.error(chalk.red(`Unknown integration: ${platform}`));
    console.error(chalk.gray(`Supported integrations: ${Object.keys(INTEGRATION_LABELS).join(', ')}`));
    process.exit(1);
  }

  return resolved;
}

function runIntegrationScript(scriptName: string, args: string[]) {
  const rootDir = path.resolve(__dirname, '../../..');
  const scriptPath = path.join(rootDir, 'scripts', scriptName);
  const result = spawnSync('node', [scriptPath, ...args], { cwd: rootDir, stdio: 'inherit' });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
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

            // Clean stale dist/ to prevent type mismatches with new source
            console.log(chalk.gray('Cleaning stale build artifacts...'));
            const distDirs = ['packages/core/dist', 'packages/storage-json/dist', 'packages/storage-sqlite/dist', 'packages/telemetry/dist', 'packages/cli/dist', 'packages/server/dist'];
            for (const d of distDirs) {
              const p = path.join(rootDir, d);
              if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
            }

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
  .option('--easter-eggs', 'Enable easter egg animations')
  .action(async (options) => {
    const rootDir = path.resolve(__dirname, '../../..');
    console.log(chalk.blue('🚀 Bringing up AgenFK Engineering Framework (agenfk)...'));

    // 0. Cleanup zombies
    console.log(chalk.gray('🧹 Cleaning up zombie processes...'));
    killPort(3000); // API
    killPort(5173); // UI default
    killPattern('packages/server/dist/server.js');
    killPattern('packages/ui');

    // 1. Only bootstrap if start-services.mjs or any required dist is missing
    const startScript = path.join(rootDir, 'scripts', 'start-services.mjs');
    const requiredDists = [
        path.join(rootDir, 'packages/server/dist/server.js'),
        path.join(rootDir, 'packages/storage-sqlite/dist/index.js'),
        path.join(rootDir, 'packages/storage-json/dist/index.js'),
        path.join(rootDir, 'packages/core/dist/index.js'),
    ];
    const missingDist = requiredDists.some(d => !fs.existsSync(d));

    if (!fs.existsSync(startScript) || missingDist || options.rebuild) {
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
        const startEnv = { ...process.env };
        if (options.easterEggs) startEnv.VITE_EASTER_EGGS = 'true';
        const start = spawn('node', ['scripts/start-services.mjs'], { cwd: rootDir, stdio: 'inherit', env: startEnv });
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
  .command('kill')
  .description('Force kill all AgenFK related processes and ports (aggressive cleanup)')
  .action(() => {
    console.log(chalk.red('🧹 Aggressively killing all AgenFK related processes...'));

    // Kill by port
    console.log(chalk.gray('  - Killing processes on port 3000 (API)...'));
    killPort(3000);
    console.log(chalk.gray('  - Killing processes on port 5173 (UI)...'));
    killPort(5173);

    // Kill by pattern
    console.log(chalk.gray('  - Killing API server processes...'));
    killPattern('packages/server/dist/server.js');
    console.log(chalk.gray('  - Killing UI server processes...'));
    killPattern('packages/ui');
    console.log(chalk.gray('  - Killing MCP server processes...'));
    killPattern('packages/server/dist/index.js');
    
    console.log(chalk.green('\n✅ Cleanup complete.'));
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
        'mcp__agenfk__workflow_gatekeeper', 'mcp__agenfk__review_changes',
        'mcp__agenfk__test_changes', 'mcp__agenfk__log_token_usage',
        'mcp__agenfk__analyze_request', 'mcp__agenfk__get_server_info',
        'mcp__agenfk__add_context', 'mcp__agenfk__delete_item',
        'mcp__agenfk__log_test_result', 'mcp__agenfk__update_project',
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

const integrationCommand = program
  .command('integration')
  .description('Manage individual AI editor and agent integrations');

integrationCommand
  .command('list')
  .description('List supported integrations')
  .action(() => {
    console.table(
      Object.entries(INTEGRATION_LABELS).map(([id, label]) => ({
        ID: id,
        Name: label,
      }))
    );
  });

integrationCommand
  .command('install <platform>')
  .description('Install or refresh a single integration without running the full framework installer')
  .option('--rebuild', 'Force a rebuild before installing the integration')
  .action((platform, options) => {
    const resolvedPlatform = resolveIntegrationPlatform(platform);
    const args = [`--only=${resolvedPlatform}`];

    if (options.rebuild) {
      args.push('--rebuild');
    }

    console.log(chalk.blue(`Installing ${INTEGRATION_LABELS[resolvedPlatform]} integration...`));
    runIntegrationScript('install.mjs', args);
  });

integrationCommand
  .command('uninstall <platform>')
  .description('Remove a single integration without uninstalling the full framework')
  .option('-y, --yes', 'Skip confirmation prompts')
  .action((platform, options) => {
    const resolvedPlatform = resolveIntegrationPlatform(platform);
    const args = [`--only=${resolvedPlatform}`];

    if (options.yes) {
      args.push('--yes');
    }

    console.log(chalk.blue(`Removing ${INTEGRATION_LABELS[resolvedPlatform]} integration...`));
    runIntegrationScript('uninstall.mjs', args);
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
  .option('--type <type>', 'New type (EPIC, STORY, TASK, BUG)')
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
      if (options.type) updates.type = options.type.toUpperCase();

      const { data: updated } = await axios.put(`${API_URL}/items/${targetId}`, updates);
      console.log(chalk.green(`Updated item: ${updated.title} [${updated.type}] (${updated.status})`));
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
  .command('move <id> <targetProjectId>')
  .description('Move an item and all its children to another project')
  .action(async (id, targetProjectId) => {
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

      const { data } = await axios.post(`${API_URL}/items/${targetId}/move`, { targetProjectId });
      const { item, movedCount } = data;
      console.log(chalk.green(`✓ Moved "${item.title}" and ${movedCount - 1} child item(s) to project ${targetProjectId}`));
    } catch (error: any) {
      const msg = error.response?.data?.error || error.message;
      console.error(chalk.red('Error moving item:'), msg);
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

// ── agenfk github ────────────────────────────────────────────────────────────

const githubCommand = program
  .command('github')
  .description('GitHub Issues import integration');

githubCommand
  .command('setup')
  .description('Link the current project to a GitHub repository for issue import')
  .option('--owner <owner>', 'GitHub repository owner')
  .option('--repo <repo>', 'GitHub repository name')
  .action(async (options: { owner?: string; repo?: string }) => {
    // 1. Verify gh CLI is installed and authenticated
    try {
      execSync('gh auth status', { stdio: 'pipe' });
    } catch {
      console.error(chalk.red('\nError: GitHub CLI (gh) is not installed or not authenticated.'));
      console.log(chalk.white('  Install: https://cli.github.com/'));
      console.log(chalk.white('  Authenticate: gh auth login'));
      process.exit(1);
    }

    // 2. Resolve project ID
    const projectId = findProjectId(process.cwd());
    if (!projectId) {
      console.error(chalk.red('\nError: No AgenFK project found. Run `agenfk init` first.'));
      process.exit(1);
    }

    // 3. Determine owner/repo
    let owner = options.owner;
    let repo = options.repo;

    if (!owner || !repo) {
      // Try to detect from git remote
      try {
        const remoteUrl = execSync('git remote get-url origin', { encoding: 'utf8' }).trim();
        const match = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
        if (match) {
          owner = owner || match[1];
          repo = repo || match[2];
          console.log(chalk.gray(`\nDetected from git remote: ${owner}/${repo}`));
        }
      } catch { /* no git remote */ }
    }

    if (!owner || !repo) {
      // Interactive fallback
      const readline = await import('readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const ask = (q: string): Promise<string> =>
        new Promise((resolve) => rl.question(q, (a: string) => resolve(a.trim())));

      console.log(chalk.blue('\nGitHub Repository Setup\n'));
      if (!owner) owner = await ask(chalk.white('Repository owner (org or username): '));
      if (!repo) repo = await ask(chalk.white('Repository name: '));
      rl.close();
    }

    if (!owner || !repo) {
      console.error(chalk.red('\nError: Owner and repo are required.'));
      process.exit(1);
    }

    // 4. Verify the repo exists and is accessible
    try {
      execSync(`gh repo view ${owner}/${repo} --json name`, { stdio: 'pipe' });
    } catch {
      console.error(chalk.red(`\nError: Cannot access repository ${owner}/${repo}.`));
      console.log(chalk.white('  Check that the repo exists and you have access.'));
      process.exit(1);
    }

    // 5. Write to config
    const configPath = path.join(os.homedir(), '.agenfk', 'config.json');
    let config: any = {};
    if (fs.existsSync(configPath)) {
      try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { /* ignore */ }
    }

    if (!config.github) config.github = { repos: {} };
    if (!config.github.repos) config.github.repos = {};

    config.github.repos[projectId] = {
      owner,
      repo,
    };

    const agenfkDir = path.join(os.homedir(), '.agenfk');
    if (!fs.existsSync(agenfkDir)) fs.mkdirSync(agenfkDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    console.log(chalk.green(`\nGitHub import configured for project ${projectId}!`));
    console.log(chalk.gray(`  Repository: ${owner}/${repo}`));
    console.log(chalk.blue('\nNext steps:'));
    console.log(chalk.white('  Import issues from the AgenFK dashboard using the GitHub import button.'));
  });

githubCommand
  .command('status')
  .description('Show GitHub import configuration and connection status')
  .action(async () => {
    console.log(chalk.blue('\nGitHub Import Status\n'));

    const projectId = findProjectId(process.cwd());

    // Config check
    const configPath = path.join(os.homedir(), '.agenfk', 'config.json');
    let ghConfig: any = null;
    if (fs.existsSync(configPath)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (projectId && cfg.github?.repos?.[projectId]) {
          ghConfig = cfg.github.repos[projectId];
        }
      } catch { /* ignore */ }
    }

    if (ghConfig) {
      console.log(chalk.green('  Configuration: ✓ Configured'));
      console.log(chalk.gray(`    Repository:    ${ghConfig.owner}/${ghConfig.repo}`));
    } else {
      console.log(chalk.yellow('  Configuration: ✗ Not configured'));
      if (!projectId) {
        console.log(chalk.white('    No AgenFK project found. Run `agenfk init` first.'));
      } else {
        console.log(chalk.white('    Run: agenfk github setup'));
      }
    }

    // gh CLI check
    try {
      execSync('gh auth status', { stdio: 'pipe' });
      console.log(chalk.green('\n  GitHub CLI:    ✓ Authenticated'));
    } catch {
      console.log(chalk.yellow('\n  GitHub CLI:    ✗ Not authenticated'));
      console.log(chalk.white('    Run: gh auth login'));
    }

    // Live server status
    try {
      const { data } = await axios.get(`${API_URL}/github/status`, { timeout: 2000 });
      console.log(chalk.blue(`\n  Live Server:   ${data.configured ? chalk.green('✓ Configured') : chalk.yellow('✗ Not configured')}`));
    } catch {
      console.log(chalk.gray('\n  Live Server:   (server not reachable)'));
    }

    console.log('');
  });

githubCommand
  .command('disconnect')
  .description('Remove GitHub import configuration for the current project')
  .action(async () => {
    const projectId = findProjectId(process.cwd());
    if (!projectId) {
      console.log(chalk.yellow('No AgenFK project found.'));
      return;
    }

    const configPath = path.join(os.homedir(), '.agenfk', 'config.json');
    if (!fs.existsSync(configPath)) {
      console.log(chalk.yellow('No GitHub configuration found — already disconnected.'));
      return;
    }

    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (config.github?.repos?.[projectId]) {
        delete config.github.repos[projectId];
        // Clean up empty repos object
        if (Object.keys(config.github.repos).length === 0) {
          delete config.github;
        }
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        console.log(chalk.green('GitHub import configuration removed for this project.'));
      } else {
        console.log(chalk.yellow('No GitHub configuration found for this project.'));
      }
    } catch {
      console.log(chalk.yellow('Could not read configuration file.'));
    }
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
  .command('review <id> <command>')
  .description('Run agent-chosen command and transition item IN_PROGRESS → REVIEW. MCP fallback: review_changes')
  .action(async (id, command) => {
    const tokenPath = path.join(os.homedir(), '.agenfk', 'verify-token');
    if (!fs.existsSync(tokenPath)) {
      console.error(chalk.red('Error: ~/.agenfk/verify-token not found.'));
      process.exit(1);
    }
    const verifyToken = fs.readFileSync(tokenPath, 'utf8').trim();

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

    console.log(chalk.blue(`Running review: ${command}`));
    try {
      const { data } = await axios.post(
        `${API_URL}/items/${targetId}/review`,
        { command },
        { headers: { 'x-agenfk-internal': verifyToken } }
      );
      if (data.output) console.log(data.output);
      console.log(chalk.green(`\n✅ Review passed. Item moved to ${data.status}.`));
    } catch (error: any) {
      const errData = error.response?.data;
      if (errData?.output) console.error(errData.output);
      console.error(chalk.red(`\n❌ ${errData?.message || error.message}`));
      process.exit(1);
    }
  });

program
  .command('test <id>')
  .description('Run project verifyCommand and transition item TEST → DONE. MCP fallback: test_changes')
  .action(async (id) => {
    const tokenPath = path.join(os.homedir(), '.agenfk', 'verify-token');
    if (!fs.existsSync(tokenPath)) {
      console.error(chalk.red('Error: ~/.agenfk/verify-token not found.'));
      process.exit(1);
    }
    const verifyToken = fs.readFileSync(tokenPath, 'utf8').trim();

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

    console.log(chalk.blue(`Running project test suite...`));
    try {
      const { data } = await axios.post(
        `${API_URL}/items/${targetId}/test`,
        {},
        { headers: { 'x-agenfk-internal': verifyToken } }
      );
      if (data.output) console.log(data.output);
      console.log(chalk.green(`\n✅ Tests passed. Item moved to ${data.status}.`));
    } catch (error: any) {
      const errData = error.response?.data;
      if (errData?.output) console.error(errData.output);
      console.error(chalk.red(`\n❌ ${errData?.message || error.message}`));
      process.exit(1);
    }
  });

// ── Branch commands ──────────────────────────────────────────────────────────

const branchCmd = program
  .command('branch')
  .description('Manage git branches for AgenFK items');

branchCmd
  .command('create <itemId>')
  .description('Create a git branch for an item (BUG → fix/, others → feature/). Stores branch name on the item.')
  .option('--name <name>', 'Override the generated branch name (prefix is still enforced)')
  .action(async (itemId, options) => {
    try {
      const { data: item } = await axios.get(`${API_URL}/items/${itemId}`);
      if (item.parentId) {
        console.error(chalk.red(`❌ Branches are tracked on top-level items only. Item [${itemId.substring(0, 8)}] is a child of [${item.parentId.substring(0, 8)}]. Run this command on the parent item instead.`));
        process.exit(1);
      }
      const prefix = item.type === 'BUG' ? 'fix' : 'feature';
      const slug = options.name ? options.name.replace(/^(feature|fix)\//, '') : slugifyTitle(item.title);
      const branchName = `${prefix}/${slug}`;

      console.log(chalk.blue(`Creating branch: ${branchName}`));
      try {
        execSync(`git checkout -b ${branchName}`, { stdio: 'inherit' });
      } catch {
        console.error(chalk.red(`Failed to create branch. Does it already exist? Try: git checkout ${branchName}`));
        process.exit(1);
      }

      await axios.put(`${API_URL}/items/${itemId}`, { branchName });
      console.log(chalk.green(`✅ Branch '${branchName}' created and linked to item [${itemId.substring(0, 8)}].`));
    } catch (e: any) {
      console.error(chalk.red('Error:'), e.response?.data?.error || e.message);
      process.exit(1);
    }
  });

branchCmd
  .command('push <itemId>')
  .description('Push the item\'s tracked branch to remote (no-op if no remote configured)')
  .action(async (itemId) => {
    try {
      const { data: item } = await axios.get(`${API_URL}/items/${itemId}`);
      if (!item.branchName) {
        console.error(chalk.yellow(`⚠ No branch linked to item [${itemId.substring(0, 8)}]. Run 'agenfk branch create' first.`));
        process.exit(1);
      }

      let hasRemote = false;
      try {
        const remotes = execSync('git remote', { encoding: 'utf8' }).trim();
        hasRemote = remotes.length > 0;
      } catch { /* not a git repo */ }

      if (!hasRemote) {
        console.log(chalk.yellow('ℹ No git remote configured — skipping push.'));
        return;
      }

      console.log(chalk.blue(`Pushing branch '${item.branchName}' to remote...`));
      execSync(`git push -u origin ${item.branchName}`, { stdio: 'inherit' });
      console.log(chalk.green(`✅ Branch '${item.branchName}' pushed to remote.`));
    } catch (e: any) {
      console.error(chalk.red('Error:'), e.response?.data?.error || e.message);
      process.exit(1);
    }
  });

branchCmd
  .command('status <itemId>')
  .description('Show the branch linked to an item and whether it has been pushed to remote')
  .action(async (itemId) => {
    try {
      const { data: item } = await axios.get(`${API_URL}/items/${itemId}`);
      if (!item.branchName) {
        console.log(chalk.yellow(`No branch linked to item [${itemId.substring(0, 8)}].`));
        return;
      }

      console.log(`Branch: ${chalk.cyan(item.branchName)}`);

      try {
        const remoteBranches = execSync('git branch -r', { encoding: 'utf8' });
        const pushed = remoteBranches.split('\n').some(b => b.trim().endsWith(item.branchName));
        console.log(`Remote: ${pushed ? chalk.green('pushed') : chalk.yellow('not pushed yet')}`);
      } catch {
        console.log(`Remote: ${chalk.dim('(not in a git repo)')}`);
      }
    } catch (e: any) {
      console.error(chalk.red('Error:'), e.response?.data?.error || e.message);
      process.exit(1);
    }
  });

// ── PR commands ───────────────────────────────────────────────────────────────

function checkGhCli(): boolean {
  try {
    execSync('gh --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const prCmd = program
  .command('pr')
  .description('Manage pull requests for AgenFK items (requires GitHub CLI)');

prCmd
  .command('create <itemId>')
  .description('Create a pull request for the item\'s branch and store the PR URL/number on the item')
  .option('--title <title>', 'PR title (defaults to item title)')
  .option('--body <body>', 'PR body/description')
  .option('--draft', 'Create as a draft PR')
  .action(async (itemId, options) => {
    if (!checkGhCli()) {
      console.error(chalk.red('❌ GitHub CLI (gh) is not installed or not in PATH. Install from https://cli.github.com/'));
      process.exit(1);
    }
    try {
      const { data: item } = await axios.get(`${API_URL}/items/${itemId}`);
      if (item.parentId) {
        console.error(chalk.red(`❌ PRs are tracked on top-level items only. Item [${itemId.substring(0, 8)}] is a child of [${item.parentId.substring(0, 8)}]. Run this command on the parent item instead.`));
        process.exit(1);
      }
      const prTitle = options.title || item.title;
      const args = ['pr', 'create', '--title', prTitle];
      if (options.body) { args.push('--body', options.body); } else { args.push('--body', item.description || ''); }
      if (options.draft) args.push('--draft');

      console.log(chalk.blue(`Creating PR: "${prTitle}"...`));
      let output: string;
      try {
        const result = spawnSync('gh', args, { encoding: 'utf8' });
        if (result.status !== 0) {
          console.error(chalk.red(`❌ gh pr create failed:\n${result.stderr || result.stdout}`));
          process.exit(1);
        }
        output = (result.stdout || '').trim();
      } catch (e: any) {
        console.error(chalk.red(`❌ gh pr create failed: ${e.message}`));
        process.exit(1);
      }

      // gh outputs the PR URL as the last line
      const prUrl = output.split('\n').filter(Boolean).pop() || '';
      const prNumberMatch = prUrl.match(/\/pull\/(\d+)$/);
      const prNumber = prNumberMatch ? parseInt(prNumberMatch[1], 10) : undefined;

      await axios.put(`${API_URL}/items/${itemId}`, { prUrl, prNumber, prStatus: 'open' });
      console.log(chalk.green(`✅ PR created: ${prUrl}`));
      if (prNumber) console.log(chalk.dim(`   PR #${prNumber} linked to item [${itemId.substring(0, 8)}]`));
      console.log(chalk.cyan('\nWhen your PR is approved and merged, run /agenfk-release to create a release.'));
    } catch (e: any) {
      console.error(chalk.red('Error:'), e.response?.data?.error || e.message);
      process.exit(1);
    }
  });

prCmd
  .command('status <itemId>')
  .description('Check the current status of the PR linked to an item')
  .action(async (itemId) => {
    if (!checkGhCli()) {
      console.error(chalk.red('❌ GitHub CLI (gh) is not installed. Install from https://cli.github.com/'));
      process.exit(1);
    }
    try {
      const { data: item } = await axios.get(`${API_URL}/items/${itemId}`);
      if (!item.prNumber && !item.prUrl) {
        console.log(chalk.yellow(`No PR linked to item [${itemId.substring(0, 8)}]. Run 'agenfk pr create' first.`));
        return;
      }
      const ref = item.prNumber || item.prUrl;
      let result: any;
      try {
        const raw = execSync(`gh pr view ${ref} --json state,title,url`, { encoding: 'utf8' });
        result = JSON.parse(raw);
      } catch (e: any) {
        console.error(chalk.red(`❌ gh pr view failed: ${e.message}`));
        process.exit(1);
      }

      const stateColour: Record<string, any> = { open: chalk.yellow, merged: chalk.green, closed: chalk.red, draft: chalk.dim };
      const colour = stateColour[result.state] || chalk.white;
      console.log(`PR:     ${chalk.cyan(result.title)}`);
      console.log(`Status: ${colour(result.state.toUpperCase())}`);
      console.log(`URL:    ${result.url}`);

      const prStatus = result.state as 'open' | 'merged' | 'closed' | 'draft';
      await axios.put(`${API_URL}/items/${itemId}`, { prStatus });
    } catch (e: any) {
      console.error(chalk.red('Error:'), e.response?.data?.error || e.message);
      process.exit(1);
    }
  });

prCmd
  .command('check <itemId>')
  .description('Check whether the PR linked to an item is merged (one-shot, for use before releasing)')
  .action(async (itemId) => {
    if (!checkGhCli()) {
      console.error(chalk.red('❌ GitHub CLI (gh) is not installed. Install from https://cli.github.com/'));
      process.exit(1);
    }
    try {
      const { data: item } = await axios.get(`${API_URL}/items/${itemId}`);
      if (!item.prNumber && !item.prUrl) {
        console.log(chalk.yellow(`No PR linked to item [${itemId.substring(0, 8)}]. Run 'agenfk pr create' first.`));
        process.exit(1);
      }
      const ref = item.prNumber || item.prUrl;
      let result: any;
      try {
        const raw = execSync(`gh pr view ${ref} --json state,title,url`, { encoding: 'utf8' });
        result = JSON.parse(raw);
      } catch (e: any) {
        console.error(chalk.red(`❌ gh pr view failed: ${e.message}`));
        process.exit(1);
      }

      const prStatus = result.state as 'open' | 'merged' | 'closed' | 'draft';
      await axios.put(`${API_URL}/items/${itemId}`, { prStatus });

      if (result.state === 'merged') {
        console.log(chalk.green(`✅ PR #${item.prNumber} is merged: "${result.title}"`));
        console.log(chalk.cyan('You can now run /agenfk-release to create a release.'));
        process.exit(0);
      } else if (result.state === 'closed') {
        console.log(chalk.red(`⚠ PR #${item.prNumber} was closed without merging.`));
        process.exit(1);
      } else {
        console.log(chalk.yellow(`PR #${item.prNumber} is ${result.state}: "${result.title}"`));
        console.log(chalk.dim('Run /agenfk-release once the PR is merged.'));
        process.exit(1);
      }
    } catch (e: any) {
      console.error(chalk.red('Error:'), e.response?.data?.error || e.message);
      process.exit(1);
    }
  });

// ── Flow Commands ─────────────────────────────────────────────────────────────

const flowCommand = program
  .command('flow')
  .description('Manage workflow flows (list, show, create, edit, use, reset)');

flowCommand
  .command('list')
  .description('List all flows')
  .action(async () => {
    try {
      const { data: flows } = await axios.get(`${API_URL}/flows`);
      if (flows.length === 0) {
        console.log(chalk.yellow('No flows found.'));
        return;
      }
      console.table(flows.map((f: any) => ({
        ID: f.id.substring(0, 8),
        Name: f.name,
        Steps: f.steps ? f.steps.length : 0,
        Project: f.projectId ? f.projectId.substring(0, 8) : '-',
      })));
    } catch (error: any) {
      console.error(chalk.red('Error listing flows:'), error.response?.data?.error || error.message);
    }
  });

flowCommand
  .command('show <id>')
  .description('Show a flow and its steps in order')
  .action(async (id) => {
    try {
      const { data: flow } = await axios.get(`${API_URL}/flows/${id}`);
      console.log(chalk.blue(`\nFlow: ${flow.name}`));
      if (flow.description) console.log(chalk.gray(`Description: ${flow.description}`));
      console.log(chalk.gray(`Project: ${flow.projectId}`));
      console.log();
      if (!flow.steps || flow.steps.length === 0) {
        console.log(chalk.yellow('No steps defined.'));
        return;
      }
      const sorted = [...flow.steps].sort((a: any, b: any) => a.order - b.order);
      console.table(sorted.map((s: any) => ({
        Order: s.order,
        Name: s.name,
        Label: s.label,
        Special: s.isSpecial ? 'yes' : 'no',
        'Exit Criteria': s.exitCriteria ? s.exitCriteria.substring(0, 50) : '-',
      })));
    } catch (error: any) {
      console.error(chalk.red('Error showing flow:'), error.response?.data?.error || error.message);
    }
  });

flowCommand
  .command('create <name>')
  .description('Interactively create a new flow')
  .option('--project <projectId>', 'Project ID to scope this flow to')
  .action(async (name, options) => {
    try {
      const inquirer = (await import('inquirer')).default;

      const projectId = options.project || findProjectId(process.cwd());
      if (!projectId) {
        console.error(chalk.red('Error: Project ID is required. Use --project <id> or initialize with agenfk init.'));
        process.exit(1);
      }

      const { description } = await inquirer.prompt([
        { type: 'input', name: 'description', message: 'Flow description (optional):' },
      ]);

      const steps: any[] = [];
      let addMore = true;
      let order = 1;

      console.log(chalk.blue('\nAdd steps to the flow (leave name blank to finish):'));

      while (addMore) {
        const stepAnswers = await inquirer.prompt([
          { type: 'input', name: 'stepName', message: `Step ${order} name (or blank to finish):` },
        ]);

        if (!stepAnswers.stepName.trim()) {
          addMore = false;
          break;
        }

        const stepDetails = await inquirer.prompt([
          { type: 'input', name: 'label', message: 'Display label:', default: stepAnswers.stepName },
          { type: 'input', name: 'exitCriteria', message: 'Exit criteria (optional):' },
          { type: 'confirm', name: 'isSpecial', message: 'Is this a terminal/special step?', default: false },
        ]);

        steps.push({
          id: randomUUID(),
          name: stepAnswers.stepName.trim(),
          label: stepDetails.label.trim() || stepAnswers.stepName.trim(),
          order,
          exitCriteria: stepDetails.exitCriteria.trim() || undefined,
          isSpecial: stepDetails.isSpecial,
        });
        order++;
      }

      const { data } = await axios.post(`${API_URL}/flows`, { name, description, projectId, steps });
      console.log(chalk.green(`\nCreated flow: ${data.name} (ID: ${data.id}) with ${data.steps.length} step(s)`));
    } catch (error: any) {
      console.error(chalk.red('Error creating flow:'), error.response?.data?.error || error.message);
    }
  });

flowCommand
  .command('edit <id>')
  .description('Interactively edit an existing flow')
  .action(async (id) => {
    try {
      const inquirer = (await import('inquirer')).default;

      const { data: flow } = await axios.get(`${API_URL}/flows/${id}`);
      let steps: any[] = [...(flow.steps || [])].sort((a: any, b: any) => a.order - b.order);

      let done = false;
      while (!done) {
        const stepList = steps.map((s: any, i: number) => `${i + 1}. [${s.order}] ${s.name} (${s.label})`).join('\n') || '  (no steps)';
        console.log(chalk.blue(`\nFlow: ${flow.name}\nSteps:\n${stepList}\n`));

        const { action } = await inquirer.prompt([
          {
            type: 'list',
            name: 'action',
            message: 'What would you like to do?',
            choices: [
              { name: 'Add step', value: 'add' },
              { name: 'Remove step', value: 'remove' },
              { name: 'Reorder step', value: 'reorder' },
              { name: 'Edit step', value: 'edit' },
              { name: 'Save and exit', value: 'save' },
              { name: 'Cancel', value: 'cancel' },
            ],
          },
        ]);

        if (action === 'cancel') {
          console.log(chalk.yellow('Edit cancelled.'));
          return;
        }

        if (action === 'save') {
          done = true;
          break;
        }

        if (action === 'add') {
          const ans = await inquirer.prompt([
            { type: 'input', name: 'name', message: 'Step name:' },
            { type: 'input', name: 'label', message: 'Display label:' },
            { type: 'input', name: 'exitCriteria', message: 'Exit criteria (optional):' },
            { type: 'confirm', name: 'isSpecial', message: 'Is this a terminal/special step?', default: false },
          ]);
          const maxOrder = steps.reduce((m: number, s: any) => Math.max(m, s.order), 0);
          steps.push({
            id: randomUUID(),
            name: ans.name.trim(),
            label: ans.label.trim() || ans.name.trim(),
            order: maxOrder + 1,
            exitCriteria: ans.exitCriteria.trim() || undefined,
            isSpecial: ans.isSpecial,
          });
        } else if (action === 'remove') {
          if (steps.length === 0) { console.log(chalk.yellow('No steps to remove.')); continue; }
          const { stepToRemove } = await inquirer.prompt([
            {
              type: 'list',
              name: 'stepToRemove',
              message: 'Select step to remove:',
              choices: steps.map((s: any) => ({ name: `${s.name} (${s.label})`, value: s.id })),
            },
          ]);
          steps = steps.filter((s: any) => s.id !== stepToRemove);
        } else if (action === 'reorder') {
          if (steps.length < 2) { console.log(chalk.yellow('Need at least 2 steps to reorder.')); continue; }
          const { stepToMove } = await inquirer.prompt([
            {
              type: 'list',
              name: 'stepToMove',
              message: 'Select step to move:',
              choices: steps.map((s: any) => ({ name: `${s.name} (order: ${s.order})`, value: s.id })),
            },
          ]);
          const { newOrder } = await inquirer.prompt([
            { type: 'number', name: 'newOrder', message: 'New order number:' },
          ]);
          steps = steps.map((s: any) => s.id === stepToMove ? { ...s, order: newOrder } : s)
            .sort((a: any, b: any) => a.order - b.order);
        } else if (action === 'edit') {
          if (steps.length === 0) { console.log(chalk.yellow('No steps to edit.')); continue; }
          const { stepToEdit } = await inquirer.prompt([
            {
              type: 'list',
              name: 'stepToEdit',
              message: 'Select step to edit:',
              choices: steps.map((s: any) => ({ name: `${s.name} (${s.label})`, value: s.id })),
            },
          ]);
          const step = steps.find((s: any) => s.id === stepToEdit);
          const ans = await inquirer.prompt([
            { type: 'input', name: 'name', message: 'Step name:', default: step.name },
            { type: 'input', name: 'label', message: 'Display label:', default: step.label },
            { type: 'input', name: 'exitCriteria', message: 'Exit criteria:', default: step.exitCriteria || '' },
            { type: 'confirm', name: 'isSpecial', message: 'Terminal/special step?', default: step.isSpecial || false },
          ]);
          steps = steps.map((s: any) => s.id === stepToEdit ? {
            ...s,
            name: ans.name.trim(),
            label: ans.label.trim(),
            exitCriteria: ans.exitCriteria.trim() || undefined,
            isSpecial: ans.isSpecial,
          } : s);
        }
      }

      const { data: updated } = await axios.put(`${API_URL}/flows/${id}`, { ...flow, steps });
      console.log(chalk.green(`\nSaved flow: ${updated.name} (${updated.steps.length} step(s))`));
    } catch (error: any) {
      console.error(chalk.red('Error editing flow:'), error.response?.data?.error || error.message);
    }
  });

flowCommand
  .command('use <id>')
  .description('Activate a flow for a project')
  .option('--project <projectId>', 'Project ID (defaults to current project)')
  .action(async (id, options) => {
    try {
      const projectId = options.project || findProjectId(process.cwd());
      if (!projectId) {
        console.error(chalk.red('Error: Project ID is required. Use --project <id> or initialize with agenfk init.'));
        process.exit(1);
      }
      await axios.post(`${API_URL}/projects/${projectId}/flow`, { flowId: id });
      console.log(chalk.green(`Flow ${id} activated for project ${projectId}.`));
    } catch (error: any) {
      console.error(chalk.red('Error activating flow:'), error.response?.data?.error || error.message);
    }
  });

flowCommand
  .command('reset')
  .description('Reset project flow to the default')
  .option('--project <projectId>', 'Project ID (defaults to current project)')
  .action(async (options) => {
    try {
      const projectId = options.project || findProjectId(process.cwd());
      if (!projectId) {
        console.error(chalk.red('Error: Project ID is required. Use --project <id> or initialize with agenfk init.'));
        process.exit(1);
      }
      await axios.post(`${API_URL}/projects/${projectId}/flow`, { flowId: null });
      console.log(chalk.green(`Project ${projectId} flow reset to default.`));
    } catch (error: any) {
      console.error(chalk.red('Error resetting flow:'), error.response?.data?.error || error.message);
    }
  });

if (process.env.NODE_ENV !== 'test') {
  program.parse(process.argv);
}
