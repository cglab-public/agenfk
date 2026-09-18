/**
 * CGLAB-167: how the desktop main process gets a server to talk to.
 *
 * The rule that matters: never end up with two servers on one SQLite database.
 * A developer running `agenfk up` in a terminal and then opening the app must
 * get ONE server — the one already running — not a second one racing it for
 * the same file. Everything here is dependency-injected so the decision logic
 * is tested without spawning processes or booting Electron.
 */
import { describe, it, expect, vi } from 'vitest';
import { resolveServer, ServerUnavailableError } from '../main/serverLifecycle.js';

/** A probe that answers true only for the ports listed. */
const probeFor = (...live: number[]) =>
  vi.fn(async (port: number) => live.includes(port));

const never = async (): Promise<boolean> => false;

describe('resolveServer — adopting an already-running server', () => {
  it('adopts the server named in the port file instead of spawning', async () => {
    const spawn = vi.fn();
    const result = await resolveServer({
      readPort: () => 3000,
      probe: probeFor(3000),
      spawn,
      waitMs: 0,
    });

    expect(result.adopted).toBe(true);
    expect(result.port).toBe(3000);
    expect(result.url).toBe('http://127.0.0.1:3000');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('adopts a non-default port, because the server probes upward when 3000 is taken', async () => {
    const result = await resolveServer({
      readPort: () => 3007,
      probe: probeFor(3007),
      spawn: vi.fn(),
      waitMs: 0,
    });
    expect(result.port).toBe(3007);
    expect(result.adopted).toBe(true);
  });

  it('adopts a server on the default port when the port file is missing', async () => {
    // Observed for real on a dev machine: a server was listening on 3000 with
    // no ~/.agenfk/server-port file (removed on a previous clean shutdown).
    // Trusting the file alone would fork a SECOND server onto the same SQLite
    // database — precisely the collision this whole function exists to avoid.
    const spawn = vi.fn();
    const result = await resolveServer({
      readPort: () => null,
      fallbackPorts: [3000],
      probe: probeFor(3000),
      spawn,
      waitMs: 0,
    });

    expect(result.adopted).toBe(true);
    expect(result.port).toBe(3000);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('prefers the published port over the fallback when both answer', async () => {
    const result = await resolveServer({
      readPort: () => 3007,
      fallbackPorts: [3000],
      probe: probeFor(3000, 3007),
      spawn: vi.fn(),
      waitMs: 0,
    });
    expect(result.port).toBe(3007);
  });

  it('still spawns when neither the port file nor the fallback answers', async () => {
    let started = false;
    const spawn = vi.fn(() => { started = true; });
    const result = await resolveServer({
      readPort: () => (started ? 3001 : null),
      fallbackPorts: [3000],
      probe: async (p: number) => started && p === 3001,
      spawn,
      waitMs: 0,
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(result.port).toBe(3001);
    expect(result.adopted).toBe(false);
  });

  it('retries before concluding nobody is home', async () => {
    // A live server that is briefly slow (periodic backup, loaded machine)
    // times out one probe. Treating a single 1.5s timeout as "no server" and
    // spawning is how you end up with two servers on one SQLite file — the
    // exact thing this module exists to prevent.
    let calls = 0;
    const spawn = vi.fn();
    const result = await resolveServer({
      readPort: () => 3000,
      probe: async () => { calls += 1; return calls >= 2; },
      spawn,
      waitMs: 0,
      adoptAttempts: 3,
    });

    expect(result.adopted).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('still spawns once the retries are genuinely exhausted', async () => {
    let started = false;
    const spawn = vi.fn(() => { started = true; });
    const result = await resolveServer({
      readPort: () => (started ? 3000 : 3000),
      probe: async () => started,
      spawn,
      waitMs: 0,
      adoptAttempts: 2,
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(result.adopted).toBe(false);
  });

  it('probes a port once per round even when the fallback repeats it', async () => {
    const probe = vi.fn(async () => false);
    await expect(resolveServer({
      readPort: () => 3000,
      fallbackPorts: [3000],
      probe,
      spawn: vi.fn(),
      waitMs: 0,
      adoptAttempts: 1,
      attempts: 1,
    })).rejects.toBeInstanceOf(ServerUnavailableError);
    // One adoption round + one post-spawn poll — not four calls.
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('an adopted server is never stopped by us — we did not start it', async () => {
    const result = await resolveServer({
      readPort: () => 3000,
      probe: probeFor(3000),
      spawn: vi.fn(),
      waitMs: 0,
    });
    const stopChild = vi.fn();
    result.stop(stopChild);
    expect(stopChild).not.toHaveBeenCalled();
  });
});

describe('resolveServer — spawning our own', () => {
  it('spawns when there is no port file at all', async () => {
    let started = false;
    const spawn = vi.fn(() => { started = true; });
    const result = await resolveServer({
      readPort: () => (started ? 3000 : null),
      probe: async (p: number) => started && p === 3000,
      spawn,
      waitMs: 0,
    });

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(result.adopted).toBe(false);
    expect(result.port).toBe(3000);
  });

  it('spawns when the port file is stale and nothing answers there', async () => {
    // Classic leftover: the file survived a crash, the process did not.
    let started = false;
    const spawn = vi.fn(() => { started = true; });
    const result = await resolveServer({
      readPort: () => (started ? 3011 : 3000),
      probe: async (p: number) => started && p === 3011,
      spawn,
      waitMs: 0,
    });

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(result.port).toBe(3011);
    expect(result.adopted).toBe(false);
  });

  it('stops the server it started', async () => {
    let started = false;
    const result = await resolveServer({
      readPort: () => (started ? 3000 : null),
      probe: async (p: number) => started && p === 3000,
      spawn: () => { started = true; },
      waitMs: 0,
    });

    const stopChild = vi.fn();
    result.stop(stopChild);
    expect(stopChild).toHaveBeenCalledTimes(1);
  });

  it('waits for the server to actually answer, not merely for the port file', async () => {
    // The port file is written before the first request can be served; a
    // window loaded in that gap shows a connection error.
    let probes = 0;
    const result = await resolveServer({
      readPort: () => 3000,
      probe: async () => { probes += 1; return probes >= 3; },
      spawn: vi.fn(),
      waitMs: 0,
      attempts: 10,
    });
    expect(probes).toBeGreaterThanOrEqual(3);
    expect(result.port).toBe(3000);
  });
});

describe('resolveServer — failure', () => {
  it('gives up with a clear error instead of hanging forever', async () => {
    await expect(resolveServer({
      readPort: () => null,
      probe: never,
      spawn: vi.fn(),
      waitMs: 0,
      attempts: 3,
    })).rejects.toBeInstanceOf(ServerUnavailableError);
  });

  it('reports how long it waited, so the failure is diagnosable', async () => {
    await expect(resolveServer({
      readPort: () => null,
      probe: never,
      spawn: vi.fn(),
      waitMs: 0,
      attempts: 3,
    })).rejects.toThrow(/3 attempt/i);
  });

  it('does not spawn a second time while still waiting on the first', async () => {
    const spawn = vi.fn();
    await expect(resolveServer({
      readPort: () => null,
      probe: never,
      spawn,
      waitMs: 0,
      attempts: 5,
    })).rejects.toBeInstanceOf(ServerUnavailableError);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('surfaces a spawn failure rather than silently waiting it out', async () => {
    await expect(resolveServer({
      readPort: () => null,
      probe: never,
      spawn: () => { throw new Error('ENOENT: server.js missing'); },
      waitMs: 0,
      attempts: 3,
    })).rejects.toThrow(/ENOENT/);
  });
});
