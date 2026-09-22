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

// The telemetry client is MOCKED below, but the constructor refuses to build
// one under a test runner unless asked (a guard the merge brought in, after 24
// real requests reached posthog.com per `npm test`). This is the test that
// wants the client, so it opts in.
process.env.AGENFK_TEST_ENABLE_TELEMETRY = '1';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: vi.fn(() => actual.homedir()) };
});

/**
 * The analytics client, so a test can see what would actually leave the machine.
 *
 * Asserting that `capture()` does not throw proves nothing: it is wrapped in a
 * try/catch precisely so it never throws. The only honest question is whether
 * anything was SENT, and that needs a spy on the thing that sends.
 */
const sent = vi.hoisted(() => vi.fn());
vi.mock('posthog-node', () => ({
  PostHog: vi.fn(function (this: Record<string, unknown>) {
    this.capture = sent;
    this.shutdown = vi.fn(async () => {});
  }),
}));

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

/**
 * A running process has to notice.
 *
 * The write side above is only half the guarantee, and an adversarial review
 * found the other half missing. `TelemetryClient` read the flag ONCE in its
 * constructor and cached it along with a live PostHog client; the server builds
 * exactly one at module load and captures through it for its whole life.
 *
 * So the settings screen's switch turned off, the route answered "off", the
 * file said "off" — and the long-lived process kept sending. That was invisible
 * to the route's own test, which asserts the file round-trip, because the file
 * round-trip was never the broken part.
 *
 * The CLI was safe here only by accident: every `agenfk config set telemetry`
 * is a fresh process. The settings screen is the first in-process opt-out.
 */
describe('a client that is already running', () => {
  it('stops capturing once telemetry is turned off underneath it', async () => {
    const { TelemetryClient } = await import('../index');
    // Constructed while telemetry is ON, which is the state that used to be
    // cached for the life of the process.
    setTelemetryEnabled(true);
    const client = new TelemetryClient();

    setTelemetryEnabled(false);

    expect(client.isEnabled, 'the client still reports itself enabled').toBe(false);
    /*
     * THE assertion: nothing reached the analytics client.
     *
     * `expect(...).not.toThrow()` was the first version of this line and it was
     * worthless - capture is wrapped in a try/catch so that it can never throw,
     * which means that assertion passed just as happily while the bug was
     * present. Verified by mutation: reverting the re-read leaves this red.
     */
    sent.mockClear();
    client.capture('item_created', { a: 1 });
    expect(sent, 'an event was sent after the user opted out').not.toHaveBeenCalled();
  });

  it('starts capturing again when it is turned back on', async () => {
    // The mirror. A client that latched OFF would be just as wrong, and would
    // be the obvious way to "fix" the above.
    const { TelemetryClient } = await import('../index');
    setTelemetryEnabled(true);
    const client = new TelemetryClient();
    setTelemetryEnabled(false);
    expect(client.isEnabled).toBe(false);
    setTelemetryEnabled(true);
    expect(client.isEnabled).toBe(true);
    sent.mockClear();
    client.capture('item_created', { a: 1 });
    expect(sent, 'opting back in did not resume capture').toHaveBeenCalled();
  });
});
