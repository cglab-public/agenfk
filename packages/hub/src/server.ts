import express, { Express, Request, Response, NextFunction } from 'express';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cookieParser: (...a: any[]) => any = require('cookie-parser');
import { openHubDb, DB, HubBackend } from './db.js';
import type { HubDb } from './db/types.js';
import { HubServerConfig } from './types.js';
import { eventsRouter } from './routes/events.js';
import { flowsRouter } from './routes/flows.js';
import { authRouter, setupRouter } from './routes/auth.js';
import { adminRouter } from './routes/admin.js';
import { orgRenameRouter } from './routes/orgRename.js';
import { googleRouter } from './auth/google.js';
import { entraRouter } from './auth/entra.js';
import { ensureBootstrapToken } from './auth/bootstrapToken.js';
import { queriesRouter } from './routes/queries.js';
import { connectRouter } from './routes/connect.js';
import { startRollupTimer } from './rollup.js';
import * as fs from 'fs';
import * as pathMod from 'path';

// Read the package version once at module load. Resolved from this file's dir
// so it works under both ts source (../package.json) and the built dist
// (./package.json colocated with dist/server.js after `npm pack`).
const HUB_VERSION: string = (() => {
  const candidates = [
    pathMod.resolve(__dirname, '../package.json'),
    pathMod.resolve(__dirname, '../../package.json'),
  ];
  for (const c of candidates) {
    try {
      const raw = JSON.parse(fs.readFileSync(c, 'utf8'));
      if (typeof raw.version === 'string' && raw.name === '@agenfk/hub') return raw.version;
    } catch { /* keep trying */ }
  }
  return '0.0.0';
})();

export interface HubServerContext {
  db: DB;
  config: HubServerConfig;
}

/**
 * Minimal Express surface served when the boot-time consistency check
 * detects an env↔DB org-id mismatch. Every route returns the same
 * mismatch payload — HTML for browser hits, JSON for API/healthz — so an
 * admin sees the problem in the browser without having to dig logs and
 * downstream tooling sees an unhealthy /healthz.
 */
