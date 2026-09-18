/**
 * Reading a worktree's state, for the session panel (CGLAB-173).
 *
 * Parsing only — no process is spawned here. The caller runs the command and
 * hands the bytes in, which is what makes the interesting cases (a rename, a
 * path with a space, an empty tree) something you can write down instead of
 * reproducing against a real repository.
 *
 * `git status --porcelain=v1 -z` is the input on purpose:
 *
 *  - `--porcelain` is the documented stable format. The human-readable output
 *    changes between versions and is localised; parsing it is how a tool
 *    starts reporting nonsense to whoever has a different locale.
 *  - `-z` separates records with NUL instead of newline, so a filename
 *    containing a newline — which git allows — cannot invent extra entries.
 */
export type GitFileState = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';

export interface GitFileChange {
  readonly path: string;
  /** Where the change is: staged for the next commit, or only in the tree. */
  readonly staged: boolean;
  readonly state: GitFileState;
  /** Only for a rename: where the file came from. */
  readonly from?: string;
}

export interface GitWorktreeStatus {
  readonly changed: number;
  readonly staged: number;
  readonly files: GitFileChange[];
}

const STATE_BY_CODE: Record<string, GitFileState> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'added',
  '?': 'untracked',
};

/**
 * Parse the output of `git status --porcelain=v1 -z`.
 *
 * Each record is `XY <path>`, where X is the index (staged) state and Y the
 * worktree state. A rename adds a SECOND NUL-separated field for the original
 * path, which is why this cannot be a simple split-and-map: consuming that
 * field is what keeps every subsequent entry aligned.
 */
export function parseGitStatus(porcelain: string): GitWorktreeStatus {
  const records = porcelain.split('\0').filter(r => r.length > 0);
  const files: GitFileChange[] = [];

  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    // `XY ` — two status codes and a space. Anything shorter is not a record.
    if (record.length < 4) continue;
    const index = record[0];
    const tree = record[1];
    const filePath = record.slice(3);

    if (index === '?' && tree === '?') {
      files.push({ path: filePath, staged: false, state: 'untracked' });
      continue;
    }

    // A rename's original path is the NEXT record, not part of this one.
    // Skipping it here is also what stops it being read as a file of its own.
    let from: string | undefined;
    if (index === 'R' || index === 'C') {
      from = records[i + 1];
      i += 1;
    }

    // Both halves can be set at once — staged edits plus further unstaged ones
    // on the same file — and that is two entries, because they are two
    // different states of the same path and collapsing them loses one.
    if (index !== ' ' && index !== '?') {
      files.push({ path: filePath, staged: true, state: STATE_BY_CODE[index] ?? 'modified', ...(from ? { from } : {}) });
    }
    if (tree !== ' ' && tree !== '?') {
      files.push({ path: filePath, staged: false, state: STATE_BY_CODE[tree] ?? 'modified' });
    }
  }

  return {
    // Counted from the entries rather than tracked separately, so the numbers
    // cannot disagree with the list they label.
    changed: files.filter(f => !f.staged).length,
    staged: files.filter(f => f.staged).length,
    files,
  };
}
