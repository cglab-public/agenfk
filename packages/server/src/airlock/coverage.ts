/**
 * SX-1 (8dd7c7c0): which requests come from an Airlock sandbox, and which cards
 * they touched.
 *
 * The launcher's proxy stamps every request the sandbox sends here with a marker
 * keyed by the Airlock report token (sessionMarker in core). The sandbox cannot
 * read that token, so it cannot mint a marker, and the sandbox refuses direct
 * loopback, so it cannot reach this server except through that proxy. This
 * middleware checks the marker, removes the header so no route ever sees it, and
 * records every card a marked request names - and that card's root, at that
 * moment - in its own table, which no item write can clear. A marker that does
 * not verify is refused (401), never let through uncovered.
 *
 * Naming is not enough on its own: bulk routes and imports write cards a request
 * never names. So every createItem / updateItem the server makes while handling
 * a covered request covers what it writes too (coverWritesIn), before the write
 * (the tree a card leaves) and after it (the card and the tree it joins).
 *
 * A card's tree is covered when ANY card in it is recorded (airlockTreeCovered).
 * Recording the root too means moving the card away later does not uncover the
 * tree it was in; checking the whole tree means it covers the one it moves to.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { AIRLOCK_SESSION_HEADER, airlockMarkerProject, verifyAirlockSessionMarker, type StorageProvider } from '@agenfk/core';

/** Set by the relay on a 401 for a marker that did not verify, so it can re-mint once (a token the server just replaced). */
export const AIRLOCK_MARKER_STATUS_HEADER = 'x-agenfk-airlock-marker';

/** 403: a sandboxed session setting a project's commands, or reaching /internal. */
export const AIRLOCK_PROJECT_COMMAND = 'AIRLOCK_PROJECT_COMMAND';
/** 403: a sandboxed session reaching the host's terminals (herdr panes, terminal sessions). */
export const AIRLOCK_HOST_TERMINAL = 'AIRLOCK_HOST_TERMINAL';
/**
 * 403: a sandboxed session reaching Airlock's own records (approvals, decisions, learning).
 * They carry other sessions' ids, and a grant is scoped by the session id a caller states:
 * a launch that could list them could spend a grant a person gave another (da69b17a review).
 */
export const AIRLOCK_RECORDS = 'AIRLOCK_RECORDS';
/** 409: a marker from a launcher older than PO-1, which does not say which project it is for. */
export const AIRLOCK_LAUNCH_OUTDATED = 'AIRLOCK_LAUNCH_OUTDATED';
/**
 * 403: a sandbox changing a project's root. The root's git origin is the
 * project's repository, which picks its per-project overrides (PO-1): an agent
 * that could repoint it could choose a looser policy for its own project.
 */
export const AIRLOCK_PROJECT_ROOT = 'AIRLOCK_PROJECT_ROOT';
const PROJECT_ROOT_MESSAGE = 'An Airlock session cannot change a project\'s root or delete a project: its repository decides the project\'s Airlock overrides. Do it outside the sandbox (agenfk update-project <id> --project-root <path>, or the board).';

/**
 * The covered request the current async work belongs to, if any. A sandbox may
 * reach any project's cards (da69b17a): Airlock blocks harmful agent behaviour,
 * it does not keep AgEnFK projects apart. What it touches is covered all the
 * same, so that card's commands run sandboxed under its own project's policy.
 */
const coveredRequest = new AsyncLocalStorage<{ since: string }>();

export interface AirlockCoverageDeps {
  storage: () => StorageProvider;
  /** The current report token; null when there is none (nothing is then covered). */
  reportToken: () => string | null;
  now?: () => number;
}

