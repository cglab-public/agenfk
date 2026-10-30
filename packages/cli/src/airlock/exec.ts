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
 * 2026-10-28).
 *
 * CGLAB-696 task 5: it runs in the workspace's machine, made from the image the
 * policy names (else the AgEnFK base image of this version), so the command sees
 * the dependencies the session installed there. ACCEPTED LIMIT (user decision
 * 2026-10-30): beside a session already in that machine the command runs on the
 * session's terms - its network, the relay to the AgEnFK server included, and
 * through /proc what the session sees. The command policy above holds when no
 * session is in the machine (smolvm.ts, prepare).
 *
 * It fails closed: a policy it cannot read, or a machine that cannot start,
 * means the command never runs and the exit is 125. It sandboxes whatever the
 * mode: the server only calls it when the policy enforces.
 */
import os from 'os';
import path from 'path';
import { normalizeAirlockPolicy, airlockPolicyErrors, type AirlockPolicy } from '@agenfk/core';
import { buildSandboxSpec, type SandboxSpec, sharedTempDir } from './spec';
import type { AirlockRuntime } from './runtime';
import { machineImageFor } from './image';
import { findAgenfkDirs, projectAgenfkDirs, workspaceGitDir, workspaceOf, AGENFK_SCAN_LIMIT, type LaunchDeps } from './launch';

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
  /** This agenfk's version: the base image's tag. */
  agenfkVersion: LaunchDeps['agenfkVersion'];
  /** The environment the command's comes from (scopedCommandEnv, then guestCommandEnv). */
  env: NodeJS.ProcessEnv;
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
 * Names among scopedCommandEnv's that hold host paths: the guest has its own (its PATH, its HOME
 * at the host user's path, its own /tmp), and a host path there names nothing or the wrong thing.
 */
const HOST_PATH_NAMES = new Set([
  'PATH', 'HOME', 'SHELL', 'PWD', 'USER', 'LOGNAME', 'TMPDIR', 'TEMP', 'TMP', 'NODE_PATH', 'JAVA_HOME', 'GOPATH', 'GOROOT',
  'CARGO_HOME', 'RUSTUP_HOME', 'VIRTUAL_ENV', 'PYTHONPATH', 'NVM_DIR', 'PNPM_HOME', 'BUN_INSTALL', 'DENO_DIR', 'EDITOR', 'PAGER',
]);

/** An absolute path in a value (`--require=/x`, `--require="/x"`, `/x:/y`, `/x`): a host path, wherever it sits. */
const HOST_PATH_IN_VALUE = /(?:^|[\s=:,'"])\//;

/** What of the server's environment a command gets in the machine: scopedCommandEnv's, but no host path, by name or in a value. */
export function guestCommandEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(scopedCommandEnv(env))
    .filter(([name, value]) => !HOST_PATH_NAMES.has(name) && !name.startsWith('XDG_') && !HOST_PATH_IN_VALUE.test(value)));
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
 * `projectId`: the card's project, whose overrides the policy carries (PO-1).
 * `processGroup` (default true): the command gets a process group of its own, and
 * signals reach all of it. False (`--no-process-group`, what the AgEnFK server
 * passes): it stays in exec's own group, because the caller already gave exec one
 * and kills that whole group - SIGKILL, which exec could not pass on (SX-3).
 */
export async function runAirlockExec(command: string, opts: { cwd: string; processGroup?: boolean; projectId?: string }, d: ExecDeps): Promise<number> {
  const cannot = (why: string): number => {
    d.error(`[agenfk airlock] ${why} The command was not run.`);
    return EXEC_CANNOT_SANDBOX;
  };
  const cwd = path.resolve(opts.cwd);
  let spec: SandboxSpec;
  try {
    // The card's project (--project-id, the server passes it): its overrides apply (PO-1).
    const view = await d.fetchPolicy(opts.projectId ?? null);
    const policy = effectivePolicyOf(view);
    // An older server's policy drops machineImage: the base image would run over the one the policy names.
    const caps = Array.isArray(view?.capabilities) ? (view.capabilities as unknown[]) : [];
    if (!caps.includes('machine-image')) {
      return cannot('The AgEnFK server running is older than this agenfk: the policy it gives drops the machine image your policy may name. Restart it on this version (agenfk restart).');
    }
    const image = machineImageFor(policy, d.agenfkVersion()).image;
    // The repository's machine, as a launch from here would use (CGLAB-696 task 7).
    const workspace = workspaceOf(cwd, d);
    const nested = findAgenfkDirs(workspace, d);
    if (!nested.complete && d.platform === 'linux') {
      return cannot(`Could not list every .agenfk directory under ${workspace} (more than ${AGENFK_SCAN_LIMIT}, or one could not be read); on Linux each must be protected by name.`);
    }
    // The report token's directory must exist for the sandbox to hide it (Linux masks what exists at launch).
    d.ensurePrivateDir(path.join(d.home, '.agenfk', 'airlock'));
    spec = buildSandboxSpec(policy, {
      client: 'pi',
      purpose: 'command',
      home: d.home,
      workspace,
      tempDirs: [...new Set([d.tmpDir, sharedTempDir(d.platform, d.realpath) ?? d.tmpDir])],
      inferenceHosts: [],
      serverPort: 0,
      directServerPort: d.directServerPort,
      installDirs: d.installDirs,
      projectAgenfkDirs: [...projectAgenfkDirs({ cwd, home: d.home, exists: d.exists }), ...nested.dirs],
      gitDir: workspaceGitDir(workspace, d),
      runtimePackageDir: d.runtimePackageDir,
    });
    spec.machineImage = image;
    // What the spec sets wins: the sandbox marker, NO_PROXY.
    spec.env = { ...guestCommandEnv(d.env), ...spec.env };
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
