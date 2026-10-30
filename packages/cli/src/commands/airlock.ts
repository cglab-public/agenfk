import { Command } from 'commander';
import chalk from 'chalk';
import axios from 'axios';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { getApiUrl } from '@agenfk/telemetry';
import { resolveProjectIdentity, linkedWorktreeOf } from '@agenfk/core';
import { resolveDashboardUrl } from '../uiUrl.js';
import { runAirlockLaunch, AirlockLaunchError, type LaunchDeps, type LaunchOptions } from '../airlock/launch.js';
import { runAirlockExec, scopedCommandEnv, EXEC_CANNOT_SANDBOX, type ExecDeps } from '../airlock/exec.js';
import { AsrtRuntime } from '../airlock/runtime.js';
import { stagePiAgentDir } from '../airlock/piAgentDir.js';
import { PROXY_REPORT_TIMEOUT_MS } from '../airlock/proxyReport.js';
import { runLearnImport, defaultPiSessionsDir } from '../airlock/learnImport.js';
import { runDatasetImport, defaultOpenCodeDb, DatasetImportError } from '../airlock/datasetImport.js';

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

/**
 * A 404 the server did not explain (no JSON error of its own: Express's page for an unknown
 * route) is a server older than this CLI - one without the route (BUG 3a5ec1ff).
 */
