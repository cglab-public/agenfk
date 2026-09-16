/**
 * Turning telemetry on and off from somewhere that is not the CLI.
 *
 * `agenfk config set telemetry` has always written `~/.agenfk/config.json`
 * itself, inline in the command. That was fine while the CLI was the only
 * writer. The settings screen is a second one, and two hand-rolled
 * read-modify-writes over the same JSON file is how a config file loses the
 * keys the other writer did not know about.
 *
 * So the write moves next to `isTelemetryEnabled`, which is already the only
 * reader, and both callers use it. One file, one writer, one place where the
 * "do not clobber the other keys" rule is written down.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: vi.fn(() => actual.homedir()) };
});

import { isTelemetryEnabled, setTelemetryEnabled } from '../index';

let sandbox: string;
const configFile = (): string => path.join(sandbox, '.agenfk', 'config.json');

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-telemetry-'));
  vi.mocked(os.homedir).mockReturnValue(sandbox);
});
afterEach(() => {
  vi.mocked(os.homedir).mockRestore();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('writing the telemetry choice', () => {
  it('records an opt-out that the reader then sees', () => {
    // The pair is the point. A setter nothing reads back is the defect shape
    // this repo keeps finding.
    setTelemetryEnabled(false);
    expect(isTelemetryEnabled()).toBe(false);
  });

  it('records an opt-in again', () => {
    setTelemetryEnabled(false);
    setTelemetryEnabled(true);
    expect(isTelemetryEnabled()).toBe(true);
  });

  it('creates the directory rather than failing on a fresh install', () => {
    // A machine that has never run the CLI has no ~/.agenfk at all, and the
    // settings screen is reachable before any command has ever been typed.
    expect(fs.existsSync(path.join(sandbox, '.agenfk'))).toBe(false);
    setTelemetryEnabled(false);
    expect(JSON.parse(fs.readFileSync(configFile(), 'utf8')).telemetry).toBe(false);
  });

  it('leaves every other key in the file alone', () => {
    // THE failure this consolidation exists to prevent. flowRegistry and the
    // JIRA credentials live in this same file, and a naive write drops them.
    fs.mkdirSync(path.join(sandbox, '.agenfk'), { recursive: true });
    fs.writeFileSync(configFile(), JSON.stringify({
      flowRegistry: 'cglab-public/flows',
      github: { repos: { p1: { owner: 'cglab', repo: 'agenfk' } } },
    }));
    setTelemetryEnabled(false);
    const after = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    expect(after.flowRegistry).toBe('cglab-public/flows');
    expect(after.github.repos.p1.repo).toBe('agenfk');
    expect(after.telemetry).toBe(false);
  });

  it('does not destroy a config file it cannot parse', () => {
    // Overwriting unreadable JSON with `{telemetry:false}` throws away whatever
    // was in there — including credentials the user cannot regenerate. Refusing
    // is recoverable; a silent overwrite is not.
    fs.mkdirSync(path.join(sandbox, '.agenfk'), { recursive: true });
    fs.writeFileSync(configFile(), '{ this is not json');
    expect(() => setTelemetryEnabled(false)).toThrow();
    expect(fs.readFileSync(configFile(), 'utf8')).toBe('{ this is not json');
  });

  it('reads the home directory at call time, like every other path here', () => {
    // The 2026-08-31 clobber was a module-level os.homedir() capture. A new
    // writer that repeats it puts the same hole back.
    setTelemetryEnabled(false);
    const second = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-telemetry-2-'));
    try {
      vi.mocked(os.homedir).mockReturnValue(second);
      setTelemetryEnabled(true);
      expect(JSON.parse(fs.readFileSync(path.join(second, '.agenfk', 'config.json'), 'utf8')).telemetry).toBe(true);
      // And the first sandbox still holds what it was given.
      expect(JSON.parse(fs.readFileSync(configFile(), 'utf8')).telemetry).toBe(false);
    } finally {
      fs.rmSync(second, { recursive: true, force: true });
    }
  });
});
