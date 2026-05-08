/**
 * Regression test for BUG 0bc7669b: events shipped with `remoteUrl: null`
 * because `recordHubEvent` fired `warmProjectRemote(projectId)` as a
 * fire-and-forget promise (`.catch(() => {})`) and then immediately enqueued
 * the event with `remoteUrl: null`. The cache only became populated for
 * *subsequent* events — so the first event for any project (e.g. right after
 * server boot) always reached the hub without a remote URL attached.
 *
 * Fix contract pinned here:
 *   - `recordHubEvent` is async and awaits `warmProjectRemote` on cache miss
 *     BEFORE calling `hubClient.recordEvent(...)` — so the very first event
 *     for a project carries the resolved remoteUrl.
 *   - The fire-and-forget pattern around warmProjectRemote is gone.
 *
 * Source-string assertions match the convention in
 * hub-validate-step-transition.test.ts and upgrade-tier.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const SERVER_SRC = readFileSync(
  path.resolve(__dirname, '../server.ts'),
  'utf8'
);

// Slice the recordHubEvent definition so assertions don't bleed into
// elsewhere in the file (warmProjectRemote itself, etc.).
function getRecordHubEventBody(src: string): string {
  const declIdx = src.search(/const\s+recordHubEvent\s*=/);
  if (declIdx === -1) return '';
  // The function is followed by other top-level definitions; cap at next `const ` definition starting a line.
  const tail = src.slice(declIdx);
  const nextTopLevel = tail.search(/\n\}\s*;\s*\n\s*\/\//);
  return nextTopLevel === -1 ? tail.slice(0, 4000) : tail.slice(0, nextTopLevel + 4);
}

describe('BUG 0bc7669b — recordHubEvent must await warmProjectRemote on cold cache', () => {
  it('declares recordHubEvent as an async function', () => {
    const body = getRecordHubEventBody(SERVER_SRC);
    expect(body.length).toBeGreaterThan(0);
    // Either `async (input...) =>` arrow or `async function recordHubEvent`.
    expect(body).toMatch(/recordHubEvent\s*=\s*async\b|async\s+function\s+recordHubEvent\b/);
  });

  it('awaits warmProjectRemote on cache miss (no fire-and-forget)', () => {
    const body = getRecordHubEventBody(SERVER_SRC);
    expect(body.length).toBeGreaterThan(0);
    // Must contain `await warmProjectRemote(`.
    expect(body).toMatch(/await\s+warmProjectRemote\s*\(/);
  });

  it('does not retain the original fire-and-forget warm pattern', () => {
    const body = getRecordHubEventBody(SERVER_SRC);
    expect(body.length).toBeGreaterThan(0);
    // The original bug pattern was: warmProjectRemote(input.projectId).catch(...)
    // After the fix this expression must not exist (we await instead).
    expect(body).not.toMatch(/warmProjectRemote\s*\([^)]*\)\s*\.catch/);
  });

  it('awaits the warm BEFORE calling hubClient.recordEvent', () => {
    const body = getRecordHubEventBody(SERVER_SRC);
    expect(body.length).toBeGreaterThan(0);
    const warmIdx = body.search(/await\s+warmProjectRemote\s*\(/);
    const recordIdx = body.search(/hubClient\.recordEvent\s*\(/);
    expect(warmIdx).toBeGreaterThan(-1);
    expect(recordIdx).toBeGreaterThan(-1);
    expect(warmIdx).toBeLessThan(recordIdx);
  });

  it('reads the resolved remoteUrl from cache after the warm completes', () => {
    const body = getRecordHubEventBody(SERVER_SRC);
    expect(body.length).toBeGreaterThan(0);
    // After awaiting, the function must re-read the cache so the event sees
    // the just-populated value (not the stale `null` captured before the await).
    // We assert at least two cache reads exist OR a single read placed AFTER
    // the await.
    const cacheReads = body.match(/projectRemoteCache\.get\s*\(/g) ?? [];
    expect(cacheReads.length).toBeGreaterThanOrEqual(1);
    const lastCacheReadIdx = body.lastIndexOf('projectRemoteCache.get(');
    const warmIdx = body.search(/await\s+warmProjectRemote\s*\(/);
    expect(lastCacheReadIdx).toBeGreaterThan(warmIdx);
  });
});
