// upgradeSync — local fleet client for hub-issued upgrade directives.
// Story 3b of EPIC 541c12b3.
//
// Two pure-ish functions are exported for direct unit testing:
//   - reconcileUpgradeDirective: one polling tick. Pulls /v1/upgrade-directive,
//     decides, emits events, optionally spawns `agenfk upgrade --version <x>`.
//   - replayPendingUpgradeOutcome: boot-time recovery. If a previous run wrote
//     state="started" but the new server boots without ever sending the
//     succeeded/failed event (because `agenfk upgrade` killed the emitting
//     process), reconcile by comparing the running version against the
//     directive's intent and emit the appropriate outcome.
//
// `startUpgradeSync` wires both of the above into the polling timer used by
// the live server.
import {
  readUpgradeState, writeUpgradeState, clearUpgradeState,
  UpgradeState,
} from './upgradeState.js';

export interface FetchedDirective {
  directiveId: string;
  targetVersion: string;
}

export type FetchDirectiveImpl = (input: {
  hubUrl: string;
  hubToken: string;
  installationId: string;
}) => Promise<{ status: number; json: () => Promise<any> }>;

export interface SpawnUpgradeResult {
  exitCode: number | null;
  stdout: string;
}

export type SpawnUpgradeImpl = (cmd: string, args: string[]) => SpawnUpgradeResult;

export interface RecordEventFn {
  (input: {
    installationId: string;
    type: 'fleet:upgrade:started' | 'fleet:upgrade:succeeded' | 'fleet:upgrade:failed';
    payload: any;
    occurredAt?: string;
  }): void;
}

export interface ReconcileArgs {
  dbDir: string;
  currentVersion: string;
  hubUrl: string;
  hubToken: string;
  installationId: string;
  fetchImpl: FetchDirectiveImpl;
  recordEvent: RecordEventFn;
  flushNow: (timeoutMs?: number) => Promise<void>;
  spawnImpl: SpawnUpgradeImpl;
  // Default points at the local cli bin. Tests inject something simpler.
  cliCommand?: string;
  cliArgs?: (targetVersion: string) => string[];
}

export interface ReplayArgs {
  dbDir: string;
  currentVersion: string;
  installationId: string;
  recordEvent: RecordEventFn;
}

const DEFAULT_CLI_COMMAND = 'node';
const DEFAULT_CLI_ARGS = (targetVersion: string): string[] => [
  'packages/cli/bin/agenfk.js',
  'upgrade',
  '--version', targetVersion,
  '--json',
];

let inflight = false;

