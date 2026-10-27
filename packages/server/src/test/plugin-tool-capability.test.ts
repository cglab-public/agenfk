import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
// @ts-ignore — .ts extension is loaded by pi via jiti; here we import it directly.
import activate from '../../../../bin/agenfk-pi-extension.ts';

// BUG dac2720a (GH-294): both adapters used to gate tools by NAME (bash, read),
// so tools added by community plugins — pi-patty-bg-tasks' bash_bg, or any
// OpenCode plugin tool — skipped the enforcer. A tool is now judged by what its
// input carries: a command is a command, a path is a path, whatever the tool is
// called. The same cases run through both adapters so the two cannot drift.

const ENFORCER_OPENCODE = path.resolve(__dirname, '../../../../bin/agenfk-mcp-enforcer-opencode.mjs');

const DB_READ = 'cat .agenfk/db.sqlite';
const SERVER_CURL = 'curl -s http://localhost:3000/items';

/** Tools that carry a command, under names no adapter knows. */
const COMMAND_TOOLS: Array<{ tool: string; input: Record<string, unknown> }> = [
  { tool: 'bash_bg', input: { command: DB_READ } },
  { tool: 'run_script', input: { cmd: DB_READ } },
  { tool: 'shell', input: { command: DB_READ } },
];

/** Tools that carry a path to read, under names no adapter knows. */
const PATH_TOOLS: Array<{ tool: string; input: Record<string, unknown> }> = [
  { tool: 'grep', input: { path: '/work/.agenfk/db.sqlite', pattern: 'x' } },
  { tool: 'view_file', input: { file_path: '/work/.agenfk/db.json' } },
];

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

const BLOCK = { decision: 'block', reason: 'AgenFK MCP ENFORCER: forbidden' };

describe('pi: a tool carrying a command goes through the enforcer, whatever its name', () => {
  for (const { tool, input } of COMMAND_TOOLS) {
    it(`blocks ${tool} when the enforcer blocks its command`, async () => {
      const { pi, fire } = makeFakePi();
      const deps = makeDeps({ enforcerVerdict: vi.fn().mockReturnValue(BLOCK) });
      activate(pi as any, deps);
      const res = await fire('tool_call', { toolName: tool, input: { ...input } });
      expect(deps.enforcerVerdict).toHaveBeenCalledWith(DB_READ);
      expect(res).toEqual({ block: true, reason: BLOCK.reason });
    });
  }

  it('forces the real model onto an agenfk pr command run through bash_bg', async () => {
    const { pi, fire } = makeFakePi();
    const deps = makeDeps({ readEnvModel: () => 'anthropic/claude-test' });
    activate(pi as any, deps);
    const input = { command: 'agenfk pr create abc --model guessed --harness pi' };
    await fire('tool_call', { toolName: 'bash_bg', input });
    expect(input.command).toContain('--model anthropic/claude-test');
    expect(deps.enforcerVerdict).toHaveBeenCalledTimes(1);
  });

  it('rewrites the key that holds the command, not a blank sibling', async () => {
    const { pi, fire } = makeFakePi();
    const deps = makeDeps({ readEnvModel: () => 'anthropic/claude-test' });
    activate(pi as any, deps);
    const input = { command: '', cmd: 'agenfk pr create abc --model guessed --harness pi' };
    await fire('tool_call', { toolName: 'run_script', input });
    expect(input.cmd).toContain('--model anthropic/claude-test');
    expect(input.command).toBe('');
  });

  it('checks the path too when a tool carries both a command and a path', async () => {
    const { pi, fire } = makeFakePi();
    const deps = makeDeps({ readVerdict: vi.fn().mockReturnValue(BLOCK) });
    activate(pi as any, deps);
    const res = await fire('tool_call', {
      toolName: 'sql_query',
      input: { command: 'select 1', path: '/work/.agenfk/db.sqlite' },
    });
    expect(deps.readVerdict).toHaveBeenCalledWith('/work/.agenfk/db.sqlite');
    expect(res).toEqual({ block: true, reason: BLOCK.reason });
  });
});

