/**
 * Security audit, Fix 2 (AEF-5): a dependency advisory must fail CI.
 *
 * The audit found a critical (proxy-addr) and several highs in production
 * dependencies that nothing in CI would ever have flagged: the suite tests our
 * code, not the advisories against the code we ship. This pins the gate that
 * does: a workflow that runs `npm audit --omit=dev --audit-level=high` and is
 * not allowed to pass on failure, on every PR and on the release branches, plus
 * a schedule, because a new advisory lands against an unchanged tree.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const WORKFLOW = path.resolve(__dirname, '../../../../.github/workflows/audit.yml');
const read = (): string => fs.readFileSync(WORKFLOW, 'utf8');

describe('.github/workflows/audit.yml', () => {
  it('exists', () => {
    expect(fs.existsSync(WORKFLOW)).toBe(true);
  });

  it('runs the production-only, high-severity npm audit', () => {
    expect(read()).toMatch(/npm audit --omit=dev --audit-level=high/);
  });

  it('is a blocking gate: no continue-on-error, no `|| true` swallowing the exit code', () => {
    const y = read();
    expect(y).not.toMatch(/continue-on-error:\s*true/);
    expect(y).not.toMatch(/npm audit[^\n]*\|\|\s*(true|:|exit 0)/);
  });

  it('runs on pull requests, on main and beta, and on a schedule', () => {
    const y = read();
    expect(y).toMatch(/^\s*pull_request:/m);
    expect(y).toMatch(/branches:\s*\[[^\]]*main[^\]]*\]/);
    expect(y).toMatch(/branches:\s*\[[^\]]*beta[^\]]*\]/);
    expect(y).toMatch(/^\s*schedule:/m);
  });

  it('holds the token to read-only, like ci.yml', () => {
    expect(read()).toMatch(/permissions:\s*\n\s*contents:\s*read/);
  });
});
