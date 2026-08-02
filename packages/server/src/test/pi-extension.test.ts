import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Importing the native pi extension. Pure helpers + the activate() default export
// are exercised directly with a fake pi/ctx so no pi runtime is required.
// @ts-ignore — .ts extension is loaded by pi via jiti; here we import it directly.
import activate, {
  composeReminder,
  injectDeterministicModel,
  resolveModelId,
  readPiDefaultModel,
  readPiArgvModel,
  readPiSessionModel,
  piSessionDirName,
  memoizeResolved,
} from '../../../../bin/agenfk-pi-extension.ts';

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe('composeReminder', () => {
  const base = 'You just opened a PR. Reply by calling register_pr(...). harness = "pi".';

  it('injects the deterministic model id when known', () => {
    const out = composeReminder(base, 'zhipu/glm-5.2');
    expect(out).toContain(base);
    expect(out).toMatch(/--model\s+zhipu\/glm-5\.2/);
    expect(out).toContain('--harness pi');
  });

  it('degrades gracefully when the model is unknown', () => {
    const out = composeReminder(base, null);
    expect(out).toContain(base);
    expect(out).not.toMatch(/--model\s+null/);
  });
});

describe('injectDeterministicModel (force the real model onto agenfk pr commands)', () => {
  const M = 'cloudflare-workers-ai/@cf/zai-org/glm-5.2';

  it('overrides an agent-guessed --model on `agenfk pr create` (last-wins)', () => {
    const out = injectDeterministicModel(
      'agenfk pr create abc123 --model claude-sonnet-4-5 --harness pi --title "T" --body "B"', M,
    );
    // The real model is appended LAST so commander last-wins picks it.
    expect(out).toMatch(/--model claude-sonnet-4-5 --harness pi --title "T" --body "B" --model cloudflare-workers-ai\/@cf\/zai-org\/glm-5\.2 --harness pi$/);
  });

  it('adds --model/--harness when the agent omitted them', () => {
    const out = injectDeterministicModel('agenfk pr create abc123 --title "T"', M);
    expect(out).toBe('agenfk pr create abc123 --title "T" --model cloudflare-workers-ai/@cf/zai-org/glm-5.2 --harness pi');
  });

  it('handles pr-register and pr-resize', () => {
    expect(injectDeterministicModel('agenfk pr-register --item x --number 5 --repo o/r --epic 0 --story 0 --task 1 --bug 0', M))
      .toMatch(/--bug 0 --model \S+ --harness pi$/);
    expect(injectDeterministicModel('agenfk pr-resize --number 5 --repo o/r --epic 0 --story 0 --task 2 --bug 0', M))
      .toMatch(/--bug 0 --model \S+ --harness pi$/);
  });

  it('inserts before a trailing shell pipe/redirect, not after it', () => {
    const out = injectDeterministicModel('agenfk pr create abc --model x --harness pi 2>&1 | head -40', M);
    expect(out).toBe('agenfk pr create abc --model x --harness pi --model cloudflare-workers-ai/@cf/zai-org/glm-5.2 --harness pi 2>&1 | head -40');
  });

  it('does not corrupt a --body that literally contains "--model"', () => {
    const cmd = 'agenfk pr create abc --title "T" --body "see --model docs"';
    const out = injectDeterministicModel(cmd, M);
    // The body text is untouched; the injected flags are appended after it.
    expect(out).toBe('agenfk pr create abc --title "T" --body "see --model docs" --model cloudflare-workers-ai/@cf/zai-org/glm-5.2 --harness pi');
  });

  it('does not split a --body containing an escaped quote then a shell metachar', () => {
    const cmd = 'agenfk pr create abc --body "a \\" ; rm -rf"';
    const out = injectDeterministicModel(cmd, M);
    // The escaped quote keeps us inside the body, so the `;` is NOT treated as a
    // top-level operator — flags append cleanly after the closing quote.
    expect(out).toBe('agenfk pr create abc --body "a \\" ; rm -rf" --model cloudflare-workers-ai/@cf/zai-org/glm-5.2 --harness pi');
  });

  it('does not treat a literal ;/| inside a quoted --body as an operator', () => {
    const cmd = 'agenfk pr create abc --body "first; then | also"';
    const out = injectDeterministicModel(cmd, M);
    expect(out).toBe('agenfk pr create abc --body "first; then | also" --model cloudflare-workers-ai/@cf/zai-org/glm-5.2 --harness pi');
  });

  it('refuses to inject a model that is not a clean id token (shell-injection guard)', () => {
    const cmd = 'agenfk pr create abc --model x --harness pi';
    // settings.json defaultModel is free-form; anything outside the id allowlist
    // (incl. shell metacharacters) must be rejected so it can't reach the shell.
    for (const bad of ['has space', 'has"quote', "has'quote", 'glm;rm -rf', 'glm$(whoami)',
      'glm`whoami`', 'glm&&echo', 'glm|cat', 'glm>/etc/x', 'a()b']) {
      expect(injectDeterministicModel(cmd, bad)).toBe(cmd);
    }
  });

  it('accepts legitimate model ids', () => {
    const cmd = 'agenfk pr create abc --title "T"';
    expect(injectDeterministicModel(cmd, '@cf/zai-org/glm-5.2')).toContain('--model @cf/zai-org/glm-5.2 --harness pi');
    expect(injectDeterministicModel(cmd, 'claude-opus-4-8')).toContain('--model claude-opus-4-8 --harness pi');
  });

  it('leaves non-PR / non-agenfk commands untouched', () => {
    expect(injectDeterministicModel('npm test', M)).toBe('npm test');
    expect(injectDeterministicModel('agenfk list --json', M)).toBe('agenfk list --json');
    expect(injectDeterministicModel('echo agenfk pr create', M)).toBe('echo agenfk pr create');
  });

  it('no-ops when the model is unknown (null/empty)', () => {
    const cmd = 'agenfk pr create abc --model x --harness pi';
    expect(injectDeterministicModel(cmd, null)).toBe(cmd);
    expect(injectDeterministicModel(cmd, '')).toBe(cmd);
  });
});

