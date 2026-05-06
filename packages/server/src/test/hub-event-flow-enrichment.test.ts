/**
 * Hub events must carry `flow: { name, install_source }` in their payload
 * whenever a projectId is known, so the hub admin can see at a glance which
 * flow was active and whether the install is hub-managed or manual.
 *
 * Source-string assertions match the convention in
 * hub-event-remote-url-cold-cache.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const SERVER_SRC = readFileSync(
  path.resolve(__dirname, '../server.ts'),
  'utf8',
);

function getRecordHubEventBody(src: string): string {
  const declIdx = src.search(/const\s+recordHubEvent\s*=/);
  if (declIdx === -1) return '';
  const tail = src.slice(declIdx);
  const nextTopLevel = tail.search(/\n\}\s*;\s*\n\s*\/\//);
  return nextTopLevel === -1 ? tail.slice(0, 4000) : tail.slice(0, nextTopLevel + 4);
}

describe('Hub event flow enrichment', () => {
  it('recordHubEvent injects a flow object into the event payload', () => {
    const body = getRecordHubEventBody(SERVER_SRC);
    expect(body.length).toBeGreaterThan(0);
    // Must reference resolveFlowName for the active flow's display name.
    expect(body).toMatch(/resolveFlowName\s*\(/);
    // Must reference getInstallSource (re-exported from @agenfk/telemetry).
    expect(body).toMatch(/getInstallSource\s*\(/);
    // Must build a flow envelope with name + install_source on the payload.
    expect(body).toMatch(/flow\s*:\s*\{[^}]*name\s*:[^}]*install_source\s*:/);
  });

  it('imports getInstallSource from @agenfk/telemetry', () => {
    expect(SERVER_SRC).toMatch(
      /import\s+\{[^}]*getInstallSource[^}]*\}\s+from\s+["']@agenfk\/telemetry["']/,
    );
  });

  it('does not enrich when projectId is absent', () => {
    const body = getRecordHubEventBody(SERVER_SRC);
    expect(body.length).toBeGreaterThan(0);
    // The enrichment must be guarded by `input.projectId` so non-project
    // events (e.g. server-level diagnostics) don't get a meaningless flow.
    // We assert the resolveFlowName call appears in a branch alongside
    // input.projectId — same pattern as the remoteUrl resolution.
    expect(body).toMatch(/input\.projectId[\s\S]{0,400}resolveFlowName/);
  });
});
