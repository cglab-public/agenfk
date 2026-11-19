/**
 * GH-278: this repository's CI asks the hub whether a receipt certifies the
 * PR's content (RFC-002), and skips only the Linux suite when one does. The
 * workflow is read as data (the parsed YAML), since GitHub's expressions cannot
 * run here; what is pinned is the shape that keeps a skip honest:
 *
 *  - the action that decides comes from the PR's BASE commit, so a PR cannot
 *    rewrite the check that would skip its own tests;
 *  - the agenfk it runs is a pinned release, not the PR's code;
 *  - only the Linux Test step is gated: the build still runs, and the Windows
 *    shards never ask;
 *  - without the token (fork PRs) there is no check, so the suite runs.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const ROOT = path.resolve(__dirname, '../../../..');
const workflow: any = yaml.load(fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8'));
const linux: any[] = workflow.jobs['build-and-test'].steps;
const stepNamed = (name: string) => linux.find(s => s.name === name);
const receipt = linux.find(s => s.id === 'receipt');
const compact = (expr: unknown) => String(expr ?? '').replace(/\s+/g, ' ').trim();

describe('CI asks the hub for a receipt before the Linux suite (GH-278)', () => {
  it('has a receipt step that runs the ci-check action for verification', () => {
    expect(receipt, 'a step with id "receipt"').toBeTruthy();
    expect(receipt.uses).toMatch(/^\.\/[\w.-]+\/actions\/ci-check$/);
    expect(receipt.with.kind).toBe('verification');
  });

  it('takes that action from the PR\'s base commit, checked out before it', () => {
    const actionDir = receipt.uses.replace(/^\.\//, '').replace(/\/actions\/ci-check$/, '');
    const at = linux.indexOf(receipt);
    const checkout = linux.slice(0, at).find(s => String(s.uses).startsWith('actions/checkout@') && s.with?.path === actionDir);
    expect(checkout, `an actions/checkout of the base into ${actionDir}`).toBeTruthy();
    expect(compact(checkout.with.ref)).toBe('${{ github.event.pull_request.base.sha }}');
  });

  it('runs a pinned agenfk release, not whatever is latest', () => {
    expect(String(receipt.with['agenfk-version'])).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
  });

  it('pins the release\'s digest beside its version', () => {
    expect(String(receipt.with['agenfk-sha256'])).toMatch(/^[0-9a-f]{64}$/);
  });

  // Codex review: until this lands, the base commit's action is the broken one.
  it('never fails the job itself: a check that cannot answer leaves Test to run', () => {
    expect(receipt['continue-on-error']).toBe(true);
  });

  it('reads the hub URL from a repository variable and the token from a secret', () => {
    expect(compact(receipt.with['hub-url'])).toBe('${{ vars.AGENFK_HUB_URL }}');
    expect(compact(receipt.with.token)).toBe('${{ secrets.AGENFK_CI_TOKEN }}');
  });

  it('asks only on pull requests that carry the token, so a fork PR runs the suite', () => {
    const cond = compact(receipt.if);
    expect(cond).toContain("github.event_name == 'pull_request'");
    expect(cond).toMatch(/env\.HAS_CI_TOKEN == 'true'/);
    expect(compact(workflow.jobs['build-and-test'].env?.HAS_CI_TOKEN)).toBe("${{ secrets.AGENFK_CI_TOKEN != '' }}");
  });

  // Codex review (second pass): under continue-on-error a failed check still
  // publishes its outputs, so only a check that SUCCEEDED may skip.
  it('gates the Test step on the answer, and runs it unless a successful check said no', () => {
    expect(compact(stepNamed('Test').if)).toBe("${{ steps.receipt.outcome != 'success' || steps.receipt.outputs.run != 'false' }}");
  });

  it('fails the job on a tampered release, which continue-on-error would otherwise swallow', () => {
    const at = linux.indexOf(receipt);
    const refuse = linux.slice(at + 1).find(s => compact(s.if) === "${{ steps.receipt.outputs.integrity == 'mismatch' }}");
    expect(refuse, 'a step after the check that refuses a digest mismatch').toBeTruthy();
    expect(refuse['continue-on-error']).toBeUndefined();
    expect(String(refuse.run)).toMatch(/exit 1/);
  });

  it('still builds whatever the answer', () => {
    expect(stepNamed('Build').if).toBeUndefined();
  });

  it('never gates the Windows shards', () => {
    expect(JSON.stringify(workflow.jobs['windows-full'])).not.toMatch(/ci-check|receipt/);
  });
});
