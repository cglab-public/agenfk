/**
 * @vitest-environment node
 *
 * A session must not attribute its runs to another session's card.
 *
 * The run recorder reads the note `agenfk gatekeeper` writes, and that note
 * lives in a SINGLE shared file (`~/.agenfk/active-work.json`) because the CLI
 * gatekeeper has no session id to key on. The reader *supports* per-session
 * notes, but nothing writes them — so every session on the machine falls back
 * to the same note, and the last card authorized by ANYONE captures the runs
 * of EVERYONE.
 *
 * Measured 2026-09-17: a Claude Code session reviewing cglab-vectors (card
 * 2cab541e, project c3ae2b5f) opened its run on card 53ed7163 (project
 * fca0b99a) — whatever card a pi session had last authorized. The card showed
 * `running` with the wrong harness.
 *
 * The fix is a guard, not a redirect: when the session's project is known and
 * the note names a DIFFERENT project, the note is not that session's. A run
 * on the wrong card is worse than no run, which is the rule the run recorder
 * already lives by (see the header of activeWork.ts).
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { noteMatchesProject, projectIdFromCwd } from '../../../../bin/agenfk-run-hook.mjs';

describe('a note only authorizes its own project', () => {
  it('accepts a note for the session project', () => {
    expect(noteMatchesProject({ itemId: 'x', projectId: 'p1' }, 'p1')).toBe(true);
  });

  it('refuses a note for a different project', () => {
    // The bug: the cglab-vectors session was attributed to an agenfk card.
    expect(noteMatchesProject({ itemId: 'x', projectId: 'p1' }, 'p2')).toBe(false);
  });

  it('keeps the old behaviour when the session project is unknown', () => {
    // No `.agenfk/project.json` above the cwd (a bare worktree, say) — we
    // cannot disprove the note, and refusing here would kill recording.
    expect(noteMatchesProject({ itemId: 'x', projectId: 'p1' }, undefined)).toBe(true);
    expect(noteMatchesProject({ itemId: 'x', projectId: 'p1' }, null)).toBe(true);
  });

  it('does not refuse a note that names no project', () => {
    expect(noteMatchesProject({ itemId: 'x' }, 'p1')).toBe(true);
  });
});

describe('the session project comes from the cwd', () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  const tempDir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-attrib-'));
    made.push(dir);
    return dir;
  };

  it('reads the project id from the nearest .agenfk/project.json', () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, '.agenfk'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.agenfk', 'project.json'),
      JSON.stringify({ projectId: 'p1' }),
    );
    const nested = path.join(root, 'packages', 'deep');
    fs.mkdirSync(nested, { recursive: true });
    expect(projectIdFromCwd(nested)).toBe('p1');
  });

  it('returns null when no project owns the cwd', () => {
    expect(projectIdFromCwd(tempDir())).toBeNull();
  });

  it('returns null for a missing or malformed project file', () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, '.agenfk'), { recursive: true });
    fs.writeFileSync(path.join(root, '.agenfk', 'project.json'), '{ not json');
    expect(projectIdFromCwd(root)).toBeNull();
  });
});