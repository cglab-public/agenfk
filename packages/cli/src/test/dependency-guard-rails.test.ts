/**
 * EPIC #320 / issue #340 - guard rails so new high/critical alerts are caught
 * on `beta` and Dependabot PRs land where the work happens.
 *
 * Dependabot counts alerts on `main`, but the fixes are made on `beta` (see
 * docs/RELEASES.md). Two things keep the count from growing back:
 *  - the CI that runs on `beta` fails on a runtime high/critical advisory, and
 *  - Dependabot version updates open against `beta`, not against `main`
 *    changes `beta` has already superseded (#314 / #315).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { load } from 'js-yaml';

const repoRoot = join(__dirname, '../../../..');
const readYaml = <T>(rel: string): T => load(readFileSync(join(repoRoot, rel), 'utf8')) as T;

type Step = { name?: string; run?: string; if?: unknown; 'continue-on-error'?: boolean | string };
type Workflow = {
  on: { push?: { branches?: string[] }; pull_request?: unknown };
  jobs: Record<string, { steps: Step[] }>;
};

const AUDIT = 'npm audit --omit=dev --audit-level=high';

describe('Dependabot targets beta (#342)', () => {
  const { updates } = readYaml<{ updates: Array<Record<string, unknown>> }>('.github/dependabot.yml');

  it('every update entry sets target-branch: beta', () => {
    const offenders = updates
      .filter(u => u['target-branch'] !== 'beta')
      .map(u => `${u['package-ecosystem']} ${u.directory}`);
    expect(offenders, `no target-branch: beta on: ${offenders.join(', ')}`).toEqual([]);
  });
});

describe('beta CI fails on runtime high/critical advisories (#341)', () => {
  const ci = readYaml<Workflow>('.github/workflows/ci.yml');
  const steps = ci.jobs['build-and-test'].steps;
  const auditIndex = steps.findIndex(s => s.run?.includes(AUDIT));

  it('CI runs on pushes to beta', () => {
    expect(ci.on.push?.branches).toContain('beta');
  });

  it(`build-and-test runs \`${AUDIT}\``, () => {
    expect(auditIndex, `no step runs ${AUDIT}`).toBeGreaterThanOrEqual(0);
  });

  it('the audit step runs after dependencies are installed', () => {
    const install = steps.findIndex(s => s.run?.startsWith('npm ci'));
    expect(install).toBeGreaterThanOrEqual(0);
    expect(auditIndex).toBeGreaterThan(install);
  });

  it('the audit step can fail the build (no continue-on-error)', () => {
    expect(auditIndex).toBeGreaterThanOrEqual(0);
    const coe = steps[auditIndex]['continue-on-error'];
    expect(coe === undefined || coe === false || coe === 'false').toBe(true);
  });

  it('the audit step is unconditional (an `if:` could switch the gate off)', () => {
    expect(auditIndex).toBeGreaterThanOrEqual(0);
    expect(steps[auditIndex].if).toBeUndefined();
  });

  it('the audit runs after the tests, so a red audit never hides their results', () => {
    const test = steps.findIndex(s => s.run === 'npm test');
    expect(test).toBeGreaterThanOrEqual(0);
    expect(auditIndex).toBeGreaterThan(test);
  });

  it('audits only runtime dependencies, at high or above', () => {
    const run = steps[auditIndex]?.run ?? '';
    expect(run).toContain('--omit=dev');
    expect(run).toContain('--audit-level=high');
  });
});
