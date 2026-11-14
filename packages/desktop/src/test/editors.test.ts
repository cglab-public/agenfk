/**
 * @vitest-environment node
 *
 * Opening a session's worktree in an editor.
 *
 * The point is that the user never has to find the path. A worktree lives at
 * ~/.agenfk-worktrees/<repo>/<branch>-<hash>, which nobody is going to type.
 *
 * The security shape is the whole reason this is its own module. The desktop's
 * `openExternally` guard accepts http(s) ONLY, deliberately: `shell.openExternal`
 * hands the string to whatever handler the OS has registered for that scheme,
 * so a permissive guard turns a URL into "run this local program with this
 * argument". Adding `vscode://` needs an exception that is narrow and written
 * down, not a relaxed guard.
 */
import { describe, it, expect } from 'vitest';
import { editorUrlFor, detectEditors, EDITORS } from '../main/editors';

describe('the URL handed to the OS', () => {
  it('points at the folder, in the editor\'s own scheme', () => {
    expect(editorUrlFor('vscode', '/Users/x/.agenfk-worktrees/repo/feat-a'))
      .toBe('vscode://file/Users/x/.agenfk-worktrees/repo/feat-a');
  });

  it('encodes a path with spaces rather than emitting a broken URL', () => {
    // ~/.agenfk-worktrees is under HOME, and a HOME with a space is ordinary
    // on Windows. An unencoded space ends the URL early, so the editor opens
    // the wrong directory or none.
    const url = editorUrlFor('vscode', '/Users/John Smith/work/repo');
    expect(url).not.toMatch(/ /);
    expect(url).toContain('John%20Smith');
  });

  it('refuses a path that is not absolute', () => {
    // A relative path resolves against whatever the OS handler's cwd happens
    // to be, which is nobody's intent.
    for (const bad of ['relative/path', '', '   ', '../escape']) {
      expect(() => editorUrlFor('vscode', bad), bad).toThrow(/absolute/i);
    }
  });

  it('refuses an editor it does not know', () => {
    // The scheme is the dangerous part: it decides WHICH program the OS
    // launches. A closed list is the control.
    expect(() => editorUrlFor('evil' as never, '/tmp/x')).toThrow(/unknown editor/i);
  });

  it('never emits a scheme outside the closed list', () => {
    for (const editor of EDITORS) {
      const url = editorUrlFor(editor.id, '/tmp/x');
      expect(url.startsWith(`${editor.scheme}://`), editor.id).toBe(true);
    }
  });

  it('does not let a crafted path smuggle a second argument', () => {
    // The path is interpolated into a URL that the OS hands to a program.
    // Anything that could terminate the path and start something else has to
    // come out the other side encoded, not honoured.
    const url = editorUrlFor('vscode', '/tmp/x?evil=1#frag');
    expect(url).not.toMatch(/[?#]/);
  });
});

describe('which editors are offered', () => {
  it('offers only the ones actually installed', async () => {
    // Listing an editor the machine does not have produces a click that opens
    // nothing and explains nothing.
    const found = await detectEditors({ which: async cmd => cmd === 'code' });
    expect(found.map(e => e.id)).toEqual(['vscode']);
  });

  it('returns nothing when none are installed, rather than guessing', async () => {
    // The caller then offers to copy the path instead, which is a real answer.
    expect(await detectEditors({ which: async () => false })).toEqual([]);
  });

  it('survives a probe that throws', async () => {
    // `which` shells out. A broken PATH must not take the feature down.
    await expect(detectEditors({ which: async () => { throw new Error('boom'); } }))
      .resolves.toEqual([]);
  });
});
