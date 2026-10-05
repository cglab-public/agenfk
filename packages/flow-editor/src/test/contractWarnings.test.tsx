/**
 * @vitest-environment jsdom
 *
 * CGLAB-457 (T3) — the flow editor says when a step's words ask for an
 * independent review or a person's go-ahead its checks do not enforce. A
 * warning, never a block on Save; an older server sends no warnings and the
 * editor shows nothing.
 */
import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { describeFlowContract } from '@agenfk/core';
import { ContractWarnings } from '../FlowContractSection';
import type { FlowContract } from '../types';

afterEach(cleanup);
const s = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `id-${name}`, name, label: name, order, ...extra });
const unchecked = () => describeFlowContract([
  s('TODO', 0, { isAnchor: true }),
  s('REVIEW', 1, { exitCriteria: 'Review it in a separate adversarial agent.' }),
  s('DONE', 2, { isAnchor: true, role: 'closing' }),
]) as unknown as FlowContract;

describe('ContractWarnings', () => {
  it("lists each step that asks for a check it does not carry, and says Save is not blocked", () => {
    render(<ContractWarnings contract={unchecked()} />);
    const box = screen.getByTestId('flow-contract-warnings');
    expect(box.textContent).toMatch(/REVIEW reads as a review step/);
    expect(box.textContent).toMatch(/role 'review'/);
    expect(box.textContent).toMatch(/can still be saved/i);
  });

  it('shows nothing for a flow that enforces what it asks for', () => {
    const c = describeFlowContract([s('TODO', 0, { isAnchor: true }), s('REVIEW', 1, { role: 'review' }), s('DONE', 2, { isAnchor: true, role: 'closing' })]) as unknown as FlowContract;
    const { container } = render(<ContractWarnings contract={c} />);
    expect(container.innerHTML).toBe('');
  });

  it('shows nothing for a contract from an older server, which sends no warnings', () => {
    const { warnings, ...older } = unchecked() as any;
    void warnings;
    const { container } = render(<ContractWarnings contract={older} />);
    expect(container.innerHTML).toBe('');
  });
});
