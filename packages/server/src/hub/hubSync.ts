/**
 * GH-346 — the one loop that keeps this installation in step with the hub.
 *
 * It replaced four timers (the event flusher, the flow reconciler, the repoint
 * and the upgrade reconcilers). The flow reconciler ran flows, repo settings,
 * Airlock and receipts one after another and scheduled its next tick only once
 * the current one had finished, so a single request that never answered
 * stopped every later sync, silently, until a restart.
 *
 * Here each tick starts every channel at once and the timer never waits for
 * them. A channel still running from an earlier tick is skipped, so it is
 * never run alongside itself (an upgrade directive can take minutes to apply).
 * A channel that fails logs one line and holds up nothing else.
 */

export interface HubSyncChannel {
  name: string;
  run: () => unknown;
}

export interface HubSyncHandle {
  stop: () => void;
}

export const DEFAULT_HUB_SYNC_INTERVAL_MS = 30_000;
const DEFAULT_FIRST_DELAY_MS = 2_000;

export interface StartHubSyncArgs {
  channels: HubSyncChannel[];
  intervalMs?: number;
  /** Before the first tick: lets boot-time work (the upgrade outcome replay) queue its events first. */
  firstDelayMs?: number;
}

export function startHubSync(args: StartHubSyncArgs): HubSyncHandle {
  const intervalMs = args.intervalMs ?? DEFAULT_HUB_SYNC_INTERVAL_MS;
  const inFlight = new Set<string>();
  let stopped = false;
  let interval: NodeJS.Timeout | null = null;

  const tick = (): void => {
    if (stopped) return;
    for (const channel of args.channels) {
      if (inFlight.has(channel.name)) continue;
      inFlight.add(channel.name);
      Promise.resolve()
        .then(() => channel.run())
        .catch((e) => console.error(`[HUB_SYNC] ${channel.name} failed:`, (e as Error)?.message ?? e))
        .finally(() => inFlight.delete(channel.name));
    }
  };

  const first = setTimeout(() => {
    if (stopped) return;
    tick();
    interval = setInterval(tick, intervalMs);
    interval.unref?.();
  }, args.firstDelayMs ?? DEFAULT_FIRST_DELAY_MS);
  first.unref?.();

  return {
    stop: () => {
      stopped = true;
      clearTimeout(first);
      if (interval) clearInterval(interval);
    },
  };
}
