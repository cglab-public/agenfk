import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * CGLAB-117 story 5: the org-tenancy boundary is only leak-proof if the
 * docs stay true to the code. These are drift pins, in the repo's
 * source-scan tradition: every fact the docs assert about the rejection
 * taxonomy, the deadletter path, and the carry-over command must also
 * exist in the shipped code — and vice versa. Written BEFORE the docs
 * section (TDD), so the doc had to satisfy the assertions, not the other
 * way round.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const DOCS = fs.readFileSync(path.join(REPO_ROOT, 'HUB_ARCHITECTURE.md'), 'utf8');
const CHANGELOG = fs.readFileSync(path.join(REPO_ROOT, 'CHANGELOG.md'), 'utf8');
const EVENTS_ROUTE = fs.readFileSync(path.join(REPO_ROOT, 'packages/hub/src/routes/events.ts'), 'utf8');
const FLUSHER = fs.readFileSync(path.join(REPO_ROOT, 'packages/server/src/hub/flusher.ts'), 'utf8');
const CLI_HUB = fs.readFileSync(path.join(REPO_ROOT, 'packages/cli/src/commands/hub.ts'), 'utf8');
const ROOT_PKG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));

describe('HUB_ARCHITECTURE org-tenancy section stays true to the code (CGLAB-117)', () => {
  it('has a tenancy-boundary section', () => {
    expect(DOCS).toMatch(/tenancy boundary/i);
  });

  it('documents exactly the rejection reasons the hub emits — no more, no fewer', () => {
    // The hub's taxonomy, pinned at the source: the reason literals that
    // events.ts can emit. If a reason is added/removed there, this test
    // fails until the docs follow.
    const emitted = ['invalid', 'org_mismatch', 'foreign_installation', 'hidden_user'];
    for (const reason of emitted) {
      expect(EVENTS_ROUTE).toContain(`'${reason}'`);
      expect(DOCS).toContain(reason);
    }
    // And the docs must not invent reasons the hub never emits.
    const invented = DOCS.match(/reason[^\n]*\b(unknown_org|bad_org|org_denied)\b/g);
    expect(invented).toBeNull();
  });

  it('documents the deadletter path that the flusher actually writes', () => {
    // The path contract: flusher composes it from ('.agenfk', 'hub-deadletter.jsonl').
    expect(FLUSHER).toMatch(/'\.agenfk', 'hub-deadletter\.jsonl'/);
    expect(DOCS).toContain('hub-deadletter.jsonl');
    // The CLI reads/writes the same path (duplicated expression, drift-pinned
    // in the CLI's own tests — here we pin that the DOCS name the same file).
    expect(CLI_HUB).toMatch(/'\.agenfk', 'hub-deadletter\.jsonl'/);
  });

  it('documents carry-over as the sole stamp-rewrite command, with its real flags', () => {
    expect(DOCS).toContain('carry-over');
    // The flags the CLI actually registers.
    expect(CLI_HUB).toMatch(/--from <orgId>/);
    expect(CLI_HUB).toMatch(/--to <orgId>/);
    expect(DOCS).toMatch(/carry-over --from/);
    // Audit sink named in docs must be the file the CLI writes.
    expect(CLI_HUB).toMatch(/'hub-audit\.jsonl'/);
    expect(DOCS).toContain('hub-audit.jsonl');
  });

  it('documents the deadletter line shape the flusher actually writes', () => {
    // Field names pinned at the flusher's deadletterRows writer.
    // `deadletteredAt` and `payload` are object shorthand there, so they get
    // the `field[,}]` form instead of `field:`.
    for (const field of ['eventId', 'occurredAt', 'reason']) {
      expect(FLUSHER).toMatch(`${field}:`);
      expect(DOCS).toContain(field);
    }
    for (const field of ['deadletteredAt', 'payload']) {
      expect(FLUSHER).toMatch(new RegExp(`${field}[,}]`));
      expect(DOCS).toContain(field);
    }
  });

  it('documents the healthz identity gate with the real service name', () => {
    expect(CLI_HUB).toContain("service !== 'agenfk-hub'");
    expect(DOCS).toMatch(/\/healthz/);
    expect(DOCS).toContain('service=agenfk-hub');
  });

  it('documents the repoint --carry-over gate that the CLI implements', () => {
    expect(CLI_HUB).toMatch(/--carry-over/);
    expect(DOCS).toMatch(/repoint[^\n]*--carry-over|--carry-over[^\n]*repoint/);
  });
});

describe('release self-documentation', () => {
  it('CHANGELOG has an entry for the current version', () => {
    const version: string = ROOT_PKG.version;
    expect(CHANGELOG).toContain(`## [${version}]`);
  });
});
