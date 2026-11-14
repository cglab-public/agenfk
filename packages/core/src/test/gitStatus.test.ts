/**
 * Reading a worktree's state.
 *
 * Parsing is separated from spawning so the cases that actually break parsers
 * can be written down rather than reproduced against a real repository — and
 * every one below is a real thing git emits.
 */
import { describe, it, expect } from 'vitest';
import { parseGitStatus } from '../gitStatus';

/** Records are NUL-separated, so the fixtures read closer to the real bytes. */
const rec = (...records: string[]) => records.join('\0') + '\0';

describe('a clean worktree', () => {
  it('has nothing in it', () => {
    expect(parseGitStatus('')).toEqual({ changed: 0, staged: 0, files: [] });
  });
});

describe('what changed and where', () => {
  it('separates staged from unstaged', () => {
    const status = parseGitStatus(rec('M  staged.ts', ' M unstaged.ts'));
    expect(status.staged).toBe(1);
    expect(status.changed).toBe(1);
  });

  it('reports a file that is BOTH, as two entries', () => {
    // Staged edits plus further unstaged ones on the same path. They are two
    // different states of one file, and collapsing them loses one.
    const status = parseGitStatus(rec('MM both.ts'));
    expect(status.files).toHaveLength(2);
    expect(status.staged).toBe(1);
    expect(status.changed).toBe(1);
  });

  it('recognises added, deleted and untracked', () => {
    const status = parseGitStatus(rec('A  new.ts', ' D gone.ts', '?? unknown.ts'));
    expect(status.files.map(f => f.state).sort())
      .toEqual(['added', 'deleted', 'untracked']);
  });
});

describe('the records that break naive parsers', () => {
  it('keeps a rename\'s original path, and does not read it as another file', () => {
    // A rename adds a SECOND NUL-separated field. Consuming it is what keeps
    // every later entry aligned — without that, `old.ts` becomes a phantom
    // file and everything after it shifts.
    const status = parseGitStatus(rec('R  new.ts', 'old.ts', ' M after.ts'));
    const renamed = status.files.find(f => f.state === 'renamed');
    expect(renamed?.from).toBe('old.ts');
    expect(status.files.map(f => f.path)).not.toContain('old.ts');
    expect(status.files.find(f => f.path === 'after.ts')).toBeTruthy();
  });

  it('keeps a path containing a space intact', () => {
    // Splitting on whitespace is the classic way to lose half a filename.
    const status = parseGitStatus(rec(' M src/my file.ts'));
    expect(status.files[0].path).toBe('src/my file.ts');
  });

  it('does not invent entries for a path containing a newline', () => {
    // git allows it, and this is exactly why the command uses -z: with
    // newline-separated output this single file would read as two.
    const status = parseGitStatus(rec(' M weird\nname.ts'));
    expect(status.files).toHaveLength(1);
    expect(status.files[0].path).toBe('weird\nname.ts');
  });

  it('ignores a truncated record rather than emitting a nameless file', () => {
    expect(parseGitStatus(rec('M', 'x')).files.every(f => f.path.length > 0)).toBe(true);
  });
});

describe('the counts', () => {
  it('always agree with the list they label', () => {
    // Derived from the entries rather than tracked alongside them, so the
    // header cannot say 3 while the list shows 2.
    const status = parseGitStatus(rec('M  a.ts', ' M b.ts', '?? c.ts', 'MM d.ts'));
    expect(status.staged).toBe(status.files.filter(f => f.staged).length);
    expect(status.changed).toBe(status.files.filter(f => !f.staged).length);
  });
});