describe('resolveModelId (bare id; getModel → lastSelected → settings.json)', () => {
  it('prefers the live ctx.getModel().id (bare, not provider/id)', () => {
    const ctx = { getModel: () => ({ provider: 'cloudflare-workers-ai', id: '@cf/zai-org/glm-5.2' }) };
    expect(resolveModelId(ctx as any, 'cached', () => 'fromfile')).toBe('@cf/zai-org/glm-5.2');
  });

  it('falls back to the cached model_select id when getModel is unavailable', () => {
    expect(resolveModelId({} as any, 'glm-5.2', () => 'fromfile')).toBe('glm-5.2');
  });

  it('falls back to settings.json defaultModel when neither getModel nor cache is available', () => {
    expect(resolveModelId({} as any, null, () => '@cf/zai-org/glm-5.2')).toBe('@cf/zai-org/glm-5.2');
  });

  it('returns null when no source yields a model', () => {
    expect(resolveModelId({} as any, null, () => null)).toBeNull();
  });
});

describe('readPiDefaultModel (parse ~/.pi/agent/settings.json)', () => {
  it('returns the defaultModel id', () => {
    expect(readPiDefaultModel(() => JSON.stringify({ defaultModel: '@cf/zai-org/glm-5.2' }))).toBe('@cf/zai-org/glm-5.2');
  });
  it('returns null when defaultModel is absent or JSON is bad', () => {
    expect(readPiDefaultModel(() => JSON.stringify({ other: 1 }))).toBeNull();
    expect(readPiDefaultModel(() => 'not json')).toBeNull();
    expect(readPiDefaultModel(() => { throw new Error('ENOENT'); })).toBeNull();
  });
});

describe('readPiArgvModel (the session\'s own `--model` flag)', () => {
  it('reads the space-separated `--model <id>` form', () => {
    expect(readPiArgvModel(['node', 'pi', '-p', '-a', '--provider', 'amazon-bedrock',
      '--model', 'us.anthropic.claude-opus-5', '@prompt.md'])).toBe('us.anthropic.claude-opus-5');
  });

  it('reads the `--model=<id>` form', () => {
    expect(readPiArgvModel(['node', 'pi', '--model=us.anthropic.claude-sonnet-5'])).toBe('us.anthropic.claude-sonnet-5');
  });

  it('takes the last occurrence (shell last-wins)', () => {
    expect(readPiArgvModel(['pi', '--model', 'a', '--model', 'b'])).toBe('b');
  });

  it('returns null when --model is absent', () => {
    expect(readPiArgvModel(['node', 'pi', '-p', '-a', '@prompt.md'])).toBeNull();
  });

  it('returns null for a dangling --model with no value, or a value that is another flag', () => {
    expect(readPiArgvModel(['pi', '--model'])).toBeNull();
    expect(readPiArgvModel(['pi', '--model', '--provider'])).toBeNull();
  });

  it('ignores a --model that belongs to some other embedded command string', () => {
    // Only a standalone argv token counts; text mentioning --model must not match.
    expect(readPiArgvModel(['pi', '@prompt', 'pass --model foo when registering'])).toBeNull();
  });
});