function buildMaintenanceApp(
  args: { envOrgId: string; dbOrgIds: string[]; db: DB; config: HubServerConfig },
): { app: Express; ctx: HubServerContext } {
  const { envOrgId, dbOrgIds, db, config } = args;
  console.error(
    `[HUB] BOOT REFUSED — AGENFK_HUB_ORG_ID="${envOrgId}" does not match any org in the database (${dbOrgIds.join(', ')}). ` +
    `Serving maintenance page only.`,
  );
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  const safeEnv = String(envOrgId).replace(/[<>&"']/g, '');
  const safeDb = dbOrgIds.map(s => String(s).replace(/[<>&"']/g, ''));
  const html = `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Agenfk Hub — configuration mismatch</title>
  <style>
    body { font: 16px/1.5 -apple-system, system-ui, sans-serif; max-width: 720px; margin: 4rem auto; padding: 0 1rem; color: #222; }
    h1 { margin: 0 0 0.5rem; font-size: 1.5rem; }
    code, pre { background: #f4f4f5; padding: 0.15rem 0.4rem; border-radius: 4px; font-size: 0.95em; }
    pre { padding: 0.75rem 1rem; overflow-x: auto; }
    .banner { background: #fef3c7; border-left: 4px solid #f59e0b; padding: 0.75rem 1rem; border-radius: 4px; margin-bottom: 1.25rem; }
    ul { padding-left: 1.25rem; }
    .muted { color: #555; font-size: 0.9rem; }
  </style>
</head><body>
  <div class="banner"><strong>Agenfk Hub is in maintenance mode.</strong> Configuration mismatch — see below.</div>
  <h1>AGENFK_HUB_ORG_ID does not match the database</h1>
  <p>The hub process started with <code>AGENFK_HUB_ORG_ID=${safeEnv}</code>, but the database contains the following org id(s):</p>
  <ul>${safeDb.map(id => `<li><code>${id}</code></li>`).join('')}</ul>
  <p>This usually happens after an admin renames the org via the admin UI without updating the deployment manifest.</p>
  <h2>Fix</h2>
  <p>Pick one of these and restart the hub:</p>
  <ol>
    <li>Update your deployment to <code>AGENFK_HUB_ORG_ID=${safeDb[0] ?? ''}</code> (the value carried by the database) — this is almost always what you want.</li>
    <li>Or restore the database from before the rename and continue using <code>${safeEnv}</code>.</li>
  </ol>
  <p class="muted">No real hub functionality is exposed while this page is shown. <code>/healthz</code> reports HTTP 503 so deployment health checks see the unhealthy state.</p>
</body></html>`;

  app.get('/healthz', (_req: Request, res: Response) => {
    res.status(503).json({
      ok: false,
      service: 'agenfk-hub',
      mismatch: true,
      envOrgId,
      dbOrgIds,
      version: HUB_VERSION,
    });
  });

  // Catch-all: same payload for every other route. Detect HTML preference
  // for browser hits, otherwise return a structured JSON error so spokes /
  // automation see something machine-readable.
  app.use((req: Request, res: Response) => {
    const accept = String(req.headers.accept ?? '');
    if (req.method === 'GET' && accept.includes('text/html')) {
      res.status(503).type('html').send(html);
    } else {
      res.status(503).json({
        error: 'Agenfk Hub is in maintenance mode: AGENFK_HUB_ORG_ID does not match any org in the database.',
        mismatch: true,
        envOrgId,
        dbOrgIds,
      });
    }
  });

  return { app, ctx: { db, config } };
}

export async function createHubApp(
  config: HubServerConfig & { backend?: HubBackend; pgUrl?: string; db?: HubDb },
): Promise<{ app: Express; ctx: HubServerContext }> {
  // `db` override is the test escape hatch: tests that already hold an open
  // HubDb (e.g. a shared pg-mem instance) inject it here instead of paying
  // the bootstrap+open cost a second time.
  const db = config.db ?? await openHubDb({
    dbPath: config.dbPath,
    backend: config.backend,
    pgUrl: config.pgUrl,
  });

  // Boot-time env-var guard. If the DB already contains org rows but none
  // matches the env-supplied defaultOrgId, the operator probably renamed
  // the org via the admin UI but forgot to update AGENFK_HUB_ORG_ID in the
  // deployment manifest. Rather than crash (logs in cloud envs are a hassle
  // to read) or silently resurrect a phantom org row, we boot a minimal
  // "maintenance mode" Express app whose every route serves a self-explanatory
  // mismatch page so the admin can see the problem in the browser and fix it.
  let dbOrgIds: string[] = [];
  try {
    const existing = await db.all<{ id: string }>('SELECT id FROM orgs');
    dbOrgIds = existing.map(r => r.id);
  } catch { /* table may not exist on a brand-new DB; treat as empty */ }
  if (dbOrgIds.length > 0 && !dbOrgIds.includes(config.defaultOrgId)) {
    return buildMaintenanceApp({ envOrgId: config.defaultOrgId, dbOrgIds, db, config });
  }

  // Default org row (single-tenant v1).
  await db.run('INSERT OR IGNORE INTO orgs (id, name) VALUES (?, ?)', [config.defaultOrgId, config.defaultOrgId]);
  // Default auth_config row for the default org.
  await db.run('INSERT OR IGNORE INTO auth_config (org_id, password_enabled) VALUES (?, 1)', [config.defaultOrgId]);

  // First-run admin bootstrap token. Logged once per boot (re-logged on
  // restart while setup is still pending) so the operator can paste it into
  // the Setup UI. Returns null once a user already exists, in which case
  // we say nothing.
  const bootstrapToken = await ensureBootstrapToken(db);
  if (bootstrapToken) {
    const banner = [
      '╔══════════════════════════════════════════════════════════════════════╗',
      '║  AgEnFK Hub — first-run setup                                        ║',
      '║  Open the hub in your browser, click Setup, and paste this token:    ║',
      '║                                                                      ║',
      `║      ${bootstrapToken.padEnd(62)}  ║`,
      '║                                                                      ║',
      '║  This token works exactly once. Do not share it.                     ║',
      '╚══════════════════════════════════════════════════════════════════════╝',
    ].join('\n');
    console.log(banner);
  }

  const ctx: HubServerContext = { db, config };

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());

  app.get('/healthz', (_req: Request, res: Response) => {
    // `service` lets spokes verify they're pointing at an agenfk hub (and not
    // some unrelated server that happens to return JSON 200 at /healthz).
    // Used by `agenfk hub repoint` before swapping the local hub config.
    res.json({ ok: true, service: 'agenfk-hub', version: HUB_VERSION });
  });

  app.use('/v1', eventsRouter(ctx));
  app.use('/v1', flowsRouter(ctx));
  app.use('/auth', authRouter(ctx));
  app.use('/auth/google', googleRouter(ctx));
  app.use('/auth/entra', entraRouter(ctx));
  app.use('/setup', setupRouter(ctx));
  app.use('/v1/admin', adminRouter(ctx));
  app.use('/v1/admin', orgRenameRouter(ctx));
  app.use('/v1', queriesRouter(ctx));
  app.use('/hub', connectRouter(ctx));
  startRollupTimer(db);

  // Serve the built hub-ui SPA. The build emits to packages/hub-ui/dist; in
  // the released tarball that lives next to the hub package. We probe a few
  // sensible roots so both source-checkout and npx-extracted layouts work.
  const candidates = [
    process.env.AGENFK_HUB_UI_DIR,
    pathMod.resolve(__dirname, '../public'),
    pathMod.resolve(__dirname, '../../hub-ui/dist'),
    // npx flow extracts the dist tarball into ~/.agenfk-system; if __dirname
    // is anywhere under that tree, hub-ui/dist is a sibling of packages/hub.
    pathMod.resolve(__dirname, '../../../packages/hub-ui/dist'),
  ].filter(Boolean) as string[];
  const uiDir = candidates.find((d) => fs.existsSync(pathMod.join(d, 'index.html')));
  if (uiDir) {
    console.log(`[HUB] Serving SPA bundle from ${uiDir}`);
    app.use(express.static(uiDir));
    // SPA fallback. Anything that isn't an API route falls through to
    // index.html so deep-link refreshes (e.g. /users/alice@acme.com,
    // /admin/keys, /connect) resolve to the React shell rather than 404.
    // We read index.html once at boot and serve it from memory — earlier
    // versions used res.sendFile which surfaced "Not Found" 500s when the
    // installed path resolution flickered between startup and request time.
    // Note: `/setup` itself is a SPA route (the first-run Setup page), so we
    // only exclude the specific API path under it. Adding new API endpoints
    // under /setup means listing them here.
    const API_PREFIXES = ['/v1', '/auth', '/setup/initial-admin', '/healthz', '/hub'];
    let indexHtml = '';
    try {
      indexHtml = fs.readFileSync(pathMod.join(uiDir, 'index.html'), 'utf8');
    } catch (e) {
      console.warn('[HUB] Failed to preload index.html:', (e as Error).message);
    }
    const spaFallback = (req: Request, res: Response, next: NextFunction): void => {
      if (req.method !== 'GET') return next();
      if (API_PREFIXES.some(p => req.path === p || req.path.startsWith(p + '/'))) return next();
      if (!indexHtml) return next();
      res.type('html').send(indexHtml);
    };
    app.use(spaFallback);
    // Defence in depth: a final 404 trap that re-applies the same fallback
    // for anything that snuck past, e.g. a router calling res.sendStatus(404)
    // or an unmatched mount point. Idempotent — if the response is already
    // sent it short-circuits.
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (res.headersSent) return next();
      spaFallback(req, res, next);
    });
  } else {
    console.warn('[HUB] No SPA bundle found — searched:\n  ' + candidates.join('\n  '));
    console.warn('[HUB] Set AGENFK_HUB_UI_DIR to the directory containing index.html if your layout is non-standard.');
  }

  (app as any).hubCtx = ctx;

  // Default error handler — never leak stack traces.
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    console.error('[HUB_ERROR]', err?.message ?? err);
    res.status(500).json({ error: err?.message ?? 'internal error' });
  });

  return { app, ctx };
}

export function configFromEnv(): HubServerConfig & { backend?: HubBackend; pgUrl?: string } {
  const secretKey = process.env.AGENFK_HUB_SECRET_KEY;
  const sessionSecret = process.env.AGENFK_HUB_SESSION_SECRET;
  if (!secretKey) throw new Error('AGENFK_HUB_SECRET_KEY is required (32-byte hex/base64).');
  if (!sessionSecret) throw new Error('AGENFK_HUB_SESSION_SECRET is required.');
  const rawBackend = process.env.AGENFK_HUB_DB?.trim().toLowerCase();
  const backend: HubBackend | undefined =
    rawBackend === 'sqlite' || rawBackend === 'postgres' ? rawBackend : undefined;
  return {
    dbPath: process.env.AGENFK_HUB_DB_PATH || '/var/lib/agenfk-hub/hub.sqlite',
    secretKey,
    sessionSecret,
    defaultOrgId: process.env.AGENFK_HUB_ORG_ID || 'default',
    backend,
    pgUrl: process.env.AGENFK_HUB_PG_URL,
  };
}

export type { HubServerConfig, SessionPayload } from './types.js';
export { openDb, openHubDb } from './db.js';
export type { HubBackend } from './db.js';
