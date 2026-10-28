/**
 * SX-2 (8dd7c7c0): `agenfk airlock exec --cwd <dir> -- <command>`.
 *
 * The AgEnFK server runs verify and suite commands, and a sandboxed agent can
 * make it run code: a command it passes to verify, or the tests it edited. For a
 * card an Airlock sandbox touched (SX-1), the server runs that command through
 * this instead (SX-3): `/bin/sh -c <command>` inside the sandbox built from the
 * effective policy for a COMMAND. The workspace is writable; the credential
 * stores and the report token are unreadable; AgEnFK's own files are unwritable;
 * egress goes only to the policy's allow list - no AgEnFK server, no inference
 * host. Loopback is the command's own, so test servers run (user decision
 * 2026-10-28): on Linux the host's loopback stays out of reach (a network
 * namespace); macOS has none, so there a command can reach local services.
 *
 * It fails closed: a policy it cannot read, or a sandbox that cannot start,
 * means the command never runs and the exit is 125. It sandboxes whatever the
 * mode: the server only calls it when the policy enforces.
 *
 * One process per run: ASRT's SandboxManager holds one configuration per process.
 */
import os from 'os';
import path from 'path';
import { normalizeAirlockPolicy, airlockPolicyErrors, type AirlockPolicy } from '@agenfk/core';
import { buildSandboxSpec, type SandboxSpec } from './spec';
import type { AirlockRuntime } from './runtime';
import { findAgenfkDirs, projectAgenfkDirs, AGENFK_SCAN_LIMIT, type LaunchDeps } from './launch';

/** The exit when the command could not be sandboxed, so never ran (like a shell's "cannot execute"). */
export const EXEC_CANNOT_SANDBOX = 125;

export interface ExecDeps {
  fetchPolicy: LaunchDeps['fetchPolicy'];
  runtime: AirlockRuntime;
  home: string;
  tmpDir: string;
  installDirs: string[];
  runtimePackageDir: string;
  /** The AgEnFK server's port: never reachable from the command's sandbox. */
  directServerPort?: number;
  listDir: LaunchDeps['listDir'];
  realpath: LaunchDeps['realpath'];
  isDirectory: LaunchDeps['isDirectory'];
  exists: LaunchDeps['exists'];
  platform: NodeJS.Platform;
  ensurePrivateDir: (dir: string) => void;
  onSignal: LaunchDeps['onSignal'];
  /** Where the reason goes when the command cannot run (the server shows the command's stderr). */
  error: (message: string) => void;
}

/**
 * What a command keeps of the server's environment: an ALLOWLIST of what test
 * suites and toolchains read (a denylist of secret names misses GH_PAT, a
 * DATABASE_URL with its password inside, npm's `//host/:_authToken`). Anything
 * else stays out; a project that needs more gets it from its own config files.
 */
const ENV_NAMES = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'PWD', 'LANG', 'LANGUAGE', 'TZ', 'TERM', 'COLORTERM',
  'TMPDIR', 'TEMP', 'TMP', 'CI', 'FORCE_COLOR', 'NO_COLOR', 'NODE_ENV', 'NODE_OPTIONS', 'NODE_PATH',
  'JAVA_HOME', 'GOPATH', 'GOROOT', 'GOFLAGS', 'CARGO_HOME', 'RUSTUP_HOME', 'VIRTUAL_ENV', 'PYTHONPATH',
  'PYTHONDONTWRITEBYTECODE', 'NVM_DIR', 'PNPM_HOME', 'BUN_INSTALL', 'DENO_DIR', 'EDITOR', 'PAGER',
]);
const ENV_PREFIXES = ['LC_', 'XDG_', 'VITEST', 'JEST_', 'npm_lifecycle_', 'npm_package_'];
/** Still out, allowlisted or not: a secret's name, or credentials inside a value. */
const SECRET_NAME = /(?:^|_)(?:TOKEN|SECRET|SECRETS|PASSWORD|PASSWD|PASS|PASSPHRASE|API_?KEY|KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?|AUTH|COOKIE|SESSION|PAT)(?:_|$)/i;
const SECRET_VALUE = /[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i;

export function scopedCommandEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (!ENV_NAMES.has(name) && !ENV_PREFIXES.some((p) => name.startsWith(p))) continue;
    if (SECRET_NAME.test(name) || SECRET_VALUE.test(value)) continue;
    out[name] = value;
  }
  return out;
}

