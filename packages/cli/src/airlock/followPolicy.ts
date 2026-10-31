/**
 * CGLAB-696 story review 2 (LIFE-2): the policy is followed while a session or a command runs, not
 * only read at its launch. Asked again every policyPollMs; the machine is handed what the server
 * says (its own record decides what is newer, so a launcher whose answer came late changes nothing).
 * The server not answering, or turning the policy off, leaves the session as it is. A policy that no
 * longer admits the session - its inference host denied - or a machine that cannot follow it (one
 * an older AgEnFK started) ends the session: the machine is held to the new policy first where it
 * can be, then the session is sent SIGTERM, and SIGKILL once killGraceMs has passed.
 */
import { normalizeAirlockPolicy } from '@agenfk/core';
import type { SandboxSpec } from './spec';
import type { AirlockRuntime } from './runtime';
import type { PolicyView } from './launch';

export interface FollowDeps {
  fetchPolicy(projectId?: string | null): Promise<PolicyView>;
  runtime: AirlockRuntime;
  warn(message: string): void;
  log?(message: string): void;
  /** How often the policy is asked for again (ms). */
  policyPollMs?: number;
  /** How long an ended session has to go after SIGTERM before SIGKILL (ms). */
  killGraceMs?: number;
}

export interface Followed {
  project: string | null;
  /** The session's workspace: its machine's. */
  workspace: string;
  /** The session's sandbox under `view`; throws when the policy no longer admits the session. */
  specFor(view: PolicyView): SandboxSpec;
  /** The machine's network under `view` for a session it no longer admits (no inference host). */
  networkOnlyFor(view: PolicyView): SandboxSpec;
  session: { kill(signal: NodeJS.Signals): boolean; exited: Promise<unknown> };
}

/** Follows the policy until stop(), which waits for a check under way. Nothing when the runtime cannot. */
export function followPolicy(d: FollowDeps, f: Followed): { stop(): Promise<void> } {
  const update = d.runtime.updateNetwork?.bind(d.runtime);
  if (!update) return { stop: async () => undefined };
  let stopped = false;
  let checking: Promise<void> | null = null;
  let warned = false;
  const end = async (why: string) => {
    stopped = true;
    d.warn(`Airlock: ${why} The session is ended.`);
    f.session.kill('SIGTERM');
    const gone = await Promise.race([f.session.exited.then(() => true, () => true), new Promise<boolean>((r) => setTimeout(() => r(false), d.killGraceMs ?? 5000))]);
    if (!gone) f.session.kill('SIGKILL');
  };
  const check = async () => {
    let refused: string | null = null;
    // Run by the runtime holding the machine's lock: the answer is applied in the order it was fetched.
    const next = async (): Promise<SandboxSpec | null> => {
      let view: PolicyView;
      try { view = await d.fetchPolicy(f.project); } catch { return null; }
      if (stopped || normalizeAirlockPolicy(view?.effective).mode === 'off') return null;
      try {
        return f.specFor(view);
      } catch (e) {
        refused = `the policy changed and no longer admits this session: ${(e as Error).message.replace(/ Nothing was launched\.$/, '')}`;
        try { return f.networkOnlyFor(view); } catch { return null; }
      }
    };
    try {
      const outcome = await update(f.workspace, next);
      warned = false;
      if (outcome === 'applied') d.log?.('Airlock: the policy changed; the running session now follows it.');
    } catch (e) {
      if ((e as { cannotFollow?: boolean })?.cannotFollow) refused ??= `the policy changed, and ${(e as Error).message}, which cannot follow it. Launch again.`;
      else if (!warned) {
        warned = true;
        d.warn(`Airlock: the policy changed, but the running session could not follow it yet (${(e as Error)?.message ?? e}); it is tried again.`);
      }
    }
    if (refused) await end(refused);
  };
  const timer = setInterval(() => { if (!stopped && !checking) checking = check().finally(() => { checking = null; }); }, d.policyPollMs ?? 10_000);
  timer.unref?.();
  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await checking;
    },
  };
}