describe('pi: a tool carrying a path goes through the read check, whatever its name', () => {
  for (const { tool, input } of PATH_TOOLS) {
    it(`blocks ${tool} when the read check blocks its path`, async () => {
      const { pi, fire } = makeFakePi();
      const deps = makeDeps({ readVerdict: vi.fn().mockReturnValue(BLOCK) });
      activate(pi as any, deps);
      const res = await fire('tool_call', { toolName: tool, input: { ...input } });
      expect(deps.readVerdict).toHaveBeenCalledWith(input.path ?? input.file_path);
      expect(res).toEqual({ block: true, reason: BLOCK.reason });
    });
  }

  it('still sends an edit to the gatekeeper, not to the read check', async () => {
    const { pi, fire } = makeFakePi();
    const deps = makeDeps();
    activate(pi as any, deps);
    await fire('tool_call', { toolName: 'edit', input: { path: '/repo/src/a.ts' } });
    expect(deps.gatekeeperVerdict).toHaveBeenCalledWith('/repo/src/a.ts');
    expect(deps.readVerdict).not.toHaveBeenCalled();
  });

  it('lets a tool with neither a command nor a path through untouched', async () => {
    const { pi, fire } = makeFakePi();
    const deps = makeDeps({
      enforcerVerdict: vi.fn().mockReturnValue(BLOCK),
      readVerdict: vi.fn().mockReturnValue(BLOCK),
    });
    activate(pi as any, deps);
    const res = await fire('tool_call', { toolName: 'ask_user', input: { question: 'ok?' } });
    expect(res).toBeFalsy();
    expect(deps.enforcerVerdict).not.toHaveBeenCalled();
    expect(deps.readVerdict).not.toHaveBeenCalled();
  });
});

// ── OpenCode ─────────────────────────────────────────────────────────────────

let project: string;

beforeAll(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-capability-'));
  fs.mkdirSync(path.join(project, '.agenfk'));
  fs.writeFileSync(path.join(project, '.agenfk', 'local.json'), JSON.stringify({ projectId: 'p' }));
});

afterAll(() => {
  fs.rmSync(project, { recursive: true, force: true });
});

/**
 * The OpenCode plugin's verdict: the thrown message, or null when it lets the
 * call run. Called the way OpenCode calls it (@opencode-ai/plugin 1.19.4):
 * `(input: { tool, sessionID, callID }, output: { args })` — the arguments are
 * on the SECOND parameter, never on `input`.
 */
async function opencode(tool: string, args: Record<string, unknown>, plugin = ENFORCER_OPENCODE): Promise<string | null> {
  const mod = await import(`${pathToFileURL(plugin).href}?t=${Date.now()}`);
  const hooks = await mod.default({ directory: project });
  try {
    await hooks['tool.execute.before']({ tool, sessionID: 's', callID: 'c' }, { args });
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

describe('OpenCode: the plugin reads the arguments where OpenCode puts them', () => {
  it('blocks bash reading the database when the args arrive on output', async () => {
    expect(await opencode('bash', { command: DB_READ })).toMatch(/database/i);
  });

  it('blocks read on a database file when the args arrive on output', async () => {
    expect(await opencode('read', { filePath: '/work/.agenfk/db.sqlite' })).toMatch(/database/i);
  });
});

describe('OpenCode: the gatekeeper plugin reads the arguments where OpenCode puts them', () => {
  const GATEKEEPER_OPENCODE = path.resolve(__dirname, '../../../../bin/agenfk-gatekeeper-opencode.mjs');

  it('blocks an edit with no active task when the args arrive on output', async () => {
    // The plugin delegates to ~/.agenfk/bin/agenfk-gatekeeper.mjs. HOME is the
    // run's sandbox here (vitest-home-pin), so a stand-in that always blocks
    // is planted there; the real machine home is never touched.
    expect(os.homedir()).not.toBe(process.env.AGENFK_REAL_HOME);
    const bin = path.join(os.homedir(), '.agenfk', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(
      path.join(bin, 'agenfk-gatekeeper.mjs'),
      `process.stdout.write(JSON.stringify({ decision: 'block', reason: 'AgenFK WORKFLOW VIOLATION: no active task' }));`,
    );
    expect(await opencode('edit', { filePath: '/work/src/a.ts' }, GATEKEEPER_OPENCODE)).toMatch(/WORKFLOW VIOLATION/);
  });
});

describe('OpenCode: a tool carrying a command goes through the enforcer, whatever its name', () => {
  for (const { tool, input } of COMMAND_TOOLS) {
    it(`blocks ${tool} reading the database`, async () => {
      expect(await opencode(tool, { ...input })).toMatch(/database/i);
    });
  }

  it('checks the path too when a tool carries both a command and a path', async () => {
    expect(await opencode('sql_query', { command: 'select 1', path: '/work/.agenfk/db.sqlite' })).toMatch(/database/i);
  });

  it('blocks a plugin tool curling the server inside a project', async () => {
    expect(await opencode('bash_bg', { command: SERVER_CURL })).toMatch(/localhost:3000/);
  });
});

describe('OpenCode: a tool carrying a path goes through the read check, whatever its name', () => {
  for (const { tool, input } of PATH_TOOLS) {
    it(`blocks ${tool} on a database file`, async () => {
      expect(await opencode(tool, { ...input })).toMatch(/database/i);
    });
  }

  it('blocks the filePath spelling OpenCode tools use', async () => {
    expect(await opencode('glob_read', { filePath: '/work/.agenfk/db.sqlite' })).toMatch(/database/i);
  });

  it('lets an ordinary file through', async () => {
    expect(await opencode('grep', { path: '/work/src/a.ts', pattern: 'x' })).toBeNull();
  });
});