/** Ids a request names: its /items/:id path (Express routes case-insensitively), and itemId / parentId in the body or the query. */
function idsNamed(req: any): string[] {
  const ids: string[] = [];
  const m = /^\/items\/([^/?#]+)/i.exec(req.path ?? '');
  if (m) {
    try {
      ids.push(decodeURIComponent(m[1]));
    } catch {
      /* not a card id */
    }
  }
  for (const bag of [req.body, req.query]) {
    if (!bag || typeof bag !== 'object') continue;
    for (const key of ['itemId', 'parentId']) if (typeof bag[key] === 'string' && bag[key]) ids.push(bag[key]);
  }
  return ids;
}

const decodeURIComponentSafe = (s: string): string => { try { return decodeURIComponent(s); } catch { return s; } };

/** The root of a card's tree; the card itself when it has no parent (or a parent that does not exist). */
async function rootOf(storage: StorageProvider, itemId: string): Promise<string | null> {
  let current: any = await storage.getItem(itemId);
  if (!current) return null;
  const seen = new Set<string>([current.id]);
  while (current.parentId && !seen.has(current.parentId)) {
    const parent: any = await storage.getItem(current.parentId);
    if (!parent) break;
    seen.add(parent.id);
    current = parent;
  }
  return current.id;
}

/** Record the cards among `ids` that exist, and their roots. A name that is no card (`bulk`) is not recorded. */
async function cover(storage: StorageProvider, ids: Array<string | null | undefined>, since: string): Promise<void> {
  const all = new Set<string>();
  for (const id of new Set(ids)) {
    if (typeof id !== 'string' || !id) continue;
    const root = await rootOf(storage, id);
    if (!root) continue;
    all.add(id);
    all.add(root);
  }
  if (all.size) await storage.markAirlockCovered([...all], since);
}

/**
 * Wrap `storage` so every card written while a covered request is handled is
 * covered: the card and the tree it is in before the write, and after it. Like
 * withRecordRetention, it patches the instance and returns it.
 */
export function coverWritesIn<S extends StorageProvider>(storage: S): S {
  const create = storage.createItem.bind(storage);
  const update = storage.updateItem.bind(storage);
  storage.createItem = async (item) => {
    const ctx = coveredRequest.getStore();
    if (ctx) {
      // Recorded BEFORE the card is written: a record that fails leaves no
      // uncovered card behind (a record for a card that never got written is harmless).
      await cover(storage, [item.parentId], ctx.since);
      if (typeof item.id === 'string' && item.id) await storage.markAirlockCovered([item.id], ctx.since);
    }
    const made = await create(item);
    if (ctx && made.id !== item.id) await cover(storage, [made.id], ctx.since);
    return made;
  };
  const updateProject = storage.updateProject.bind(storage);
  storage.updateProject = async (id, updates) => {
    if (coveredRequest.getStore() && (updates as any)?.projectRoot !== undefined) {
      throw Object.assign(new Error(PROJECT_ROOT_MESSAGE), { code: AIRLOCK_PROJECT_ROOT });
    }
    return updateProject(id, updates);
  };
  storage.updateItem = async (id, updates) => {
    const ctx = coveredRequest.getStore();
    if (ctx) {
      await cover(storage, [id], ctx.since);
    }
    const updated = await update(id, updates);
    if (ctx) await cover(storage, [updated.id, updated.parentId], ctx.since);
    return updated;
  };
  return storage;
}

export function airlockCoverageMiddleware(deps: AirlockCoverageDeps) {
  const now = deps.now ?? Date.now;
  return async (req: any, res: any, next: (err?: unknown) => void): Promise<void> => {
    const value = req.headers?.[AIRLOCK_SESSION_HEADER];
    delete req.headers?.[AIRLOCK_SESSION_HEADER];
    if (value === undefined) return next();
    let token: string | null = null;
    try {
      token = deps.reportToken();
    } catch {
      token = null;
    }
    // A request that says it comes from a sandbox is never served as one that does not.
    if (!token) {
      return res.status(503).json({ error: 'This AgEnFK server cannot check the Airlock marker (its report token is missing or unreadable): agenfk restart.' });
    }
    const nonce = verifyAirlockSessionMarker(token, Array.isArray(value) ? value[0] : value);
    if (!nonce) {
      res.set(AIRLOCK_MARKER_STATUS_HEADER, 'invalid');
      return res.status(401).json({ error: 'The Airlock marker on this request does not verify.' });
    }
    // The project the launch was signed for (PO-1): what its tool calls are judged under.
    const project = airlockMarkerProject(nonce);
    if (project === undefined) {
      return res.status(409).json({
        error: AIRLOCK_LAUNCH_OUTDATED,
        message: 'This Airlock session was launched by an agenfk older than this server, which does not say which project it is for. Exit it and launch it again (agenfk airlock pi|opencode).',
      });
    }
    req.airlockSession = nonce;
    req.airlockProject = project;
    const ctx = { since: new Date(now()).toISOString() };
    try {
      const storage = deps.storage();
      // The host's terminals (BUG 794bb674): herdr panes take text and keys typed into shells
      // outside the sandbox, a terminal session launches an agent on the host. Refused here as
      // well as at the launcher's relay, whatever the request is.
      if (/^\/(?:herdr|terminal-sessions)(?:\/|$)/i.test(req.path ?? '')) {
        return res.status(403).json({ error: AIRLOCK_HOST_TERMINAL, message: 'An Airlock session cannot reach the host\'s terminals (herdr panes, terminal sessions).' });
      }
      // Airlock's own records are the board's and the host CLI's, whatever the method.
      if (/^\/airlock\/(?:approvals|decisions|learning)(?:\/|$)/i.test(req.path ?? '')) {
        return res.status(403).json({ error: AIRLOCK_RECORDS, message: 'An Airlock session cannot read or answer Airlock\'s approvals, decisions or learning: they are a person\'s, on the board (agenfk ui).' });
      }
      // A project's commands (BUG d4a53bf5): every later verify of a card no sandbox touched
      // runs them on the host. The sandbox holds the internal token, so its own project's are
      // refused too; a person sets them outside the sandbox. /internal is not an agent's either.
      if ((req.method === 'PUT' && /^\/projects\/[^/]+\/(?:verify-command|setup-command|test-report)\/?$/i.test(req.path ?? ''))
        || /^\/internal(?:\/|$)/i.test(req.path ?? '')) {
        return res.status(403).json({ error: AIRLOCK_PROJECT_COMMAND, message: 'An Airlock session cannot set a project\'s verify, setup or test-report command: a person sets it outside the sandbox (agenfk update-project).' });
      }
      // A flow's command checks run on the host for every card it governs (review): a sandbox
      // creates, changes, deletes, selects or installs no flow.
      const flowWrite = (req.method === 'POST' && /^\/(?:flows|projects\/[^/]+\/flow(?:\/(?:migrate|select-org))?|registry\/flows\/(?:install|publish))\/?$/i.test(req.path ?? ''))
        || ((req.method === 'PUT' || req.method === 'DELETE') && /^\/flows\/[^/]+\/?$/i.test(req.path ?? ''));
      if (flowWrite) {
        return res.status(403).json({ error: AIRLOCK_PROJECT_COMMAND, message: 'An Airlock session cannot create, change, select or install a flow: its command checks run on the host. A person does it outside the sandbox.' });
      }
      // Its root, or the project itself: the repository pin goes with either.
      if (/^\/projects\/[^/]+\/project-root\/?$/i.test(req.path ?? '') || (req.method === 'DELETE' && /^\/projects\/[^/]+\/?$/i.test(req.path ?? ''))) {
        return res.status(403).json({ error: AIRLOCK_PROJECT_ROOT, message: PROJECT_ROOT_MESSAGE });
      }
      const ids = idsNamed(req);
      // A run is reached through its card (/agent-runs/:id and its events).
      const run = /^\/agent-runs\/([^/?#]+)/i.exec(req.path ?? '');
      if (run) {
        const found: any = await storage.getAgentRun(decodeURIComponentSafe(run[1]));
        if (found?.itemId) ids.push(found.itemId);
      }
      await cover(storage, ids, ctx.since);
    } catch (e) {
      return next(e);
    }
    coveredRequest.run(ctx, () => next());
  };
}

/** Every card in the tree `itemId` belongs to: its root and all the root's descendants. */
async function treeOf(storage: StorageProvider, itemId: string): Promise<string[]> {
  const root = await rootOf(storage, itemId);
  if (!root) return [];
  const rootItem: any = await storage.getItem(root);
  const items: any[] = await storage.listItems({ projectId: rootItem.projectId } as any);
  const children = new Map<string, string[]>();
  for (const it of items) {
    if (!it.parentId) continue;
    const list = children.get(it.parentId) ?? [];
    list.push(it.id);
    children.set(it.parentId, list);
  }
  const tree: string[] = [];
  const queue = [root];
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    tree.push(id);
    queue.push(...(children.get(id) ?? []));
  }
  return tree;
}

/** Is any card in `itemId`'s tree recorded as touched by an Airlock sandbox? */
export async function airlockTreeCovered(storage: StorageProvider, itemId: string): Promise<boolean> {
  const tree = await treeOf(storage, itemId);
  return tree.length > 0 && (await storage.airlockCoveredAmong(tree)).length > 0;
}
