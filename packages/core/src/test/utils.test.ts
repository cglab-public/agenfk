import { describe, it, expect } from 'vitest';
import { ItemType } from '../types';
import { buildBranchName, slugifyTitle } from '../utils';

describe('slugifyTitle', () => {
  it('lowercases, strips punctuation, and joins with dashes', () => {
    expect(slugifyTitle('Fix the thing, now!')).toBe('fix-the-thing-now');
  });

  it('collapses repeated dashes and trims the trailing one', () => {
    expect(slugifyTitle('  A  --  B --  ')).toBe('a-b');
  });

  it('caps the slug at 50 chars', () => {
    const slug = slugifyTitle('a'.repeat(80));
    expect(slug.length).toBeLessThanOrEqual(50);
  });
});

describe('buildBranchName', () => {
  it('prefixes BUG with fix/<slug>', () => {
    expect(buildBranchName(ItemType.BUG, 'Fix the login bug')).toBe('fix/fix-the-login-bug');
  });

  it('prefixes STORY with feature/<slug>', () => {
    expect(buildBranchName(ItemType.STORY, 'Add the export feature')).toBe('feature/add-the-export-feature');
  });

  it('prefixes TASK with feature/<slug>', () => {
    expect(buildBranchName(ItemType.TASK, 'Refactor the parser')).toBe('feature/refactor-the-parser');
  });

  it('prefixes EPIC with feature/<slug>', () => {
    expect(buildBranchName(ItemType.EPIC, 'Ship the dashboard')).toBe('feature/ship-the-dashboard');
  });
});
