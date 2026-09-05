import { describe, it, expect, vi } from 'vitest';
// Importing the native pi extension. Pure helpers + the activate() default export
// are exercised directly with a fake pi/ctx so no pi runtime is required.
// @ts-ignore — .ts extension is loaded by pi via jiti; here we import it directly.
import activate, {
  composeReminder,
  injectDeterministicModel,
  readPiDefaultModel,
  readPiSessionModel,
  envModel,
  resolveModelSource,
  preferredModelArg,
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

describe('resolveModelSource (env → ctx → model_select → transcript → settings.json)', () => {
  const src = (o: any) => resolveModelSource({ env: () => null, ...o });

  it('qualifies the live ctx.getModel() with its provider', () => {
    // A bare id is ambiguous: settings.json splits model across defaultProvider +
    // defaultModel, and the hub strips the route prefix when it matches (modelMeta).
    const ctx = { getModel: () => ({ provider: 'cloudflare-workers-ai', id: '@cf/zai-org/glm-5.2' }) };
    expect(src({ ctx, lastSelected: 'cached', readDefault: () => 'fromfile' })).toBe('cloudflare-workers-ai/@cf/zai-org/glm-5.2');
  });

  it('returns a bare id when the source knows no provider', () => {
    const ctx = { getModel: () => ({ id: 'glm-5.2' }) };
    expect(src({ ctx, lastSelected: null, readDefault: () => null })).toBe('glm-5.2');
  });

  it('falls back to the cached model_select id when getModel is unavailable', () => {
    expect(src({ ctx: {}, lastSelected: 'glm-5.2', readDefault: () => 'fromfile' })).toBe('glm-5.2');
  });

  it('falls back to settings.json defaultModel when nothing fresher is available', () => {
    expect(src({ ctx: {}, lastSelected: null, readDefault: () => '@cf/zai-org/glm-5.2', readTranscript: () => null })).toBe('@cf/zai-org/glm-5.2');
  });

  it('returns null when no source yields a model', () => {
    expect(src({ ctx: {}, lastSelected: null, readDefault: () => null })).toBeNull();
  });

  // BUG: settings.json defaultModel is pi's STARTUP model read WITHOUT its
  // defaultProvider, so it is not the live model. It must rank BELOW the
  // transcript, which records the model that actually answered each turn.
  it('ranks the live transcript ABOVE the settings.json defaultModel', () => {
    expect(src({ ctx: {}, lastSelected: null, readDefault: () => 'qwen3.8:27b', readTranscript: () => 'qwen38-flashnext' })).toBe('qwen38-flashnext');
  });

  it('ranks the model_select cache above the transcript (a switch beats the last turn)', () => {
    expect(src({ ctx: {}, lastSelected: 'glm-5.2', readDefault: () => 'qwen3.8:27b', readTranscript: () => 'qwen38-flashnext' })).toBe('glm-5.2');
  });

  it('uses the transcript when ctx.getModel and model_select are both unavailable', () => {
    expect(src({ ctx: {}, lastSelected: null, readDefault: () => null, readTranscript: () => 'qwen38-flashnext' })).toBe('qwen38-flashnext');
  });

  it('still prefers the live ctx.getModel() over every fallback', () => {
    const ctx = { getModel: () => ({ provider: 'p', id: 'live' }) };
    expect(src({ ctx, lastSelected: 'cached', readDefault: () => 'default', readTranscript: () => 'transcript' })).toBe('p/live');
  });
});

// ── Authoritative sources the bug ignored ───────────────────────────────────

describe('envModel (pi publishes the live model to every bash command)', () => {
  // pi sets PI_PROVIDER/PI_MODEL per command from ctx.model and re-resolves them
  // on a model switch (dist/core/tools/bash.js), so this is the freshest source.
  it('joins PI_PROVIDER/PI_MODEL as provider/model', () => {
    expect(envModel({ PI_PROVIDER: 'coding4', PI_MODEL: 'qwen3.8:27b' })).toBe('coding4/qwen3.8:27b');
  });

  it('returns the bare id when only PI_MODEL is set', () => {
    expect(envModel({ PI_MODEL: 'qwen38-flashnext' })).toBe('qwen38-flashnext');
  });

  it('returns the bare id when PI_PROVIDER is blank', () => {
    expect(envModel({ PI_PROVIDER: '   ', PI_MODEL: 'glm-5.2' })).toBe('glm-5.2');
  });

  it('returns null when neither is set (non-pi shell / ephemeral session)', () => {
    expect(envModel({})).toBeNull();
    expect(envModel({ PI_PROVIDER: 'coding4' })).toBeNull();
    expect(envModel(undefined)).toBeNull();
  });

  it('ignores blank values', () => {
    expect(envModel({ PI_PROVIDER: '  ', PI_MODEL: '  ' })).toBeNull();
  });
});

describe('resolveModelSource (env wins, then ctx, cache, transcript, settings)', () => {
  const env = (e: Record<string, string>) => () => (e.PI_MODEL ? `${e.PI_PROVIDER ? e.PI_PROVIDER + '/' : ''}${e.PI_MODEL}` : null);

  it('prefers the per-command env over a stale ctx.getModel()', () => {
    const ctx = { getModel: () => ({ provider: 'anthropic', id: 'claude-opus-4-8' }) };
    expect(resolveModelSource({
      ctx: ctx as any, lastSelected: null, readDefault: () => 'default',
      readTranscript: () => 'transcript', env: env({ PI_PROVIDER: 'coding4', PI_MODEL: 'qwen3.8:27b' }),
    })).toBe('coding4/qwen3.8:27b');
  });

  it('falls through ctx → cache → transcript → settings.json in order', () => {
    const noEnv = () => null;
    expect(resolveModelSource({ ctx: { getModel: () => ({ id: 'live' }) } as any, lastSelected: 'c', readDefault: () => 'd', readTranscript: () => 't', env: noEnv })).toBe('live');
    expect(resolveModelSource({ ctx: {} as any, lastSelected: 'c', readDefault: () => 'd', readTranscript: () => 't', env: noEnv })).toBe('c');
    expect(resolveModelSource({ ctx: {} as any, lastSelected: null, readDefault: () => 'd', readTranscript: () => 't', env: noEnv })).toBe('t');
    expect(resolveModelSource({ ctx: {} as any, lastSelected: null, readDefault: () => 'd', readTranscript: () => null, env: noEnv })).toBe('d');
    expect(resolveModelSource({ ctx: {} as any, lastSelected: null, readDefault: () => null, readTranscript: () => null, env: noEnv })).toBeNull();
  });

  it('never throws when every source is missing', () => {
    expect(() => resolveModelSource({ ctx: undefined, lastSelected: null, readDefault: () => null, readTranscript: () => { throw new Error('boom'); }, env: () => { throw new Error('boom'); } })).not.toThrow();
  });
});

describe('readPiSessionModel (the transcript records the model that answered)', () => {
  it('reads provider/model from the newest assistant message', () => {
    const lines = [
      JSON.stringify({ type: 'session' }),
      JSON.stringify({ type: 'message', message: { role: 'assistant', provider: 'old', model: 'old-model' } }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: [] } }),
      JSON.stringify({ type: 'message', message: { role: 'assistant', provider: 'qwen38-flashnext', model: 'qwen38-flashnext' } }),
    ].join('\n');
    expect(readPiSessionModel(() => lines)).toBe('qwen38-flashnext/qwen38-flashnext');
  });

  it('returns the bare id when the transcript entry has no provider', () => {
    const lines = JSON.stringify({ type: 'message', message: { role: 'assistant', model: 'glm-5.2' } });
    expect(readPiSessionModel(() => lines)).toBe('glm-5.2');
  });

  it('follows a model_change entry over earlier assistant messages', () => {
    const lines = [
      JSON.stringify({ type: 'message', message: { role: 'assistant', provider: 'p', model: 'first' } }),
      JSON.stringify({ type: 'model_change', provider: 'coding4', modelId: 'qwen3.8:27b' }),
    ].join('\n');
    expect(readPiSessionModel(() => lines)).toBe('coding4/qwen3.8:27b');
  });

  it('returns null for empty, model-less, or unreadable content', () => {
    expect(readPiSessionModel(() => '')).toBeNull();
    expect(readPiSessionModel(() => JSON.stringify({ type: 'message', message: { role: 'user' } }))).toBeNull();
    expect(readPiSessionModel(() => 'not json')).toBeNull();
    expect(readPiSessionModel(() => { throw new Error('ENOENT'); })).toBeNull();
  });

  it('skips malformed lines instead of failing the whole read', () => {
    const lines = ['not json', JSON.stringify({ type: 'message', message: { role: 'assistant', model: 'glm-5.2' } })].join('\n');
    expect(readPiSessionModel(() => lines)).toBe('glm-5.2');
  });

  // The default reader runs SYNCHRONOUSLY inside pi's own process: a FIFO would
  // block pi outright (open() with no writer never returns) and a huge file would
  // be allocated whole. It must stat first and only ever open a regular file.
  it('default reader refuses a non-regular file instead of opening it', () => {
    const os = require('node:os');
    const fsp = require('node:fs');
    const dir = fsp.mkdtempSync(require('node:path').join(os.tmpdir(), 'pi-sess-'));
    const dirPath = require('node:path').join(dir, 'sessions'); // a directory, not a file
    fsp.mkdirSync(dirPath);
    const saved = process.env.PI_SESSION_FILE;
    process.env.PI_SESSION_FILE = dirPath;
    try {
      expect(readPiSessionModel()).toBeNull(); // returned without blocking
    } finally {
      if (saved === undefined) delete process.env.PI_SESSION_FILE;
      else process.env.PI_SESSION_FILE = saved;
      fsp.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('default reader returns null when PI_SESSION_FILE is unset', () => {
    const saved = process.env.PI_SESSION_FILE;
    delete process.env.PI_SESSION_FILE;
    try {
      expect(readPiSessionModel()).toBeNull();
    } finally {
      if (saved !== undefined) process.env.PI_SESSION_FILE = saved;
    }
  });

  it('ignores a model_change with no model and keeps looking back', () => {
    const lines = [
      JSON.stringify({ type: 'message', message: { role: 'assistant', model: 'glm-5.2' } }),
      JSON.stringify({ type: 'model_change', provider: 'p' }),
    ].join('\n');
    expect(readPiSessionModel(() => lines)).toBe('glm-5.2');
  });

  it('does not read a model off a non-assistant message', () => {
    const lines = JSON.stringify({ type: 'message', message: { role: 'toolResult', provider: 'p', model: 'glm-5.2', toolName: 'bash' } });
    expect(readPiSessionModel(() => lines)).toBeNull();
  });

  it('reads a model_change whose provider is absent', () => {
    expect(readPiSessionModel(() => JSON.stringify({ type: 'model_change', modelId: 'glm-5.2' }))).toBe('glm-5.2');
  });

  it('ignores an assistant message with no usable model', () => {
    const lines = [
      JSON.stringify({ type: 'message', message: { role: 'assistant', model: '   ' } }),
      JSON.stringify({ type: 'message', message: { role: 'assistant', model: 'glm-5.2' } }),
    ].join('\n');
    expect(readPiSessionModel(() => lines)).toBe('glm-5.2');
  });
});

describe('readPiDefaultModel still reports the bare defaultModel', () => {
  it('is unchanged in shape (the provider fix happens in resolution, not here)', () => {
    expect(readPiDefaultModel(() => JSON.stringify({ defaultProvider: 'coding4', defaultModel: 'qwen3.8:27b' }))).toBe('qwen3.8:27b');
  });
});

describe('preferredModelArg (never overwrite a correct agent-reported model)', () => {
  const cmd = 'agenfk pr create abc --model qwen38-flashnext --harness pi';

  it('reports no model to inject when the agent-supplied --model already agrees', () => {
    // null means "leave the command alone" — the agent's value stands.
    expect(preferredModelArg(cmd, 'coding4/qwen38-flashnext')).toBeNull();
  });

  it('agrees when the agent wrote the provider-qualified form', () => {
    expect(preferredModelArg('agenfk pr create abc --model coding4/qwen38-flashnext', 'coding4/qwen38-flashnext')).toBeNull();
  });

  it('agrees when only the agent wrote the provider prefix', () => {
    expect(preferredModelArg('agenfk pr create abc --model coding4/qwen38-flashnext', 'qwen38-flashnext')).toBeNull();
  });

  it('overrides an agent-supplied --model that contradicts the detected model', () => {
    expect(preferredModelArg('agenfk pr create abc --model claude-sonnet-4-5', 'coding4/qwen38-flashnext')).toBe('coding4/qwen38-flashnext');
  });

  it('adds the model when the agent omitted --model', () => {
    expect(preferredModelArg('agenfk pr create abc --title "T"', 'coding4/qwen38-flashnext')).toBe('coding4/qwen38-flashnext');
  });

  it('returns null when the model is unknown (nothing to inject)', () => {
    expect(preferredModelArg(cmd, null)).toBeNull();
  });

  it('does not read a --model inside a quoted --body', () => {
    expect(preferredModelArg('agenfk pr create abc --body "see --model docs"', 'glm-5.2')).toBe('glm-5.2');
  });

  // A quoted operator is data, not a command boundary: the scan must continue past
  // it, or a real --model after the --body is never seen.
  it('keeps scanning past a quoted ; or | to reach a later --model', () => {
    expect(preferredModelArg('agenfk pr create abc --body "first; then" --model wrong', 'glm-5.2')).toBe('glm-5.2');
    expect(preferredModelArg("agenfk pr create abc --body 'a | b' --model glm-5.2", 'glm-5.2')).toBeNull();
  });

  it('reads a quoted --model value as one shell word', () => {
    expect(preferredModelArg('agenfk pr create abc --model "glm-5.2"', 'glm-5.2')).toBeNull();
    expect(preferredModelArg('agenfk pr create abc --model="glm 5.2"', 'glm 5.2')).toBeNull();
  });

  it('reads the --model=VALUE form', () => {
    expect(preferredModelArg('agenfk pr create abc --model=glm-5.2', 'glm-5.2')).toBeNull();
    expect(preferredModelArg('agenfk pr create abc --model=claude-sonnet-4-5', 'glm-5.2')).toBe('glm-5.2');
  });

  it('compares the artifact name case-insensitively', () => {
    expect(preferredModelArg('agenfk pr create abc --model Qwen38-FlashNext', 'coding4/qwen38-flashnext')).toBeNull();
  });

  it('does not treat --model-a or a --model in a later pipeline stage as ours', () => {
    expect(preferredModelArg('agenfk pr create abc --model-a glm-5.2', 'glm-5.2')).toBe('glm-5.2');
    // `glm-5.2` belongs to the SECOND command; ours has none, so still inject.
    expect(preferredModelArg('agenfk pr create abc | grep glm-5.2', 'glm-5.2')).toBe('glm-5.2');
  });

  it('takes the last --model when the agent passed several (commander last-wins)', () => {
    expect(preferredModelArg('agenfk pr create abc --model wrong --model glm-5.2', 'glm-5.2')).toBeNull();
    expect(preferredModelArg('agenfk pr create abc --model glm-5.2 --model wrong', 'glm-5.2')).toBe('glm-5.2');
  });

  it('treats a dangling --model with no value as no report at all', () => {
    expect(preferredModelArg('agenfk pr create abc --model', 'glm-5.2')).toBe('glm-5.2');
    expect(preferredModelArg('agenfk pr create abc --model ""', 'glm-5.2')).toBe('glm-5.2');
  });

  it('stops at a redirect so a later stage cannot satisfy our --model', () => {
    // `x` is ours and disagrees; the glm-5.2 after the redirect is another command's.
    expect(preferredModelArg('agenfk pr create abc --model x > /tmp/f glm-5.2', 'glm-5.2')).toBe('glm-5.2');
  });

  it('reads a value that runs to the end of the command with no trailing space', () => {
    expect(preferredModelArg('agenfk pr create abc --model glm-5.2', 'glm-5.2')).toBeNull();
    expect(preferredModelArg('agenfk pr create abc --model=glm-5.2', 'glm-5.2')).toBeNull();
  });

  it('stops the value at a shell operator so it is not swallowed into it', () => {
    // Without the operator guard the value would read `glm-5.2|grep` and disagree.
    expect(preferredModelArg('agenfk pr create abc --model glm-5.2|grep x', 'glm-5.2')).toBeNull();
  });

  it('matches a quoted value containing a space or an operator', () => {
    expect(preferredModelArg('agenfk pr create abc --model "glm 5.2"', 'glm 5.2')).toBeNull();
    expect(preferredModelArg('agenfk pr create abc --model "a;b"', 'a;b')).toBeNull();
  });

  it('does not match a flag merely starting with --model', () => {
    expect(preferredModelArg('agenfk pr create abc --modelname glm-5.2', 'glm-5.2')).toBe('glm-5.2');
    expect(preferredModelArg('agenfk pr create abc --modelx=glm-5.2', 'glm-5.2')).toBe('glm-5.2');
  });

  // `--model$` is the end-of-command alternative in the flag regex: without it the
  // value scan starts past the end and a correct final --model reads as absent.
  it('kills the end-of-command branch of the flag regex', () => {
    expect(preferredModelArg('agenfk pr create abc --model glm-5.2', 'glm-5.2')).toBeNull();
    expect(preferredModelArg('agenfk pr create abc --model=glm-5.2', 'glm-5.2')).toBeNull();
    // and the flag alone at EOL is still "no report"
    expect(preferredModelArg('agenfk pr create abc --model', 'glm-5.2')).toBe('glm-5.2');
  });

  it('honours both quote styles when reading a value', () => {
    expect(preferredModelArg(`agenfk pr create abc --model 'glm-5.2'`, 'glm-5.2')).toBeNull();
    expect(preferredModelArg('agenfk pr create abc --model "glm-5.2"', 'glm-5.2')).toBeNull();
    // a value quoted in one style ignores the other style's quote char inside it
    expect(preferredModelArg(`agenfk pr create abc --model 'a"b'`, 'a"b')).toBeNull();
  });

  it('honours an escaped quote inside a double-quoted value', () => {
    expect(preferredModelArg('agenfk pr create abc --model "a\\"b"', 'a"b')).toBeNull();
  });

  it('is not confused by a command ending exactly at --model or by escapes', () => {
    expect(preferredModelArg('agenfk pr create abc --model ', 'glm-5.2')).toBe('glm-5.2');
    // An escaped quote stays INSIDE the body, so the ; it contains is data and the
    // real --model after the closing quote is still found.
    expect(preferredModelArg('agenfk pr create abc --body "a \\" ; rm -rf" --model glm-5.2', 'glm-5.2')).toBeNull();
    // An unescaped backslash skips the next char rather than ending the scan.
    expect(preferredModelArg('agenfk pr create abc --model \\glm-5.2', 'glm-5.2')).toBeNull();
  });
});

describe('injectDeterministicModel keeps agreeing with the agent', () => {
  it('does not append a duplicate --model when the agent already reported it', () => {
    const cmd = 'agenfk pr create abc --model qwen38-flashnext --harness pi';
    expect(injectDeterministicModel(cmd, 'coding4/qwen38-flashnext')).toBe(cmd);
  });

  it('still overrides a contradicting model', () => {
    const out = injectDeterministicModel('agenfk pr create abc --model claude-sonnet-4-5 --harness pi', 'coding4/qwen38-flashnext');
    expect(out).toMatch(/--model claude-sonnet-4-5 --harness pi --model coding4\/qwen38-flashnext --harness pi$/);
  });

  it('accepts a provider-qualified id (slash is on the allowlist)', () => {
    const out = injectDeterministicModel('agenfk pr create abc --title "T"', 'coding4/qwen3.8:27b');
    expect(out).toContain('--model coding4/qwen3.8:27b --harness pi');
  });

  it('still refuses shell metacharacters in a provider-qualified id', () => {
    const cmd = 'agenfk pr create abc --title "T"';
    expect(injectDeterministicModel(cmd, 'coding4/qwen; rm -rf')).toBe(cmd);
  });

  it('does not inject twice when the agent quoted a correct --model', () => {
    const cmd = 'agenfk pr create abc --model "qwen38-flashnext" --harness pi';
    expect(injectDeterministicModel(cmd, 'coding4/qwen38-flashnext')).toBe(cmd);
  });

  it('overrides a wrong --model that follows a quoted --body containing an operator', () => {
    const out = injectDeterministicModel('agenfk pr create abc --body "first; then" --model claude-sonnet-4-5', 'glm-5.2');
    expect(out).toBe('agenfk pr create abc --body "first; then" --model claude-sonnet-4-5 --model glm-5.2 --harness pi');
  });

  it('injects before a pipe even when the later stage mentions the model', () => {
    const out = injectDeterministicModel('agenfk pr create abc | grep glm-5.2', 'glm-5.2');
    expect(out).toBe('agenfk pr create abc --model glm-5.2 --harness pi | grep glm-5.2');
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

// ── BUG regression: activate() must use the AUTHORITATIVE model sources ──────

describe('activate(): model detection uses env + transcript, not settings.json alone', () => {
  it('prefers the per-command pi session env over ctx.getModel()', async () => {
    const { pi, sent, fire } = makeFakePi();
    const deps = makeDeps({
      prReminder: vi.fn().mockReturnValue({ message: 'open. harness = "pi".' }),
      readEnvModel: () => 'coding4/qwen3.8:27b',
    });
    activate(pi as any, deps);

    await fire(
      'tool_result',
      { toolName: 'bash', input: { command: 'gh pr create --fill' } },
      ctxWithModel('anthropic', 'claude-opus-4-8'), // stale/absent in live pi
    );

    expect(sent[0].message.content).toContain('coding4/qwen3.8:27b');
    expect(sent[0].message.content).not.toContain('claude-opus-4-8');
  });

  it('uses the session transcript when env + ctx + model_select are all unavailable', async () => {
    const { pi, sent, fire } = makeFakePi();
    const deps = makeDeps({
      prReminder: vi.fn().mockReturnValue({ message: 'open. harness = "pi".' }),
      readTranscriptModel: () => 'qwen38-flashnext',
    });
    activate(pi as any, deps);

    await fire('tool_result', { toolName: 'bash', input: { command: 'gh pr create' } }, {});

    expect(sent[0].message.content).toContain('qwen38-flashnext');
  });

  // The exact failure from the report: the hook asserted a model the session
  // transcript contradicted, because settings.json defaultModel outranked it.
  it('does NOT report the settings.json defaultModel when the transcript contradicts it', async () => {
    const { pi, sent, fire } = makeFakePi();
    const deps = makeDeps({
      prReminder: vi.fn().mockReturnValue({ message: 'open. harness = "pi".' }),
      readDefaultModel: () => '@cf/zai-org/glm-5.2',
      readTranscriptModel: () => 'qwen38-flashnext/qwen38-flashnext',
    });
    activate(pi as any, deps);

    await fire('tool_result', { toolName: 'bash', input: { command: 'gh pr create' } }, {});

    expect(sent[0].message.content).toContain('qwen38-flashnext');
    expect(sent[0].message.content).not.toContain('@cf/zai-org/glm-5.2');
  });

  it('re-reads the model per event instead of caching settings.json for the session', async () => {
    const { pi, sent, fire } = makeFakePi();
    let live = 'model-a';
    const deps = makeDeps({
      prReminder: vi.fn().mockReturnValue({ message: 'open. harness = "pi".' }),
      readDefaultModel: () => live, // no memoisation: a switch is picked up
    });
    activate(pi as any, deps);

    await fire('tool_result', { toolName: 'bash', input: { command: 'gh pr create' } }, {});
    expect(sent[0].message.content).toContain('model-a');

    live = 'model-b';
    await fire('tool_result', { toolName: 'bash', input: { command: 'gh pr create' } }, {});
    expect(sent[1].message.content).toContain('model-b');
  });

  it('rewrites agenfk pr-register with the transcript model, not the config default', async () => {
    const { pi, fire } = makeFakePi();
    const deps = makeDeps({
      readDefaultModel: () => '@cf/zai-org/glm-5.2',
      readTranscriptModel: () => 'qwen38-flashnext',
    });
    activate(pi as any, deps);

    const event = {
      toolName: 'bash',
      input: { command: 'agenfk pr-register --item x --number 5 --repo o/r --epic 0 --story 0 --task 1 --bug 0 --model @cf/zai-org/glm-5.2 --harness pi' },
    };
    const res = await fire('tool_call', event, {});

    expect(res).toBeUndefined();
    expect(event.input.command).toContain('--model qwen38-flashnext --harness pi');
    // The config default is still present as the agent's (wrong) first --model;
    // what matters is that the detected model is LAST, so commander last-wins it.
    expect(event.input.command.endsWith('--model qwen38-flashnext --harness pi')).toBe(true);
  });

  it('leaves a pr create command alone when the agent already reported the right model', async () => {
    const { pi, fire } = makeFakePi();
    const deps = makeDeps({ readTranscriptModel: () => 'coding4/qwen38-flashnext' });
    activate(pi as any, deps);

    const cmd = 'agenfk pr create abc --model qwen38-flashnext --harness pi --title "T"';
    const event = { toolName: 'bash', input: { command: cmd } };
    await fire('tool_call', event, {});

    expect(event.input.command).toBe(cmd);
  });

  // The TTL cache must not outlive the session it was read from: PI_SESSION_FILE
  // changes on /resume, /new and fork.
  it('drops the transcript cache when PI_SESSION_FILE changes', async () => {
    const fsp = require('node:fs');
    const os = require('node:os');
    const ppath = require('node:path');
    const dir = fsp.mkdtempSync(ppath.join(os.tmpdir(), 'pi-sess2-'));
    const line = (m: string) => JSON.stringify({ type: 'message', message: { role: 'assistant', provider: 'p', model: m } });
    const a = ppath.join(dir, 'a.jsonl');
    const b = ppath.join(dir, 'b.jsonl');
    fsp.writeFileSync(a, line('model-a'));
    fsp.writeFileSync(b, line('model-b'));

    const { defaultDeps } = await import('../../../../bin/agenfk-pi-extension.ts');
    const deps = defaultDeps();
    const saved = process.env.PI_SESSION_FILE;
    process.env.PI_SESSION_FILE = a;
    try {
      expect(deps.readTranscriptModel()).toBe('p/model-a');
      // Same file, inside the TTL: cached, and still correct.
      expect(deps.readTranscriptModel()).toBe('p/model-a');
      // Session switched: the cache is keyed on the file, so this must NOT be stale.
      process.env.PI_SESSION_FILE = b;
      expect(deps.readTranscriptModel()).toBe('p/model-b');
    } finally {
      if (saved === undefined) delete process.env.PI_SESSION_FILE;
      else process.env.PI_SESSION_FILE = saved;
      fsp.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports the model on session_start from the transcript when ctx has none', async () => {
    const { pi, fire } = makeFakePi();
    const notify = vi.fn();
    activate(pi as any, makeDeps({ readTranscriptModel: () => 'coding4/qwen3.8:27b' }));

    await fire('session_start', { reason: 'startup' }, { ui: { notify } });

    expect(notify.mock.calls[0][0]).toContain('coding4/qwen3.8:27b');
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
    // Likewise the transcript and the pi session env (in real pi these reach the
    // extension via PI_SESSION_FILE / PI_MODEL on the bash tool's own env).
    readTranscriptModel: () => null,
    readEnvModel: () => null,
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
    // Provider-qualified id — a bare id is ambiguous across providers.
    expect(sent[0].message.content).toContain('anthropic/claude-opus-4-8');
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
    expect(msg).toContain('zhipu/glm-5.2'); // provider-qualified
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
    // Provider-qualified id appended last (overrides the agent's guess).
    expect(event.input.command).toMatch(/--model cloudflare-workers-ai\/@cf\/zai-org\/glm-5\.2 --harness pi$/);
  });

  it('leaves an ordinary bash command unchanged', async () => {
    const { pi, fire } = makeFakePi();
    activate(pi as any, makeDeps());
    const event: any = { toolName: 'bash', input: { command: 'npm test' } };
    await fire('tool_call', event, ctxWithModel('a', 'b'));
    expect(event.input.command).toBe('npm test');
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
