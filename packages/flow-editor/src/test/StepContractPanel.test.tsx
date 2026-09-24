/**
 * @vitest-environment jsdom
 *
 * CGLAB-384 (S8-T2) — one step's contract in the editor: its role and the
 * checks that brings (locked), the checks the flow adds (params as real
 * controls, Block or Warn), a person's approval, and what an agent must do to
 * leave the step. It is fed the server's contract (computed here with core,
 * as the server does) and reports edits as a patch to the step.
 */
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { describeFlowContract } from '@agenfk/core';
import { StepContractPanel } from '../StepContractPanel';
import type { FlowStep } from '../types';

const s = (name: string, order: number, extra: Partial<FlowStep> = {}): FlowStep => ({ id: name, name, label: name, order, ...extra });
const flow = (build: Partial<FlowStep> = {}) => [
  s('TODO', 0, { isAnchor: true }),
  s('SPECS', 1, { role: 'test-authoring' }),
  s('BUILD', 2, { role: 'coding', ...build }),
  s('DONE', 3, { isAnchor: true, role: 'closing' }),
];

function show(steps: FlowStep[], index = 2, disabled = false) {
  const onChange = vi.fn();
  const contract = describeFlowContract(steps) as any;
  render(<StepContractPanel step={steps[index]} stepContract={contract.steps[index]} contract={contract} disabled={disabled} onChange={onChange} />);
  return onChange;
}
afterEach(() => cleanup());