const PREDATES = 'The AgEnFK server running is older than this agenfk and predates Airlock (it does not know this request). Restart it on this version (agenfk restart), or upgrade it, and retry.';
const fail = (e: any): void => {
  const data = e?.response?.data;
  const explained = data && typeof data === 'object' && (data.message || data.error);
  const message = e?.response?.status === 404 && !explained
    ? PREDATES
    : (explained || e?.message || String(e));
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

/**
 * Where the sandbox runtime is installed (never writable from the sandbox): its
 * package, or - in the desktop app's exec helper, which bundles it (ea94c023) -
 * the helper's own directory, which holds its vendored helpers.
 */
function runtimePackageDir(): string {
  try {
    return AsrtRuntime.packageDir();
  } catch {
    return path.resolve(__dirname, '..');
  }
}

/**
 * The project root to record for a launch from `root`: in a linked worktree, the
 * same place in the main checkout (a monorepo's subpath kept). A worktree is one
 * card's tree, never the project's root, and the server refuses one.
 */
export function mainCheckoutRoot(root: string, wt: { top: string; main: string } | null): string {
  if (!wt) return root;
  const rel = path.relative(wt.top, root);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return root;
  return path.join(wt.main, rel);
}

/**
 * The launcher's ensureProjectRoot: the project's root, set with the verify token
 * (as agenfk update-project does) only when the server has none. The launcher is
 * outside the sandbox, which cannot read that token.
 */
export function ensureProjectRootVia(
  apiUrl: string,
  token: () => string | null,
  get: (url: string, opts: object) => Promise<{ data: any }> = axios.get,
  put: (url: string, body: unknown, opts: object) => Promise<unknown> = axios.put,
): (projectId: string, root: string) => Promise<void> {
  return async (projectId, root) => {
    const id = encodeURIComponent(projectId);
    const { data } = await get(`${apiUrl}/projects/${id}`, { timeout: 5000 });
    if (typeof data?.projectRoot === 'string' && data.projectRoot) return;
    const t = token();
    if (!t) throw new Error('~/.agenfk/verify-token is missing');
    await put(`${apiUrl}/projects/${id}/project-root`, { projectRoot: root }, { timeout: 5000, headers: { 'x-agenfk-internal': t } });
  };
}

/** GET /airlock/policy, for a project when one is named (PO-1). */
const policyUrl = (apiUrl: string, projectId?: string | null): string =>
  `${apiUrl}/airlock/policy${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`;

/** The real launcher's dependencies: this machine, this server, ASRT. */
export function defaultLaunchDeps(): LaunchDeps {
  const home = os.homedir();
  return {
    fetchPolicy: async (projectId) => (await axios.get(policyUrl(getApiUrl(), projectId), { timeout: 5000 })).data,
    projectId: () => { try { return resolveProjectIdentity(process.cwd())?.projectId ?? null; } catch { return null; } },
    projectRoot: () => {
      try {
        const root = resolveProjectIdentity(process.cwd())?.root;
        return root ? mainCheckoutRoot(root, linkedWorktreeOf(process.cwd())) : null;
      } catch {
        return null;
      }
    },
    ensureProjectRoot: ensureProjectRootVia(getApiUrl(), () => {
      try { return fs.readFileSync(path.join(home, '.agenfk', 'verify-token'), 'utf8').trim(); } catch { return null; }
    }),
    runtime: new AsrtRuntime(),
    stageAgentDir: (realDir) => stagePiAgentDir(realDir, realpath(os.tmpdir())),
    env: process.env,
    home,
    cwd: realpath(process.cwd()),
    tmpDir: realpath(os.tmpdir()),
    apiUrl: getApiUrl(),
    readJson: (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } },
    exists: (file) => fs.existsSync(file),
    which: (file) => whichOnPath(file),
    runtimePackageDir: realpath(runtimePackageDir()),
    // The installed copy, and the package this CLI runs from (dist/commands -> package root).
    installDirs: [...new Set([path.join(home, '.agenfk-system'), realpath(path.resolve(__dirname, '..', '..'))])],
    // The package this CLI runs from (dist/commands -> package root): its version tags the base image.
    // The desktop app's bundled exec helper has none: its bundler sets the version.
    agenfkVersion: () => (typeof __AGENFK_VERSION__ === 'string' ? __AGENFK_VERSION__
      : JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8')).version),
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

/** Set by the desktop app's bundler (packages/desktop/scripts/bundle-airlock.mjs); undeclared elsewhere. */
declare const __AGENFK_VERSION__: string | undefined;

type Launch = (client: 'pi' | 'opencode', args: string[], opts: LaunchOptions) => Promise<number>;
type Exec = (command: string, opts: { cwd: string; processGroup: boolean; projectId?: string }) => Promise<number>;

/**
 * The real exec's dependencies (SX-2): the launcher's, as a command needs them,
 * all bound to `apiUrl` - the server exec was pointed at, captured before its
 * environment is scoped (which removes AGENFK_API_URL).
 */
export function defaultExecDeps(apiUrl: string, get: (url: string, opts: object) => Promise<{ data: unknown }> = axios.get): ExecDeps {
  const l = defaultLaunchDeps();
  let directServerPort: number | undefined;
  try {
    const u = new URL(apiUrl);
    directServerPort = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  } catch {
    directServerPort = undefined;
  }
  return {
    fetchPolicy: async (projectId) => (await get(policyUrl(apiUrl, projectId), { timeout: 5000 })).data as any,
    runtime: l.runtime, home: l.home, tmpDir: l.tmpDir, installDirs: l.installDirs,
    runtimePackageDir: l.runtimePackageDir, directServerPort, listDir: l.listDir, realpath: l.realpath,
    isDirectory: l.isDirectory, exists: l.exists, platform: l.platform, ensurePrivateDir: l.ensurePrivateDir,
    onSignal: l.onSignal, error: (m) => console.error(m), agenfkVersion: l.agenfkVersion,
    // Scoped by the exec command before the run (registerAirlockCommands).
    env: process.env,
  };
}

export function registerAirlockCommands(
  program: Command,
  overrides: { launch?: Launch; exec?: Exec; exit?: (code: number) => void } = {},
): void {
  const launch: Launch = overrides.launch ?? ((client, args, opts) => runAirlockLaunch(client, args, opts, defaultLaunchDeps()));
  const exec: Exec = overrides.exec ?? ((command, opts) => {
    // Which server to ask, before the scope removes AGENFK_API_URL.
    const apiUrl = getApiUrl();
    const deps = defaultExecDeps(apiUrl);
    // The sandbox's env comes from this process's: secrets out before ASRT reads it.
    const scoped = scopedCommandEnv(process.env);
    for (const name of Object.keys(process.env)) if (!(name in scoped)) delete process.env[name];
    return runAirlockExec(command, opts, deps);
  });
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

  airlock
    .command('learn')
    .description('Learning mode (TEL-3): feed the proposed allowlist. --import-pi-sessions reads pi session logs here and sends only host names and counts. Accepting the proposal is a person\'s, on the board (or the hub). Writes no policy.')
    .option('--import-pi-sessions', 'Import the hosts existing pi sessions reached')
    .option('--dir <dir>', 'Where the pi session logs are (default ~/.pi/agent/sessions)')
    .option('--json', 'Print the result as JSON')
    .action(async (options) => {
      if (!options.importPiSessions) {
        console.error(chalk.red('Nothing to do: pass --import-pi-sessions.'));
        exit(1);
        return;
      }
      try {
        const result = await runLearnImport({ dir: options.dir }, {
          post: (url, body) => axios.post(url, body, { timeout: 30_000 }),
          apiUrl: getApiUrl(),
          log: (m) => { if (!options.json) console.log(chalk.gray(m)); },
        });
        if (options.json) { console.log(JSON.stringify(result, null, 2)); return; }
        const notes = [result.invalid && `${result.invalid} refused`, result.excluded && `${result.excluded} already covered by the policy`].filter(Boolean).join(', ');
        console.log(`Learned ${result.recorded} host${result.recorded === 1 ? '' : 's'}${notes ? ` (${notes})` : ''}.`);
        console.log(`Review the proposed allowlist on the board: ${airlockBoardUrl()}`);
      } catch (e) { fail(e); }
    });

  const dataset = airlock
    .command('dataset')
    .description('The Airlock dataset (DS-3): your organization\'s hub keeps full tool calls, secrets removed, to train Airlock\'s scorer, while an org admin has it switched on.');

  dataset
    .command('status')
    .description('Whether your organization\'s hub has the Airlock dataset switched on, as the hub says now (BUG 4f2e0354).')
    .option('--json', 'Print the server answer as JSON')
    .action(async (options) => {
      try {
        // refresh=1: the hub's word now, not the last 5-minute sync's.
        const { data } = await axios.get(`${getApiUrl()}/airlock/dataset?refresh=1`, { timeout: 15_000 });
        if (options.json) { console.log(JSON.stringify(data, null, 2)); return; }
        if (!data?.joined) {
          console.log('Airlock dataset: off - this installation is not joined to a hub, so there is no dataset.');
        } else if (data.enabled) {
          console.log(`Airlock dataset: ${chalk.bold('on')} - your organization's hub keeps this installation's pi and OpenCode tool calls, secrets removed.`);
        } else {
          console.log(`Airlock dataset: ${chalk.bold('off')} - an org admin switches it on (Admin -> Airlock -> Dataset).`);
        }
      } catch (e) { fail(e); }
    });

  dataset
    .command('import')
    .description('Send past pi and OpenCode sessions to the hub\'s Airlock dataset: every tool call, judged under the current policy and joined to its card, secrets removed here first. Only while this installation is joined to a hub whose dataset switch is on. Importing again adds nothing.')
    .option('--pi-dir <dir>', 'Where pi\'s session logs are (default ~/.pi/agent/sessions)')
    .option('--opencode-db <path>', 'OpenCode\'s database, read-only (default ~/.local/share/opencode/opencode.db)')
    .option('--no-pi', 'Skip pi\'s sessions')
    .option('--no-opencode', 'Skip OpenCode\'s sessions')
    .option('--json', 'Print the result as JSON')
    .action(async (options) => {
      try {
        const api = getApiUrl();
        const result = await runDatasetImport({
          piDir: options.pi === false ? null : (options.piDir ?? defaultPiSessionsDir()),
          openCodeDb: options.opencode === false ? null : (options.opencodeDb ?? defaultOpenCodeDb()),
        }, {
          status: async () => (await axios.get(`${api}/airlock/dataset`, { timeout: 10_000 })).data,
          post: async (body) => (await axios.post(`${api}/airlock/dataset/import`, body, { timeout: 60_000 })).data,
          log: (m) => { if (!options.json) console.log(chalk.gray(m)); },
        });
        if (options.json) { console.log(JSON.stringify(result, null, 2)); return; }
        const notes = [result.skipped && `${result.skipped} skipped`, result.tooLarge && `${result.tooLarge} too large to send`].filter(Boolean).join(', ');
        console.log(`Sent ${result.sent} tool call${result.sent === 1 ? '' : 's'} from ${result.sessions} session${result.sessions === 1 ? '' : 's'} to the hub's Airlock dataset${notes ? ` (${notes})` : ''}.`);
      } catch (e) {
        if (options.json && e instanceof DatasetImportError) console.log(JSON.stringify({ error: e.message, progress: e.progress }, null, 2));
        fail(e);
      }
    });

  airlock
    .command('exec')
    .description('Run one command inside the Airlock sandbox built from the effective policy (the AgEnFK server uses it for verify and suite runs of cards a sandboxed session touched). Exits 125, without running it, when it cannot be sandboxed.')
    .requiredOption('--cwd <dir>', 'the directory to run it in (writable inside the sandbox)')
    .option('--project-id <id>', 'the AgEnFK project the command is for: its per-project Airlock overrides apply (the AgEnFK server passes the card\'s)')
    .option('--no-process-group', 'keep the command in exec\'s own process group (for a caller that kills that group whole, as the AgEnFK server does)')
    .argument('[command...]', 'the command, after --, as ONE argument, run with /bin/sh -c')
    .allowExcessArguments()
    .action(async (words: string[], options: { cwd: string; processGroup: boolean; projectId?: string }) => {
      // One argument, verbatim: joining several would lose their quoting (and could make shell operators of them).
      if ((words ?? []).length !== 1 || !words[0].trim()) {
        console.error(chalk.red('❌ agenfk airlock exec takes the command as one argument after --, e.g. agenfk airlock exec --cwd . -- \'npm test\'.'));
        return exit(EXEC_CANNOT_SANDBOX);
      }
      const command = words[0];
      try {
        exit(await exec(command, { cwd: options.cwd, processGroup: options.processGroup !== false, projectId: options.projectId }));
      } catch (e) {
        console.error(chalk.red(`❌ ${(e as Error)?.message ?? String(e)}`));
        exit(EXEC_CANNOT_SANDBOX);
      }
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
