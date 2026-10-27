import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
// @ts-ignore — .ts extension is loaded by pi via jiti; here we import it directly.
import activate from '../../../../bin/agenfk-pi-extension.ts';

// BUG 59d3ad7c (GH-294): a patch tool names its files inside the patch text
// ('*** Update File: src/a.ts'), not in a path argument, so the gatekeeper —
// which looked for path/file_path/filePath on tools named edit/write — never
// saw an edit made through OpenCode's `patch` (`apply_patch` in older builds).
// A tool carrying a patch is now gated by every file the patch touches,
// whatever the tool is called.

const GATEKEEPER_OPENCODE = path.resolve(__dirname, '../../../../bin/agenfk-gatekeeper-opencode.mjs');

const patch = (...headers: string[]) =>
  ['*** Begin Patch', ...headers.flatMap((h) => [h, '@@', '-old', '+new']), '*** End Patch'].join('\n');

// ── OpenCode ─────────────────────────────────────────────────────────────────

let project: string;

beforeAll(() => {
  // The plugin delegates to ~/.agenfk/bin/agenfk-gatekeeper.mjs. HOME is the
  // run's sandbox (vitest-home-pin); the stand-in planted there blocks exactly
  // the files whose name ends in `.blocked`, and names the file it was asked
  // about, so a test can tell WHICH target reached the gatekeeper.
  expect(os.homedir()).not.toBe(process.env.AGENFK_REAL_HOME);
  const bin = path.join(os.homedir(), '.agenfk', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, 'agenfk-gatekeeper.mjs'),
    `let s = '';
process.stdin.on('data', (d) => (s += d)).on('end', () => {
  const file = JSON.parse(s).tool_input.file_path;
  if (file.endsWith('.blocked')) {
    process.stdout.write(JSON.stringify({ decision: 'block', reason: 'AgenFK WORKFLOW VIOLATION: ' + file }));
  }
});`,
  );
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-patch-gate-'));
});

afterAll(() => {
  fs.rmSync(project, { recursive: true, force: true });
});

