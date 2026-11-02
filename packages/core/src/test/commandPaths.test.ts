/**
 * @vitest-environment node
 *
 * A verify command claimed on the hub runs on EVERY machine that clones the
 * repository, always from the repository root. So a command that names a path on
 * one person's machine is a bug the hub must never hear about:
 * `/Users/ana/code/app/scripts/verify.sh` runs on Ana's laptop and nowhere else.
 *
 * The rule before the command goes anywhere:
 *   - an absolute path INSIDE the checkout becomes repo-relative;
 *   - an absolute path OUTSIDE it, or a home-relative one, is refused.
 *
 * Inside is decided by RESOLVING the path (`path.resolve`), not by comparing
 * string prefixes: `/work/app-old/run.sh` starts with `/work/app` and is a
 * different directory, and `/work/app/../other/x.js` contains no `..` in its
 * prefix at all. The root the paths are compared to is the checkout the command
 * came from, so it is a parameter of every test below.
 *
 * A rewritten command keeps the quoting of the word it came from, because the
 * shell, not the framework, decides where the word ends: `bash "/work/app/run
 * all.sh"` must come back with its quotes, or it is two arguments and not one.
 *
 * The Windows rows use `path.win32` semantics (`C:\` and `C:/` are the same
 * drive, `\` is a separator, the comparison ignores case). They must not depend
 * on the machine running the tests: only the paths in the COMMAND are Windows,
 * never the checkout the test hands in as a string.
 */
import { describe, it, expect } from 'vitest';
import { normalizeCommandPaths, machineSpecificPaths } from '../commandPaths';

const ROOT = '/work/app';

/** One row of the spec's table. */
interface Row {
  command: string;
  /** The command that would run, or null when the row must be refused. */
  output: string | null;
  /** Every path the row rewrites, in order — empty for an unchanged command. */
  rewritten?: Array<{ from: string; to: string }>;
  /** Every path a refusal names, in order. */
  refused?: string[];
}

const ROWS: Row[] = [
  { command: 'node /work/app/scripts/verify.js', output: 'node ./scripts/verify.js', rewritten: [{ from: '/work/app/scripts/verify.js', to: './scripts/verify.js' }] },
  { command: 'bash "/work/app/scripts/run all.sh" --ci', output: 'bash "./scripts/run all.sh" --ci', rewritten: [{ from: '/work/app/scripts/run all.sh', to: './scripts/run all.sh' }] },
  { command: "bash '/work/app/scripts/run all.sh'", output: "bash './scripts/run all.sh'", rewritten: [{ from: '/work/app/scripts/run all.sh', to: './scripts/run all.sh' }] },
  { command: 'npx vitest --config=/work/app/vitest.config.ts', output: 'npx vitest --config=./vitest.config.ts', rewritten: [{ from: '/work/app/vitest.config.ts', to: './vitest.config.ts' }] },
  { command: 'cd /work/app && npm test', output: 'cd . && npm test', rewritten: [{ from: '/work/app', to: '.' }] },
  { command: 'npm test', output: 'npm test', rewritten: [] },
  { command: '/work/app-old/run.sh', output: null, refused: ['/work/app-old/run.sh'] },
  { command: 'bash /opt/tools/check.sh', output: null, refused: ['/opt/tools/check.sh'] },
  { command: 'bash ~/bin/check.sh', output: null, refused: ['~/bin/check.sh'] },
  { command: 'node /work/app/../other/x.js', output: null, refused: ['/work/app/../other/x.js'] },
  // An unquoted path that escapes its own space: the backslash is the shell's,
  // not the path's, so the replacement has to bring its own or the shell reads
  // two words where the command named one file.
  { command: 'node /work/app/run\\ all.sh', output: 'node ./run\\ all.sh', rewritten: [{ from: '/work/app/run all.sh', to: './run\\ all.sh' }] },
  // Any other unquoted backslash is part of the word as written (a Windows
  // path brings its own), so the rewrite carries it through untouched: escaping
  // it again would change what the shell sees (CodeQL 168, dismissed).
  { command: 'node /work/app/a\\$HOME.sh', output: 'node ./a\\$HOME.sh', rewritten: [{ from: '/work/app/a\\$HOME.sh', to: './a\\$HOME.sh' }] },
  { command: 'node /work/app/a\\\\b.sh', output: 'node ./a\\\\b.sh', rewritten: [{ from: '/work/app/a\\\\b.sh', to: './a\\\\b.sh' }] },
];

