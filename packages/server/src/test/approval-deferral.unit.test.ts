/**
 * 961f301d - which checks wait for a person's approval, as a pure decision.
 *
 * While a step's approval is missing, verify defers the SLOW checks (a suite
 * capture, a remote fetch, a command run) to the verify after the approval and
 * judges the cheap ones at once. This used to be pinned end to end, once per
 * slow check (approval-first-baseline, tree-in-sync): a real repository, a
 * flow, a project and a verify for each kind. The classification is pure, so
 * it is pinned here; one end-to-end test of the deferral itself stays in
 * approval-first-baseline.test.ts.
 */
import { describe, it, expect } from 'vitest';
import type { ResolvedCheck } from '@agenfk/core';
import * as engine from '../checkEngine';

const check = (id: string, extra: Partial<ResolvedCheck> = {}): ResolvedCheck =>
  ({ id, params: {}, severity: 'block', source: 'flow', step: 'PLAN', applicable: true, ...extra });

describe('what makes a check slow', () => {
  it('suite-green needs a capture: it runs the suite', () => {
    expect(engine.needsCapture([check('suite-green')])).toBe(true);
  });

  it('tree-in-sync talks to a remote', () => {
    expect(engine.needsNetwork(check('tree-in-sync'))).toBe(true);
  });

  it('jira-key-valid is cheap: no capture, no remote', () => {
    expect(engine.needsCapture([check('jira-key-valid')])).toBe(false);
    expect(engine.needsNetwork(check('jira-key-valid'))).toBe(false);
  });
});

/*
 * The selection itself lives inline in server.ts today (the `deferToApproval`
 * filter in the verify gate). These tests name the pure export it should
 * become: checkEngine.ts `checksDeferredToApproval(resolved, waitingOn)`,
 * returning the ids of the applicable checks to defer. `waitingOn` is the
 * command checks that themselves wait for a person to approve their command:
 * those are judged now, so the person sees what they are asked to approve.
 */
describe('checksDeferredToApproval', () => {
  const select = (resolved: ResolvedCheck[], waitingOn: ResolvedCheck[] = []): string[] => {
    const fn = (engine as unknown as Record<string, unknown>).checksDeferredToApproval;
    expect(typeof fn, 'checkEngine.ts does not export checksDeferredToApproval').toBe('function');
    return (fn as (r: ResolvedCheck[], w: ResolvedCheck[]) => string[])(resolved, waitingOn);
  };

  it('defers the capture, the remote fetch and a command run, and judges a cheap check now', () => {
    const resolved = [check('suite-green'), check('tree-in-sync'), check('command-check:lint'), check('jira-key-valid'), check('human-approval')];
    expect(select(resolved).sort()).toEqual(['command-check:lint', 'suite-green', 'tree-in-sync']);
  });

  it('does not defer a command check that is itself waiting for a person to approve its command', () => {
    const lint = check('command-check:lint');
    expect(select([lint], [lint])).toEqual([]);
  });

  it('defers nothing that does not apply', () => {
    expect(select([check('suite-green', { applicable: false }), check('tree-in-sync', { applicable: false })])).toEqual([]);
  });
});
