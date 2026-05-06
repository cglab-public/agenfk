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
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import {
  readUpgradeState, writeUpgradeState, clearUpgradeState,
  UpgradeState,
} from './upgradeState.js';

function stripV(v: string): string {
  return v.startsWith('v') ? v.slice(1) : v;
}

/**
 * Walk a few candidate package.json paths and return the first version we
 * find on disk. Mirrors the resolution used in flusher's CURRENT_VERSION,
 * but re-reads each call so we see writes that landed after process start.
 */
function defaultReadInstalledVersion(): string | null {
  const candidates = [
    path.resolve(__dirname, '../../package.json'),
    path.resolve(__dirname, '../../../package.json'),
    path.resolve(__dirname, '../../../cli/package.json'),
    path.resolve(__dirname, '../../../../packages/cli/package.json'),
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (typeof pkg?.version === 'string' && pkg.version) return pkg.version;
    } catch { /* keep trying */ }
  }
  return null;
}

/**
 * Best-effort guess at the install root — the directory whose `packages/`
 * subtree the release tarball should be extracted into. From the built
 * `packages/server/dist/hub/upgradeSync.js`, that's four levels up.
 * Validated by checking that `packages/cli/package.json` exists, so we don't
 * accidentally clobber an unrelated directory.
 */
function defaultInstallRoot(): string | null {
  const candidate = path.resolve(__dirname, '../../../..');
  try {
    if (fs.existsSync(path.join(candidate, 'packages/cli/package.json'))) return candidate;
  } catch { /* fall through */ }
  return null;
}

const DIST_REPO = 'cglab-public/agenfk';
const DIST_ASSET = 'agenfk-dist.tar.gz';

