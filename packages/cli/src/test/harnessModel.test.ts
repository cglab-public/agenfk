/**
 * Detecting which model actually ran, rather than believing what an agent says.
 *
 * The bug this exists for: a pi session running DeepSeek v4.1 Flash reported its
 * PR as Qwen 3.8 27b. pi writes a `model_change` record every time the model is
 * selected — the FIRST is the launch default from settings.json
 * (coding4/qwen3.8:27b), and a session that switches writes another. Reading the
 * default setting, or the first record, attributes every such session to a model
 * it never ran. The last `model_change` is the one that was in force.
 *
 * Detection is evidence; a `--model` flag is a claim. These tests pin that the
 * evidence is read correctly and that a disagreement is never silent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectHarnessModel, reconcileModel, resolveModelForReport, resolveFromOptions } from '../harnessModel';

let home: string;
// The detector reads the REAL environment by default, and this suite runs
// inside a harness: under Claude Code CLAUDE_CODE_SESSION_ID is set, under pi
// PI_SESSION_FILE points at a live log. Left in place they would answer for
// every heuristic test below. Cleared per test and restored after.
const HARNESS_VARS = ['CLAUDE_CODE_SESSION_ID', 'PI_SESSION_FILE'] as const;
let savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-hm-'));
  savedEnv = Object.fromEntries(HARNESS_VARS.map(k => [k, process.env[k]]));
  for (const k of HARNESS_VARS) delete process.env[k];
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  for (const k of HARNESS_VARS) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
});

/** Write a pi session log for `cwd`, with the given model_change sequence. */
function piSession(cwd: string, changes: Array<{ provider: string; modelId: string }>, opts: { dir?: string; mtime?: Date } = {}) {
  const dir = path.join(home, '.pi', 'agent', 'sessions', opts.dir ?? `--${cwd.replace(/\//g, '-')}--`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}_${Math.random().toString(36).slice(2)}.jsonl`);
  const lines = [JSON.stringify({ type: 'session', version: 3, id: 'sess', cwd })];
  for (const c of changes) lines.push(JSON.stringify({ type: 'model_change', provider: c.provider, modelId: c.modelId }));
  fs.writeFileSync(file, lines.join('\n') + '\n');
  if (opts.mtime) fs.utimesSync(file, opts.mtime, opts.mtime);
  return file;
}

function piSettings(defaultModel: string) {
  const dir = path.join(home, '.pi', 'agent');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ defaultProvider: 'coding4', defaultModel }));
}

describe('detectHarnessModel — pi', () => {
  it('reports the LAST model_change, not the launch default', () => {
    const cwd = '/work/proj';
    piSession(cwd, [
      { provider: 'coding4', modelId: 'qwen3.8:27b' },
      { provider: 'openrouter', modelId: 'deepseek/deepseek-v4.1-flash' },
    ]);
    expect(detectHarnessModel({ cwd, home })).toMatchObject({
      model: 'deepseek/deepseek-v4.1-flash', harness: 'pi',
    });
  });

  it('ignores settings.json even when it is the only thing naming a model', () => {
    // The previous version of this wrote settings.json next to a session that
    // already disagreed with it, so it asserted nothing the preceding test did
    // not: settings.json lives outside sessions/ and is never read. Pin the
    // real rule instead — a default with NO session to back it detects nothing,
    // rather than being used as a fallback.
    piSettings('qwen3.8:27b');
    expect(detectHarnessModel({ cwd: '/work/proj', home })).toBeNull();
  });

  it('reports the launch default when the session never switched', () => {
    const cwd = '/work/proj';
    piSession(cwd, [{ provider: 'coding4', modelId: 'qwen3.8:27b' }]);
    expect(detectHarnessModel({ cwd, home })!.model).toBe('qwen3.8:27b');
  });

  it('picks the session for THIS directory, not another project running concurrently', () => {
    piSession('/work/other', [{ provider: 'p', modelId: 'wrong-model' }]);
    piSession('/work/proj', [{ provider: 'p', modelId: 'right-model' }]);
    expect(detectHarnessModel({ cwd: '/work/proj', home })!.model).toBe('right-model');
  });

  it('matches on the session record cwd, not the directory name spelling', () => {
    // The sessions folder encodes cwd in its name, but that encoding is lossy —
    // a path containing a dash is indistinguishable from a path separator.
    const cwd = '/work/my-proj';
    piSession(cwd, [{ provider: 'p', modelId: 'right-model' }], { dir: 'an-unrelated-folder-name' });
    expect(detectHarnessModel({ cwd, home })!.model).toBe('right-model');
  });

  it('prefers the most recent session when several ran in the same directory', () => {
    const cwd = '/work/proj';
    piSession(cwd, [{ provider: 'p', modelId: 'older' }], { mtime: new Date(Date.now() - 86_400_000) });
    piSession(cwd, [{ provider: 'p', modelId: 'newer' }], { mtime: new Date() });
    expect(detectHarnessModel({ cwd, home })!.model).toBe('newer');
  });

  it('falls back to the nearest ancestor session, since agenfk runs from subdirectories', () => {
    piSession('/work/proj', [{ provider: 'p', modelId: 'repo-root-model' }]);
    expect(detectHarnessModel({ cwd: '/work/proj/packages/cli', home })!.model).toBe('repo-root-model');
  });

  it('returns null when no session matches, rather than guessing', () => {
    piSession('/work/other', [{ provider: 'p', modelId: 'not-mine' }]);
    expect(detectHarnessModel({ cwd: '/work/proj', home })).toBeNull();
  });

  it('survives a malformed or truncated log instead of throwing', () => {
    const cwd = '/work/proj';
    const dir = path.join(home, '.pi', 'agent', 'sessions', 'x');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.jsonl'),
      [JSON.stringify({ type: 'session', cwd }), '{not json', JSON.stringify({ type: 'model_change', provider: 'p', modelId: 'ok' }), '{trunc'].join('\n'));
    expect(detectHarnessModel({ cwd, home })!.model).toBe('ok');
  });

  it('returns null when pi has never run at all', () => {
    expect(detectHarnessModel({ cwd: '/work/proj', home })).toBeNull();
  });
});

describe('detectHarnessModel — claude code', () => {
  const claudeSession = (cwd: string, models: string[]) => {
    const dir = path.join(home, '.claude', 'projects', cwd.replace(/\//g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sess.jsonl'),
      models.map(m => JSON.stringify({ type: 'assistant', cwd, message: { model: m } })).join('\n') + '\n');
  };

  it('reports the model its transcript records', () => {
    claudeSession('/work/proj', ['claude-opus-5', 'claude-opus-5']);
    expect(detectHarnessModel({ cwd: '/work/proj', home })).toMatchObject({
      model: 'claude-opus-5', harness: 'claude-code',
    });
  });

  it('reports the last model when the session switched mid-run', () => {
    claudeSession('/work/proj', ['claude-sonnet-5', 'claude-opus-5']);
    expect(detectHarnessModel({ cwd: '/work/proj', home })!.model).toBe('claude-opus-5');
  });
});

describe('detectHarnessModel — choosing between harnesses', () => {
  const claudeSession = (cwd: string, model: string, mtime?: Date) => {
    const dir = path.join(home, '.claude', 'projects', cwd.replace(/\//g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'sess.jsonl');
    fs.writeFileSync(f, JSON.stringify({ type: 'assistant', cwd, message: { model } }) + '\n');
    if (mtime) fs.utimesSync(f, mtime, mtime);
  };

  it('uses the most RECENT session, not a fixed harness order', () => {
    // A machine that has ever run pi in a repo would otherwise have every later
    // Claude Code session in that repo attributed to a stale pi model.
    const cwd = '/work/proj';
    piSession(cwd, [{ provider: 'p', modelId: 'stale-pi-model' }], { mtime: new Date(Date.now() - 3_600_000) });
    claudeSession(cwd, 'claude-opus-5', new Date());
    expect(detectHarnessModel({ cwd, home })).toMatchObject({
      model: 'claude-opus-5', harness: 'claude-code',
    });
  });

  it('still picks pi when pi is the more recent one', () => {
    const cwd = '/work/proj';
    claudeSession(cwd, 'claude-opus-5', new Date(Date.now() - 3_600_000));
    piSession(cwd, [{ provider: 'p', modelId: 'live-pi-model' }], { mtime: new Date() });
    expect(detectHarnessModel({ cwd, home })!.model).toBe('live-pi-model');
  });

  it('ignores a session too old to be the one running now', () => {
    // A PR is opened from within a session, so its log was written moments ago.
    // Attributing today's PR to a log from last month is worse than not guessing.
    const cwd = '/work/proj';
    piSession(cwd, [{ provider: 'p', modelId: 'ancient' }], { mtime: new Date(Date.now() - 40 * 86_400_000) });
    expect(detectHarnessModel({ cwd, home })).toBeNull();
  });

  it('prefers an exact directory match over a more recent ancestor', () => {
    // Two sessions, one at the repo root and one in this package: the closer
    // match is the one describing where the work is happening.
    piSession('/work/proj', [{ provider: 'p', modelId: 'root-model' }], { mtime: new Date() });
    piSession('/work/proj/packages/cli', [{ provider: 'p', modelId: 'pkg-model' }], { mtime: new Date(Date.now() - 60_000) });
    expect(detectHarnessModel({ cwd: '/work/proj/packages/cli', home })!.model).toBe('pkg-model');
  });
});

describe('detectHarnessModel — the harness says which session it is (CGLAB-365)', () => {
  /*
   * Two live sessions in ONE repo directory are indistinguishable by cwd, and
   * the mtime tiebreak picks whichever wrote last. On 2026-09-22 a Fable
   * session was "corrected" to claude-opus-5 from a concurrent Opus session's
   * transcript. Both harnesses put the exact answer in the tool shell's
   * environment; that beats every heuristic.
   */
  const claudeLog = (cwd: string, id: string, model: string, mtime?: Date) => {
    const dir = path.join(home, '.claude', 'projects', cwd.replace(/\//g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(file, JSON.stringify({ type: 'assistant', cwd, message: { model } }) + '\n');
    if (mtime) fs.utimesSync(file, mtime, mtime);
    return file;
  };

  it('CLAUDE_CODE_SESSION_ID picks THIS session even when a sibling session in the same directory wrote more recently', () => {
    claudeLog('/work/proj', 'mine', 'claude-fable-5-1', new Date(Date.now() - 60_000));
    claudeLog('/work/proj', 'other', 'claude-opus-5');
    const got = detectHarnessModel({ cwd: '/work/proj', home, env: { CLAUDE_CODE_SESSION_ID: 'mine' } });
    expect(got).toMatchObject({ model: 'claude-fable-5-1', harness: 'claude-code' });
    expect(got!.source).toMatch(/mine\.jsonl$/);
  });

  it('without the variable the heuristic still applies — and picks the more recent sibling, which is the bug being closed', () => {
    claudeLog('/work/proj', 'mine', 'claude-fable-5-1', new Date(Date.now() - 60_000));
    claudeLog('/work/proj', 'other', 'claude-opus-5');
    expect(detectHarnessModel({ cwd: '/work/proj', home, env: {} })!.model).toBe('claude-opus-5');
  });

  it('CLAUDE_CODE_SESSION_ID wins even when the session log records a different cwd than the one agenfk runs from', () => {
    // A session started in one worktree and running agenfk in another: the
    // env var is the identity, the cwd was only ever a proxy for it.
    claudeLog('/work/elsewhere', 'mine', 'claude-fable-5-1');
    claudeLog('/work/proj', 'other', 'claude-opus-5');
    expect(detectHarnessModel({ cwd: '/work/proj', home, env: { CLAUDE_CODE_SESSION_ID: 'mine' } })!.model).toBe('claude-fable-5-1');
  });

  it('a CLAUDE_CODE_SESSION_ID with no matching log falls back to the heuristic rather than returning nothing', () => {
    claudeLog('/work/proj', 'other', 'claude-opus-5');
    expect(detectHarnessModel({ cwd: '/work/proj', home, env: { CLAUDE_CODE_SESSION_ID: 'gone' } })!.model).toBe('claude-opus-5');
  });

  it('a CLAUDE_CODE_SESSION_ID that is not a plain id is ignored, not used as a path', () => {
    claudeLog('/work/proj', 'other', 'claude-opus-5');
    fs.writeFileSync(path.join(home, 'evil.jsonl'), JSON.stringify({ type: 'assistant', cwd: '/x', message: { model: 'evil' } }) + '\n');
    const got = detectHarnessModel({ cwd: '/work/proj', home, env: { CLAUDE_CODE_SESSION_ID: '../../evil' } });
    expect(got!.model).toBe('claude-opus-5');
  });

  it('PI_SESSION_FILE picks THIS pi session over a more recent one in the same directory', () => {
    const mine = piSession('/work/proj', [{ provider: 'coding4', modelId: 'qwen3.8:27b' }], { mtime: new Date(Date.now() - 60_000) });
    piSession('/work/proj', [{ provider: 'openrouter', modelId: 'deepseek/deepseek-v4.1-flash' }]);
    const got = detectHarnessModel({ cwd: '/work/proj', home, env: { PI_SESSION_FILE: mine } });
    expect(got).toMatchObject({ model: 'qwen3.8:27b', harness: 'pi', source: mine });
  });

  it('PI_SESSION_FILE still reports the LAST model_change of that session', () => {
    const mine = piSession('/work/proj', [
      { provider: 'coding4', modelId: 'qwen3.8:27b' },
      { provider: 'openrouter', modelId: 'moonshotai/kimi-k3' },
    ]);
    expect(detectHarnessModel({ cwd: '/work/proj', home, env: { PI_SESSION_FILE: mine } })!.model).toBe('moonshotai/kimi-k3');
  });

  it('a PI_SESSION_FILE that does not exist falls back to the heuristic', () => {
    piSession('/work/proj', [{ provider: 'coding4', modelId: 'qwen3.8:27b' }]);
    expect(detectHarnessModel({ cwd: '/work/proj', home, env: { PI_SESSION_FILE: path.join(home, 'nope.jsonl') } })!.model).toBe('qwen3.8:27b');
  });

  it('the pi variable beats a Claude Code log in the same directory, and vice versa — the env names the harness', () => {
    const mine = piSession('/work/proj', [{ provider: 'coding4', modelId: 'qwen3.8:27b' }]);
    claudeLog('/work/proj', 'cc', 'claude-opus-5');
    expect(detectHarnessModel({ cwd: '/work/proj', home, env: { PI_SESSION_FILE: mine } })!.harness).toBe('pi');
    expect(detectHarnessModel({ cwd: '/work/proj', home, env: { CLAUDE_CODE_SESSION_ID: 'cc' } })!.harness).toBe('claude-code');
  });

  it('resolveFromOptions reads the real process environment, so the PR commands get the fix without new flags', () => {
    claudeLog('/work/proj', 'mine', 'claude-fable-5-1', new Date(Date.now() - 60_000));
    claudeLog('/work/proj', 'other', 'claude-opus-5');
    // The production call sites pass no env at all; process.env must be the default.
    process.env.CLAUDE_CODE_SESSION_ID = 'mine';
    const r = resolveFromOptions({ model: 'claude-fable-5-1', harness: 'claude-code' }, { cwd: '/work/proj', home });
    expect(r).toEqual({ model: 'claude-fable-5-1', verified: true });
  });

  it('finds the id in whichever project directory holds it, not just the first', () => {
    claudeLog('/work/a', 'a1', 'claude-opus-5');
    claudeLog('/work/m', 'm1', 'claude-opus-5');
    claudeLog('/work/z', 'mine', 'claude-fable-5-1');
    expect(detectHarnessModel({ cwd: '/work/proj', home, env: { CLAUDE_CODE_SESSION_ID: 'mine' } })!.model).toBe('claude-fable-5-1');
  });

  it('honours CLAUDE_CONFIG_DIR for a relocated Claude Code config', () => {
    const cfg = path.join(home, 'elsewhere', 'claude-cfg');
    const dir = path.join(cfg, 'projects', '-work-proj');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'mine.jsonl'), JSON.stringify({ type: 'assistant', cwd: '/work/proj', message: { model: 'claude-fable-5-1' } }) + '\n');
    expect(detectHarnessModel({ cwd: '/work/proj', home, env: { CLAUDE_CODE_SESSION_ID: 'mine', CLAUDE_CONFIG_DIR: cfg } })!.model).toBe('claude-fable-5-1');
  });

  describe('a named session with no usable answer is final — it never hands over to the sibling', () => {
    it('Claude Code: the transcript exists but has no model yet → unverified, not the sibling', () => {
      const dir = path.join(home, '.claude', 'projects', '-work-proj');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'mine.jsonl'), JSON.stringify({ type: 'user', cwd: '/work/proj' }) + '\n');
      claudeLog('/work/proj', 'other', 'claude-opus-5');
      expect(detectHarnessModel({ cwd: '/work/proj', home, env: { CLAUDE_CODE_SESSION_ID: 'mine' } })).toBeNull();
    });

    it('Claude Code: the named transcript is older than the freshness bound → the session is dead, not the sibling', () => {
      claudeLog('/work/proj', 'mine', 'claude-fable-5-1', new Date(Date.now() - 2 * 24 * 60 * 60 * 1000));
      claudeLog('/work/proj', 'other', 'claude-opus-5');
      expect(detectHarnessModel({ cwd: '/work/proj', home, env: { CLAUDE_CODE_SESSION_ID: 'mine' } })).toBeNull();
    });

    it('Claude Code: a subagent writing right now shares the id and may run another model → ambiguous, unverified', () => {
      // Verified on this machine: subagents inherit CLAUDE_CODE_SESSION_ID and
      // their transcripts live under <id>/subagents/, all isSidechain.
      claudeLog('/work/proj', 'mine', 'claude-opus-5');
      const sub = path.join(home, '.claude', 'projects', '-work-proj', 'mine', 'subagents');
      fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(path.join(sub, 'agent-abc.jsonl'), JSON.stringify({ type: 'assistant', isSidechain: true, cwd: '/work/proj', message: { model: 'claude-sonnet-5' } }) + '\n');
      expect(detectHarnessModel({ cwd: '/work/proj', home, env: { CLAUDE_CODE_SESSION_ID: 'mine' } })).toBeNull();
    });

    it('Claude Code: a subagent that finished a while ago does not make the parent ambiguous', () => {
      claudeLog('/work/proj', 'mine', 'claude-opus-5');
      const sub = path.join(home, '.claude', 'projects', '-work-proj', 'mine', 'subagents');
      fs.mkdirSync(sub, { recursive: true });
      const f = path.join(sub, 'agent-abc.jsonl');
      fs.writeFileSync(f, JSON.stringify({ type: 'assistant', isSidechain: true, cwd: '/work/proj', message: { model: 'claude-sonnet-5' } }) + '\n');
      const old = new Date(Date.now() - 60 * 60 * 1000);
      fs.utimesSync(f, old, old);
      expect(detectHarnessModel({ cwd: '/work/proj', home, env: { CLAUDE_CODE_SESSION_ID: 'mine' } })!.model).toBe('claude-opus-5');
    });

    it('Claude Code: a subagent that handed back minutes ago, with the parent writing since, does not make the parent ambiguous (d26832d6)', () => {
      // The field case: a reviewer finished at 12:51:48 and the parent ran
      // `agenfk pr create` at 12:54:39 - inside the 5-minute window, so the PR
      // went out "unverified" although only the parent was running.
      const sub = path.join(home, '.claude', 'projects', '-work-proj', 'mine', 'subagents');
      fs.mkdirSync(sub, { recursive: true });
      const f = path.join(sub, 'agent-abc.jsonl');
      fs.writeFileSync(f, JSON.stringify({ type: 'assistant', isSidechain: true, cwd: '/work/proj', message: { model: 'claude-sonnet-5' } }) + '\n');
      const handedBack = new Date(Date.now() - 3 * 60 * 1000);
      fs.utimesSync(f, handedBack, handedBack);
      const parent = claudeLog('/work/proj', 'mine', 'claude-opus-5');
      // The hand-back as Claude Code writes it into the parent transcript.
      fs.appendFileSync(parent, JSON.stringify({ type: 'user', timestamp: new Date(Date.now() - 2 * 60 * 1000).toISOString(), message: { content: 'Another Claude session sent a message:\n<agent-message from="abc">\n[Subagent hand-back] ...' } }) + '\n');
      expect(detectHarnessModel({ cwd: '/work/proj', home, env: { CLAUDE_CODE_SESSION_ID: 'mine' } })!.model).toBe('claude-opus-5');
    });

    it('Claude Code: a subagent resumed after handing back is running again, and keeps the parent ambiguous', () => {
      // The coordinator resumes a reviewer with SendMessage: its old hand-back is
      // still in the parent transcript, but it has written since.
      const sub = path.join(home, '.claude', 'projects', '-work-proj', 'mine', 'subagents');
      fs.mkdirSync(sub, { recursive: true });
      const parent = claudeLog('/work/proj', 'mine', 'claude-opus-5');
      fs.appendFileSync(parent, JSON.stringify({ type: 'user', timestamp: new Date(Date.now() - 4 * 60 * 1000).toISOString(), message: { content: '<agent-message from="abc">\n[Subagent hand-back] first report' } }) + '\n');
      fs.writeFileSync(path.join(sub, 'agent-abc.jsonl'), JSON.stringify({ type: 'assistant', isSidechain: true, cwd: '/work/proj', message: { model: 'claude-sonnet-5' } }) + '\n');
      expect(detectHarnessModel({ cwd: '/work/proj', home, env: { CLAUDE_CODE_SESSION_ID: 'mine' } })).toBeNull();
    });

    it('Claude Code: a background subagent still working while the parent writes keeps the parent ambiguous (no hand-back yet)', () => {
      // The parent kept writing after the subagent's last write, but nothing
      // handed it back: it may still be running - and may open the PR itself.
      const sub = path.join(home, '.claude', 'projects', '-work-proj', 'mine', 'subagents');
      fs.mkdirSync(sub, { recursive: true });
      const f = path.join(sub, 'agent-abc.jsonl');
      fs.writeFileSync(f, JSON.stringify({ type: 'assistant', isSidechain: true, cwd: '/work/proj', message: { model: 'claude-sonnet-5' } }) + '\n');
      const earlier = new Date(Date.now() - 60 * 1000);
      fs.utimesSync(f, earlier, earlier);
      claudeLog('/work/proj', 'mine', 'claude-opus-5');
      expect(detectHarnessModel({ cwd: '/work/proj', home, env: { CLAUDE_CODE_SESSION_ID: 'mine' } })).toBeNull();
    });

    it('Claude Code: a subagent still writing after the parent\'s last turn keeps the parent ambiguous', () => {
      const parentAt = new Date(Date.now() - 2 * 60 * 1000);
      claudeLog('/work/proj', 'mine', 'claude-opus-5', parentAt);
      const sub = path.join(home, '.claude', 'projects', '-work-proj', 'mine', 'subagents');
      fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(path.join(sub, 'agent-abc.jsonl'), JSON.stringify({ type: 'assistant', isSidechain: true, cwd: '/work/proj', message: { model: 'claude-sonnet-5' } }) + '\n');
      expect(detectHarnessModel({ cwd: '/work/proj', home, env: { CLAUDE_CODE_SESSION_ID: 'mine' } })).toBeNull();
    });

    it('pi: the named log has no model_change and nothing else says → unverified, not the sibling', () => {
      const mine = piSession('/work/proj', []);
      piSession('/work/proj', [{ provider: 'openrouter', modelId: 'deepseek/deepseek-v4.1-flash' }]);
      expect(detectHarnessModel({ cwd: '/work/proj', home, env: { PI_SESSION_FILE: mine } })).toBeNull();
    });

    it('pi: a named log older than the freshness bound is a dead session', () => {
      const mine = piSession('/work/proj', [{ provider: 'coding4', modelId: 'qwen3.8:27b' }], { mtime: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) });
      piSession('/work/proj', [{ provider: 'openrouter', modelId: 'deepseek/deepseek-v4.1-flash' }]);
      expect(detectHarnessModel({ cwd: '/work/proj', home, env: { PI_SESSION_FILE: mine } })).toBeNull();
    });
  });

  describe('pi also exports the model in force', () => {
    it('PI_MODEL answers when the named log has no model_change yet', () => {
      const mine = piSession('/work/proj', []);
      const got = detectHarnessModel({ cwd: '/work/proj', home, env: { PI_SESSION_FILE: mine, PI_MODEL: 'qwen3.8:27b' } });
      expect(got).toMatchObject({ model: 'qwen3.8:27b', harness: 'pi', source: 'env:PI_MODEL' });
    });

    it('PI_MODEL answers on its own for an in-memory session that has no file', () => {
      piSession('/work/proj', [{ provider: 'openrouter', modelId: 'deepseek/deepseek-v4.1-flash' }]);
      expect(detectHarnessModel({ cwd: '/work/proj', home, env: { PI_MODEL: 'qwen3.8:27b' } })!.model).toBe('qwen3.8:27b');
    });

    it('the log outranks PI_MODEL when both are present — the transcript is what actually answered', () => {
      const mine = piSession('/work/proj', [{ provider: 'openrouter', modelId: 'moonshotai/kimi-k3' }]);
      expect(detectHarnessModel({ cwd: '/work/proj', home, env: { PI_SESSION_FILE: mine, PI_MODEL: 'qwen3.8:27b' } })!.model).toBe('moonshotai/kimi-k3');
    });
  });

  describe('the environment is not a trusted place to take a path from', () => {
    it('PI_SESSION_FILE outside pi\'s own sessions directory is ignored', () => {
      const rogue = path.join(home, 'rogue.jsonl');
      fs.writeFileSync(rogue, JSON.stringify({ type: 'model_change', provider: 'x', modelId: 'evil' }) + '\n');
      piSession('/work/proj', [{ provider: 'coding4', modelId: 'qwen3.8:27b' }]);
      expect(detectHarnessModel({ cwd: '/work/proj', home, env: { PI_SESSION_FILE: rogue } })!.model).toBe('qwen3.8:27b');
    });

    it('a directory named as PI_SESSION_FILE is ignored', () => {
      const dir = path.join(home, '.pi', 'agent', 'sessions', 'x.jsonl');
      fs.mkdirSync(dir, { recursive: true });
      piSession('/work/proj', [{ provider: 'coding4', modelId: 'qwen3.8:27b' }]);
      expect(detectHarnessModel({ cwd: '/work/proj', home, env: { PI_SESSION_FILE: dir } })!.model).toBe('qwen3.8:27b');
    });

    it('an absurdly long model string never goes on the wire', () => {
      expect(detectHarnessModel({ cwd: '/work/proj', home, env: { PI_MODEL: 'x'.repeat(300) } })).toBeNull();
    });
  });
});

describe('reconcileModel', () => {
  const detected = { model: 'deepseek/deepseek-v4.1-flash', harness: 'pi', source: '/s.jsonl' };

  it('prefers the detected model and says what it overrode', () => {
    // A session log is evidence; --model is a claim. The user chose evidence.
    const r = reconcileModel('qwen3.8:27b', detected);
    expect(r.model).toBe('deepseek/deepseek-v4.1-flash');
    expect(r.warning).toMatch(/qwen3\.8:27b/);
    expect(r.warning).toMatch(/deepseek\/deepseek-v4\.1-flash/);
  });

  it('stays quiet when the declaration is already right', () => {
    const r = reconcileModel('deepseek/deepseek-v4.1-flash', detected);
    expect(r.model).toBe('deepseek/deepseek-v4.1-flash');
    expect(r.warning).toBeUndefined();
  });

  it('keeps the declared value when nothing could be detected', () => {
    // Detection covers pi and claude code; every other harness must still work.
    const r = reconcileModel('some-other-model', null);
    expect(r.model).toBe('some-other-model');
    expect(r.warning).toBeUndefined();
  });
});

describe('resolveModelForReport — what the PR commands actually call', () => {
  const session = (cwd: string, modelId: string) => {
    const dir = path.join(home, '.pi', 'agent', 'sessions', 's');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.jsonl'), [
      JSON.stringify({ type: 'session', cwd }),
      JSON.stringify({ type: 'model_change', provider: 'coding4', modelId: 'qwen3.8:27b' }),
      JSON.stringify({ type: 'model_change', provider: 'openrouter', modelId }),
    ].join('\n'));
  };

  it('corrects a wrong declaration from the session log', () => {
    session('/work/proj', 'deepseek/deepseek-v4.1-flash');
    const r = resolveModelForReport('qwen3.8:27b', { cwd: '/work/proj', home });
    expect(r.model).toBe('deepseek/deepseek-v4.1-flash');
    expect(r.warning).toBeDefined();
  });

  it('honours --no-detect-model by skipping detection entirely', () => {
    // The opt-out has to stop the DETECTION, not just the override: reading a
    // session log is the part someone might want off.
    session('/work/proj', 'deepseek/deepseek-v4.1-flash');
    const r = resolveModelForReport('qwen3.8:27b', { cwd: '/work/proj', home, detect: false });
    expect(r.model).toBe('qwen3.8:27b');
    expect(r.warning).toBeUndefined();
  });

  it('leaves the declaration alone outside a known harness', () => {
    const r = resolveModelForReport('some-model', { cwd: '/work/proj', home });
    expect(r.model).toBe('some-model');
    expect(r.warning).toBeUndefined();
  });
});

describe('detectHarnessModel — safety of the claude-code matcher', () => {
  const claude = (cwd: string, records: any[]) => {
    // The directory name replaces '/' with '-' and is therefore lossy. The
    // records carry the real cwd, which is what must be matched on.
    const dir = path.join(home, '.claude', 'projects', cwd.replace(/\//g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sess.jsonl'), records.map(r => JSON.stringify(r)).join('\n') + '\n');
  };

  it('does not treat a SIBLING directory as a descendant', () => {
    // '-' flattened to '/' made /work/proj-2 look like a child of /work/proj,
    // so a different repo's session overrode the declared model.
    claude('/work/proj', [{ type: 'assistant', cwd: '/work/proj', message: { model: 'claude-sonnet-5' } }]);
    expect(detectHarnessModel({ cwd: '/work/proj-2', home })).toBeNull();
  });

  it('does not confuse /work/my-proj with /work/my/proj', () => {
    claude('/work/my/proj', [{ type: 'assistant', cwd: '/work/my/proj', message: { model: 'claude-opus-5' } }]);
    expect(detectHarnessModel({ cwd: '/work/my-proj', home })).toBeNull();
  });

  it('does not let a home-directory session answer for every repo under it', () => {
    claude('/Users/d', [{ type: 'assistant', cwd: '/Users/d', message: { model: 'stale' } }]);
    // An ancestor match is legitimate for a repo subdirectory, but the home
    // directory is an ancestor of everything the user owns.
    expect(detectHarnessModel({ cwd: '/Users/d/some/brand/new/repo', home })).toBeNull();
  });

  it('ignores a <synthetic> sentinel and reports the last REAL model', () => {
    // Claude Code writes model "<synthetic>" on cancelled/error turns; 10 of
    // 174 real transcripts on this machine end on one. Taking it would replace
    // a correct --model with a non-model string on an append-only event.
    claude('/work/proj', [
      { type: 'assistant', cwd: '/work/proj', message: { model: 'claude-opus-5' } },
      { type: 'assistant', cwd: '/work/proj', message: { model: '<synthetic>' } },
    ]);
    expect(detectHarnessModel({ cwd: '/work/proj', home })!.model).toBe('claude-opus-5');
  });

  it('returns null rather than a sentinel when there is no real model at all', () => {
    claude('/work/proj', [{ type: 'assistant', cwd: '/work/proj', message: { model: '<synthetic>' } }]);
    expect(detectHarnessModel({ cwd: '/work/proj', home })).toBeNull();
  });

  it('ignores a subagent turn, which runs a different model from the session', () => {
    claude('/work/proj', [
      { type: 'assistant', cwd: '/work/proj', message: { model: 'claude-opus-5' } },
      { type: 'assistant', cwd: '/work/proj', isSidechain: true, message: { model: 'claude-haiku-4-5' } },
    ]);
    expect(detectHarnessModel({ cwd: '/work/proj', home })!.model).toBe('claude-opus-5');
  });
});

describe('detectHarnessModel — path shapes', () => {
  it('matches despite a trailing slash on either side', () => {
    piSession('/work/f/', [{ provider: 'p', modelId: 'm' }]);
    expect(detectHarnessModel({ cwd: '/work/f', home })!.model).toBe('m');
  });

  it('matches a relative or unnormalised cwd', () => {
    piSession('/work/f', [{ provider: 'p', modelId: 'm' }]);
    expect(detectHarnessModel({ cwd: '/work/g/../f', home })!.model).toBe('m');
  });
});

describe('reconcileModel — harness disagreement', () => {
  it('will not rewrite the model when the harness does not match', () => {
    // A stale pi log in the directory must not relabel a codex run's model,
    // which would write an internally incoherent {model, harness} pair.
    const detected = { model: 'qwen3.8:27b', harness: 'pi', source: '/s.jsonl' };
    const r = reconcileModel('gpt-5.2', detected, 'codex');
    expect(r.model).toBe('gpt-5.2');
    expect(r.warning).toMatch(/codex/);
    expect(r.warning).toMatch(/pi/);
  });

  it('still corrects within the same harness', () => {
    const detected = { model: 'deepseek/deepseek-v4.1-flash', harness: 'pi', source: '/s.jsonl' };
    expect(reconcileModel('qwen3.8:27b', detected, 'pi').model).toBe('deepseek/deepseek-v4.1-flash');
  });

  it('corrects when the caller declares no harness', () => {
    const detected = { model: 'x', harness: 'pi', source: '/s.jsonl' };
    expect(reconcileModel('y', detected).model).toBe('x');
  });
});
