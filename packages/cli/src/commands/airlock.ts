import { Command } from 'commander';
import chalk from 'chalk';
import axios from 'axios';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { getApiUrl } from '@agenfk/telemetry';
import { resolveDashboardUrl } from '../uiUrl.js';
import { runAirlockLaunch, AirlockLaunchError, type LaunchDeps, type LaunchOptions } from '../airlock/launch.js';
import { AsrtRuntime } from '../airlock/runtime.js';
import { PROXY_REPORT_TIMEOUT_MS } from '../airlock/proxyReport.js';

/**
 * `agenfk airlock` (GH-294): read the Airlock policy and ask what it would
 * decide. The CLI is the agent's route to the server, so nothing here writes the
 * policy: `edit` only points a person at the board, where it is changed (or, on
 * a hub-joined installation, at nothing local - the hub owns it).
 */

/** Where the board's Airlock settings open (the panel itself arrives with T5). */
export function airlockBoardUrl(base: string = resolveDashboardUrl('')): string {
  return `${base}${base.includes('?') ? '&' : '?'}settings=airlock`;
}

const fail = (e: any): void => {
  const message = e?.response?.data?.error || e?.message || String(e);
  console.error(chalk.red(`❌ ${message}`));
  process.exit(1);
};

function openInBrowser(url: string): void {
  try {
    if (process.platform === 'darwin') execFileSync('open', [url], { stdio: 'ignore', windowsHide: true });
    else if (process.platform === 'win32') execFileSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore', windowsHide: true });
    else execFileSync('xdg-open', [url], { stdio: 'ignore', windowsHide: true });
  } catch {
    console.log(chalk.yellow('Could not open a browser; open the URL above yourself.'));
  }
}

/** Absolute path of an executable on PATH, or null. */
function whichOnPath(file: string, env: NodeJS.ProcessEnv = process.env): string | null {
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, file);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* next */ }
  }
  return null;
}

/**
 * `dir` as a real 0700 directory: created, or set to exactly 0700 (looser, or
 * owner-restrictive like 0600 that the owner could not use). Throws when it
 * cannot be; the launch is then refused. POSIX modes only: Windows has none to
 * set (and the sandbox refuses Windows before this is reached).
 */
export function ensurePrivateDir(dir: string, platform: NodeJS.Platform = process.platform): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory()) throw new Error('it is not a directory');
  if (platform !== 'win32' && (st.mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700);
}

/**
 * The Airlock report token, read as the server reads it: without following a
 * link or blocking on a FIFO (this process runs the sandbox's proxy), and only
 * from a regular file. Null when missing or not one.
 */
function readReportToken(file: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  } catch {
    return null;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > 128) return null;
    const buf = Buffer.alloc(128);
    return buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)).toString('utf8').trim() || null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

const realpath = (p: string): string => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

/** The real launcher's dependencies: this machine, this server, ASRT. */
export function defaultLaunchDeps(): LaunchDeps {
  const home = os.homedir();
  return {
    fetchPolicy: async () => (await axios.get(`${getApiUrl()}/airlock/policy`, { timeout: 5000 })).data,
    runtime: new AsrtRuntime(),
    env: process.env,
    home,
    cwd: realpath(process.cwd()),
    tmpDir: realpath(os.tmpdir()),
    apiUrl: getApiUrl(),
    readJson: (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } },
    exists: (file) => fs.existsSync(file),
    which: (file) => whichOnPath(file),
    runtimePackageDir: realpath(AsrtRuntime.packageDir()),
    // The installed copy, and the package this CLI runs from (dist/commands -> package root).
    installDirs: [...new Set([path.join(home, '.agenfk-system'), realpath(path.resolve(__dirname, '..', '..'))])],
    log: (m) => console.error(chalk.gray(m)),
    warn: (m) => console.error(chalk.yellow(m)),
    listDir: (dir) => {
      try {
        return fs.readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory(), isLink: e.isSymbolicLink() }));
      } catch {
        return null;
      }
    },
    realpath: (p) => { try { return fs.realpathSync(p); } catch { return null; } },
    isDirectory: (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
    platform: process.platform,
    // Fire-and-forget: the reporter races this against its own timeout too.
    postProxyDecisions: (body, signal, token) => axios.post(`${getApiUrl()}/airlock/proxy-decisions`, body, {
      timeout: PROXY_REPORT_TIMEOUT_MS, signal, headers: { 'x-agenfk-airlock-report': token },
    }),
    ensurePrivateDir: (dir) => ensurePrivateDir(dir),
    reportToken: () => readReportToken(path.join(home, '.agenfk', 'airlock', 'report-token')),
    hostNetns: (() => { try { return process.platform === 'linux' ? fs.readlinkSync('/proc/self/ns/net') : null; } catch { return null; } })(),
    onSignal: (signal, handler) => {
      process.on(signal, handler);
      return () => { process.off(signal, handler); };
    },
  };
}

