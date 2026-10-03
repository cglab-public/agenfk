/**
 * @vitest-environment node
 *
 * Re-capturing the login PATH without stampeding (CGLAB 8a6cdf70).
 *
 * The memoised value expires, and the code that noticed it had no single
 * flight: N concurrent callers all awaited the same stale promise, all woke in
 * the same batch, all compared against the same stale timestamp, and all
 * started a capture. Each capture is a real `$SHELL -lic env` — the user's
 * whole rc chain, nvm and rbenv and conda included, with a 1 MB buffer and a
 * five second timeout — for a value that is the same every time.
 *
 * The trigger is ordinary: any burst of terminal spawns more than the memo
 * window after boot, or an agent refresh landing alongside one.
 *
 * Extracted from the Electron bootstrap so the concurrency can be driven
 * deliberately, which is the only way to see this at all. The precedent is
 * `adoptFailure.ts`, separated for the same reason.
 */
import { describe, it, expect, vi } from 'vitest';
import { makeLoginPathCache, LOGIN_PATH_MEMO_MS } from '../main/loginPathCache';

/**
 * A capture that resolves only when told, so overlap can be built on purpose.
 *
 * Pending resolvers are QUEUED rather than kept as one, which matters: a test
 * that releases before a capture has started, or after several have, would
 * otherwise call whatever `release` happened to hold — and the first version
 * of this fixture did exactly that and threw.
 */
const controllable = (value: string | null = '/usr/bin:/opt/homebrew/bin') => {
  const pending: Array<() => void> = [];
  const calls = { n: 0 };
  const capture = vi.fn(() => {
    calls.n += 1;
    return new Promise<string | null>(resolve => { pending.push(() => resolve(value)); });
  });
  // Drains whatever is waiting; harmless when nothing is.
  return { capture, calls, release: () => pending.splice(0).forEach(fn => fn()) };
};

describe('the first capture', () => {
  it('runs exactly once however many callers arrive together', async () => {
    const { capture, calls, release } = controllable();
    const cache = makeLoginPathCache({ capture });
    const all = Promise.all([cache(), cache(), cache(), cache()]);
    release();
    expect(await all).toEqual(Array(4).fill('/usr/bin:/opt/homebrew/bin'));
    expect(calls.n).toBe(1);
  });

  it('is shared, not restarted, by a caller arriving mid-flight', async () => {
    // A terminal opened in the app's first second must WAIT for the capture
    // already running, not start a second one — the whole reason this may
    // answer with a promise.
    const { capture, calls, release } = controllable();
    const cache = makeLoginPathCache({ capture });
    const first = cache();
    const second = cache();
    release();
    await Promise.all([first, second]);
    expect(calls.n).toBe(1);
  });
});

describe('re-capturing when the memo goes stale', () => {
  it('does NOT start one per caller', async () => {
    /*
     * THE test. Four spawns arriving after the window: they all await the same
     * stale promise, they all wake in the same batch, and they all used to
     * evaluate the staleness check against the same stale timestamp — so all
     * four forked a login shell. On a machine with a heavy rc chain that is
     * seconds of CPU and hundreds of megabytes of transient memory.
     */
    let now = 1_000;
    const { capture, calls, release } = controllable();
    const cache = makeLoginPathCache({ capture, now: () => now });

    const first = cache();
    release();
    await first;
    expect(calls.n).toBe(1);

    now += LOGIN_PATH_MEMO_MS + 1;
    const burst = Promise.all([cache(), cache(), cache(), cache()]);
    release();
    await burst;
    expect(calls.n).toBe(2);
  });

  it('still re-captures later, rather than pinning the value forever', async () => {
    // The single flight must not turn into a permanent memo. The expiry exists
    // because the memo was once session-long, and that was the previous bug.
    let now = 1_000;
    const { capture, calls, release } = controllable();
    const cache = makeLoginPathCache({ capture, now: () => now });
    // The call has to come FIRST: `release` drains what is waiting, and
    // nothing is waiting until a capture has started.
    const settle = async () => { const p = cache(); release(); await p; };
    await settle();
    now += LOGIN_PATH_MEMO_MS + 1;
    await settle();
    now += LOGIN_PATH_MEMO_MS + 1;
    await settle();
    expect(calls.n).toBe(3);
  });

  it('does not re-capture while the value is still fresh', async () => {
    let now = 1_000;
    const { capture, calls, release } = controllable();
    const cache = makeLoginPathCache({ capture, now: () => now });
    const first = cache(); release(); await first;
    now += LOGIN_PATH_MEMO_MS - 1;
    await cache();
    expect(calls.n).toBe(1);
  });

  it('hands every caller in the burst the NEW value', async () => {
    // Joining the in-flight capture has to mean joining its result. Returning
    // the stale value to the followers would make the re-capture pointless
    // for everyone but the caller that happened to trigger it.
    let now = 1_000;
    let value = '/old';
    const capture = vi.fn(async () => value);
    const cache = makeLoginPathCache({ capture, now: () => now });
    expect(await cache()).toBe('/old');

    now += LOGIN_PATH_MEMO_MS + 1;
    value = '/new';
    expect(await Promise.all([cache(), cache()])).toEqual(['/new', '/new']);
  });
});

describe('when the capture fails', () => {
  it('lets the next caller try again rather than pinning a null', async () => {
    /*
     * A failed capture answers null — a login shell that timed out, or a
     * broken rc file. Treating that as a fresh value would degrade every
     * spawn for the rest of the session to whatever PATH launchd handed the
     * app, which is the very failure the capture exists to prevent.
     */
    let value: string | null = null;
    const capture = vi.fn(async () => value);
    const cache = makeLoginPathCache({ capture, now: () => 1_000 });
    expect(await cache()).toBeNull();
    value = '/recovered';
    expect(await cache()).toBe('/recovered');
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it('does not stampede on retry either', async () => {
    // The retry path is the one MOST likely to be hit by several callers at
    // once, because a failed capture leaves everybody unsatisfied.
    const { capture, calls, release } = controllable(null);
    const cache = makeLoginPathCache({ capture, now: () => 1_000 });
    const first = cache(); release(); await first;
    const burst = Promise.all([cache(), cache(), cache()]);
    release();
    await burst;
    expect(calls.n).toBe(2);
  });

  it('survives a capture that rejects', async () => {
    // Nothing should be able to make asking for the PATH throw at a spawn.
    const capture = vi.fn(async () => { throw new Error('shell exploded'); });
    const cache = makeLoginPathCache({ capture, now: () => 1_000 });
    await expect(cache()).resolves.toBeNull();
    await expect(cache()).resolves.toBeNull();
  });
});