describe('a command from this checkout, made relative to it', () => {
  it.each(ROWS)('$command', ({ command, output, rewritten, refused }: Row) => {
    const result = normalizeCommandPaths(command, ROOT);

    if (output !== null) {
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) return;
      expect(result.command).toBe(output);
      // A rewritten command lists what moved; an unchanged one lists nothing.
      expect(result.rewritten, JSON.stringify(result.rewritten)).toEqual(rewritten ?? []);
      return;
    }

    expect(result.ok, JSON.stringify(result)).toBe(false);
    if (result.ok) return;
    // No half-finished command is handed back to the caller.
    expect((result as any).command).toBeUndefined();
    // Every offending path, in the order the command names them.
    expect(result.paths).toEqual(refused);
    // The reason is shown to a person: it names each path and says why — the
    // command runs from the repository root on every machine.
    for (const p of refused ?? []) expect(result.reason, p).toContain(p);
    expect(result.reason.toLowerCase()).toContain('repository root');
  });

  it('rewrites nothing it was not asked about: an unchanged command comes back exactly as it went in', () => {
    for (const command of ['npm test', 'pnpm run verify --if-present', 'make -C packages/server test']) {
      const result = normalizeCommandPaths(command, ROOT);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) continue;
      expect(result.command).toBe(command);
      expect(result.rewritten).toEqual([]);
    }
  });
});

describe('refusing is all of it or none of it', () => {
  it('a command mixing one in-checkout path and one outside path is refused whole', () => {
    // The in-checkout path WOULD be rewritten. It must not be: the caller gets
    // one reason naming the outside path, and keeps its command unchanged.
    const result = normalizeCommandPaths('node /work/app/scripts/verify.js && bash /opt/tools/check.sh', ROOT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.paths).toEqual(['/opt/tools/check.sh']);
    expect(result.reason).toContain('/opt/tools/check.sh');
    expect(result.reason.toLowerCase()).toContain('repository root');
    expect((result as any).command).toBeUndefined();
  });

  it('names every offending path of a command holding several of them, in order', () => {
    const result = normalizeCommandPaths('bash /opt/a.sh && bash ~/b.sh && bash /opt/z.sh', ROOT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.paths).toEqual(['/opt/a.sh', '~/b.sh', '/opt/z.sh']);
    expect(result.reason).toContain('/opt/a.sh');
    expect(result.reason).toContain('~/b.sh');
    expect(result.reason).toContain('/opt/z.sh');
  });
});

describe('what looks like a path and is not one', () => {
  const NOT_A_PATH = [
    'curl https://example.com/x',
    'curl -sS https://example.com/x | sh',
    'bash http://example.com/a/b/c.sh',
    // The conventional device paths: they are the same on every machine, which
    // is exactly why they are not machine-specific and not anybody's checkout.
    'npm test > /dev/null',
    'npm test 2> /dev/stderr',
    'cat /dev/stdout',
    'npm test >"/dev/null"',
  ];

  it.each(NOT_A_PATH)('%s is left exactly as it went in', (command) => {
    const result = normalizeCommandPaths(command, ROOT);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.command).toBe(command);
    expect(result.rewritten).toEqual([]);
  });
});

