/**
 * Opening a session's worktree in an editor (CGLAB-174).
 *
 * The whole point is that the user never has to find the path: a worktree
 * lives at `~/.agenfk-worktrees/<repo>/<branch>-<hash>`, which nobody is going
 * to type.
 *
 * This is its own module because of the security shape rather than the size.
 * The desktop's `openExternally` guard accepts http(s) ONLY, and that is
 * deliberate — `shell.openExternal` hands the string to whatever handler the
 * OS has registered for the scheme, so a permissive guard turns "open a URL"
 * into "run this local program with this argument". Supporting `vscode://`
 * needs a narrow, written-down exception, not a relaxed guard, and the two
 * controls here are what make it narrow:
 *
 *  - the SCHEME can only come from the closed list below, so the set of
 *    programs the OS can be asked to launch is fixed at compile time;
 *  - the PATH is encoded, so nothing in it can terminate the path and start
 *    something else.
 */
export interface EditorEntry {
  readonly id: 'vscode' | 'cursor' | 'zed';
  readonly label: string;
  /** The URL scheme the OS resolves to this editor. */
  readonly scheme: string;
  /** The executable to probe for, to decide whether to offer it at all. */
  readonly command: string;
}

/**
 * The editors this app is willing to ask the OS to launch.
 *
 * Closed on purpose: the scheme decides WHICH program runs, so this list is
 * the control. Adding one is a deliberate act, not configuration.
 */
export const EDITORS: ReadonlyArray<EditorEntry> = [
  { id: 'vscode', label: 'VS Code', scheme: 'vscode', command: 'code' },
  { id: 'cursor', label: 'Cursor', scheme: 'cursor', command: 'cursor' },
  { id: 'zed', label: 'Zed', scheme: 'zed', command: 'zed' },
];

/**
 * Build the URL that opens `dirPath` in `editorId`.
 *
 * Refuses rather than repairs, the same posture the tmux session name takes:
 * the value ends up in something the OS executes, and there is no defensible
 * guess at what a caller meant by a relative path.
 */
export function editorUrlFor(editorId: EditorEntry['id'], dirPath: string): string {
  const editor = EDITORS.find(e => e.id === editorId);
  if (!editor) {
    throw new Error(`Unknown editor "${String(editorId)}". Expected one of: ${EDITORS.map(e => e.id).join(', ')}`);
  }
  const trimmed = (dirPath ?? '').trim();
  // Absolute only. A relative path resolves against whatever cwd the OS
  // handler happens to have, which is nobody's intent.
  if (!trimmed || !trimmed.startsWith('/')) {
    throw new Error(`Refusing to open a path that is not absolute: ${JSON.stringify(dirPath)}`);
  }

  // Encoded segment by segment: `encodeURIComponent` would eat the separators,
  // and leaving the path raw lets a `?` or `#` end it and start a query or a
  // fragment that the handler then reads as something else.
  const encoded = trimmed.split('/').map(encodeURIComponent).join('/');
  return `${editor.scheme}://file${encoded}`;
}

/**
 * Which of them are actually on this machine.
 *
 * Offering an editor the user does not have produces a click that opens
 * nothing and explains nothing. When none are found the caller offers to copy
 * the path instead, which is a real answer rather than a dead button.
 */
export async function detectEditors(deps: {
  which: (command: string) => Promise<boolean>;
}): Promise<EditorEntry[]> {
  const found: EditorEntry[] = [];
  for (const editor of EDITORS) {
    try {
      // `which` shells out, and a broken PATH must not take the feature down
      // — "no editors" is a usable answer, an exception is not.
      if (await deps.which(editor.command)) found.push(editor);
    } catch { /* treated as not installed */ }
  }
  return found;
}