describe('piSessionDirName (pi\'s cwd -> sessions subdirectory slug)', () => {
  it('slugs a plain repo path the way pi does', () => {
    expect(piSessionDirName('/Users/daniel/agenfk/agenfk')).toBe('--Users-daniel-agenfk-agenfk--');
  });

  it('slugs a nested worktree path the way pi does', () => {
    expect(piSessionDirName('/private/tmp/claude-502/-Users-daniel-agenfk-agenfk-f9a195c5/scratchpad/bench-wt-qwen'))
      .toBe('--private-tmp-claude-502--Users-daniel-agenfk-agenfk-f9a195c5-scratchpad-bench-wt-qwen--');
  });
});

describe('readPiSessionModel (the live session JSONL model_change record)', () => {
  /** Build a fake ~/.pi/agent/sessions/<slug>/ tree and return its home dir. */
  function makeHome(cwd: string, files: Array<{ name: string; lines: string[]; mtime?: number }>): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sess-'));
    const dir = path.join(home, '.pi', 'agent', 'sessions', piSessionDirName(cwd));
    fs.mkdirSync(dir, { recursive: true });
    for (const f of files) {
      const p = path.join(dir, f.name);
      fs.writeFileSync(p, f.lines.join('\n'));
      if (f.mtime) fs.utimesSync(p, new Date(f.mtime), new Date(f.mtime));
    }
    return home;
  }

  const sessionLine = (cwd: string, id: string) =>
    JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-08-01T23:05:31.107Z', cwd });
  const modelLine = (modelId: string, provider = 'amazon-bedrock') =>
    JSON.stringify({ type: 'model_change', id: 'e05df1bc', parentId: null, provider, modelId });

  it('returns the model_change modelId written at session start', () => {
    const cwd = '/repo/proj';
    const home = makeHome(cwd, [{
      name: '2026-08-01T23-05-31-107Z_opus5-run.jsonl',
      lines: [sessionLine(cwd, 'opus5-run'), modelLine('us.anthropic.claude-opus-5'), JSON.stringify({ type: 'message' })],
    }]);
    expect(readPiSessionModel({ cwd, home })).toBe('us.anthropic.claude-opus-5');
  });

  it('uses the LAST model_change so a mid-session switch wins', () => {
    const cwd = '/repo/proj';
    const home = makeHome(cwd, [{
      name: 'a_run.jsonl',
      lines: [sessionLine(cwd, 'run'), modelLine('model-one'), modelLine('model-two')],
    }]);
    expect(readPiSessionModel({ cwd, home })).toBe('model-two');
  });

  it('prefers the most recently modified session file when several share a cwd', () => {
    const cwd = '/repo/proj';
    const home = makeHome(cwd, [
      { name: 'old_run.jsonl', lines: [sessionLine(cwd, 'old'), modelLine('stale-model')], mtime: Date.parse('2026-07-01T00:00:00Z') },
      { name: 'new_run.jsonl', lines: [sessionLine(cwd, 'new'), modelLine('current-model')], mtime: Date.parse('2026-08-01T00:00:00Z') },
    ]);
    expect(readPiSessionModel({ cwd, home })).toBe('current-model');
  });

  it('ignores a session file recorded for a different cwd', () => {
    const cwd = '/repo/proj';
    const home = makeHome(cwd, [{
      name: 'a_run.jsonl',
      lines: [sessionLine('/somewhere/else', 'run'), modelLine('wrong-cwd-model')],
    }]);
    expect(readPiSessionModel({ cwd, home })).toBeNull();
  });

  it('tolerates a partial trailing line (pi is still appending)', () => {
    const cwd = '/repo/proj';
    const home = makeHome(cwd, [{
      name: 'a_run.jsonl',
      lines: [sessionLine(cwd, 'run'), modelLine('good-model'), '{"type":"messa'],
    }]);
    expect(readPiSessionModel({ cwd, home })).toBe('good-model');
  });

  it('returns null when the sessions dir, the file, or a model_change is missing', () => {
    expect(readPiSessionModel({ cwd: '/repo/proj', home: fs.mkdtempSync(path.join(os.tmpdir(), 'pi-empty-')) })).toBeNull();
    const cwd = '/repo/proj';
    const noModel = makeHome(cwd, [{ name: 'a_run.jsonl', lines: [sessionLine(cwd, 'run'), JSON.stringify({ type: 'message' })] }]);
    expect(readPiSessionModel({ cwd, home: noModel })).toBeNull();
    const empty = makeHome(cwd, []);
    expect(readPiSessionModel({ cwd, home: empty })).toBeNull();
  });

  it('never throws on an unreadable home', () => {
    expect(() => readPiSessionModel({ cwd: '/x', home: '/nonexistent-home-xyz' })).not.toThrow();
    expect(readPiSessionModel({ cwd: '/x', home: '/nonexistent-home-xyz' })).toBeNull();
  });
});