// Defense-in-depth: refuse to spawn the CLI with a malformed version. Story 1's
// CLI also enforces this allowlist, but a compromised hub shouldn't even get
// the chance to land an exotic value into argv on a fleet machine.
const SEMVER_TAG_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export async function reconcileUpgradeDirective(args: ReconcileArgs): Promise<void> {
  if (inflight) return;
  inflight = true;
  try {
    const resp = await args.fetchImpl({
      hubUrl: args.hubUrl,
      hubToken: args.hubToken,
      installationId: args.installationId,
    });
    if (resp.status !== 200) return; // 204 → nothing pending; other → ignore
    const body: FetchedDirective = await resp.json();
    if (!body || typeof body.directiveId !== 'string' || typeof body.targetVersion !== 'string') return;
    if (!SEMVER_TAG_RE.test(body.targetVersion)) {
      console.error('[HUB_UPGRADE_SYNC] refusing to apply malformed targetVersion:', body.targetVersion);
      return;
    }

    // Skip if already applied — re-entry after restart, or admin re-listed.
    const existing = readUpgradeState(args.dbDir);
    if (existing && existing.lastDirectiveId === body.directiveId) return;

    const occurredAt = new Date().toISOString();

    // 1. Append `started` to outbox.
    args.recordEvent({
      installationId: args.installationId,
      type: 'fleet:upgrade:started',
      payload: { directiveId: body.directiveId, targetVersion: body.targetVersion },
      occurredAt,
    });

    // 2. Persist intent BEFORE we hand control to a process that might kill us.
    writeUpgradeState(args.dbDir, {
      lastDirectiveId: body.directiveId,
      outcome: 'started',
      resultVersion: body.targetVersion, // intent — replay compares against this.
    });

    // 3. Drain the outbox so the hub sees `started` before we suicide.
    await args.flushNow(5_000);

    // 4. Spawn the CLI.
    const cliArgs = (args.cliArgs ?? DEFAULT_CLI_ARGS)(body.targetVersion);
    const cliCommand = args.cliCommand ?? DEFAULT_CLI_COMMAND;
    const result = args.spawnImpl(cliCommand, cliArgs);

    // 5. Parse the CLI's JSON outcome (Story 1 contract).
    let parsed: { status?: string; fromVersion?: string; toVersion?: string; error?: string } = {};
    try {
      const lastLine = (result.stdout || '').trim().split('\n').filter(Boolean).pop() ?? '{}';
      parsed = JSON.parse(lastLine);
    } catch { /* leave parsed empty; treat as failed */ }

    const exitOk = (result.exitCode ?? 0) === 0;
    const cliReportedSucceeded = parsed.status === 'noop' || parsed.status === 'upgraded';

    if (exitOk && cliReportedSucceeded) {
      args.recordEvent({
        installationId: args.installationId,
        type: 'fleet:upgrade:succeeded',
        payload: {
          directiveId: body.directiveId,
          resultVersion: parsed.toVersion ?? body.targetVersion,
        },
      });
      // Settled — clear local state so the hub's eventual ack-cycle is the
      // single source of truth.
      clearUpgradeState(args.dbDir);
    } else {
      const error = parsed.error || `agenfk upgrade exited ${result.exitCode}`;
      args.recordEvent({
        installationId: args.installationId,
        type: 'fleet:upgrade:failed',
        payload: { directiveId: body.directiveId, error },
      });
      // Persist as failed so we don't re-spawn on every poll.
      writeUpgradeState(args.dbDir, {
        lastDirectiveId: body.directiveId,
        outcome: 'failed',
        error,
        finishedAt: new Date().toISOString(),
      });
    }
  } finally {
    inflight = false;
  }
}

export async function replayPendingUpgradeOutcome(args: ReplayArgs): Promise<void> {
  const state: UpgradeState | null = readUpgradeState(args.dbDir);
  if (!state) return;
  if (state.outcome !== 'started') return;

  // Compare the running version against the directive's intent.
  const intent = state.resultVersion ?? '';
  if (intent && args.currentVersion === intent) {
    args.recordEvent({
      installationId: args.installationId,
      type: 'fleet:upgrade:succeeded',
      payload: {
        directiveId: state.lastDirectiveId,
        resultVersion: args.currentVersion,
      },
    });
  } else {
    args.recordEvent({
      installationId: args.installationId,
      type: 'fleet:upgrade:failed',
      payload: {
        directiveId: state.lastDirectiveId,
        error: `Upgrade did not complete: expected ${intent || '<unknown>'}, got ${args.currentVersion}`,
      },
    });
  }
  clearUpgradeState(args.dbDir);
}

// ── Live polling timer (used at server boot) ────────────────────────────────
const DEFAULT_INTERVAL_MS = 60_000;

export interface UpgradeSyncHandle { stop: () => void }

export interface StartUpgradeSyncArgs extends Omit<ReconcileArgs, never> {
  intervalMs?: number;
}

export function startUpgradeSync(args: StartUpgradeSyncArgs): UpgradeSyncHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const interval = args.intervalMs ?? DEFAULT_INTERVAL_MS;

  const tick = async () => {
    if (stopped) return;
    try {
      await reconcileUpgradeDirective(args);
    } catch (e) {
      console.error('[HUB_UPGRADE_SYNC] tick failed:', (e as Error).message);
    }
    if (!stopped) timer = setTimeout(tick, interval);
  };

  // Defer first tick by 2s so boot-time replay (which runs before this) gets
  // its events into the outbox first.
  timer = setTimeout(tick, 2_000);

  return {
    stop: () => {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
    },
  };
}
