import { describe, it, expect } from 'vitest';
import { canSaveQuery } from '../savedQueries';

describe('canSaveQuery', () => {
  it('requires a non-empty name and sql', () => {
    expect(canSaveQuery('my query', 'SELECT 1')).toBe(true);
  });
  it('rejects a blank name', () => {
    expect(canSaveQuery('', 'SELECT 1')).toBe(false);
    expect(canSaveQuery('   ', 'SELECT 1')).toBe(false);
  });
  it('rejects blank sql', () => {
    expect(canSaveQuery('name', '')).toBe(false);
    expect(canSaveQuery('name', '   \n ')).toBe(false);
  });
});
