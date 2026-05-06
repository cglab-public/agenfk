import { Command } from 'commander';
import chalk from 'chalk';
import axios from 'axios';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { exec, execFileSync, execSync, spawn } from 'child_process';
import { getApiUrl, getInstallationId } from '@agenfk/telemetry';

function readGitConfig(key: string): string | null {
  try {
    return execFileSync('git', ['config', '--get', key], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500,
    }).trim() || null;
  } catch {
    return null;
  }
}

function localInstallationIdentity(): { installationId: string; osUser: string; gitName: string | null; gitEmail: string | null } {
  return {
    installationId: getInstallationId(),
    osUser: os.userInfo().username,
    gitName: readGitConfig('user.name'),
    gitEmail: readGitConfig('user.email'),
  };
}

const HUB_CONFIG_FILE = path.join(os.homedir(), '.agenfk', 'hub.json');
const VERIFY_TOKEN_FILE = path.join(os.homedir(), '.agenfk', 'verify-token');

interface HubConfig { url: string; token: string; orgId: string }

function readHubConfig(): HubConfig | null {
  try {
    return JSON.parse(fs.readFileSync(HUB_CONFIG_FILE, 'utf8')) as HubConfig;
  } catch {
    return null;
  }
}

function writeHubConfig(cfg: HubConfig): void {
  fs.mkdirSync(path.dirname(HUB_CONFIG_FILE), { recursive: true });
  fs.writeFileSync(HUB_CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  // Re-apply mode in case the file already existed without 600 perms.
  try { fs.chmodSync(HUB_CONFIG_FILE, 0o600); } catch { /* ignore */ }
}

function readVerifyToken(): string | null {
  try { return fs.readFileSync(VERIFY_TOKEN_FILE, 'utf8').trim() || null; } catch { return null; }
}

export function registerHubCommands(program: Command): void {
  const hub = program.command('hub').description('Corporate Hub: forward events to a self-hosted fleet metrics server');

  hub
    .command('login')
    .description('Configure this installation to push events to a corporate Hub')
    .requiredOption('--url <url>', 'Hub base URL, e.g. https://hub.acme.com')
    .option('--token <token>', 'Installation API key (legacy: skips browser flow)')
    .option('--org <orgId>', 'Org identifier (only required with --token)')
    .option('--no-open', 'Do not auto-open the browser; just print the URL')
    .action(async (opts) => {
      const url = String(opts.url).replace(/\/$/, '');

      // Legacy path — explicit token + org, no browser.
      if (opts.token) {
        if (!opts.org) {
          console.error(chalk.red('--org is required when using --token.'));
          process.exit(1);
        }
        const cfg: HubConfig = { url, token: String(opts.token), orgId: String(opts.org) };
        try {
          await axios.get(`${cfg.url}/v1/ping`, {
            headers: { Authorization: `Bearer ${cfg.token}`, 'X-Installation-Id': 'cli-login' },
            timeout: 10_000,
          });
        } catch (e: any) {
          console.error(chalk.red(`Hub /v1/ping failed: ${e?.response?.status ?? ''} ${e?.message}`));
          console.error(chalk.gray('Refusing to write hub.json — fix the URL/token and try again.'));
          process.exit(1);
        }
        writeHubConfig(cfg);
        console.log(chalk.green(`✓ Hub configured at ${cfg.url} (org=${cfg.orgId}). Restart the API server to begin pushing events.`));
        return;
      }

      // Device-code flow.
      let start;
      try {
        start = (await axios.post(`${url}/hub/device/start`, {}, { timeout: 10_000 })).data;
      } catch (e: any) {
        console.error(chalk.red(`Could not reach ${url}: ${e?.message ?? 'unknown'}`));
        console.error(chalk.gray('Tip: pass --token <key> --org <id> to skip the browser flow.'));
        process.exit(1);
      }
      console.log();
      console.log(chalk.bold('Device code: ') + chalk.cyan(start.userCode));
      console.log(chalk.gray('Open this URL in your browser to approve:'));
      console.log('  ' + chalk.underline(start.verificationUri));
      if (opts.open !== false) {
        const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
        exec(`${opener} ${JSON.stringify(start.verificationUri)}`, () => { /* best-effort */ });
      }

      const interval = Math.max(1, Number(start.interval) || 2);
      const expiresAt = Date.now() + Math.max(60, Number(start.expiresIn) || 600) * 1000;
      process.stdout.write(chalk.gray('Waiting for approval'));
      while (Date.now() < expiresAt) {
        await new Promise(r => setTimeout(r, interval * 1000));
        process.stdout.write(chalk.gray('.'));
        try {
          const { data } = await axios.post(`${url}/hub/device/poll`, { deviceCode: start.deviceCode }, { timeout: 10_000 });
          if (data.status === 'approved') {
            console.log();
            const cfg: HubConfig = { url: String(data.hubUrl ?? url).replace(/\/$/, ''), token: String(data.token), orgId: String(data.orgId) };
            writeHubConfig(cfg);
            console.log(chalk.green(`✓ Hub configured at ${cfg.url} (org=${cfg.orgId}). Restart the API server to begin pushing events.`));
            return;
          }
          if (data.status === 'expired') {
            console.log();
            console.error(chalk.red('Device code expired. Re-run `agenfk hub login --url <hub>`.'));
            process.exit(1);
          }
        } catch (e: any) {
          // 404/410/etc — keep going until expiry, surface message at end.
          if (e?.response?.status === 410) {
            console.log();
            console.error(chalk.red('Login session ended unexpectedly. Re-run the command.'));
            process.exit(1);
          }
        }
      }
      console.log();
      console.error(chalk.red('Timed out waiting for approval.'));
      process.exit(1);
    });

  hub
    .command('join <inviteToken>')
    .description('Redeem a magic-link invite issued by your Hub admin')
    .option('--no-restart', 'Do not restart the local API server after a successful join (useful for scripted/CI flows that manage services themselves).')
    .action(async (inviteToken: string, opts: { restart?: boolean }) => {
      // Try every known hub URL: prefer existing config, else encoded URL prefix.
      const existing = readHubConfig();
      const candidates: string[] = [];
      if (existing?.url) candidates.push(existing.url);
      // Allow `agenfk hub join <hubUrl>:<token>` as a future extension.
      // For v1, require AGENFK_HUB_URL or an existing config to know where to redeem.
      if (process.env.AGENFK_HUB_URL) candidates.unshift(process.env.AGENFK_HUB_URL.replace(/\/$/, ''));
      if (candidates.length === 0) {
        console.error(chalk.red('No Hub URL known. Set AGENFK_HUB_URL or run `agenfk hub login --url <hub>` first.'));
        process.exit(1);
      }
      for (const url of candidates) {
        try {
          const { data } = await axios.post(
            `${url}/hub/invite/redeem`,
            { inviteToken, installation: localInstallationIdentity() },
            { timeout: 10_000 },
          );
          const cfg: HubConfig = { url: String(data.hubUrl ?? url).replace(/\/$/, ''), token: String(data.token), orgId: String(data.orgId) };
          writeHubConfig(cfg);
          console.log(chalk.green(`✓ Joined ${cfg.url} (org=${cfg.orgId}).`));

          // Story 6: probe the local API server and bounce it so the new
          // hub.json is picked up without manual intervention. --no-restart
          // (commander parses to `opts.restart === false`) skips this for
          // scripted flows.
          if (opts.restart === false) {
            console.log(chalk.gray('Skipping restart per --no-restart. Run `agenfk down && agenfk up` when convenient.'));
            return;
          }
          let servicesRunning = false;
          try {
            await axios.get(`${getApiUrl()}/`, { timeout: 2_000 });
            servicesRunning = true;
          } catch { /* not running — leave alone */ }
          if (!servicesRunning) {
            console.log(chalk.gray('Local API server is not running; the next `agenfk up` will pick up the new hub config.'));
            return;
          }
          const rootDir = path.resolve(__dirname, '../../../..');
          console.log(chalk.blue('Restarting local API server so it picks up the new hub config...'));
          try {
            execSync('node packages/cli/bin/agenfk.js down', { cwd: rootDir, stdio: 'inherit' });
          } catch { /* may already be down */ }
          try {
            const start = spawn('node', ['packages/cli/bin/agenfk.js', 'up'], {
              cwd: rootDir, detached: true, stdio: 'inherit',
            });
            start.unref();
            console.log(chalk.green('✓ Restarted local API server.'));
          } catch (e: any) {
            console.error(chalk.red(`Auto-restart failed: ${e?.message ?? e}. Run \`agenfk up\` manually.`));
          }
          return;
        } catch (e: any) {
          const msg = e?.response?.data?.error ?? e?.message;
          console.error(chalk.red(`Redeem at ${url} failed: ${msg}`));
        }
      }
      process.exit(1);
    });

  hub
    .command('status')
    .description('Show hub configuration and outbox state')
    .action(async () => {
      const cfg = readHubConfig();
      if (!cfg) {
        console.log(chalk.gray('Hub: not configured (no ~/.agenfk/hub.json).'));
        return;
      }
      console.log(`Hub URL:   ${cfg.url}`);
      console.log(`Org:       ${cfg.orgId}`);
      console.log(`Token:     ${cfg.token.slice(0, 8)}…`);
      const verifyToken = readVerifyToken();
      if (!verifyToken) {
        console.log(chalk.yellow('  (cannot reach local server: ~/.agenfk/verify-token missing)'));
        return;
      }
      try {
        const { data } = await axios.get(`${getApiUrl()}/internal/hub/status`, {
          headers: { 'x-agenfk-internal': verifyToken }, timeout: 5_000,
        });
        console.log(`Outbox:    ${data.outboxDepth} pending`);
        console.log(`Last flush: ${data.lastFlushAt ?? 'never'}`);
        console.log(`Last error: ${data.lastError ?? 'none'}`);
        console.log(`Halted:    ${data.halted ? 'YES (4xx threshold reached)' : 'no'}`);
      } catch (e: any) {
        console.log(chalk.gray(`  (API server not reachable: ${e?.message ?? 'unknown error'})`));
      }
    });

  hub
    .command('flush')
    .description('Force the local server to attempt a flush cycle now')
    .action(async () => {
      const verifyToken = readVerifyToken();
      if (!verifyToken) {
        console.error(chalk.red('Cannot flush: ~/.agenfk/verify-token not found. Is the framework installed?'));
        process.exit(1);
      }
      try {
        const { data } = await axios.post(`${getApiUrl()}/internal/hub/flush`, {}, {
          headers: { 'x-agenfk-internal': verifyToken }, timeout: 30_000,
        });
        console.log(chalk.green(`✓ Flush completed. Outbox now ${data.outboxDepth}, last error: ${data.lastError ?? 'none'}`));
      } catch (e: any) {
        const msg = e?.response?.data?.error ?? e?.message;
        console.error(chalk.red(`Flush failed: ${msg}`));
        process.exit(1);
      }
    });

  hub
    .command('logout')
    .description('Disconnect from the Hub (preserves the local outbox)')
    .action(() => {
      try {
        fs.unlinkSync(HUB_CONFIG_FILE);
        console.log(chalk.green('✓ Removed ~/.agenfk/hub.json. Restart the API server to stop pushing.'));
      } catch {
        console.log(chalk.gray('Hub was not configured.'));
      }
    });
}
