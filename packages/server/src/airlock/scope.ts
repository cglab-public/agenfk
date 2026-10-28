/**
 * A sandboxed session's listings are its own project's (BUG afc07064, epic review).
 *
 * The coverage middleware refuses a request that NAMES another project or card;
 * a listing that names none answered with every project's records. For a marked
 * request (req.airlockProject, set by airlockCoverageMiddleware), a GET or HEAD of:
 *  - a listing that filters by project is read with the launch's project as its
 *    filter, whatever the request said (one naming another is refused before this);
 *  - the projects listing answers with the launch's project alone;
 *  - a listing that cannot be narrowed to one project is refused. None of them is
 *    called by agenfk, pi or OpenCode from inside the sandbox.
 * A launch signed for no project gets none of them. An unmarked request (the
 * board, the CLI outside the sandbox) is untouched.
 */
export const AIRLOCK_UNSCOPED_LISTING = 'AIRLOCK_UNSCOPED_LISTING';

const BY_PROJECT = new Set(['/items', '/agent-runs', '/token-events']);
const UNSCOPED = new Set(['/airlock/approvals', '/airlock/decisions', '/airlock/learning', '/verify-runs', '/hub/refusals', '/db/status']);

export function airlockCollectionScope() {
  return (req: any, res: any, next: () => void): void => {
    // HEAD runs the GET route (its length and ETag tell of what it read): judged the same.
    if (req.airlockSession === undefined || (req.method !== 'GET' && req.method !== 'HEAD')) return next();
    const project: string | null = typeof req.airlockProject === 'string' ? req.airlockProject : null;
    // As Express routes it: without case, and with a trailing slash or not.
    const p = String(req.path ?? '').toLowerCase().replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
    const listing = BY_PROJECT.has(p) || p === '/projects' || UNSCOPED.has(p);
    if (!listing) return next();
    // A launch signed for no project has no project to read: its listings are refused.
    if (project === null) {
      res.status(403).json({ error: AIRLOCK_UNSCOPED_LISTING, message: `This Airlock session was launched outside any project, so it reads no project's ${p}.` });
      return;
    }
    if (BY_PROJECT.has(p)) {
      // Express 5 parses req.query on each read: an own property is what the route sees.
      Object.defineProperty(req, 'query', { value: { ...req.query, projectId: project }, writable: true, configurable: true, enumerable: true });
      return next();
    }
    if (p === '/projects') {
      const json = res.json.bind(res);
      res.json = (body: unknown) => json(Array.isArray(body) ? body.filter((x: any) => x && x.id === project) : body);
      return next();
    }
    if (UNSCOPED.has(p)) {
      res.status(403).json({ error: AIRLOCK_UNSCOPED_LISTING, message: `An Airlock session reads only its own project (${project}); ${p} lists every project's records.` });
      return;
    }
    next();
  };
}