describe('StepContractPanel', () => {
  it("shows the role and the checks it brings, locked, in plain words", () => {
    show(flow());
    const role = screen.getByTestId('contract-role');
    expect(role.textContent).toMatch(/Implementing/);
    const builtins = screen.getByTestId('contract-builtins');
    expect(builtins.textContent).toMatch(/failing tests now pass/i);
    expect(builtins.textContent).not.toMatch(/red-set-passes-by-name/);
    expect(within(builtins).queryByRole('button', { name: /remove/i })).toBeNull();
  });

  it('says in words why a built-in has nothing to check', () => {
    show([s('TODO', 0, { isAnchor: true }), s('BUILD', 1, { role: 'coding' }), s('DONE', 2, { isAnchor: true })], 1);
    expect(screen.getByTestId('contract-builtins').textContent).toMatch(/Failing-test list/);
  });

  it('changes the role, or clears it', () => {
    const onChange = show(flow());
    fireEvent.click(screen.getByRole('button', { name: /change role/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Review/ }));
    expect(onChange).toHaveBeenLastCalledWith({ role: 'review' });
    fireEvent.click(screen.getByRole('button', { name: /change role/i }));
    fireEvent.click(screen.getByRole('button', { name: /no role/i }));
    expect(onChange).toHaveBeenLastCalledWith({ role: null });
  });

  it('adds a check from the gallery, found by what it stops', () => {
    const onChange = show(flow());
    fireEvent.click(screen.getByRole('button', { name: /add a check/i }));
    fireEvent.change(screen.getByLabelText(/search checks/i), { target: { value: 'JIRA' } });
    const gallery = screen.getByTestId('check-gallery');
    expect(within(gallery).queryByText(/whole test suite/i)).toBeNull();
    fireEvent.click(within(gallery).getByRole('button', { name: /add linked to a jira/i }));
    expect(onChange).toHaveBeenLastCalledWith({ checks: [{ id: 'jira-key-valid' }] });
  });

  it('never offers the go-ahead in the gallery: it has its own control', () => {
    show(flow());
    fireEvent.click(screen.getByRole('button', { name: /add a check/i }));
    expect(within(screen.getByTestId('check-gallery')).queryByText(/person approve/i)).toBeNull();
  });

  it("sets an added check's params with real controls, and its severity", () => {
    const onChange = show(flow({ checks: [{ id: 'has-children' }] }));
    fireEvent.change(screen.getByLabelText(/which card types must have children/i), { target: { value: 'EPIC,STORY' } });
    expect(onChange).toHaveBeenLastCalledWith({ checks: [{ id: 'has-children', params: { types: 'EPIC,STORY' } }] });
    fireEvent.click(screen.getByRole('button', { name: /only warn/i }));
    expect(onChange).toHaveBeenLastCalledWith({ checks: [{ id: 'has-children', severity: 'warn' }] });
  });

  it('shows a warn-by-default check as Warn, and stores Block explicitly when chosen', () => {
    const onChange = show(flow({ checks: [{ id: 'red-is-assertion' }] }));
    expect(screen.getByRole('button', { name: /only warn: fails on an assertion/i }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: /block the step: fails on an assertion/i }));
    expect(onChange).toHaveBeenLastCalledWith({ checks: [{ id: 'red-is-assertion', severity: 'block' }] });
  });

  it('removes an added check', () => {
    const onChange = show(flow({ checks: [{ id: 'jira-key-valid' }] }));
    fireEvent.click(screen.getByRole('button', { name: /remove linked to a jira/i }));
    expect(onChange).toHaveBeenLastCalledWith({ checks: [] });
  });

  it('turns on a person\'s go-ahead, then asks every card and a passkey', () => {
    const onChange = show(flow());
    fireEvent.click(screen.getByRole('checkbox', { name: /a person must approve/i }));
    expect(onChange).toHaveBeenLastCalledWith({ checks: [{ id: 'human-approval' }] });
  });

  it('with the go-ahead on: each card on its own, and signed with a passkey', () => {
    const onChange = show(flow({ checks: [{ id: 'human-approval' }] }));
    fireEvent.change(screen.getByLabelText(/who needs a go-ahead/i), { target: { value: 'every-card' } });
    expect(onChange).toHaveBeenLastCalledWith({ checks: [{ id: 'human-approval', params: { appliesTo: 'every-card' } }] });
    fireEvent.click(screen.getByRole('checkbox', { name: /sign with a passkey/i }));
    expect(onChange).toHaveBeenLastCalledWith({ checks: [{ id: 'human-approval', params: { signature: 'passkey' } }] });
  });

  it('turning the go-ahead off removes it', () => {
    const onChange = show(flow({ checks: [{ id: 'human-approval' }, { id: 'jira-key-valid' }] }));
    fireEvent.click(screen.getByRole('checkbox', { name: /a person must approve/i }));
    expect(onChange).toHaveBeenLastCalledWith({ checks: [{ id: 'jira-key-valid' }] });
  });

  it('the preview tells the author the agent must stage its work on a step that commits', () => {
    show(flow({ autoCommit: true, requireCommit: true } as Partial<FlowStep>), 1);
    const preview = screen.getByTestId('contract-preview');
    expect(preview.textContent).not.toMatch(/stage/i);
    cleanup();
    const steps = [s('TODO', 0, { isAnchor: true }), s('SPECS', 1, { role: 'test-authoring', autoCommit: true, requireCommit: true } as Partial<FlowStep>), s('BUILD', 2, { role: 'coding' }), s('DONE', 3, { isAnchor: true, role: 'closing' })];
    show(steps, 1);
    const text = screen.getByTestId('contract-preview').textContent ?? '';
    expect(text).toMatch(/Stage its work before verify: this step commits the card's staged, claimed files when it leaves/);
    expect(text).toMatch(/refuses to move on without that commit/);
  });

  it('says nothing about staging on the step whose leaving ends the flow, where no step commit runs (review)', () => {
    show(flow({ autoCommit: true } as Partial<FlowStep>), 2);
    expect(screen.getByTestId('contract-preview').textContent).not.toMatch(/stage/i);
  });

  it('previews what an agent must do to leave the step', () => {
    show(flow({ checks: [{ id: 'jira-key-valid' }] }));
    const p = screen.getByTestId('contract-preview').textContent ?? '';
    expect(p).toMatch(/Get the whole suite passing/);
    expect(p).toMatch(/JIRA/);
  });

  it('says the go-ahead must be signed when the step asks for a passkey', () => {
    show(flow({ checks: [{ id: 'human-approval', params: { signature: 'passkey' } }] }));
    expect(screen.getByTestId('contract-preview').textContent).toMatch(/signed with a passkey/i);
  });

  it("the step before the end lists what the move into the end runs too", () => {
    show(flow(), 2);
    expect(screen.getByTestId('contract-preview').textContent).toMatch(/project's own verify command/);
  });

  it('the terminal step says it is checked on the move into it, not on leaving', () => {
    show(flow(), 3);
    expect(screen.getByTestId('contract-preview').textContent).toMatch(/checked when a card moves into this step/i);
  });

  it("turns on committing the card's work when it leaves the step, and requiring it", () => {
    const onChange = show(flow());
    fireEvent.click(screen.getByRole('checkbox', { name: /commit the card's work when it leaves/i }));
    expect(onChange).toHaveBeenLastCalledWith({ autoCommit: true });
  });

  it('requiring the commit, and turning it off again', () => {
    const onChange = show(flow({ autoCommit: true }));
    fireEvent.click(screen.getByRole('checkbox', { name: /refuse to move on/i }));
    expect(onChange).toHaveBeenLastCalledWith({ requireCommit: true });
    fireEvent.click(screen.getByRole('checkbox', { name: /commit the card's work when it leaves/i }));
    expect(onChange).toHaveBeenLastCalledWith({ autoCommit: null, requireCommit: null });
  });

  it('read-only: shows the contract, offers no controls', () => {
    show(flow({ checks: [{ id: 'jira-key-valid' }] }), 2, true);
    expect(screen.queryByRole('button', { name: /add a check/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /change role/i })).toBeNull();
    expect((screen.getByRole('checkbox', { name: /a person must approve/i }) as HTMLInputElement).disabled).toBe(true);
  });
});

/**
 * efcacdeb (C4) — custom checks in the editor: a command the server runs, and
 * an instruction the coding agent carries out. Several per step, by name.
 */
describe('custom checks in the editor', () => {
  const plain = (checks?: unknown[]) => [s('TODO', 0, { isAnchor: true }), s('WORK', 1, checks ? { checks: checks as any } : {}), s('DONE', 2, { isAnchor: true })];
  const LINT = { id: 'command-check', params: { name: 'lint', argv: ['npm', 'run', 'lint'] } };
  const TYPES = { id: 'command-check', params: { name: 'types', argv: ['npx', 'tsc', '--noEmit'] } };
  const lastChecks = (onChange: ReturnType<typeof vi.fn>) => onChange.mock.calls[onChange.mock.calls.length - 1][0].checks;

  it('offers both custom checks in the gallery, even when one of that kind is already there', () => {
    show(plain([LINT]), 1);
    fireEvent.click(screen.getByRole('button', { name: /add a check/i }));
    const gallery = screen.getByTestId('check-gallery');
    expect(within(gallery).getByRole('button', { name: /Add A command the flow defines passes/ })).toBeTruthy();
    expect(within(gallery).getByRole('button', { name: /Add The agent carried out an instruction/ })).toBeTruthy();
  });

  it('adds a command check as a named draft, a new name each time', () => {
    const onChange = show(plain([LINT]), 1);
    fireEvent.click(screen.getByRole('button', { name: /add a check/i }));
    fireEvent.click(screen.getByRole('button', { name: /Add A command the flow defines passes/ }));
    const checks = lastChecks(onChange);
    expect(checks).toHaveLength(2);
    expect(checks[1]).toMatchObject({ id: 'command-check', params: { name: 'check-1' } });
  });

  it('edits the command one argument per line, sent as a list', () => {
    const onChange = show(plain([LINT]), 1);
    const argv = screen.getByRole('textbox', { name: /command.*lint/i }) as HTMLTextAreaElement;
    expect(argv.value).toBe('npm\nrun\nlint');
    fireEvent.change(argv, { target: { value: 'npm\nrun\nlint:ci\n' } });
    expect(lastChecks(onChange)[0].params.argv).toEqual(['npm', 'run', 'lint:ci']);
  });

  it('keeps two command checks apart: editing or removing one leaves the other', () => {
    const onChange = show(plain([LINT, TYPES]), 1);
    fireEvent.change(screen.getByRole('textbox', { name: /name.*types/i }), { target: { value: 'tsc' } });
    expect(lastChecks(onChange).map((c: any) => c.params.name)).toEqual(['lint', 'tsc']);
    fireEvent.click(screen.getAllByRole('button', { name: /Remove A command the flow defines passes/ })[0]);
    expect(lastChecks(onChange)).toEqual([TYPES]);
  });

  it("asks for a person's approval of the command with a real control", () => {
    const onChange = show(plain([LINT]), 1);
    fireEvent.change(screen.getByRole('combobox', { name: /approves it on the board/i }), { target: { value: 'person' } });
    expect(lastChecks(onChange)[0].params).toMatchObject({ name: 'lint', approval: 'person' });
  });

  it("edits an agent check's instruction", () => {
    const onChange = show(plain([{ id: 'agent-check', params: { name: 'docs', instruction: 'Check the README.' } }]), 1);
    fireEvent.change(screen.getByRole('textbox', { name: /instruction.*docs/i }), { target: { value: 'Check the README and the CHANGELOG.' } });
    expect(lastChecks(onChange)[0].params).toEqual({ name: 'docs', instruction: 'Check the README and the CHANGELOG.' });
  });
});
