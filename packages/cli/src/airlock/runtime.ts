/**
 * Airlock layer 2 (GH-294, L2-1): the runtime that puts a process inside the
 * sandbox. AgEnFK talks to it only through AirlockRuntime, so the Sandbox
 * Runtime (ASRT, pre-1.0) can be swapped or bumped behind it; the conformance
 * suite (airlock-sandbox-conformance.test.ts) pins what any version must hold.
 *
 * ASRT is used as a library: its proxy lives in this (unsandboxed) process for
 * as long as the sandboxed one runs.
 */
import path from 'path';
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'child_process';
import type { SandboxSpec } from './spec';

/** Exactly the version in packages/cli/package.json (no range): a bump is a reviewed change. */
export const ASRT_VERSION = '0.0.81';
const ASRT_PACKAGE = '@anthropic-ai/sandbox-runtime';

export interface SandboxCommand { file: string; args: string[]; cwd: string }
export interface SandboxExit { code: number | null; signal: NodeJS.Signals | null }
export interface LaunchedSandbox {
  pid: number | undefined;
  kill(signal: NodeJS.Signals): boolean;
  exited: Promise<SandboxExit>;
}
export type RuntimeCheck = { ok: true; warnings: string[] } | { ok: false; reason: string };

export interface AirlockRuntime {
  /** e.g. `asrt@0.0.81` */
  readonly id: string;
  /** Can this machine sandbox at all? Says what is missing when not. */
  check(): Promise<RuntimeCheck>;
  /** Start `command` inside a sandbox built from `spec`. Rejects (and starts nothing) when it cannot. */
  launch(spec: SandboxSpec, command: SandboxCommand): Promise<LaunchedSandbox>;
  /** Stop the runtime's proxies. */
  dispose(): Promise<void>;
}

/** The part of ASRT's SandboxManager this adapter uses. */
export interface AsrtManager {
  initialize(config: AsrtConfig): Promise<void>;
  checkDependencies(): { errors: string[]; warnings: string[] };
  wrapWithSandboxArgv(command: string, binShell?: string, customConfig?: unknown, abortSignal?: AbortSignal, cwd?: string):
    Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>;
  reset(): Promise<void>;
}

export interface AsrtConfig {
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
    deniedResolvedAddresses: string[];
    allowLocalBinding?: boolean;
    tlsTerminate?: Record<string, never>;
  };
  filesystem: { denyRead: string[]; allowWrite: string[]; denyWrite: string[] };
  credentials?: { envVars: Array<{ name: string; mode: 'mask'; injectHosts: string[] }> };
  allowPty: boolean;
  allowAppleEvents?: boolean;
  enableWeakerNetworkIsolation?: boolean;
  allowNestedUserNamespaces?: boolean;
}

export function toAsrtConfig(spec: SandboxSpec): AsrtConfig {
  const cfg: AsrtConfig = {
    network: {
      allowedDomains: [...spec.network.allow],
      deniedDomains: [...spec.network.deny],
      deniedResolvedAddresses: [...spec.network.denyResolved],
    },
    filesystem: {
      denyRead: [...spec.filesystem.denyRead],
      allowWrite: [...spec.filesystem.allowWrite],
      denyWrite: [...spec.filesystem.denyWrite],
    },
    allowPty: spec.allowPty,
  };
  if (spec.maskedEnv.length) {
    // Masking needs TLS termination, so the real key only leaves over a
    // verified TLS connection to the hosts named.
    cfg.network.tlsTerminate = {};
    cfg.credentials = { envVars: spec.maskedEnv.map((m) => ({ name: m.name, mode: 'mask', injectHosts: [...m.injectHosts] })) };
  }
  return cfg;
}

const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** The shell line the sandbox runs: the spec's env over the runtime's, then the program. */
export function sandboxCommandLine(spec: SandboxSpec, command: SandboxCommand): string {
  const env = Object.entries(spec.env).map(([k, v]) => quote(`${k}=${v}`));
  return ['exec', 'env', ...env, quote(command.file), ...command.args.map(quote)].join(' ');
}

interface AsrtRuntimeDeps {
  load?: () => Promise<{ SandboxManager: AsrtManager }>;
  spawn?: (file: string, args: string[], options: SpawnOptions) => ChildProcess;
  platform?: NodeJS.Platform;
}

export class AsrtRuntime implements AirlockRuntime {
  readonly id = `asrt@${ASRT_VERSION}`;
  private readonly load: () => Promise<{ SandboxManager: AsrtManager }>;
  private readonly spawn: NonNullable<AsrtRuntimeDeps['spawn']>;
  private readonly platform: NodeJS.Platform;
  private manager: AsrtManager | null = null;

  constructor(deps: AsrtRuntimeDeps = {}) {
    // Node 22.12+ loads the ESM package through require (ASRT itself needs 22.12).
    this.load = deps.load ?? (async () => require(ASRT_PACKAGE));
    this.spawn = deps.spawn ?? nodeSpawn;
    this.platform = deps.platform ?? process.platform;
  }

  /** Where the ASRT package is installed (the launcher keeps it outside every write root). */
  static packageDir(req: NodeRequire = require): string {
    return path.dirname(req.resolve(`${ASRT_PACKAGE}/package.json`));
  }

  async check(): Promise<RuntimeCheck> {
    if (this.platform === 'win32') {
      return { ok: false, reason: 'Windows is not supported by the Airlock sandbox in this release (macOS and Linux only).' };
    }
    if (this.platform !== 'darwin' && this.platform !== 'linux') {
      return { ok: false, reason: `The Airlock sandbox does not support ${this.platform} (macOS and Linux only).` };
    }
    const { SandboxManager } = await this.load();
    const deps = SandboxManager.checkDependencies();
    if (deps.errors.length) {
      const hint = this.platform === 'linux' ? ' Install bubblewrap (bwrap), socat and ripgrep (rg).' : '';
      return { ok: false, reason: `The Airlock sandbox cannot run here: ${deps.errors.join('; ')}.${hint}` };
    }
    return { ok: true, warnings: deps.warnings };
  }

  async launch(spec: SandboxSpec, command: SandboxCommand): Promise<LaunchedSandbox> {
    const ready = await this.check();
    if (!ready.ok) throw new Error(ready.reason);
    const { SandboxManager } = await this.load();
    this.manager = SandboxManager;
    let child: ChildProcess;
    try {
      await SandboxManager.initialize(toAsrtConfig(spec));
      const wrapped = await SandboxManager.wrapWithSandboxArgv(
        sandboxCommandLine(spec, command), undefined, undefined, undefined, command.cwd,
      );
      child = this.spawn(wrapped.argv[0], wrapped.argv.slice(1), { cwd: command.cwd, env: wrapped.env, stdio: 'inherit' });
    } catch (e) {
      await this.dispose();
      throw e;
    }
    const exited = new Promise<SandboxExit>((resolve, reject) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
      child.once('error', reject);
    });
    return { pid: child.pid, kill: (signal) => child.kill(signal), exited };
  }

  async dispose(): Promise<void> {
    const m = this.manager;
    this.manager = null;
    if (m) await m.reset();
  }
}
