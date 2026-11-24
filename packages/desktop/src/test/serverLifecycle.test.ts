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
import { resolveServer, ServerUnavailableError, DatabaseOwnerError } from '../main/serverLifecycle.js';

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
  it('waits for an asynchronous spawn before polling for the port (BUG 474a8240)', async () => {
    // The server is forked only once the fresh PATH is in hand; polling while
    // that is still being captured would burn the wait budget on nothing.
    let started = false;
    let polledEarly = false;
    const spawn = vi.fn(async () => {
      await new Promise(r => setTimeout(r, 5));
      started = true;
    });
    const result = await resolveServer({
      readPort: () => (started ? 3000 : null),
      probe: async (p: number) => {
        if (!started && spawn.mock.calls.length > 0) polledEarly = true;
        return started && p === 3000;
      },
      spawn,
      waitMs: 0,
      adoptAttempts: 1,
    });
    expect(result.port).toBe(3000);
    expect(polledEarly).toBe(false);
  });

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

  it('finds its own server through the unfiltered reader, wherever it bound (PR #359 review)', async () => {
    // AGENFK_PORT=3100 with 3100-3186 busy: the server binds 3187, outside the
    // 16 ports the adopt filter keeps. The post-spawn poll must still find it.
    let started = false;
    const spawn = vi.fn(() => { started = true; });
    const result = await resolveServer({
      readPort: () => null,
      readSpawnedPort: () => (started ? 3187 : null),
      probe: async (p: number) => started && p === 3187,
      spawn,
      waitMs: 0,
      attempts: 3,
    });

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(result.adopted).toBe(false);
    expect(result.port).toBe(3187);
  });

  it('polls readPort after spawning when no separate reader is given', async () => {
    let started = false;
    const result = await resolveServer({
      readPort: () => (started ? 3005 : null),
      probe: async (p: number) => started && p === 3005,
      spawn: () => { started = true; },
      waitMs: 0,
    });

    expect(result.port).toBe(3005);
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

describe('resolveServer — a published server outside the adopt range (PR #359 review)', () => {
  // AGENFK_PORT=3100: the range is 3100-3115, while `agenfk up` published 3000
  // on the default database. The desktop would open that same SQLite file.
  const configured = { fallbackPorts: Array.from({ length: 16 }, (_, i) => 3100 + i), waitMs: 0, adoptAttempts: 1 };

  it('adopts it when it holds the database the desktop would use', async () => {
    const spawn = vi.fn();
    const result = await resolveServer({
      ...configured,
      readPort: () => 3000,
      probe: probeFor(3000),
      databaseOwner: async () => 'same',
      spawn,
    });
    expect(result).toMatchObject({ port: 3000, adopted: true });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('refuses to start a second server when it cannot tell whose database that is', async () => {
    const spawn = vi.fn();
    const run = resolveServer({
      ...configured,
      readPort: () => 3000,
      probe: probeFor(3000),
      databaseOwner: async () => 'unknown',
      spawn,
    });
    await expect(run).rejects.toBeInstanceOf(DatabaseOwnerError);
    await expect(run).rejects.toThrow(/3000/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('starts its own server when that one is on another database', async () => {
    let started = false;
    const result = await resolveServer({
      ...configured,
      readPort: () => 3000,
      readSpawnedPort: () => (started ? 3100 : null),
      probe: async p => p === 3000 || (started && p === 3100),
      databaseOwner: async () => 'different',
      spawn: () => { started = true; },
    });
    expect(result).toMatchObject({ port: 3100, adopted: false });
  });

  it('does not ask about a published server that is inside the range', async () => {
    const databaseOwner = vi.fn(async () => 'different' as const);
    const result = await resolveServer({
      ...configured,
      readPort: () => 3103,
      probe: probeFor(3103),
      databaseOwner,
      spawn: vi.fn(),
    });
    expect(result.port).toBe(3103);
    expect(databaseOwner).not.toHaveBeenCalled();
  });

  it('does not ask about a published port nothing answers on', async () => {
    let started = false;
    const databaseOwner = vi.fn(async () => 'unknown' as const);
    const result = await resolveServer({
      ...configured,
      readPort: () => 3000,
      readSpawnedPort: () => (started ? 3100 : null),
      probe: async p => started && p === 3100,
      databaseOwner,
      spawn: () => { started = true; },
    });
    expect(result.port).toBe(3100);
    expect(databaseOwner).not.toHaveBeenCalled();
  });
});

describe('resolveServer — the server it started (PR #359 review)', () => {
  it('never takes the shared port file for its own server while the child has not bound', async () => {
    // The file still names the server we declined to adopt; it answers, ours
    // does not yet. The poll must wait for the child's own port.
    let childPort: number | null = null;
    let polls = 0;
    const result = await resolveServer({
      readPort: () => 3000,
      readSpawnedPort: () => { polls++; if (polls === 3) childPort = 3100; return childPort; },
      probe: async p => p === 3000 || p === childPort,
      databaseOwner: async () => 'different',
      fallbackPorts: [3100],
      adoptAttempts: 1,
      spawn: () => {},
      waitMs: 0,
    });
    expect(result).toMatchObject({ port: 3100, adopted: false });
  });
});