async function defaultSelfExtract(input: { installRoot: string; targetVersion: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  const tag = `v${stripV(input.targetVersion)}`;
  const url = `https://github.com/${DIST_REPO}/releases/download/${tag}/${DIST_ASSET}`;
  const tmpFile = path.join(os.tmpdir(), `agenfk-self-heal-${Date.now()}.tar.gz`);
  try {
    execSync(`curl -fsSL -o "${tmpFile}" "${url}"`, { stdio: 'pipe' });
    execSync(`tar -xzf "${tmpFile}" -C "${input.installRoot}"`, { stdio: 'pipe' });
    return { ok: true };
  } catch (e: any) {
    const msg = e?.stderr?.toString?.()?.trim() || e?.message || String(e);
    return { ok: false, error: msg };
  } finally {
    try { if (fs.existsSync(tmpFile)) fs.rmSync(tmpFile, { force: true }); } catch { /* ignore */ }
  }
}

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

/**
 * Reads the agenfk version actually installed on disk *now*. We cannot trust
 * the running process's CURRENT_VERSION constant after a spawn, because the
 * spawn may have replaced files on disk while the parent kept its already-
 * loaded modules. Used to verify whether the upgrade actually landed.
 */
export type ReadInstalledVersionImpl = () => string | null;

/**
 * Self-heal fallback: when the locally-installed CLI is too old to recognise
 * `--version <ver>` (commander treats it as the global -V flag, prints its
 * own version, and exits 0), the reconciler downloads the release tarball
 * itself and untars it into the install root. Default uses curl + tar via
 * execSync; tests inject a fake.
 */
export type SelfExtractImpl = (input: {
  installRoot: string;
  targetVersion: string;
}) => Promise<{ ok: true } | { ok: false; error: string }>;

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
  // Default reads `<repoRoot>/package.json` walking a few candidate paths;
  // tests inject a fake.
  readInstalledVersionImpl?: ReadInstalledVersionImpl;
  // Install root for the self-extract fallback. Default walks up from
  // __dirname; tests inject a fake path.
  installRoot?: string;
  // Default downloads the GitHub release tarball and tar -xzf into installRoot.
  selfExtractImpl?: SelfExtractImpl;
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

    // Trust the on-disk version over the CLI's word. The CLI process may have
    // been killed before it could emit JSON (the install can replace files
    // the parent process needs to keep running), so spawnSync may report
    // exit 0 with no parseable stdout even though the upgrade landed. The
    // converse also happens: install silently no-op'd, exit 0, no JSON, but
    // the on-disk version didn't change. Comparing against the on-disk
    // version is the only ground truth.
    const readInstalledVersion = args.readInstalledVersionImpl ?? defaultReadInstalledVersion;
    const onDisk = readInstalledVersion();
    const onDiskMatchesIntent = !!onDisk && stripV(onDisk) === stripV(body.targetVersion);
    const cliReportedFailed = parsed.status === 'failed';

    const succeeded = onDiskMatchesIntent && !cliReportedFailed;

    if (succeeded) {
      args.recordEvent({
        installationId: args.installationId,
        type: 'fleet:upgrade:succeeded',
        payload: {
          directiveId: body.directiveId,
          resultVersion: parsed.toVersion ?? onDisk ?? body.targetVersion,
        },
      });
      clearUpgradeState(args.dbDir);
      return;
    }

    // ── Stale-CLI bootstrap recovery ──
    // Old fleet clients (pre-`--version` option) treat `--version <ver>` as
    // commander's global -V flag: they print their own version and exit 0
    // with no install side-effects. Detect that signature (exit 0 + no
    // parsed status + on-disk unchanged + on-disk === currentVersion) and
    // try a self-extract recovery instead of giving up. Without this, every
    // future directive on those installations will permanently re-fail.
    // A stale CLI prints its own version on stdout (commander's -V handler)
    // and exits 0. We look for that exact footprint: last non-empty line is a
    // bare semver and equals the on-disk version. This avoids false positives
    // when the CLI emits arbitrary diagnostics on the same exit path.
    const lastStdoutLine = (result.stdout || '').trim().split('\n').filter(Boolean).pop() ?? '';
    const stdoutIsBareSemver = SEMVER_TAG_RE.test(lastStdoutLine);
    const looksLikeStaleCli =
      exitOk
      && !cliReportedSucceeded
      && !cliReportedFailed
      && !!onDisk
      && !onDiskMatchesIntent
      && stripV(onDisk) === stripV(args.currentVersion)
      && stdoutIsBareSemver
      && stripV(lastStdoutLine) === stripV(onDisk);

    if (looksLikeStaleCli) {
      const installRoot = args.installRoot ?? defaultInstallRoot();
      if (installRoot) {
        const sx = await (args.selfExtractImpl ?? defaultSelfExtract)({
          installRoot,
          targetVersion: body.targetVersion,
        });
        const newOnDisk = readInstalledVersion();
        const newOnDiskMatches = !!newOnDisk && stripV(newOnDisk) === stripV(body.targetVersion);
        if (sx.ok && newOnDiskMatches) {
          args.recordEvent({
            installationId: args.installationId,
            type: 'fleet:upgrade:succeeded',
            payload: {
              directiveId: body.directiveId,
              resultVersion: newOnDisk!,
              recoveredVia: 'self-extract',
            },
          });
          clearUpgradeState(args.dbDir);
          return;
        }
        const reason = sx.ok
          ? `self-heal extraction completed but on-disk version is ${newOnDisk ?? '<unknown>'}`
          : `self-heal extraction failed: ${sx.error}`;
        const error = `fleet CLI predates pinned-version upgrades (does not recognise --version), and ${reason}. Run 'agenfk upgrade --beta' or 'npx github:cglab-public/agenfk' on the host to recover.`;
        args.recordEvent({
          installationId: args.installationId,
          type: 'fleet:upgrade:failed',
          payload: { directiveId: body.directiveId, error },
        });
        writeUpgradeState(args.dbDir, {
          lastDirectiveId: body.directiveId,
          outcome: 'failed',
          error,
          finishedAt: new Date().toISOString(),
        });
        return;
      }
    }

    // ── Generic failure paths ──
    let error: string;
    if (parsed.error) {
      error = parsed.error;
    } else if (exitOk && !cliReportedSucceeded && onDisk && !onDiskMatchesIntent) {
      error = `agenfk upgrade exited 0 but on-disk version is ${onDisk}, expected ${body.targetVersion}`;
    } else if (!exitOk) {
      error = `agenfk upgrade exited ${result.exitCode}`;
    } else {
      error = `agenfk upgrade did not land target ${body.targetVersion}`;
    }
    args.recordEvent({
      installationId: args.installationId,
      type: 'fleet:upgrade:failed',
      payload: { directiveId: body.directiveId, error },
    });
    writeUpgradeState(args.dbDir, {
      lastDirectiveId: body.directiveId,
      outcome: 'failed',
      error,
      finishedAt: new Date().toISOString(),
    });
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
