/**
 * STORY a89af514 (task 3/3) — what an audit row's before -> after shows: only
 * the fields that changed, each by its path, with the value on both sides.
 */
import { describe, it, expect } from 'vitest';
import { auditDiff } from '../pages/auditDiff';

describe('auditDiff', () => {
  it('lists the changed fields only, by path', () => {
    expect(auditDiff({ name: 'A', role: 'viewer', active: 1 }, { name: 'A', role: 'admin', active: 1 })).toEqual([
      { path: 'role', before: 'viewer', after: 'admin' },
    ]);
  });

  it('walks nested objects and arrays', () => {
    const before = { google: { clientId: 'a', clientSecret: '[secret]' }, steps: [{ name: 'build', label: 'Build' }] };
    const after = { google: { clientId: 'b', clientSecret: '[secret: changed]' }, steps: [{ name: 'build', label: 'Implement' }] };
    expect(auditDiff(before, after)).toEqual([
      { path: 'google.clientId', before: 'a', after: 'b' },
      { path: 'google.clientSecret', before: '[secret]', after: '[secret: changed]' },
      { path: 'steps[0].label', before: 'Build', after: 'Implement' },
    ]);
  });

  it('shows a field that appeared or went', () => {
    expect(auditDiff({ a: 1 }, { b: 2 })).toEqual([
      { path: 'a', before: 1, after: undefined },
      { path: 'b', before: undefined, after: 2 },
    ]);
  });

  it('shows a creation as every field arriving, and a deletion as every field going', () => {
    expect(auditDiff(null, { name: 'Main', version: 1 })).toEqual([
      { path: 'name', before: undefined, after: 'Main' },
      { path: 'version', before: undefined, after: 1 },
    ]);
    expect(auditDiff({ name: 'Main' }, null)).toEqual([{ path: 'name', before: 'Main', after: undefined }]);
  });

  it('compares a value that is not an object as a whole', () => {
    expect(auditDiff('x', 'y')).toEqual([{ path: '', before: 'x', after: 'y' }]);
    expect(auditDiff(null, null)).toEqual([]);
  });
});
