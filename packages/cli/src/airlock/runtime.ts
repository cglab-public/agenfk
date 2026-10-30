/**
 * Airlock layer 2 (GH-294, L2-1): the runtime that puts a process inside the
 * sandbox. AgEnFK talks to it only through AirlockRuntime; since CGLAB-696 the
 * only one is SmolvmRuntime (smolvm.ts), and the conformance suite
 * (airlock-sandbox-conformance.test.ts) pins what it must hold.
 */
import type { SandboxSpec } from './spec';

export interface SandboxCommand {
  file: string;
  args: string[];
  cwd: string;
  /**
   * Run it in a process group of its own (POSIX), and signal the group: a shell's
   * children are reached too, and whatever is left when it exits is ended (SX-2).
   */
  processGroup?: boolean;
}
export interface SandboxExit { code: number | null; signal: NodeJS.Signals | null }
export interface LaunchedSandbox {
  pid: number | undefined;
  kill(signal: NodeJS.Signals): boolean;
  exited: Promise<SandboxExit>;
}
export type RuntimeCheck = { ok: true; warnings: string[] } | { ok: false; reason: string };

/** One decision of the machine's egress decider. `rule` names the list or check that decided. */
export interface ProxyDecision {
  host: string;
  port: number | null;
  decision: 'allow' | 'deny';
  rule: string;
}
export interface LaunchHooks {
  /** Called with each decision the egress decider makes. Must not block; a throw is ignored. */
  onProxyDecision?: (decision: ProxyDecision) => void;
}

export interface AirlockRuntime {
  /** e.g. `smolvm@1.32.4` */
  readonly id: string;
  /** Can this machine sandbox at all? Says what is missing when not. */
  check(): Promise<RuntimeCheck>;
  /** Start `command` inside a sandbox built from `spec`. Rejects (and starts nothing) when it cannot. */
  launch(spec: SandboxSpec, command: SandboxCommand, hooks?: LaunchHooks): Promise<LaunchedSandbox>;
  /** Let go of what the runtime holds for this process (its decision watchers). */
  dispose(): Promise<void>;
}