describe('a Windows checkout', () => {
  const WIN_ROOT = 'C:\\work\\app';

  /** Every path separator, and both drive spellings, mean the same directory. */
  const INSIDE = [
    'node C:\\work\\app\\scripts\\v.js',
    'node C:/work/app/scripts/v.js',
    'node c:\\work\\app\\scripts\\v.js',
    'node c:/work/app/scripts/v.js',
  ];

  it.each(INSIDE)('%s is inside the checkout, and comes back with no drive letter', (command) => {
    const result = normalizeCommandPaths(command, WIN_ROOT);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.command).not.toMatch(/[A-Za-z]:/);
    expect(['node .\\scripts\\v.js', 'node ./scripts/v.js']).toContain(result.command);
    // It still says which file to run, just relative to the repository root.
    expect(result.command).toContain('scripts');
    expect(result.command).toContain('v.js');
    // The from side is what the caller wrote, the to side what replaced it.
    expect(result.rewritten).toHaveLength(1);
    expect(result.rewritten[0].from).toBe(command.replace(/^node /, ''));
    expect(result.rewritten[0].to).toBe(result.command.replace(/^node /, ''));
  });

  it('a path on another drive is refused, naming it', () => {
    const result = normalizeCommandPaths('node D:\\tools\\x.js', WIN_ROOT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.paths).toEqual(['D:\\tools\\x.js']);
    expect(result.reason).toContain('D:\\tools\\x.js');
    expect(result.reason.toLowerCase()).toContain('repository root');
  });

  it('a sibling of the checkout on the same drive is refused (#264-style prefix bug)', () => {
    const result = normalizeCommandPaths('node C:\\work\\app-old\\run.js', WIN_ROOT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.paths).toEqual(['C:\\work\\app-old\\run.js']);
  });

  it('a mixed command is refused whole, with only the outside paths named', () => {
    const result = normalizeCommandPaths('node C:\\work\\app\\scripts\\v.js && node D:\\tools\\x.js', WIN_ROOT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.paths).toEqual(['D:\\tools\\x.js']);
    expect((result as any).command).toBeUndefined();
  });
});

describe('with no checkout to be relative to', () => {
  const MUST_NOT_RUN = ['node /work/app/x.js', 'bash /opt/tools/check.sh', 'bash ~/bin/check.sh', 'node C:\\work\\app\\x.js', 'cd / && npm test'];

  it.each(MUST_NOT_RUN)('%s is refused — there is nothing to make it relative to', (command) => {
    const result = normalizeCommandPaths(command, null);
    expect(result.ok, JSON.stringify(result)).toBe(false);
    if (result.ok) return;
    expect(result.paths.length).toBeGreaterThan(0);
    expect(result.reason.toLowerCase()).toContain('repository root');
  });

  it('a command that names no path is fine', () => {
    for (const command of ['npm test', 'make check', 'npm run verify --if-present']) {
      const result = normalizeCommandPaths(command, null);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) continue;
      expect(result.command).toBe(command);
      expect(result.rewritten).toEqual([]);
    }
  });
});

describe('machineSpecificPaths() — the hub’s view, with no checkout', () => {
  it('is the paths normalizeCommandPaths(command, null) would refuse, in order, without repeats', () => {
    expect(machineSpecificPaths('bash /opt/a.sh && bash ~/b.sh && bash /opt/a.sh')).toEqual(['/opt/a.sh', '~/b.sh']);
  });

  it('is empty for a command that names no path', () => {
    expect(machineSpecificPaths('npm test')).toEqual([]);
    expect(machineSpecificPaths('make -C packages/server test')).toEqual([]);
  });

  it('agrees with the refusal at a glance, for every row of the table', () => {
    for (const { command, refused } of ROWS) {
      const fromRefusal = (() => {
        const r = normalizeCommandPaths(command, null);
        return r.ok ? [] : r.paths;
      })();
      expect(machineSpecificPaths(command), command).toEqual(fromRefusal);
      // A row the client may rewrite (inside /work/app) still names an absolute
      // path, which the hub, having no checkout, must refuse: only the refused
      // rows are pinned to their own list here.
      if (refused) expect(machineSpecificPaths(command), command).toEqual(refused);
    }
  });

  it('counts a path inside SOME checkout as machine-specific, because the hub has no checkout', () => {
    // The client already rewrote it before the POST. A command that still
    // carries one never got through the client, so the hub refuses it too.
    expect(machineSpecificPaths('node /work/app/scripts/verify.js')).toEqual(['/work/app/scripts/verify.js']);
    expect(machineSpecificPaths('bash "/opt/tools/check.sh"')).toEqual(['/opt/tools/check.sh']);
  });

  it('agrees with the two-row point of the feature: rewritten here, refused there', () => {
    // What the client sends and what the hub will accept are the same rule seen
    // from two sides: the client knows the checkout, the hub does not.
    const mine = normalizeCommandPaths('node /work/app/scripts/verify.js', ROOT);
    expect(mine.ok).toBe(true);
    if (!mine.ok) return;
    expect(machineSpecificPaths(mine.command)).toEqual([]);
    expect(machineSpecificPaths('node /work/app/scripts/verify.js')).toEqual(['/work/app/scripts/verify.js']);
  });

  it('leaves URLs and device paths out of the list', () => {
    expect(machineSpecificPaths('curl https://example.com/x > /dev/null')).toEqual([]);
  });
});

