/**
 * HOME isolation — the 2026-08-31 / 2026-09-01 clobber incident (item 9c297075).
 *
 * StrykerJS mutation runs wrote test-fixture hub.json values into the REAL
 * ~/.agenfk twice: once losing 57 hub events (WAL-recovered), once destroying
 * the real hub credentials (token rotated; re-login never happened).
 *
 * Two structural fixes are verified here:
 *  1. Hub/telemetry home paths resolve at CALL time (process.env.HOME), not at
 *     import time — so per-test HOME overrides are always effective, including
 *     under the Stryker vitest runner (module-level `os.homedir()` captures
 *     happened at worker boot, before any test could set HOME).
 *  2. The vitest runner pins process.env.HOME to a per-run sandbox
 *     (see vitest.config.ts / scripts/vitest-home-pin.mjs), so a test that
 *     forgets to sandbox writes into the sandbox, never the machine home.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { hubConfigPath } from '../hub/hubClient';
import { defaultDeadletterPath } from '../hub/flusher';
import { agenfkDir } from '@agenfk/telemetry';

// Set by the vitest config BEFORE the HOME pin — the machine's real home.
const REAL_HOME = process.env.AGENFK_REAL_HOME;

describe('home isolation (item 9c297075)', () => {
  it('the vitest runner pins HOME to a per-run sandbox, not the machine home', () => {
    expect(REAL_HOME, 'AGENFK_REAL_HOME unset — the vitest HOME pin is missing').toBeTruthy();
    expect(process.env.HOME).toBeTruthy();
    expect(process.env.HOME, 'test HOME must differ from the real home').not.toBe(REAL_HOME);
    // The sandbox is pre-seeded with the framework dir so code that reads
    // verify-token/server-port gets "absent", not "hostile".
    expect(fs.existsSync(path.join(process.env.HOME!, '.agenfk'))).toBe(true);
  });

  it('the hub config path resolves against the CURRENT home (lazy, not import-time)', () => {
    expect(hubConfigPath()).toBe(path.join(process.env.HOME!, '.agenfk', 'hub.json'));
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-lazy-'));
    const prev = process.env.HOME;
    process.env.HOME = sandbox;
    try {
      expect(hubConfigPath()).toBe(path.join(sandbox, '.agenfk', 'hub.json'));
    } finally {
      process.env.HOME = prev;
    }
  });

  it('the deadletter path resolves against the CURRENT home (lazy)', () => {
    expect(defaultDeadletterPath()).toBe(path.join(process.env.HOME!, '.agenfk', 'hub-deadletter.jsonl'));
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-lazy-'));
    const prev = process.env.HOME;
    process.env.HOME = sandbox;
    try {
      expect(defaultDeadletterPath()).toBe(path.join(sandbox, '.agenfk', 'hub-deadletter.jsonl'));
    } finally {
      process.env.HOME = prev;
    }
  });

  it('the telemetry agenfk dir resolves against the CURRENT home (lazy)', () => {
    expect(agenfkDir()).toBe(path.join(process.env.HOME!, '.agenfk'));
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-lazy-'));
    const prev = process.env.HOME;
    process.env.HOME = sandbox;
    try {
      expect(agenfkDir()).toBe(path.join(sandbox, '.agenfk'));
    } finally {
      process.env.HOME = prev;
    }
  });

  it('a write through the lazy hub path lands in the sandbox home, never the real home', () => {
    const p = hubConfigPath();
    expect(p.startsWith(process.env.HOME!)).toBe(true);
    expect(p.startsWith(REAL_HOME!), 'path must not point into the real home').toBe(false);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ url: 'https://sandbox.example', token: 'test-token', orgId: 'test-org' }));
    expect(JSON.parse(fs.readFileSync(p, 'utf8')).token).toBe('test-token');
    fs.rmSync(p, { force: true });
  });
});
