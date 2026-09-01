/**
 * Story e3068dce (CGLAB-117, epic a3690599): `agenfk hub carry-over` and
 * `agenfk hub deadletter`.
 *
 * carry-over is the only path that rewrites an event's org stamp BETWEEN TWO
 * NAMED ORGS — the tenancy watermark (login/boot stamping of pre-login events
 * and `hub repoint` org renames are separate, narrower paths). It must be loud
 * (summary + cross-org warning), explicit (typed confirmation or --yes, TTY
 * gated), narrow (exactly the stated from->to, nothing else), and auditable
 * (one JSONL line per rewrite). deadletter list/discard are the read/cleanup
 * side of the spoke's deadletter file (story 2 writes it).
 *
 * Command wiring is pinned here by source scan (this package's convention,
 * see hub-join-restart.test.ts); behavior beyond text pinning lives in
 * hub-carryover-actions.test.ts and hub-deadletter-helpers.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const HUB_SRC = readFileSync(path.resolve(__dirname, '../commands/hub.ts'), 'utf8');

function getSection(src: string, marker: string): string {
  const idx = src.indexOf(marker);
  if (idx === -1) return '';
  const after = src.slice(idx);
  const next = after.indexOf(".command('", 50);
  return next === -1 ? after : after.slice(0, next);
}

// The pure-helper unit tests (summarizeDeadletter / filterDeadletterForDiscard)
// live in hub-deadletter-helpers.test.ts; this file only pins command wiring
// via source scanning (this package's convention).

describe('hub carry-over wiring (source scan)', () => {
  const s = getSection(HUB_SRC, ".command('carry-over'");

  it('declares --from, --to and --yes', () => {
    expect(s.length).toBeGreaterThan(0);
    expect(s).toMatch(/\.option\(\s*'--from <orgId>'/);
    expect(s).toMatch(/\.option\(\s*'--to <orgId>'/);
    expect(s).toMatch(/\.option\(\s*'--yes'/);
  });

  it('refuses from === to', () => {
    expect(s).toMatch(/from === to/);
  });

  it('refuses when no outbox rows match --from', () => {
    expect(s).toMatch(/no queued events/i);
    expect(s).toMatch(/process\.exit\(1\)/);
  });

  it('reads counts/range/types from /internal/hub/status', () => {
    expect(s).toMatch(/\/internal\/hub\/status/);
    expect(s).toMatch(/orgs/);
    expect(s).toMatch(/firstOccurredAt|lastOccurredAt/);
    expect(s).toMatch(/types/);
  });

  it('warns loudly about the cross-org tenancy rewrite', () => {
    expect(s).toMatch(/tenancy|cross-org/i);
  });

  it('requires typed confirmation unless --yes', () => {
    expect(s).toMatch(/opts\.yes/);
    expect(s).toMatch(/readline|askConfirm|askLine|question/);
  });

  it('POSTs the rewrite and audits {at, from, to, rewritten, osUser}', () => {
    // The rewrite+audit sequence is the shared rewriteOutboxAndAudit helper
    // (single implementation for carry-over AND repoint — they must not drift).
    expect(s).toMatch(/rewriteOutboxAndAudit\(/);
    expect(HUB_SRC).toMatch(/\/internal\/hub\/rewrite-outbox-org/);
    expect(HUB_SRC).toMatch(/hub-audit\.jsonl/);
    expect(HUB_SRC).toMatch(/at: new Date\(\)\.toISOString\(\)/);
    expect(HUB_SRC).toMatch(/rewritten/);
    expect(HUB_SRC).toMatch(/osUser/);
    // Audit failure is fatal and LOUD, never folded into the POST's channel.
    expect(HUB_SRC).toMatch(/REWRITE SUCCEEDED .* BUT THE AUDIT LINE FAILED TO WRITE/);
  });

  it('pins the deadletter path literal against drift with the server flusher', () => {
    // packages/server/src/hub/flusher.ts DEFAULT_DEADLETTER_PATH uses the
    // same literal (pinned by flusher-org-boundary.test.ts); a one-sided
    // rename breaks one of the two pinning tests.
    expect(HUB_SRC).toMatch(/'\.agenfk', 'hub-deadletter\.jsonl'/);
  });
});

describe('hub deadletter wiring (source scan)', () => {
  const list = getSection(HUB_SRC, ".command('deadletter'");
  const discard = getSection(HUB_SRC, ".command('discard'");

  it('lists by reading the deadletter file via summarizeDeadletter', () => {
    expect(list.length).toBeGreaterThan(0);
    expect(list).toMatch(/hub-deadletter\.jsonl|DEADLETTER|deadletterFile/);
    expect(list).toMatch(/summarizeDeadletter/);
  });

  it('discard supports --org and --all', () => {
    expect(discard.length).toBeGreaterThan(0);
    expect(discard).toMatch(/\.option\(\s*'--org <orgId>'/);
    expect(discard).toMatch(/\.option\(\s*'--all'/);
    expect(discard).toMatch(/filterDeadletterLinesForDiscard/);
    // Review F1: the file is re-read and re-filtered immediately before write.
    expect(discard).toMatch(/readDeadletterLines\(\)[\s\S]*askLine[\s\S]*readDeadletterLines\(\)/);
  });

  it('--all requires confirmation unless --yes', () => {
    expect(discard).toMatch(/opts\.yes/);
    expect(discard).toMatch(/discard all|readline|question/);
  });
});