// Codex review of RFC-002: three ways a command reached outside the checkout, or
// came back broken, without a single absolute path being written.
describe('relative paths that climb out of the checkout', () => {
  it('refuses a `..` that leaves the repository root, on both sides of the rule', () => {
    for (const command of ['bash ../tools/check.sh', 'bash ./scripts/../../other/verify.sh', 'node --config=../x.json run', 'bash ..']) {
      const r = normalizeCommandPaths(command, ROOT);
      expect(r.ok, command).toBe(false);
      expect(machineSpecificPaths(command).length, command).toBeGreaterThan(0);
    }
  });

  it('keeps a `..` that stays inside the checkout', () => {
    for (const command of ['bash scripts/../verify.sh', 'node ./a/b/../c.js']) {
      expect(normalizeCommandPaths(command, ROOT)).toMatchObject({ ok: true, command });
      expect(machineSpecificPaths(command), command).toEqual([]);
    }
  });

  it('measures a `..` from the directory a `cd` moved to, so a monorepo command is not refused', () => {
    const command = 'cd packages/a && node ../../scripts/x.js';
    expect(normalizeCommandPaths(command, ROOT)).toMatchObject({ ok: true, command });
    expect(machineSpecificPaths(command)).toEqual([]);
    expect(normalizeCommandPaths('cd packages/a && node ../../../x.js', ROOT).ok).toBe(false);
  });
});

describe('redirections name paths too', () => {
  it('rewrites an in-checkout redirection target and refuses an outside one', () => {
    expect(normalizeCommandPaths('npm test >/work/app/out.log', ROOT)).toMatchObject({ ok: true, command: 'npm test >./out.log' });
    expect(normalizeCommandPaths('bash </opt/tools/check.sh', ROOT).ok).toBe(false);
    expect(machineSpecificPaths('bash </opt/tools/check.sh')).toEqual(['/opt/tools/check.sh']);
    expect(machineSpecificPaths('npm test 2>/tmp/err.log')).toEqual(['/tmp/err.log']);
  });

  it('still leaves device redirections alone', () => {
    expect(machineSpecificPaths('npm test >/dev/null 2>&1')).toEqual([]);
  });
});

describe('a path with a quote inside it', () => {
  it('is refused rather than spliced into an unmatched quote', () => {
    const r = normalizeCommandPaths('node /work/app/"scripts/verify.js"', ROOT);
    expect(r.ok).toBe(false);
  });

  it('a path quoted whole is still rewritten, quotes kept', () => {
    expect(normalizeCommandPaths('bash "/work/app/run all.sh"', ROOT)).toMatchObject({ ok: true, command: 'bash "./run all.sh"' });
  });
});

