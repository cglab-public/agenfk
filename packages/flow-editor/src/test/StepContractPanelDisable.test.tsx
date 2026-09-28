/**
 * @vitest-environment jsdom
 *
 * CGLAB-428 — a hub admin switches individual checks off on a step: the role's
 * built-ins, the checks every step runs, and the flow's own. Only where the
 * host allows it (`canDisableChecks`, the hub admin); a human approval keeps
 * its own setting and never gets a switch. A check the hub switched off is
 * shown as such wherever the step is viewed, and the preview says it will not
 * run, so a relaxed step never reads like an ordinary one.
 */
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { describeFlowContract } from '@agenfk/core';
import { StepContractPanel } from '../StepContractPanel';
import type { FlowStep } from '../types';

const s = (name: string, order: number, extra: Partial<FlowStep> = {}): FlowStep => ({ id: name, name, label: name, order, ...extra });
const LINT = { id: 'command-check', params: { name: 'lint', argv: ['npm', 'run', 'lint'] } as any };
const flow = (build: Partial<FlowStep> = {}) => [
  s('TODO', 0, { isAnchor: true }),
  s('SPECS', 1, { role: 'test-authoring' }),
  s('BUILD', 2, { role: 'coding', ...build }),
  s('DONE', 3, { isAnchor: true, role: 'closing' }),
];

function show(steps: FlowStep[], opts: { canDisableChecks?: boolean; disabled?: boolean } = {}, index = 2) {
  const onChange = vi.fn();
  const contract = describeFlowContract(steps) as any;
  render(<StepContractPanel step={steps[index]} stepContract={contract.steps[index]} contract={contract} disabled={!!opts.disabled}
    onChange={onChange} {...(opts.canDisableChecks ? { canDisableChecks: true } : {})} />);
  return onChange;
}
afterEach(() => cleanup());

describe('StepContractPanel: switching checks off (CGLAB-428)', () => {
  it('offers no switch where the host does not allow it', () => {
    show(flow({ checks: [LINT] }));
    expect(screen.queryByRole('button', { name: /switch off/i })).toBeNull();
  });

  it("switches a role built-in off, as a patch naming its check id", () => {
    const onChange = show(flow(), { canDisableChecks: true });
    fireEvent.click(within(screen.getByTestId('contract-builtins')).getByRole('button', { name: 'Switch off: Whole test suite passes' }));
    expect(onChange).toHaveBeenLastCalledWith({ disabledChecks: ['suite-green'] });
  });

  it('keeps the checks already switched off when switching another', () => {
    const onChange = show(flow({ disabledChecks: ['suite-green'] }), { canDisableChecks: true });
    fireEvent.click(screen.getByRole('button', { name: 'Switch off: No tests removed' }));
    expect(onChange).toHaveBeenLastCalledWith({ disabledChecks: ['suite-green', 'test-count-not-lower'] });
  });

  it('shows a switched-off built-in as such, and switches it back on', () => {
    const onChange = show(flow({ disabledChecks: ['suite-green'] }), { canDisableChecks: true });
    const builtins = screen.getByTestId('contract-builtins');
    expect(builtins.textContent).toMatch(/Whole test suite passes/);
    expect(builtins.textContent).toMatch(/switched off by your org's hub/i);
    fireEvent.click(within(builtins).getByRole('button', { name: 'Switch on: Whole test suite passes' }));
    expect(onChange).toHaveBeenLastCalledWith({ disabledChecks: [] });
  });

  it("still shows a switched-off check where the step is only viewed, without a switch", () => {
    show(flow({ disabledChecks: ['suite-green'] }));
    const builtins = screen.getByTestId('contract-builtins');
    expect(builtins.textContent).toMatch(/Whole test suite passes/);
    expect(builtins.textContent).toMatch(/switched off by your org's hub/i);
    expect(screen.queryByRole('button', { name: /switch (on|off)/i })).toBeNull();
  });

  it('offers no switch on a read-only flow, even to the hub admin', () => {
    show(flow(), { canDisableChecks: true, disabled: true });
    expect(screen.queryByRole('button', { name: /switch off/i })).toBeNull();
  });

  it("switches a flow's own custom check off by its name", () => {
    const onChange = show(flow({ checks: [LINT] }), { canDisableChecks: true });
    fireEvent.click(within(screen.getByTestId('contract-extras')).getByRole('button', { name: 'Switch off: A command the flow defines passes (lint)' }));
    expect(onChange).toHaveBeenLastCalledWith({ disabledChecks: ['command-check:lint'] });
  });

  it('switches off a check every step runs', () => {
    const onChange = show(flow(), { canDisableChecks: true });
    const universal = screen.getByTestId('contract-universal');
    fireEvent.click(within(universal).getByRole('button', { name: "Switch off: On the card's branch" }));
    expect(onChange).toHaveBeenLastCalledWith({ disabledChecks: ['on-card-branch'] });
  });

  it('never offers a switch for a human approval', () => {
    show(flow({ checks: [{ id: 'human-approval' }] }), { canDisableChecks: true });
    expect(screen.queryByRole('button', { name: /switch off: a person approves/i })).toBeNull();
  });

  it('says in the preview which checks will not run', () => {
    show(flow({ disabledChecks: ['suite-green'] }), { canDisableChecks: true });
    const preview = screen.getByTestId('contract-preview');
    expect(preview.textContent).toMatch(/not run/i);
    expect(preview.textContent).toMatch(/Whole test suite passes/);
    expect(preview.textContent).not.toMatch(/Get the whole suite passing/);
  });
});
