/**
 * BUG 2f491181 — upgrade does not auto-restart the server, leaving the
 * long-running process executing the stale (pre-upgrade) version in memory.
 *
 * Root cause: the post-install restart (BUG 174270e6) is gated solely on
 * `wasReachableBeforeInstall`, a reachability probe taken at install.mjs
 * start. But the `agenfk upgrade` CLI runs `down` BEFORE invoking
 * install.mjs, so the probe is always false during an upgrade and the
 * restart is skipped. The hub-driven path is worse: the spawned CLI's own
 * `servicesRunning` probe can false-negative, skipping both `down` and its
 * fallback `up`, so nothing ever restarts.
 *
 * The durable fix must live in install.mjs because that is the only piece
 * that runs as NEW code during the upgrade that ships it (the reconciler and
 * the CLI `upgrade` command both run as the pre-upgrade process image). The
 * restart trigger is therefore broadened to fire when ANY of these hold:
 *   1. the reachability probe succeeds (legacy behavior), OR
 *   2. the env var AGENFK_SERVER_WAS_RUNNING is set (the CLI passes the
 *      pre-`down` running state explicitly — fixes the manual path), OR
 *   3. an in-flight hub upgrade marker exists — `upgrade-state.json` with
 *      outcome === 'started', which the reconciler writes before spawning
 *      the CLI. This self-heals the hub path on the delivering upgrade.
 *
 * Source-introspection tests, mirroring restart-quiet.test.ts.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CLI_SRC = fs.readFileSync(path.join(REPO_ROOT, 'packages/cli/src/index.ts'), 'utf8');
const INSTALL_SCRIPT = fs.readFileSync(path.join(REPO_ROOT, 'scripts/install.mjs'), 'utf8');

/** The body of the `agenfk upgrade` command action. */
function upgradeCommandSection(): string {
  const idx = CLI_SRC.search(/\.command\(['"]upgrade['"]\)/);
  expect(idx).toBeGreaterThan(-1);
  // Stop at the next top-level `.command(` so we only inspect `upgrade`.
  const next = CLI_SRC.indexOf('.command(', idx + 10);
  return CLI_SRC.slice(idx, next === -1 ? undefined : next);
}

describe('BUG 2f491181: install.mjs restart trigger is not gated solely on the probe', () => {
  it('reads the explicit AGENFK_SERVER_WAS_RUNNING signal', () => {
    expect(INSTALL_SCRIPT).toMatch(/AGENFK_SERVER_WAS_RUNNING/);
  });

  it('detects an in-flight hub upgrade via the upgrade-state marker', () => {
    // install.mjs must consult upgrade-state.json (outcome 'started') so a
    // hub-driven upgrade self-heals even though `down` already ran.
    expect(INSTALL_SCRIPT).toMatch(/upgrade-state\.json/);
    expect(INSTALL_SCRIPT).toMatch(/started/);
  });

  it('age-guards the in-flight marker so a stale one cannot spuriously restart', () => {
    // An interrupted upgrade leaves upgrade-state.json at outcome 'started';
    // it is only cleared on the next server boot. Without an age guard a later
    // unrelated install would read the landmine and start a server. install.mjs
    // must only trust a *fresh* marker (startedAt within a bounded window).
    expect(INSTALL_SCRIPT).toMatch(/startedAt/);
    // A staleness window comparison must exist near the marker read. Anchor on
    // the quoted code reference so we don't match the explanatory comment.
    const markerIdx = INSTALL_SCRIPT.indexOf("'upgrade-state.json'");
    expect(markerIdx).toBeGreaterThan(-1);
    const window = INSTALL_SCRIPT.slice(markerIdx, markerIdx + 900);
    expect(window).toMatch(/STALE_MS|Date\.parse|fresh/);
  });

  it('resolves dbDir via config.json dbPath as well as AGENFK_DB_PATH', () => {
    // Must mirror the server's dbPath resolution so the marker is found even
    // when the server was started without AGENFK_DB_PATH but with a config.json.
    const markerIdx = INSTALL_SCRIPT.indexOf("'upgrade-state.json'");
    expect(markerIdx).toBeGreaterThan(-1);
    const before = INSTALL_SCRIPT.slice(Math.max(0, markerIdx - 700), markerIdx);
    expect(before).toMatch(/AGENFK_DB_PATH/);
    expect(before).toMatch(/config\.json/);
  });

  it('gates the restart on a signal broader than wasReachableBeforeInstall', () => {
    // Find the restart spawn ('restart' via agenfk.js) and walk back to the
    // enclosing `if (` guard. It must reference an OR with an explicit signal,
    // not depend on the probe alone.
    const restartIdx = INSTALL_SCRIPT.search(/agenfk\.js['"][^\n]*['"]restart['"]/);
    expect(restartIdx).toBeGreaterThan(-1);
    const guard = INSTALL_SCRIPT.lastIndexOf('if (', restartIdx);
    expect(guard).toBeGreaterThan(-1);
    const condition = INSTALL_SCRIPT.slice(guard, restartIdx);
    // The guard must combine signals (||) — i.e. not be `wasReachableBeforeInstall && !onlyPlatform` alone.
    expect(condition).toMatch(/\|\|/);
    expect(condition).toMatch(/AGENFK_SERVER_WAS_RUNNING|upgradeInFlight|serverWasRunning/);
  });
});

describe('BUG 2f491181: CLI upgrade hands the pre-down running state to install.mjs', () => {
  it('sets AGENFK_SERVER_WAS_RUNNING when invoking install.mjs', () => {
    const section = upgradeCommandSection();
    // The install.mjs invocation must propagate the env signal.
    expect(section).toMatch(/AGENFK_SERVER_WAS_RUNNING/);
    // And it must be wired to the pre-`down` capture, not unconditionally on.
    expect(section).toMatch(/servicesRunning/);
  });

  it('does not also fire a separate fallback `up` that races install.mjs restart', () => {
    // The legacy fallback (`spawn('node', [...'up'])` after install) double-
    // restarts now that install.mjs reliably owns the restart. It must be
    // removed/guarded so the two don't race for the port.
    const section = upgradeCommandSection();
    expect(section).not.toMatch(/spawn\(\s*['"]node['"]\s*,\s*\[[^\]]*['"]up['"]/);
  });
});
