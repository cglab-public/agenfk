/**
 * @vitest-environment jsdom
 *
 * CGLAB-384 (S8-T3) — the board shows each column's contract at a glance:
 * its role, how many checks the server runs there, and whether a person must
 * approve (and sign with a passkey) before a card leaves it.
 */
import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import { ColumnContractBadges, ColumnRole } from '../components/ColumnContractBadges';

afterEach(() => cleanup());

describe('ColumnContractBadges', () => {
  it('shows nothing for a step with no role and no checks', () => {
    const { container } = render(<ColumnContractBadges step={{ id: 's', name: 'X', label: 'X', order: 1 }} />);
    expect(container.textContent).toBe('');
  });

  it("shows the server's check count, and leaves the role to its own line under the step name", () => {
    render(<ColumnContractBadges step={{ id: 's', name: 'X', label: 'X', order: 1, role: 'test-authoring' }} checkCount={8} />);
    expect(screen.getByText(/8 checks/)).toBeTruthy();
    expect(screen.queryByText('Writing tests')).toBeNull();
  });

  // b13f37e6: the role sits under the step name, in the flow editor's words.
  it('ColumnRole shows the role in words, with what it means as the tooltip', () => {
    render(<ColumnRole step={{ id: 's', name: 'X', label: 'X', order: 1, role: 'test-authoring' }} />);
    const role = screen.getByText('Writing tests');
    expect(role.getAttribute('title')).toMatch(/Tests come first and must fail/);
  });

  it('ColumnRole shows nothing for a step with no role', () => {
    const { container } = render(<ColumnRole step={{ id: 's', name: 'X', label: 'X', order: 1 }} />);
    expect(container.textContent).toBe('');
  });

  it('shows no count for a flow whose checks only warn (a flow from before roles)', () => {
    const { container } = render(<ColumnContractBadges step={{ id: 's', name: 'X', label: 'X', order: 1 }} checkCount={0} />);
    expect(container.textContent).toBe('');
  });

  it('marks a step that waits for a person, and one that needs a passkey', () => {
    render(<ColumnContractBadges step={{ id: 's', name: 'X', label: 'X', order: 1, checks: [{ id: 'human-approval', params: { signature: 'passkey' } }] }} />);
    expect(screen.getByLabelText(/a person must approve/i)).toBeTruthy();
    expect(screen.getByLabelText(/signed with a passkey/i)).toBeTruthy();
  });
});
