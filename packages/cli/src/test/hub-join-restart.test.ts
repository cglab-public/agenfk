/**
 * Story 6 — `agenfk hub join <inviteToken>` must restart the local API
 * server after a successful redeem so the running process picks up the new
 * ~/.agenfk/hub.json (otherwise hubClient/flowSync stay bound to the previous
 * config and Story 3's upgradeSync will not poll until the user manually
 * restarts the framework).
 *
 * Source-string assertions matching the convention from upgrade-tier.test.ts
 * and the rest of this package's tests.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const HUB_SRC = readFileSync(
  path.resolve(__dirname, '../commands/hub.ts'),
  'utf8'
);

function getJoinActionSection(src: string): string {
  const idx = src.indexOf(".command('join");
  if (idx === -1) return '';
  // Cap at the next `.command(` declaration so assertions don't bleed into
  // status/flush/logout further down.
  const after = src.slice(idx);
  const next = after.indexOf(".command('", 50);
  return next === -1 ? after : after.slice(0, next);
}

describe('Story 6 — hub join restarts local server', () => {
  it('declares a --no-restart escape hatch on the join command', () => {
    const section = getJoinActionSection(HUB_SRC);
    expect(section.length).toBeGreaterThan(0);
    expect(section).toMatch(/\.option\(\s*['"]--no-restart/);
  });

  it('probes whether the local API server is running after writeHubConfig', () => {
    const section = getJoinActionSection(HUB_SRC);
    // Must have a guard that branches on the running state — typically axios
    // GET to API_URL or getApiUrl() before deciding to restart.
    expect(section).toMatch(/getApiUrl\(\)|API_URL/);
    // The probe must come AFTER writeHubConfig in the action body.
    const writeIdx = section.indexOf('writeHubConfig');
    const probeIdx = section.search(/getApiUrl\(\)|API_URL/);
    expect(writeIdx).toBeGreaterThan(-1);
    expect(probeIdx).toBeGreaterThan(writeIdx);
  });

  it('runs `agenfk down` then `agenfk up` when restart is required', () => {
    const section = getJoinActionSection(HUB_SRC);
    expect(section).toMatch(/agenfk\.js\s+down|['"]down['"]/);
    expect(section).toMatch(/agenfk\.js\s+up|['"]up['"]/);
    const downIdx = section.search(/agenfk\.js\s+down/);
    const upIdx = section.search(/agenfk\.js['"]?,?\s*['"]up['"]|agenfk\.js\s+up/);
    expect(downIdx).toBeGreaterThan(-1);
    expect(upIdx).toBeGreaterThan(-1);
    expect(downIdx).toBeLessThan(upIdx);
  });

  it('does NOT call down/up when --no-restart is passed', () => {
    const section = getJoinActionSection(HUB_SRC);
    // The restart branch must be guarded on the inverse of the --no-restart flag
    // (commander surfaces this as `opts.restart === false` or `!opts.restart`).
    expect(section).toMatch(/opts\.restart|options\.restart|!\s*opts\.restart|!\s*options\.restart/);
  });
});
