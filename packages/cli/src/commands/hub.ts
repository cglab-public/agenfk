import { Command } from 'commander';
import chalk from 'chalk';
import axios from 'axios';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getApiUrl } from '@agenfk/telemetry';

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
    .requiredOption('--token <token>', 'Installation API key issued by the Hub admin')
    .requiredOption('--org <orgId>', 'Org identifier as registered with the Hub')
    .action(async (opts) => {
      const cfg: HubConfig = { url: String(opts.url).replace(/\/$/, ''), token: String(opts.token), orgId: String(opts.org) };
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
