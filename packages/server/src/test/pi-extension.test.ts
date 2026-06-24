import { describe, it, expect, vi } from 'vitest';
// Importing the native pi extension. Pure helpers + the activate() default export
// are exercised directly with a fake pi/ctx so no pi runtime is required.
// @ts-ignore — .ts extension is loaded by pi via jiti; here we import it directly.
import activate, {
  formatModel,
  composeReminder,
} from '../../../../bin/agenfk-pi-extension.ts';

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe('formatModel (pi Model → provider/id)', () => {
  it('formats provider/id', () => {
    expect(formatModel({ provider: 'anthropic', id: 'claude-opus-4-8' }))
      .toBe('anthropic/claude-opus-4-8');
  });

  it('falls back to a bare id when provider is absent', () => {
    expect(formatModel({ id: 'glm-5.2' })).toBe('glm-5.2');
  });

  it('returns null when model is missing/empty', () => {
    expect(formatModel(null)).toBeNull();
    expect(formatModel(undefined)).toBeNull();
    expect(formatModel({})).toBeNull();
  });
});

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
    expect(sent[0].message.content).toContain('anthropic/claude-opus-4-8');
  });

  it('falls back to the cached model_select model when ctx.getModel() is unavailable', async () => {
    const { pi, sent, fire } = makeFakePi();
    const deps = makeDeps({ prReminder: vi.fn().mockReturnValue({ message: 'open. harness = "pi".' }) });
    activate(pi as any, deps);

    fire('model_select', { model: { provider: 'zhipu', id: 'glm-5.2' } });
    await fire('tool_result', { toolName: 'bash', input: { command: 'gh pr create' } }, {}); // no getModel
    expect(sent[0].message.content).toContain('zhipu/glm-5.2');
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
    expect(msg).toContain('zhipu/glm-5.2');
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