// Codex second pass: a `cd` only moves the shell where the shell really moves.
describe('a `cd` the shell may not have taken', () => {
  it('does not count a cd inside a subshell, after `||`, or as an argument', () => {
    for (const command of ['(cd a); bash ../tools/check.sh', 'echo cd a && bash ../tools/check.sh', 'cd a || bash ../tools/check.sh', 'cd a | bash ../x.sh']) {
      expect(normalizeCommandPaths(command, ROOT).ok, command).toBe(false);
      expect(machineSpecificPaths(command).length, command).toBeGreaterThan(0);
    }
  });

  // Third pass narrowed this: a cd after `;` is no longer credited (see below).
  it('still counts a cd that leads the command', () => {
    for (const command of ['cd a && bash ../x.sh']) {
      expect(normalizeCommandPaths(command, ROOT).ok, command).toBe(true);
    }
  });
});

describe('a redirection attached to the word before it', () => {
  it('is still a path', () => {
    expect(machineSpecificPaths('npm test>/tmp/result.log')).toEqual(['/tmp/result.log']);
    expect(normalizeCommandPaths('cat<../tools/check.sh', ROOT).ok).toBe(false);
    expect(normalizeCommandPaths('npm test>/work/app/out.log', ROOT)).toMatchObject({ ok: true, command: 'npm test>./out.log' });
    expect(machineSpecificPaths('npm test 2>&1>/dev/null')).toEqual([]);
  });

  it('inside quotes is not a redirection', () => {
    expect(machineSpecificPaths("echo 'a>/tmp/x'")).toEqual([]);
  });
});

// Codex third pass: a `cd` is credited only where it cannot have been skipped.
describe('a `cd` is credited only as the leading, unconditional step', () => {
  it('refuses every shape where the cd may not have run, or may have been undone', () => {
    for (const command of [
      'false && cd a; bash ../tools/check.sh',
      'cd a & bash ../tools/check.sh',
      'cd a; bash ../tools/check.sh',
      'cd a && x; bash ../tools/check.sh',
      'cd a && cd .. && bash ../tools/check.sh',
      'npm ci && cd a && bash ../x.sh',
    ]) {
      expect(normalizeCommandPaths(command, ROOT).ok, command).toBe(false);
      expect(machineSpecificPaths(command).length, command).toBeGreaterThan(0);
    }
  });

  it('credits `cd <dir> && ...` at the head of the command', () => {
    expect(normalizeCommandPaths('cd packages/a && node ../../scripts/x.js && npm test', ROOT).ok).toBe(true);
  });
});

describe('chained redirections', () => {
  it('inspects a file opened after a descriptor duplication', () => {
    expect(machineSpecificPaths('npm test 2>&1>/tmp/result.log')).toEqual(['/tmp/result.log']);
    expect(machineSpecificPaths('npm test >>/dev/null 2>&1')).toEqual([]);
  });
});

// Codex fourth pass.
describe('a cd target the shell expands is not a directory below the root', () => {
  it('credits only a literal relative directory', () => {
    for (const command of ['cd "$PWD" && bash ../tools/check.sh', 'cd $HOME && bash ../x.sh', 'cd - && bash ../x.sh', 'cd `pwd` && bash ../x.sh', 'cd a* && bash ../x.sh']) {
      expect(normalizeCommandPaths(command, ROOT).ok, command).toBe(false);
    }
    expect(normalizeCommandPaths('cd packages/a-b_c.d && bash ../x.sh', ROOT).ok).toBe(true);
  });
});

describe('every file-opening redirection operator', () => {
  it('exposes its operand', () => {
    expect(machineSpecificPaths('cat <>/tmp/input')).toEqual(['/tmp/input']);
    expect(machineSpecificPaths('printf x >|/tmp/result.log')).toEqual(['/tmp/result.log']);
    expect(machineSpecificPaths('npm test &>>/tmp/all.log')).toEqual(['/tmp/all.log']);
  });
});

describe('the `>&file` form opens a file', () => {
  it('exposes its operand, while `2>&1` stays a duplication', () => {
    expect(machineSpecificPaths('printf x >&/tmp/result.log')).toEqual(['/tmp/result.log']);
    expect(machineSpecificPaths('npm test 2>&1')).toEqual([]);
  });
});