/** The plugin's verdict, called the way OpenCode calls it: args on `output`. */
async function opencode(tool: string, args: Record<string, unknown>): Promise<string | null> {
  const mod = await import(`${pathToFileURL(GATEKEEPER_OPENCODE).href}?t=${Date.now()}`);
  const hooks = await mod.default({ directory: project });
  try {
    await hooks['tool.execute.before']({ tool, sessionID: 's', callID: 'c' }, { args });
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

describe('OpenCode gatekeeper: a patch is gated by the files it touches', () => {
  it('blocks the patch tool updating a file the gatekeeper refuses', async () => {
    expect(await opencode('patch', { patchText: patch('*** Update File: src/a.blocked') }))
      .toMatch(/WORKFLOW VIOLATION: .*src[\\/]a\.blocked/);
  });

  it('blocks apply_patch (older OpenCode) adding a file', async () => {
    expect(await opencode('apply_patch', { patchText: patch('*** Add File: new.blocked') }))
      .toMatch(/new\.blocked/);
  });

  it('blocks a delete', async () => {
    expect(await opencode('patch', { patchText: patch('*** Delete File: gone.blocked') }))
      .toMatch(/gone\.blocked/);
  });

  it('checks every file, not just the first', async () => {
    expect(await opencode('patch', {
      patchText: patch('*** Update File: src/ok.ts', '*** Add File: src/later.blocked'),
    })).toMatch(/later\.blocked/);
  });

  it('checks the destination of a move', async () => {
    expect(await opencode('patch', {
      patchText: patch('*** Update File: src/ok.ts\n*** Move to: src/moved.blocked'),
    })).toMatch(/moved\.blocked/);
  });

  it('gates a plugin tool carrying a patch under any name', async () => {
    expect(await opencode('my_patcher', { patchText: patch('*** Update File: x.blocked') }))
      .toMatch(/x\.blocked/);
  });

  it('lets a patch through when the gatekeeper allows every file', async () => {
    expect(await opencode('patch', { patchText: patch('*** Update File: src/ok.ts') })).toBeNull();
  });

  it('reads the patch from the patch and input aliases too', async () => {
    expect(await opencode('patch', { patch: patch('*** Update File: a.blocked') })).toMatch(/a\.blocked/);
    expect(await opencode('patch', { input: patch('*** Update File: b.blocked') })).toMatch(/b\.blocked/);
  });

  it('resolves a relative target against the workspace, not the host process directory', async () => {
    // OpenCode applies a patch relative to its workspace (context.directory);
    // the gatekeeper must be asked about that same file.
    expect(await opencode('patch', { patchText: patch('*** Update File: src/c.blocked') }))
      .toContain(path.join(project, 'src', 'c.blocked'));
  });

  it('does not treat text that merely mentions a header as a patch', async () => {
    expect(await opencode('explain', { input: 'explain this line:\n*** Update File: x.blocked' })).toBeNull();
  });
});

// ── pi ───────────────────────────────────────────────────────────────────────

function makeFakePi() {
  const handlers: Record<string, Function> = {};
  const pi = {
    on: (event: string, handler: Function) => { handlers[event] = handler; },
    sendMessage: () => {},
  };
  const fire = (event: string, payload: any, ctx: any = {}) =>
    handlers[event] ? handlers[event](payload, ctx) : undefined;
  return { pi, fire };
}

function makeDeps(overrides: any = {}) {
  return {
    gatekeeperVerdict: vi.fn().mockReturnValue(null),
    enforcerVerdict: vi.fn().mockReturnValue(null),
    readVerdict: vi.fn().mockReturnValue(null),
    prReminder: vi.fn().mockReturnValue(null),
    readDefaultModel: () => null,
    readTranscriptModel: () => null,
    readEnvModel: () => null,
    ...overrides,
  };
}

/** A gatekeeper that blocks `.blocked` files, like the OpenCode stand-in. */
const blocksDotBlocked = () =>
  vi.fn((file?: string) =>
    file && file.endsWith('.blocked') ? { decision: 'block', reason: `AgenFK WORKFLOW VIOLATION: ${file}` } : null);

describe('pi gatekeeper: a patch is gated by the files it touches', () => {
  for (const key of ['patchText', 'patch', 'input']) {
    it(`reads the targets of apply_patch carrying its patch in "${key}"`, async () => {
      const { pi, fire } = makeFakePi();
      const deps = makeDeps({ gatekeeperVerdict: blocksDotBlocked() });
      activate(pi as any, deps);
      const res = await fire('tool_call', {
        toolName: 'apply_patch',
        input: { [key]: patch('*** Update File: src/ok.ts', '*** Add File: src/b.blocked') },
      });
      expect(deps.gatekeeperVerdict).toHaveBeenCalledWith('src/ok.ts');
      expect(res).toEqual({ block: true, reason: 'AgenFK WORKFLOW VIOLATION: src/b.blocked' });
    });
  }

  it('gates a plugin tool carrying a patch under any name', async () => {
    const { pi, fire } = makeFakePi();
    const deps = makeDeps({ gatekeeperVerdict: blocksDotBlocked() });
    activate(pi as any, deps);
    const res = await fire('tool_call', { toolName: 'my_patcher', input: { patchText: patch('*** Delete File: z.blocked') } });
    expect(res).toEqual({ block: true, reason: 'AgenFK WORKFLOW VIOLATION: z.blocked' });
  });

  it('resolves a relative target against the session directory when pi reports one', async () => {
    // An embedded pi session (createAgentSession({ cwd })) applies the patch in
    // ctx.cwd while the host process stays elsewhere.
    const { pi, fire } = makeFakePi();
    const deps = makeDeps();
    activate(pi as any, deps);
    await fire('tool_call', { toolName: 'apply_patch', input: { patchText: patch('*** Update File: src/ok.ts') } }, { cwd: '/managed/repo' });
    // resolve, as the hook does: on Windows it adds the drive.
    expect(deps.gatekeeperVerdict).toHaveBeenCalledWith(path.resolve('/managed/repo', 'src', 'ok.ts'));
  });

  it('checks the destination of a move', async () => {
    const { pi, fire } = makeFakePi();
    const deps = makeDeps({ gatekeeperVerdict: blocksDotBlocked() });
    activate(pi as any, deps);
    const res = await fire('tool_call', {
      toolName: 'apply_patch',
      input: { patchText: patch('*** Update File: src/ok.ts\n*** Move to: src/m.blocked') },
    });
    expect(res).toEqual({ block: true, reason: 'AgenFK WORKFLOW VIOLATION: src/m.blocked' });
  });

  it('still checks the command of a tool that also carries a patch', async () => {
    const { pi, fire } = makeFakePi();
    const deps = makeDeps({
      enforcerVerdict: vi.fn().mockReturnValue({ decision: 'block', reason: 'AgenFK MCP ENFORCER: database' }),
    });
    activate(pi as any, deps);
    const res = await fire('tool_call', {
      toolName: 'my_patcher',
      input: { command: 'cat .agenfk/db.sqlite', patchText: patch('*** Update File: src/ok.ts') },
    });
    expect(deps.enforcerVerdict).toHaveBeenCalledWith('cat .agenfk/db.sqlite');
    expect(res).toEqual({ block: true, reason: 'AgenFK MCP ENFORCER: database' });
  });

  it('does not treat text that merely mentions a header as a patch', async () => {
    const { pi, fire } = makeFakePi();
    const deps = makeDeps({ gatekeeperVerdict: blocksDotBlocked() });
    activate(pi as any, deps);
    const res = await fire('tool_call', { toolName: 'explain', input: { input: 'explain this line:\n*** Update File: x.blocked' } });
    expect(res).toBeFalsy();
    expect(deps.gatekeeperVerdict).not.toHaveBeenCalled();
  });

  it('lets a patch through when every file is allowed', async () => {
    const { pi, fire } = makeFakePi();
    const deps = makeDeps({ gatekeeperVerdict: blocksDotBlocked() });
    activate(pi as any, deps);
    const res = await fire('tool_call', { toolName: 'apply_patch', input: { patchText: patch('*** Update File: src/ok.ts') } });
    expect(res).toBeFalsy();
  });
});