type Launch = (client: 'pi' | 'opencode', args: string[], opts: LaunchOptions) => Promise<number>;

export function registerAirlockCommands(
  program: Command,
  overrides: { launch?: Launch; exit?: (code: number) => void } = {},
): void {
  const launch: Launch = overrides.launch ?? ((client, args, opts) => runAirlockLaunch(client, args, opts, defaultLaunchDeps()));
  const exit = overrides.exit ?? ((code: number) => process.exit(code));
  const airlock = program
    .command('airlock')
    .description('Airlock: the per-tool-call policy for pi and OpenCode sessions (read-only here; change it on the board)');

  airlock
    .command('status')
    .description('Show the Airlock policy in force: mode, coverage, source (hub or local) and revision. MCP: airlock_status.')
    .option('--json', 'Print the server answer as JSON')
    .action(async (options) => {
      try {
        const { data } = await axios.get(`${getApiUrl()}/airlock/policy`);
        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }
        const p = data?.effective ?? {};
        const models = Array.isArray(p.models) && p.models.length
          ? p.models.map((m: any) => [m.client ?? '*', m.provider ?? '*', m.model ?? '*'].join(':')).join(', ')
          : 'every session';
        console.log(`Airlock mode: ${chalk.bold(String(p.mode ?? 'off'))}`);
        console.log(`Source: ${data?.source} (revision ${data?.revision})${data?.hubManaged ? chalk.yellow(' - managed by your organization\'s hub; it cannot be changed here') : ''}`);
        console.log(`Covers: ${models}${p.appliesWhenModelUnknown === false ? ' (not sessions whose model is unknown)' : ''}`);
      } catch (e) { fail(e); }
    });

  airlock
    .command('check')
    .description('Ask what Airlock would decide for a command, path or URL. A dry run: nothing runs and nothing is logged. MCP: airlock_check.')
    .requiredOption('--client <client>', 'pi or opencode')
    .option('--model <provider/model>', 'The session model, e.g. cloudflare-workers-ai/@cf/zai-org/glm-5.2')
    .option('--command <command>', 'A shell command to judge')
    .option('--path <path>', 'A file path to judge')
    .option('--url <url>', 'A URL to judge')
    .option('--json', 'Print the server answer as JSON')
    .action(async (options) => {
      const args: Record<string, string> = {};
      if (options.command) args.command = options.command;
      if (options.path) args.path = options.path;
      if (options.url) args.url = options.url;
      if (!Object.keys(args).length) {
        console.error(chalk.red('Pass at least one of --command, --path or --url.'));
        process.exit(1);
        return;
      }
      try {
        const { data } = await axios.post(`${getApiUrl()}/airlock/evaluate`, {
          client: options.client, model: options.model, toolName: 'agenfk airlock check', args, dryRun: true,
        });
        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }
        const v = data?.verdict ?? {};
        const colour = v.decision === 'deny' ? chalk.red : v.decision === 'needs-human-approval' ? chalk.yellow : chalk.green;
        const detail = v.decision === 'allow'
          ? `(${v.why}${v.observed ? `; enforce would ${v.observed.decision}: ${v.observed.rule}` : ''})`
          : `${v.rule}: ${v.reason}`;
        console.log(`${colour(String(v.decision))} ${detail}`);
        console.log(chalk.gray(`mode ${data?.mode}, revision ${data?.revision}${data?.applies ? '' : ', this session is not covered'}`));
      } catch (e) { fail(e); }
    });

  airlock
    .command('edit')
    .description('Print (or with --open, open) the board page where a person changes the Airlock policy. Writes nothing.')
    .option('--open', 'Also open it in the browser')
    .action((options) => {
      const url = airlockBoardUrl();
      console.log(`Change the Airlock policy on the board: ${url}`);
      console.log(chalk.gray('On a hub-joined installation the hub owns the policy: an org admin changes it there.'));
      if (options.open) openInBrowser(url);
    });

  for (const client of ['pi', 'opencode'] as const) {
    airlock
      .command(client)
      .description(`Launch ${client} inside the Airlock sandbox: egress only to the policy's hosts and the session's inference host, credential stores unreadable, AgEnFK's own files unwritable. Every argument after "${client}" goes to ${client}.`)
      .option('--key-env <name>', 'An env var holding the model key, to mask (repeatable; the provider\'s usual one is masked already)', (v: string, acc: string[]) => [...acc, v], [] as string[])
      .argument('[args...]', `arguments for ${client}`)
      .allowUnknownOption()
      .allowExcessArguments()
      .helpOption(false)
      .action(async (args: string[], options: { keyEnv?: string[] }) => {
        try {
          exit(await launch(client, args ?? [], { keyEnv: options.keyEnv ?? [] }));
        } catch (e) {
          const message = e instanceof AirlockLaunchError ? e.message : (e as Error)?.message ?? String(e);
          console.error(chalk.red(`❌ ${message}`));
          exit(1);
        }
      });
  }
}