describe('memoizeResolved (read the multi-MB session JSONL at most once)', () => {
  it('reads once and reuses the resolved value', () => {
    const read = vi.fn().mockReturnValue('model-x');
    const memo = memoizeResolved(read);
    expect(memo()).toBe('model-x');
    expect(memo()).toBe('model-x');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('retries while unresolved, so an early miss does not poison the session', () => {
    // pi has not written the session file yet on the first call.
    const read = vi.fn().mockReturnValueOnce(null).mockReturnValueOnce(null).mockReturnValue('model-x');
    const memo = memoizeResolved(read);
    expect(memo()).toBeNull();
    expect(memo()).toBeNull();
    expect(memo()).toBe('model-x');
    expect(memo()).toBe('model-x');
    expect(read).toHaveBeenCalledTimes(3); // stopped reading once resolved
  });
});

describe('resolveModelId precedence: session sources outrank settings.json', () => {
  const settings = () => 'deepseek/deepseek-v4-flash-0731'; // the stale settings.json default

  it('prefers the session argv --model over settings.json defaultModel', () => {
    expect(resolveModelId({} as any, null, settings, {
      argvModel: () => 'us.anthropic.claude-sonnet-5',
      sessionModel: () => 'from-jsonl',
    })).toBe('us.anthropic.claude-sonnet-5');
  });

  it('falls back to the session JSONL model_change when argv carries no --model', () => {
    expect(resolveModelId({} as any, null, settings, {
      argvModel: () => null,
      sessionModel: () => 'us.anthropic.claude-opus-5',
    })).toBe('us.anthropic.claude-opus-5');
  });

  it('still falls back to settings.json when no session source resolves', () => {
    expect(resolveModelId({} as any, null, settings, { argvModel: () => null, sessionModel: () => null }))
      .toBe('deepseek/deepseek-v4-flash-0731');
  });

  it('lets an interactive model_select switch outrank the launch --model', () => {
    expect(resolveModelId({} as any, 'switched-to', settings, {
      argvModel: () => 'launched-with',
      sessionModel: () => 'from-jsonl',
    })).toBe('switched-to');
  });

  it('keeps ctx.getModel() at the top of the chain', () => {
    const ctx = { getModel: () => ({ provider: 'p', id: 'live-model' }) };
    expect(resolveModelId(ctx as any, 'switched-to', settings, {
      argvModel: () => 'launched-with',
      sessionModel: () => 'from-jsonl',
    })).toBe('live-model');
  });
});

// ── Native activate() behavior with a fake pi/ctx ────────────────────────────

/** Build a fake pi that records handlers and spies sendMessage. */
function makeFakePi() {
  const handlers: Record<string, Function> = {};
  const sent: any[] = [];
  const pi = {
    on: (event: string, handler: Function) => { handlers[event] = handler; },
    sendMessage: (message: any, options: any) => { sent.push({ message, options }); },
  };
  const fire = (event: string, payload: any, ctx: any = {}) =>
    handlers[event] ? handlers[event](payload, ctx) : undefined;
  return { pi, handlers, sent, fire };
}

/** Fake decision deps so no child process / server is touched. */
function makeDeps(overrides: any = {}) {
  return {
    gatekeeperVerdict: vi.fn().mockReturnValue(null),
    enforcerVerdict: vi.fn().mockReturnValue(null),
    prReminder: vi.fn().mockReturnValue(null),
    // Stubbed so activate() tests never read the real ~/.pi/agent/settings.json.
    readDefaultModel: () => null,
    ...overrides,
  };
}

/** Fake ctx exposing the live model via getModel(). */
const ctxWithModel = (provider: string, id: string) => ({ getModel: () => ({ provider, id }) });

describe('activate(): PR-open reminder via tool_result', () => {
  it('sends a steer message with ctx.getModel() injected when bash opens a PR', async () => {
    const { pi, sent, fire } = makeFakePi();
    const deps = makeDeps({
      prReminder: vi.fn().mockReturnValue({ message: 'You just opened a PR. harness = "pi".' }),
    });
    activate(pi as any, deps);

    await fire(
      'tool_result',
      { toolName: 'bash', input: { command: 'gh pr create --fill' } },
      ctxWithModel('anthropic', 'claude-opus-4-8'),
    );

    expect(deps.prReminder).toHaveBeenCalledWith('gh pr create --fill');
    expect(sent).toHaveLength(1);
    expect(sent[0].options.deliverAs).toBe('steer');
    expect(sent[0].message.customType).toBe('agenfk-pr');
    // Bare model id (not provider/id) — matches settings.json + claude-code convention.
    expect(sent[0].message.content).toContain('claude-opus-4-8');
    expect(sent[0].message.content).not.toContain('anthropic/claude-opus-4-8');
  });

  it('falls back to the cached model_select model when ctx.getModel() is unavailable', async () => {
    const { pi, sent, fire } = makeFakePi();
    const deps = makeDeps({ prReminder: vi.fn().mockReturnValue({ message: 'open. harness = "pi".' }) });
    activate(pi as any, deps);

    fire('model_select', { model: { provider: 'zhipu', id: 'glm-5.2' } });
    await fire('tool_result', { toolName: 'bash', input: { command: 'gh pr create' } }, {}); // no getModel
    expect(sent[0].message.content).toContain('glm-5.2');
  });

  it('falls back to ~/.pi/agent/settings.json defaultModel when getModel + model_select are both unavailable', async () => {
    const { pi, sent, fire } = makeFakePi();
    const deps = makeDeps({
      prReminder: vi.fn().mockReturnValue({ message: 'open. harness = "pi".' }),
      readDefaultModel: () => '@cf/zai-org/glm-5.2', // the live-pi reality: model only known from config
    });
    activate(pi as any, deps);

    await fire('tool_result', { toolName: 'bash', input: { command: 'gh pr create' } }, {}); // no getModel, no model_select
    expect(sent[0].message.content).toContain('@cf/zai-org/glm-5.2');
  });

  it('still reminds (without a model line) when no model can be resolved', async () => {
    const { pi, sent, fire } = makeFakePi();
    const deps = makeDeps({ prReminder: vi.fn().mockReturnValue({ message: 'open it' }) });
    activate(pi as any, deps);
    await fire('tool_result', { toolName: 'bash', input: { command: 'gh pr create' } }, {});
    expect(sent).toHaveLength(1);
    expect(sent[0].message.content).toContain('open it');
    expect(sent[0].message.content).not.toMatch(/--model\s+null/);
  });

  it('does not send when the tool is not bash', async () => {
    const { pi, sent, fire } = makeFakePi();
    const deps = makeDeps({ prReminder: vi.fn().mockReturnValue({ message: 'x' }) });
    activate(pi as any, deps);
    await fire('tool_result', { toolName: 'edit', input: { path: 'a.ts' } }, ctxWithModel('a', 'b'));
    expect(deps.prReminder).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('does not send when the command is not a PR trigger', async () => {
    const { pi, sent, fire } = makeFakePi();
    const deps = makeDeps({ prReminder: vi.fn().mockReturnValue(null) });
    activate(pi as any, deps);
    await fire('tool_result', { toolName: 'bash', input: { command: 'ls -la' } }, ctxWithModel('a', 'b'));
    expect(sent).toHaveLength(0);
  });
});

describe('activate(): session_start load-confirmation notify', () => {
  /** ctx with both a notify spy and getModel(). */
  const ctxWithUi = (provider?: string, id?: string) => {
    const notify = vi.fn();
    const ctx: any = { ui: { notify } };
    if (id) ctx.getModel = () => ({ provider, id });
    return { ctx, notify };
  };

  it('notifies on session_start so the extension proves it loaded + fired on pi', async () => {
    const { pi, fire } = makeFakePi();
    activate(pi as any, makeDeps());
    const { ctx, notify } = ctxWithUi('zhipu', 'glm-5.2');

    await fire('session_start', { type: 'session_start', reason: 'startup' }, ctx);

    expect(notify).toHaveBeenCalledTimes(1);
    const [msg, level] = notify.mock.calls[0];
    expect(msg).toContain('agenfk');
    expect(msg).toContain('glm-5.2');
    expect(msg).not.toContain('zhipu/glm-5.2'); // bare id, not provider/id
    expect(level).toBe('info');
  });

  it('still notifies (without a model) when getModel() is unavailable', async () => {
    const { pi, fire } = makeFakePi();
    activate(pi as any, makeDeps());
    const { ctx, notify } = ctxWithUi(); // no getModel

    await fire('session_start', { type: 'session_start', reason: 'startup' }, ctx);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain('agenfk');
  });

  it('never throws when ctx.ui is missing (cannot break the host)', async () => {
    const { pi, fire } = makeFakePi();
    activate(pi as any, makeDeps());
    await expect(
      Promise.resolve(fire('session_start', { type: 'session_start', reason: 'startup' }, {})),
    ).resolves.not.toThrow();
  });
});

describe('activate(): gatekeeper enforcement via tool_call', () => {
  it('blocks edit when no task is active', async () => {
    const { pi, fire } = makeFakePi();
    const deps = makeDeps({
      gatekeeperVerdict: vi.fn().mockReturnValue({ decision: 'block', reason: 'WORKFLOW VIOLATION' }),
    });
    activate(pi as any, deps);
    const res = await fire('tool_call', { toolName: 'edit', input: { path: '/repo/src/a.ts' } });
    expect(deps.gatekeeperVerdict).toHaveBeenCalledWith('/repo/src/a.ts');
    expect(res).toEqual({ block: true, reason: 'WORKFLOW VIOLATION' });
  });

  it('blocks write when no task is active', async () => {
    const { pi, fire } = makeFakePi();
    const deps = makeDeps({
      gatekeeperVerdict: vi.fn().mockReturnValue({ decision: 'block', reason: 'nope' }),
    });
    activate(pi as any, deps);
    const res = await fire('tool_call', { toolName: 'write', input: { path: '/repo/x.ts' } });
    expect(res).toEqual({ block: true, reason: 'nope' });
  });

  it('allows edit when a task is active (no verdict)', async () => {
    const { pi, fire } = makeFakePi();
    const deps = makeDeps();
    activate(pi as any, deps);
    const res = await fire('tool_call', { toolName: 'edit', input: { path: '/repo/a.ts' } });
    expect(res).toBeFalsy();
  });
});

describe('activate(): deterministic model injection on agenfk pr commands', () => {
  it('rewrites event.input.command to force the real ctx.getModel() on `agenfk pr create`', async () => {
    const { pi, fire } = makeFakePi();
    activate(pi as any, makeDeps());
    const event: any = { toolName: 'bash', input: { command: 'agenfk pr create abc --model claude-sonnet-4-5 --harness pi --title "T"' } };
    await fire('tool_call', event, ctxWithModel('cloudflare-workers-ai', '@cf/zai-org/glm-5.2'));
    // Bare model id appended last (overrides the agent's guess), not provider/id.
    expect(event.input.command).toMatch(/--model @cf\/zai-org\/glm-5\.2 --harness pi$/);
    expect(event.input.command).not.toContain('cloudflare-workers-ai/@cf');
  });

  it('leaves an ordinary bash command unchanged', async () => {
    const { pi, fire } = makeFakePi();
    activate(pi as any, makeDeps());
    const event: any = { toolName: 'bash', input: { command: 'npm test' } };
    await fire('tool_call', event, ctxWithModel('a', 'b'));
    expect(event.input.command).toBe('npm test');
  });

  // Regression: a session launched as `pi --model us.anthropic.claude-sonnet-5`
  // while ~/.pi/agent/settings.json still said deepseek registered PRs #135/#136
  // against deepseek. The session's own model must win over the config default.
  it('injects the session --model, not the stale settings.json defaultModel', async () => {
    const { pi, fire } = makeFakePi();
    activate(pi as any, makeDeps({
      readDefaultModel: () => 'deepseek/deepseek-v4-flash-0731',
      readArgvModel: () => 'us.anthropic.claude-sonnet-5',
    }));
    const event: any = { toolName: 'bash', input: { command: 'agenfk pr create abc --title "T"' } };
    await fire('tool_call', event, {}); // live pi: no getModel(), no model_select
    expect(event.input.command).toContain('--model us.anthropic.claude-sonnet-5');
    expect(event.input.command).not.toContain('deepseek');
  });

  // pi's /model (setModel) and the model-cycle shortcut both emit model_select
  // before any later tool_call, so an interactive switch must beat the launch --model.
  it('follows an interactive /model switch away from the launch --model', async () => {
    const { pi, fire } = makeFakePi();
    activate(pi as any, makeDeps({
      readDefaultModel: () => 'deepseek/deepseek-v4-flash-0731',
      readArgvModel: () => 'us.anthropic.claude-sonnet-5', // launched with this
      readSessionModel: () => 'us.anthropic.claude-sonnet-5',
    }));

    const before: any = { toolName: 'bash', input: { command: 'agenfk pr create abc' } };
    await fire('tool_call', before, {});
    expect(before.input.command).toContain('--model us.anthropic.claude-sonnet-5');

    fire('model_select', { model: { provider: 'amazon-bedrock', id: 'us.anthropic.claude-opus-5' } });

    const after: any = { toolName: 'bash', input: { command: 'agenfk pr create abc' } };
    await fire('tool_call', after, {});
    expect(after.input.command).toContain('--model us.anthropic.claude-opus-5');
    expect(after.input.command).not.toContain('sonnet');
  });

  it('injects the session JSONL model when the launch carried no --model', async () => {
    const { pi, fire } = makeFakePi();
    activate(pi as any, makeDeps({
      readDefaultModel: () => 'deepseek/deepseek-v4-flash-0731',
      readArgvModel: () => null,
      readSessionModel: () => 'us.anthropic.claude-opus-5',
    }));
    const event: any = { toolName: 'bash', input: { command: 'agenfk pr-resize --number 5 --repo o/r --epic 0 --story 0 --task 1 --bug 0' } };
    await fire('tool_call', event, {});
    expect(event.input.command).toContain('--model us.anthropic.claude-opus-5');
    expect(event.input.command).not.toContain('deepseek');
  });
});

describe('activate(): PR reminder carries the session model, not settings.json', () => {
  it('tells the agent the session --model rather than the config default', async () => {
    const { pi, sent, fire } = makeFakePi();
    activate(pi as any, makeDeps({
      prReminder: vi.fn().mockReturnValue({ message: 'You just opened a PR.' }),
      readDefaultModel: () => 'deepseek/deepseek-v4-flash-0731',
      readArgvModel: () => 'us.anthropic.claude-sonnet-5',
    }));
    await fire('tool_result', { toolName: 'bash', input: { command: 'gh pr create --fill' } }, {});
    expect(sent[0].message.content).toContain('us.anthropic.claude-sonnet-5');
    expect(sent[0].message.content).not.toContain('deepseek');
  });
});

describe('activate(): mcp-enforcer via tool_call bash', () => {
  it('blocks a forbidden bash command (direct DB / curl)', async () => {
    const { pi, fire } = makeFakePi();
    const deps = makeDeps({
      enforcerVerdict: vi.fn().mockReturnValue({ decision: 'block', reason: 'forbidden' }),
    });
    activate(pi as any, deps);
    const res = await fire('tool_call', { toolName: 'bash', input: { command: 'cat .agenfk/db.sqlite' } });
    expect(deps.enforcerVerdict).toHaveBeenCalledWith('cat .agenfk/db.sqlite');
    expect(res).toEqual({ block: true, reason: 'forbidden' });
  });

  it('allows an ordinary bash command', async () => {
    const { pi, fire } = makeFakePi();
    const deps = makeDeps();
    activate(pi as any, deps);
    const res = await fire('tool_call', { toolName: 'bash', input: { command: 'npm test' } });
    expect(res).toBeFalsy();
  });
});

// ── buildDirective gains an explicit 'pi' case ───────────────────────────────

describe("buildDirective 'pi' case", () => {
  it('returns a message-shaped directive the pi extension consumes', async () => {
    // @ts-ignore — .mjs has no .d.ts
    const { buildDirective } = await import('../../../../bin/agenfk-pr-hook.mjs');
    expect(buildDirective('pi', 'hello')).toEqual({ message: 'hello' });
  });
});
