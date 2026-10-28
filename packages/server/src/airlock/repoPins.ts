/**
 * PO-1: which repository a project is, for its Airlock overrides - pinned.
 *
 * The repository picks the project's per-project overrides, and a sandboxed
 * command can rewrite what its checkout says: it may not write .git/config, but
 * it can move .git away and plant another (measured on macOS). So the origin is
 * read once per project root (readAirlockRemoteUrl) and pinned in a file under
 * ~/.agenfk/airlock, which no sandbox may write; the launcher's policy fetch
 * reads it before its session's agent starts. It is read again only when the
 * root is not the one pinned, or after `forget` - when the root is set outside a
 * sandbox (agenfk update-project --project-root, the launcher for a project with
 * none), the way to pick up a changed origin. A project with no root and no pin
 * throws: its repository is unknown, not absent. A lookup that
 * failed pins nothing and throws, and Airlock refuses rather than guess; so does
 * a pin file that exists but cannot be read. The pin outlives the project's
 * root, and the first read for a root is never replaced by a later one.
 */
import * as fs from 'fs';
import { writePrivateFileSync } from '@agenfk/core';

interface Pin {
  root: string;
  url: string;
  pinnedAt: string;
}

export interface RepoPinDeps {
  /** ~/.agenfk/airlock/repo-pins.json */
  file: string;
  /** The project's root, or null when it has none. */
  rootOf: (projectId: string) => Promise<string | null>;
  read: (root: string) => Promise<{ url: string; cacheable: boolean }>;
}

export function airlockRepoPins(deps: RepoPinDeps) {
  /** A missing file is no pins yet; one that cannot be read or is not a pin map fails closed, never an empty start. */
  const load = (): Record<string, Pin> => {
    let text: string;
    try {
      text = fs.readFileSync(deps.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return {};
      throw new Error(`${deps.file} cannot be read (${(e as Error).message}); fix or remove it`);
    }
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { raw = null; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${deps.file} is not a pin map; fix or remove it`);
    return raw as Record<string, Pin>;
  };
  const save = (pins: Record<string, Pin>): void => writePrivateFileSync(deps.file, JSON.stringify(pins, null, 2) + '\n');
  // Bumped by forget: a read that started before it is not pinned.
  const generation = new Map<string, number>();
  // One read per project at a time: callers that arrive while it runs share it.
  const inFlight = new Map<string, Promise<string | null>>();

  const pinFor = async (projectId: string): Promise<string | null> => {
    const root = await deps.rootOf(projectId);
    const pin = load()[projectId];
    // The pin outlives the root: a project whose root is gone (or was never
    // set again) keeps the repository it was pinned to.
    if (pin && typeof pin.url === 'string' && (root === null || pin.root === root)) return pin.url || null;
    // No root and no pin: not "no repository" but unknown (`agenfk init` sets no root);
    // Airlock refuses what needs it rather than drop the repository's overrides.
    if (!root) throw new Error(`its root is not set; set it outside the sandbox: agenfk update-project ${projectId} --project-root <path> (agenfk airlock pi|opencode does it when it launches)`);
    const started = generation.get(projectId) ?? 0;
    const answer = await deps.read(root);
    if (!answer.cacheable) throw new Error('the lookup of its git origin timed out or failed');
    if ((generation.get(projectId) ?? 0) !== started) throw new Error('its root was set again while its origin was being read; retry');
    const now = load();
    // Never replace a pin for the same root: the first read is the trusted one.
    const existing = now[projectId];
    if (existing && existing.root === root && typeof existing.url === 'string') return existing.url || null;
    save({ ...now, [projectId]: { root, url: answer.url, pinnedAt: new Date().toISOString() } });
    return answer.url || null;
  };

  return {
    /** The project's pinned origin URL, or null for none; throws when it cannot be read or the project has no root. */
    repoOf(projectId: string): Promise<string | null> {
      const running = inFlight.get(projectId);
      if (running) return running;
      const p = pinFor(projectId).finally(() => inFlight.delete(projectId));
      inFlight.set(projectId, p);
      return p;
    },
    /** A person set the project's root: read its origin again next time. */
    forget(projectId: string): void {
      generation.set(projectId, (generation.get(projectId) ?? 0) + 1);
      inFlight.delete(projectId);
      const pins = load();
      if (!(projectId in pins)) return;
      delete pins[projectId];
      save(pins);
    },
  };
}
