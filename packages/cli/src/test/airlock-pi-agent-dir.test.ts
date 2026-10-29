/**
 * BUG ff9969f5: pi (1.4.0) reads a missing auth.json as empty but an unreadable one as "no
 * key", even for a provider whose key is in models.json - and the Airlock sandbox denies
 * ~/.pi/agent/auth.json. The launcher gives pi a staged agent dir instead: every entry of the
 * real one as a link, except auth.json, which is an empty one of its own. On a real filesystem.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { stagePiAgentDir } from '../airlock/piAgentDir';

const describePosix = process.platform === 'win32' ? describe.skip : describe;
const made: string[] = [];
const tmp = (prefix: string): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return d;
};
afterEach(() => {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describePosix('stagePiAgentDir', () => {
  it('links every entry but auth.json, gives pi an empty readable auth.json, and removes only itself', () => {
    const real = tmp('pi-real-');
    fs.writeFileSync(path.join(real, 'settings.json'), '{"defaultModel":"m"}');
    fs.writeFileSync(path.join(real, 'models.json'), '{"providers":{}}');
    fs.writeFileSync(path.join(real, 'auth.json'), '{"anthropic":{"key":"real-secret"}}');
    fs.mkdirSync(path.join(real, 'sessions'));
    const work = tmp('pi-stage-');

    const staged = stagePiAgentDir(real, work);
    expect(path.dirname(staged.dir)).toBe(work);
    const names = fs.readdirSync(staged.dir).sort();
    expect(names).toEqual(['auth.json', 'models.json', 'sessions', 'settings.json']);
    for (const n of ['models.json', 'sessions', 'settings.json']) {
      expect(fs.lstatSync(path.join(staged.dir, n)).isSymbolicLink(), n).toBe(true);
      expect(fs.realpathSync(path.join(staged.dir, n))).toBe(fs.realpathSync(path.join(real, n)));
    }
    const auth = path.join(staged.dir, 'auth.json');
    expect(fs.lstatSync(auth).isSymbolicLink()).toBe(false);
    expect(JSON.parse(fs.readFileSync(auth, 'utf8'))).toEqual({});
    expect(fs.statSync(auth).mode & 0o777).toBe(0o600);
    // A session written through the link lands in the real dir.
    fs.writeFileSync(path.join(staged.dir, 'sessions', 's.jsonl'), 'x');
    expect(fs.existsSync(path.join(real, 'sessions', 's.jsonl'))).toBe(true);

    staged.cleanup();
    expect(fs.existsSync(staged.dir)).toBe(false);
    expect(fs.readFileSync(path.join(real, 'auth.json'), 'utf8')).toContain('real-secret');
    expect(fs.existsSync(path.join(real, 'sessions', 's.jsonl'))).toBe(true);
  });

  // Review C4: a first session's history (no sessions dir yet) is kept - the dir is made in
  // the real agent dir before staging, and pi writes through its link.
  it('makes the real sessions dir first, so a first session\'s history is kept', () => {
    const real = tmp('pi-real-');
    const staged = stagePiAgentDir(real, tmp('pi-stage-'));
    expect(fs.lstatSync(path.join(staged.dir, 'sessions')).isSymbolicLink()).toBe(true);
    fs.writeFileSync(path.join(staged.dir, 'sessions', 'first.jsonl'), 'history');
    staged.cleanup();
    expect(fs.readFileSync(path.join(real, 'sessions', 'first.jsonl'), 'utf8')).toBe('history');
  });

  it('a real agent dir that does not exist yet is made, with its sessions dir', () => {
    const work = tmp('pi-stage-');
    const real = path.join(work, 'nope');
    const staged = stagePiAgentDir(real, work);
    expect(fs.readdirSync(staged.dir).sort()).toEqual(['auth.json', 'sessions']);
    staged.cleanup();
    expect(fs.existsSync(path.join(real, 'sessions'))).toBe(true);
  });

  // Second review: the staged dir is the sandbox's to write, so nothing is carried out of it.
  it('carries nothing back: what the sandbox puts in the staged dir goes with it', () => {
    const real = tmp('pi-real-');
    fs.writeFileSync(path.join(real, 'auth.json'), '{"real":1}');
    const staged = stagePiAgentDir(real, tmp('pi-stage-'));
    fs.writeFileSync(path.join(staged.dir, 'auth.json'), '{"planted":1}');
    fs.writeFileSync(path.join(staged.dir, 'AUTH.JSON.bak'), 'x');
    fs.mkdirSync(path.join(staged.dir, 'EXTENSIONS'));
    fs.writeFileSync(path.join(staged.dir, 'EXTENSIONS', 'evil.ts'), 'export default () => {}');
    staged.cleanup();
    expect(fs.readFileSync(path.join(real, 'auth.json'), 'utf8')).toBe('{"real":1}');
    expect(fs.readdirSync(real).sort()).toEqual(['auth.json', 'sessions']);
  });

  it('a staged root swapped for a link: cleanup removes the link, never what it points at', () => {
    const real = tmp('pi-real-');
    const secret = tmp('ssh-');
    fs.writeFileSync(path.join(secret, 'id_ed25519'), 'PRIVATE');
    const staged = stagePiAgentDir(real, tmp('pi-stage-'));
    fs.renameSync(staged.dir, `${staged.dir}-moved`);
    made.push(`${staged.dir}-moved`);
    fs.symlinkSync(secret, staged.dir);
    staged.cleanup();
    expect(fs.existsSync(staged.dir)).toBe(false);
    expect(fs.readFileSync(path.join(secret, 'id_ed25519'), 'utf8')).toBe('PRIVATE');
    expect(fs.readdirSync(real)).toEqual(['sessions']);
  });

  it('cleanup twice is harmless', () => {
    const work = tmp('pi-stage-');
    const staged = stagePiAgentDir(tmp('pi-real-'), work);
    staged.cleanup();
    expect(() => staged.cleanup()).not.toThrow();
  });
});