/**
 * The effective policy in the server's answer, or why there is none. Checked
 * whole before normalising: a partial answer would otherwise normalise into
 * defaults the server never sent (an empty deny list, say), and the command run.
 */
function effectivePolicyOf(view: any): AirlockPolicy {
  const p = view && typeof view === 'object' ? view.effective : null;
  if (!p || typeof p !== 'object') throw new Error('the server gave no effective policy');
  const missing = ['mode', 'hosts', 'rules'].filter((k) => p[k] === undefined || p[k] === null);
  if (!p.hosts || !Array.isArray(p.hosts.allow) || !Array.isArray(p.hosts.deny)) missing.push('hosts.allow/deny');
  if (!p.iocHosts || typeof p.iocHosts.revision !== 'string' || !Array.isArray(p.iocHosts.hosts)) missing.push('iocHosts');
  if (missing.length) throw new Error(`the server's policy is incomplete (${[...new Set(missing)].join(', ')})`);
  const errors = airlockPolicyErrors(p);
  if (errors.length) throw new Error(`the server's policy is invalid (${errors.join('; ')})`);
  return normalizeAirlockPolicy(p);
}

const SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * `processGroup` (default true): the command gets a process group of its own, and
 * signals reach all of it. False (`--no-process-group`, what the AgEnFK server
 * passes): it stays in exec's own group, because the caller already gave exec one
 * and kills that whole group - SIGKILL, which exec could not pass on (SX-3).
 */
export async function runAirlockExec(command: string, opts: { cwd: string; processGroup?: boolean }, d: ExecDeps): Promise<number> {
  const cannot = (why: string): number => {
    d.error(`[agenfk airlock] ${why} The command was not run.`);
    return EXEC_CANNOT_SANDBOX;
  };
  const cwd = path.resolve(opts.cwd);
  let spec: SandboxSpec;
  try {
    const policy = effectivePolicyOf(await d.fetchPolicy());
    const nested = findAgenfkDirs(cwd, d);
    if (!nested.complete && d.platform === 'linux') {
      return cannot(`Could not list every .agenfk directory under ${cwd} (more than ${AGENFK_SCAN_LIMIT}, or one could not be read); on Linux each must be protected by name.`);
    }
    // The report token's directory must exist for the sandbox to hide it (Linux masks what exists at launch).
    d.ensurePrivateDir(path.join(d.home, '.agenfk', 'airlock'));
    spec = buildSandboxSpec(policy, {
      client: 'pi',
      purpose: 'command',
      home: d.home,
      workspace: cwd,
      tempDirs: [d.tmpDir],
      inferenceHosts: [],
      serverPort: 0,
      directServerPort: d.directServerPort,
      installDirs: d.installDirs,
      projectAgenfkDirs: [...projectAgenfkDirs({ cwd, home: d.home, exists: d.exists }), ...nested.dirs],
      runtimePackageDir: d.runtimePackageDir,
    });
  } catch (e) {
    return cannot(`Could not build the Airlock sandbox for this command from the policy (${(e as Error)?.message ?? e}).`);
  }
  let launched;
  try {
    // Its own process group: a signal, and the cleanup after it, reach everything the command started.
    launched = await d.runtime.launch(spec, { file: '/bin/sh', args: ['-c', command], cwd, processGroup: opts.processGroup ?? true });
  } catch (e) {
    await d.runtime.dispose().catch(() => undefined);
    return cannot((e as Error)?.message ?? String(e));
  }
  const offs = SIGNALS.map((sig) => d.onSignal(sig, () => { launched.kill(sig); }));
  try {
    const exit = await launched.exited;
    if (exit.code !== null) return exit.code;
    return 128 + ((exit.signal && os.constants.signals[exit.signal]) || 1);
  } finally {
    offs.forEach((off) => off());
    await d.runtime.dispose();
  }
}
