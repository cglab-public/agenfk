/**
 * PO-1 review 5 (Codex gpt-6.1-sol 01a182d1): a project's repository picks its
 * Airlock overrides, and a sandboxed command can move .git away and plant another
 * (measured on macOS: `mv .git .git2`, `rm -rf .git` and writes to .git/commondir
 * all succeed; only .git/config itself is refused). So the identity is read once
 * and pinned where no sandbox can write, and read again only when a person sets
 * the project's root.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { airlockRepoPins } from '../airlock/repoPins';

let tmp: string;
let roots: Record<string, string | null>;
let origin: Record<string, { url: string; cacheable: boolean }>;
let read: ReturnType<typeof vi.fn>;

const pins = () => airlockRepoPins({ file: path.join(tmp, 'airlock', 'repo-pins.json'), rootOf: async (id) => roots[id] ?? null, read: read as any });

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'airlock-pins-'));
  roots = { a: '/work/a', b: '/work/b' };
  origin = { '/work/a': { url: 'https://github.com/acme/api.git', cacheable: true }, '/work/b': { url: '', cacheable: true } };
  read = vi.fn(async (root: string) => origin[root]);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('airlockRepoPins', () => {
  it('reads a project\'s origin once and keeps it, whatever its checkout says later', async () => {
    const p = pins();
    expect(await p.repoOf('a')).toBe('https://github.com/acme/api.git');
    origin['/work/a'] = { url: 'https://github.com/acme/loose.git', cacheable: true };
    expect(await p.repoOf('a')).toBe('https://github.com/acme/api.git');
    // a restarted server keeps it too: it is in a file
    expect(await pins().repoOf('a')).toBe('https://github.com/acme/api.git');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('pins "no repository" as an answer as well', async () => {
    expect(await pins().repoOf('b')).toBeNull();
    origin['/work/b'] = { url: 'https://github.com/acme/loose.git', cacheable: true };
    expect(await pins().repoOf('b')).toBeNull();
  });

  it('reads again when the root is not the one it pinned, or a person set it (forget)', async () => {
    const p = pins();
    await p.repoOf('a');
    origin['/work/a2'] = { url: 'https://github.com/acme/other.git', cacheable: true };
    roots.a = '/work/a2';
    expect(await p.repoOf('a')).toBe('https://github.com/acme/other.git');
    origin['/work/a2'] = { url: 'https://github.com/acme/renamed.git', cacheable: true };
    p.forget('a');
    expect(await p.repoOf('a')).toBe('https://github.com/acme/renamed.git');
  });

  it('a lookup that failed throws and pins nothing; a project with no root has no repository', async () => {
    origin['/work/a'] = { url: '', cacheable: false };
    await expect(pins().repoOf('a')).rejects.toThrow(/timed out or failed/);
    origin['/work/a'] = { url: 'https://github.com/acme/api.git', cacheable: true };
    expect(await pins().repoOf('a')).toBe('https://github.com/acme/api.git');
    expect(await pins().repoOf('none')).toBeNull();
  });
});

describe('airlockRepoPins: review 6 (Codex gpt-6.1-sol 01a182d1)', () => {
  it('the pin outlives the root: a project whose root is gone keeps its pinned repository', async () => {
    const p = pins();
    await p.repoOf('a');
    roots.a = null;
    expect(await p.repoOf('a')).toBe('https://github.com/acme/api.git');
  });

  it('concurrent first lookups make one read, and a pin is never overwritten for the same root', async () => {
    let release!: () => void;
    read = vi.fn((root: string) => new Promise((res) => { release = () => res(origin[root]); }));
    const p = pins();
    const one = p.repoOf('a');
    const two = p.repoOf('a');
    await new Promise((r) => setTimeout(r, 5));
    release();
    expect(await one).toBe('https://github.com/acme/api.git');
    expect(await two).toBe('https://github.com/acme/api.git');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('a read that finishes after another pinned the same root does not replace that pin', async () => {
    const file = path.join(tmp, 'airlock', 'repo-pins.json');
    const deferred = () => { let release!: (v: { url: string; cacheable: boolean }) => void; const p = new Promise<{ url: string; cacheable: boolean }>((r) => { release = r; }); return { p, release }; };
    const slow = deferred();
    const fast = deferred();
    const b = airlockRepoPins({ file, rootOf: async (id) => roots[id] ?? null, read: () => slow.p });
    const a = airlockRepoPins({ file, rootOf: async (id) => roots[id] ?? null, read: () => fast.p });
    const late = b.repoOf('a');
    await new Promise((r) => setTimeout(r, 5));
    const first = a.repoOf('a');
    fast.release({ url: 'https://github.com/acme/api.git', cacheable: true });
    expect(await first).toBe('https://github.com/acme/api.git');
    // b's read saw a checkout tampered after a pinned it
    slow.release({ url: 'https://github.com/acme/loose.git', cacheable: true });
    expect(await late).toBe('https://github.com/acme/api.git');
    expect(await pins().repoOf('a')).toBe('https://github.com/acme/api.git');
  });

  it('a read that a forget overtook is not pinned', async () => {
    let release!: () => void;
    read = vi.fn((root: string) => new Promise((res) => { release = () => res(origin[root]); }));
    const p = pins();
    const pending = p.repoOf('a');
    await new Promise((r) => setTimeout(r, 5));
    p.forget('a');
    origin['/work/a'] = { url: 'https://github.com/acme/new.git', cacheable: true };
    release();
    await expect(pending).rejects.toThrow(/set again while/);
    read = vi.fn(async (root: string) => origin[root]);
    expect(await pins().repoOf('a')).toBe('https://github.com/acme/new.git');
  });

  it('a pin file that exists but cannot be read is a failure, never an empty start', async () => {
    const file = path.join(tmp, 'airlock', 'repo-pins.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (const bad of ['{not json', '[1,2]', '"x"']) {
      fs.writeFileSync(file, bad);
      await expect(pins().repoOf('a'), bad).rejects.toThrow(/repo-pins\.json/);
    }
    expect(read).not.toHaveBeenCalled();
  });
});
