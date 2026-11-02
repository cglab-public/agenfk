import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

// GH-294 T4: the OpenCode Airlock plugin when the shared
// ~/.agenfk/bin/agenfk-airlock.mjs is missing or cannot be loaded (a broken
// install). Without it the policy cannot be read in full, so the plugin is
// deliberately conservative: while the state file says enforce, any call that
// carries a command, a path or a URL is refused, whatever the model; otherwise
// it is let through.
//
// A file of its own: a module that once loaded stays in the import cache, so
// these cases must never share a file with the ones that load the script.

const PLUGIN = path.resolve(__dirname, '../../../../bin/agenfk-airlock-opencode.mjs');

let script: string;
let stateFile: string;

beforeAll(() => {
  // HOME is the run's sandbox (vitest-home-pin): never plant files in a real home.
  expect(os.homedir()).not.toBe(process.env.AGENFK_REAL_HOME);
  const bin = path.join(os.homedir(), '.agenfk', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  script = path.join(bin, 'agenfk-airlock.mjs');
  stateFile = path.join(os.homedir(), '.agenfk', 'airlock-state.json');
});

beforeEach(() => {
  fs.rmSync(script, { force: true });
  fs.rmSync(stateFile, { force: true });
});

afterAll(() => {
  fs.rmSync(script, { force: true });
  fs.rmSync(stateFile, { force: true });
});

const writeState = (mode: string, models: unknown[] = []) =>
  fs.writeFileSync(stateFile, JSON.stringify({ mode, revision: 3, source: 'local', models, appliesWhenModelUnknown: true }));

async function run(args: Record<string, unknown>, model?: { providerID: string; modelID: string }) {
  const mod = await import(`${pathToFileURL(PLUGIN).href}?t=${Date.now()}-${Math.random()}`);
  const hooks = await mod.default({ directory: '/work' });
  if (model) await hooks['chat.message']({ sessionID: 's1', model }, { message: {}, parts: [] });
  try {
    await hooks['tool.execute.before']({ tool: 'bash', sessionID: 's1', callID: 'c1' }, { args });
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

describe('OpenCode Airlock plugin: the shared script is missing', () => {
  it('under enforce, a call carrying a command is refused, telling the person to reinstall', async () => {
    writeState('enforce');
    const msg = await run({ command: 'ls' });
    expect(msg).toMatch(/\[agenfk airlock\]/);
    expect(msg).toMatch(/missing/);
  });

  it('under enforce, even a model the policy excludes is refused (it cannot be matched without the script)', async () => {
    writeState('enforce', [{ provider: 'openai' }]);
    expect(await run({ url: 'https://example.com' }, { providerID: 'anthropic', modelID: 'claude-x' })).toMatch(/\[agenfk airlock\]/);
  });

  it('under enforce, a call that carries nothing Airlock judges goes through', async () => {
    writeState('enforce');
    expect(await run({ todos: [] })).toBeNull();
  });

  it('under off, or with no state file, the call goes through', async () => {
    writeState('off');
    expect(await run({ command: 'ls' })).toBeNull();
    fs.rmSync(stateFile, { force: true });
    expect(await run({ command: 'ls' })).toBeNull();
  });
});

describe('OpenCode Airlock plugin: the shared script throws while loading', () => {
  beforeEach(() => {
    fs.writeFileSync(script, `throw new Error('broken install');\n`);
  });

  it('under enforce, the call is refused', async () => {
    writeState('enforce', [{ provider: 'openai' }]);
    expect(await run({ command: 'ls' }, { providerID: 'anthropic', modelID: 'claude-x' })).toMatch(/\[agenfk airlock\]/);
  });

  it('under off, the call goes through', async () => {
    writeState('off');
    expect(await run({ command: 'ls' })).toBeNull();
  });
});
