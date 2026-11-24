/**
 * BUG db4e8cc2: the desktop ignored AGENFK_PORT.
 *
 * The server and the CLI honour AGENFK_PORT (then PORT). The desktop scanned a
 * fixed 3000-3015 for a server to adopt and trusted the port file whatever it
 * named, so a build meant to run apart from the AgEnFK someone works in
 * adopted it anyway: on Windows the WSL server on 3000 is forwarded to
 * localhost.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  adoptPortRange, boundPortReader, invalidPortMessage, parseBoundPort, portSetting,
} from '../main/adoptPorts.js';
import { buildServerEnv } from '../main/serverEnv.js';

describe('portSetting', () => {
  // Read exactly as the server reads it (server.ts REQUESTED_PORT:
  // parseInt(AGENFK_PORT || PORT)), so the desktop and the server it starts
  // never disagree about which port is meant.
  it('reads AGENFK_PORT first, then PORT', () => {
    expect(portSetting({ AGENFK_PORT: '3100', PORT: '4000' })).toEqual({ kind: 'port', port: 3100 });
    expect(portSetting({ PORT: '4000' })).toEqual({ kind: 'port', port: 4000 });
  });

  it('is unset when neither is set or both are empty', () => {
    expect(portSetting({})).toEqual({ kind: 'unset' });
    expect(portSetting({ AGENFK_PORT: '', PORT: '' })).toEqual({ kind: 'unset' });
  });

  it('takes the leading number the way the server does', () => {
    // A trailing comment from a .env or setx: the server requests 3100, so
    // the desktop must keep to 3100 too, not fall back to 3000.
    expect(portSetting({ AGENFK_PORT: '3100 # test build' })).toEqual({ kind: 'port', port: 3100 });
    expect(portSetting({ AGENFK_PORT: '3100abc' })).toEqual({ kind: 'port', port: 3100 });
    expect(portSetting({ AGENFK_PORT: '3100.0' })).toEqual({ kind: 'port', port: 3100 });
  });

  it('is invalid, not unset, when a value is set but names no port', () => {
    for (const bad of ['abc', '0', '-1', '65536', '  ']) {
      expect(portSetting({ AGENFK_PORT: bad }).kind, bad).toBe('invalid');
    }
  });

  it('does not fall through to PORT when AGENFK_PORT is set but unusable, as the server does not', () => {
    expect(portSetting({ AGENFK_PORT: 'abc', PORT: '4000' }).kind).toBe('invalid');
  });

  it('accepts the last port', () => {
    expect(portSetting({ AGENFK_PORT: '65535' })).toEqual({ kind: 'port', port: 65535 });
  });
});

describe('adoptPortRange', () => {
  it('is the 16 ports from the default when nothing is configured', () => {
    const range = adoptPortRange({}, 3000);
    expect(range).toHaveLength(16);
    expect(range[0]).toBe(3000);
    expect(range.at(-1)).toBe(3015);
  });

  it('starts at the configured port and never includes the default', () => {
    const range = adoptPortRange({ AGENFK_PORT: '3100' }, 3000);
    expect(range[0]).toBe(3100);
    expect(range.at(-1)).toBe(3115);
    expect(range).not.toContain(3000);
  });

  it('is empty when the setting is invalid, so nothing is adopted', () => {
    // Fail closed: an unreadable setting must not mean "use 3000".
    expect(adoptPortRange({ AGENFK_PORT: 'abc' }, 3000)).toEqual([]);
  });

  it('does not run past the last port', () => {
    expect(adoptPortRange({ AGENFK_PORT: '65530' }, 3000).at(-1)).toBe(65535);
  });
});

describe('parseBoundPort', () => {
  // The line the server prints once it listens (server.ts, httpServer.listen).
  it('reads the port from the server startup line', () => {
    expect(parseBoundPort('AgEnFK API Server running on 127.0.0.1:3187 (with WebSockets)')).toBe(3187);
    expect(parseBoundPort('AgEnFK API Server running on ::1:3100 (with WebSockets)')).toBe(3100);
  });

  it('ignores every other line, including the bump notice', () => {
    expect(parseBoundPort('AgEnFK API Server: requested port 3100 was in use, bound to 3187 instead')).toBeNull();
    expect(parseBoundPort('Client connected to WebSockets')).toBeNull();
    expect(parseBoundPort('')).toBeNull();
  });

  it('ignores a log line that only contains the startup text', () => {
    expect(parseBoundPort('GET /x?q=AgEnFK API Server running on 127.0.0.1:6666 (with WebSockets)')).toBeNull();
    expect(parseBoundPort('AgEnFK API Server running on 127.0.0.1:6666 (with WebSockets) trailing')).toBeNull();
  });

  it('rejects a port outside 1 to 65535', () => {
    expect(parseBoundPort('AgEnFK API Server running on 127.0.0.1:0 (with WebSockets)')).toBeNull();
    expect(parseBoundPort('AgEnFK API Server running on 127.0.0.1:70000 (with WebSockets)')).toBeNull();
  });
});

describe('boundPortReader', () => {
  const START = (p: number) => `AgEnFK API Server running on 127.0.0.1:${p} (with WebSockets)`;

  it('parses a startup line split across two chunks', () => {
    const r = boundPortReader();
    r.push('noise\nAgEnFK API Server running on 127.0.');
    expect(r.port()).toBeNull();
    r.push('0.1:3187 (with WebSockets)\r\n');
    expect(r.port()).toBe(3187);
  });

  it('keeps the first startup line and ignores a later look-alike', () => {
    const r = boundPortReader();
    r.push(`${START(3100)}\n${START(6666)}\n`);
    r.push(`${START(7777)}\n`);
    expect(r.port()).toBe(3100);
  });

  it('ignores a log line with the pattern mid-line', () => {
    const r = boundPortReader();
    r.push(`GET /?x=${START(6666)}\n`);
    expect(r.port()).toBeNull();
  });

  it('waits for the newline before it trusts a line', () => {
    const r = boundPortReader();
    r.push(START(3100));
    expect(r.port()).toBeNull();
  });

  it('starts over after reset', () => {
    const r = boundPortReader();
    r.push(`${START(3100)}\n`);
    r.reset();
    expect(r.port()).toBeNull();
    r.push(`${START(3101)}\n`);
    expect(r.port()).toBe(3101);
  });
});

describe('invalidPortMessage', () => {
  // An unreadable value used to end inside resolveServer 15 s later, with a
  // dialog blaming `agenfk up` and never naming the variable (PR #359 review).
  it('names the variable, the raw value and the valid range', () => {
    const message = invalidPortMessage({ AGENFK_PORT: 'abc' });
    expect(message).toContain('AGENFK_PORT');
    expect(message).toContain('"abc"');
    expect(message).toContain('1 to 65535');
  });

  it('names PORT when PORT is the value that was read', () => {
    const message = invalidPortMessage({ PORT: '-1' });
    expect(message).toContain('PORT');
    expect(message).not.toContain('AGENFK_PORT');
    expect(message).toContain('"-1"');
  });

  it('refuses 0, which would start the server on a random port', () => {
    expect(invalidPortMessage({ AGENFK_PORT: '0' })).toContain('"0"');
  });

  it('is null when the setting is unset or names a port', () => {
    expect(invalidPortMessage({})).toBeNull();
    expect(invalidPortMessage({ AGENFK_PORT: '3100' })).toBeNull();
  });
});

describe('the server the desktop starts', () => {
  it('requests the configured port, because it inherits AGENFK_PORT', () => {
    const env = buildServerEnv(
      { AGENFK_PORT: '3100', PATH: '/usr/bin' },
      { uiDir: '/ui', dbPath: '/db.sqlite', freshPath: null },
      { pathDelimiter: ':', envKeysIgnoreCase: false },
    );
    expect(env.AGENFK_PORT).toBe('3100');
  });
});

describe('the desktop main process', () => {
  // boot() never runs behind mainWiring.test.ts's stand-in Electron (its
  // whenReady never settles), so these lines inside boot are pinned as text.
  const source = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../main/index.ts'), 'utf8');

  it('takes the adopt range from the environment', () => {
    expect(source).toMatch(/const ADOPT_PORT_RANGE = adoptPortRange\(process\.env, DEFAULT_API_PORT\)/);
  });

  it('reads the published port unfiltered and judges its database', () => {
    const call = source.slice(source.indexOf('resolveServer({'), source.indexOf('spawn: startServer'));
    expect(call).toMatch(/readPort:\s*readServerPort\b/);
    expect(call).toMatch(/fallbackPorts:\s*ADOPT_PORT_RANGE/);
    expect(call).toMatch(/databaseOwner:/);
  });

  it('finds its own server through the port its child reports, never the shared file', () => {
    const call = source.slice(source.indexOf('resolveServer({'), source.indexOf('spawn: startServer'));
    expect(call).toMatch(/readSpawnedPort:\s*\(\)\s*=>\s*spawnedPortReader\.port\(\)/);
    expect(call).not.toMatch(/readSpawnedPort:\s*readServerPort/);
  });

  it('stops on an unreadable port setting before looking for a server', () => {
    const body = source.slice(source.indexOf('async function boot()'));
    const check = body.indexOf('invalidPortMessage(process.env)');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(body.indexOf('resolveServer({'));
  });
});
