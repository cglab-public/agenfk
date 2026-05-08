import { describe, it, expect } from 'vitest';
import { canIssueDirective } from '../pages/adminUpgradesGate';

describe('canIssueDirective', () => {
  it('disabled while versions are loading', () => {
    expect(canIssueDirective({ targetVersion: '0.4.0', versions: [], loading: true })).toBe(false);
  });

  it('disabled when no version is selected', () => {
    expect(canIssueDirective({ targetVersion: '', versions: ['0.4.0'], loading: false })).toBe(false);
  });

  it('disabled when the available list is empty (e.g. fetcher returned no candidates)', () => {
    expect(canIssueDirective({ targetVersion: '0.4.0', versions: [], loading: false })).toBe(false);
  });

  it('disabled when the selected version is not in the available list', () => {
    expect(canIssueDirective({ targetVersion: '9.9.9', versions: ['0.4.0', '0.3.0-beta.23'], loading: false })).toBe(false);
  });

  it('enabled when a valid version from the list is selected and we are not loading', () => {
    expect(canIssueDirective({ targetVersion: '0.3.0-beta.23', versions: ['0.4.0', '0.3.0-beta.23'], loading: false })).toBe(true);
  });
});
