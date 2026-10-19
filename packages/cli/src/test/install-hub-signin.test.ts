/**
 * Story 76da75ea (INFRA-463), criterion 4: when no hub.json exists and
 * discovery finds a Hub, the installer offers sign-in. Interactive: ask, and
 * run `agenfk hub login` on yes. Non-interactive: print the command. --no-hub
 * and AGENFK_NO_HUB=1 skip the step, before any discovery (no network).
 * The step fails open: nothing it does may fail the install.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { hubSignInStep, offerHubSignIn } from '../../../../scripts/install-helpers.mjs';

const ROOT = path.resolve(__dirname, '../../../..');
const FOUND = { url: 'https://hub.acme.com', source: 'dns', reasons: [] };

function deps(o: Partial<Record<string, any>> = {}) {
  const printed: string[] = [];
  return {
    printed,
    argv: o.argv ?? ['node', 'install.mjs'],
    env: o.env ?? {},
    isTTY: o.isTTY ?? true,
    hubConfigExists: o.hubConfigExists ?? false,
    discover: o.discover ?? vi.fn(async () => FOUND),
    ask: o.ask ?? vi.fn(async () => ''),
    runLogin: o.runLogin ?? vi.fn(async () => 0),
    print: (s: string) => { printed.push(s); },
  };
}

describe('installer hub sign-in step', () => {
  it('interactive TTY: offers sign-in and runs agenfk hub login on the default answer', async () => {
    const d = deps();
    const r = await hubSignInStep(d);
    expect(d.ask).toHaveBeenCalledTimes(1);
    expect(String((d.ask as any).mock.calls[0][0])).toMatch(/hub\.acme\.com/);
    expect(d.runLogin).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ action: 'login' });
  });

  it('interactive TTY: answering no skips the login', async () => {
    const d = deps({ ask: vi.fn(async () => 'n') });
    const r = await hubSignInStep(d);
    expect(d.runLogin).not.toHaveBeenCalled();
    expect(r).toMatchObject({ action: 'skipped' });
  });

  it('non-interactive: prints the command instead of prompting or running it', async () => {
    const d = deps({ isTTY: false });
    const r = await hubSignInStep(d);
    expect(d.ask).not.toHaveBeenCalled();
    expect(d.runLogin).not.toHaveBeenCalled();
    expect(d.printed.join('\n')).toMatch(/agenfk hub login/);
    expect(d.printed.join('\n')).toMatch(/hub\.acme\.com/);
    expect(r).toMatchObject({ action: 'printed' });
  });

  it('--no-hub skips the step before any discovery', async () => {
    const d = deps({ argv: ['node', 'install.mjs', '--no-hub'] });
    const r = await hubSignInStep(d);
    expect(d.discover).not.toHaveBeenCalled();
    expect(d.ask).not.toHaveBeenCalled();
    expect(d.runLogin).not.toHaveBeenCalled();
    expect(r).toMatchObject({ action: 'skipped' });
  });

  it('AGENFK_NO_HUB=1 skips the step before any discovery', async () => {
    const d = deps({ env: { AGENFK_NO_HUB: '1' } });
    const r = await hubSignInStep(d);
    expect(d.discover).not.toHaveBeenCalled();
    expect(d.runLogin).not.toHaveBeenCalled();
    expect(r).toMatchObject({ action: 'skipped' });
  });

  it('AGENFK_NO_HUB=0 does not skip', async () => {
    const d = deps({ env: { AGENFK_NO_HUB: '0' } });
    await hubSignInStep(d);
    expect(d.discover).toHaveBeenCalledTimes(1);
  });

  it('an existing hub.json skips the step before any discovery', async () => {
    const d = deps({ hubConfigExists: true });
    const r = await hubSignInStep(d);
    expect(d.discover).not.toHaveBeenCalled();
    expect(d.runLogin).not.toHaveBeenCalled();
    expect(r).toMatchObject({ action: 'skipped' });
  });

  it('discovery finds nothing: no prompt, no login', async () => {
    const d = deps({ discover: vi.fn(async () => ({ url: null, reasons: ['none'] })) });
    const r = await hubSignInStep(d);
    expect(d.ask).not.toHaveBeenCalled();
    expect(d.runLogin).not.toHaveBeenCalled();
    expect(r).toMatchObject({ action: 'skipped' });
  });

  it('fails open: a discovery that throws does not fail the install', async () => {
    const d = deps({ discover: vi.fn(async () => { throw new Error('boom'); }) });
    await expect(hubSignInStep(d)).resolves.toMatchObject({ action: 'skipped' });
  });

  it('a login that exits non-zero is reported as not signed in, with how to retry', async () => {
    const d = deps({ runLogin: vi.fn(async () => 1) });
    const r = await hubSignInStep(d);
    expect(r).toEqual({ action: 'skipped', reason: 'login exited 1' });
    expect(d.printed.join('\n')).toMatch(/exit 1/);
    expect(d.printed.join('\n')).toMatch(/agenfk hub login/);
  });

  it('fails open: a login that fails does not fail the install, and says how to retry', async () => {
    const d = deps({ runLogin: vi.fn(async () => { throw new Error('exit 1'); }) });
    await expect(hubSignInStep(d)).resolves.toBeDefined();
    expect(d.printed.join('\n')).toMatch(/agenfk hub login/);
  });
});

describe('installer wiring', () => {
  it('install.mjs runs the hub sign-in step', () => {
    const src = readFileSync(path.join(ROOT, 'scripts', 'install.mjs'), 'utf8');
    // One call, unconditional except for --quiet, on the full-install branch.
    expect(src).toMatch(/if \(!quiet\) await offerHubSignIn\(\{ rootDir \}\)\.catch\(/);
    expect(src.match(/offerHubSignIn\(/g)).toHaveLength(1);
  });

  it.each([
    ['bin/agenfk.js'],
    ['packages/create/bin/agenfk.js'],
  ])('%s forwards --no-hub to install.mjs', (rel) => {
    const src = readFileSync(path.join(ROOT, rel), 'utf8');
    if (rel === 'bin/agenfk.js') {
      // The root launcher builds its command in bin/install-command.mjs, whose
      // own test asserts --no-hub on the built command.
      expect(src).toMatch(/execSync\(installCommand\(process\.argv\)/);
      expect(readFileSync(path.join(ROOT, 'bin', 'install-command.mjs'), 'utf8')).toMatch(/'--no-hub'/);
    } else {
      expect(src).toMatch(/process\.argv\.includes\('--no-hub'\) \? ' --no-hub' : ''/);
    }
  });
});

describe('offerHubSignIn: the deps install.mjs wires into the step', () => {
  const base = (o: Record<string, any> = {}) => ({
    rootDir: '/opt/agenfk',
    argv: ['node', 'install.mjs'],
    env: {},
    isTTY: false,
    homedir: () => '/home/dev',
    exists: () => false,
    importModule: vi.fn(async () => ({ discoverHub: async () => FOUND })),
    spawn: vi.fn(() => ({ status: 0 })),
    ask: vi.fn(async () => ''),
    print: vi.fn(),
    ...o,
  });

  it('loads discovery from the CLI build under rootDir', async () => {
    const b = base();
    await offerHubSignIn(b);
    expect(String(b.importModule.mock.calls[0][0])).toMatch(/packages[\\/]cli[\\/]dist[\\/]hub[\\/]discovery\.js$/);
  });

  it('accepts a CommonJS build that exposes discoverHub on default', async () => {
    const b = base({ importModule: vi.fn(async () => ({ default: { discoverHub: async () => FOUND } })) });
    expect(await offerHubSignIn(b)).toMatchObject({ action: 'printed' });
  });

  it('checks ~/.agenfk/hub.json under the given home', async () => {
    const seen: string[] = [];
    const b = base({ exists: (p: string) => { seen.push(p); return true; } });
    expect(await offerHubSignIn(b)).toMatchObject({ action: 'skipped', reason: 'hub.json exists' });
    expect(seen.some(p => /\.agenfk[\\/]hub\.json$/.test(p))).toBe(true);
  });

  it('runs the built CLI hub login on yes and reports its exit status', async () => {
    const b = base({ isTTY: true, spawn: vi.fn(() => ({ status: 3 })) });
    const r = await offerHubSignIn(b);
    expect(b.spawn).toHaveBeenCalledTimes(1);
    const args = b.spawn.mock.calls[0][1];
    expect(args.slice(-2)).toEqual(['hub', 'login']);
    expect(String(args[0])).toMatch(/packages[\\/]cli[\\/]dist[\\/]index\.js$/);
    expect(r).toEqual({ action: 'skipped', reason: 'login exited 3' });
  });

  it('skips, without throwing, when the build has no discovery module', async () => {
    const b = base({ importModule: vi.fn(async () => { throw new Error('Cannot find module'); }) });
    expect(await offerHubSignIn(b)).toMatchObject({ action: 'skipped' });
  });
});
