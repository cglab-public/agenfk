import express, { Express, Request, Response, NextFunction } from 'express';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cookieParser: (...a: any[]) => any = require('cookie-parser');
import { openHubDb, DB, HubBackend } from './db.js';
import type { HubDb } from './db/types.js';
import { HubServerConfig } from './types.js';
import { eventsRouter } from './routes/events.js';
import { authRouter, setupRouter } from './routes/auth.js';
import { adminRouter } from './routes/admin.js';
import { googleRouter } from './auth/google.js';
import { entraRouter } from './auth/entra.js';
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

  // Default org row (single-tenant v1).
  await db.run('INSERT OR IGNORE INTO orgs (id, name) VALUES (?, ?)', [config.defaultOrgId, config.defaultOrgId]);
  // Default auth_config row for the default org.
  await db.run('INSERT OR IGNORE INTO auth_config (org_id, password_enabled) VALUES (?, 1)', [config.defaultOrgId]);

  const ctx: HubServerContext = { db, config };

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());

  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({ ok: true, version: HUB_VERSION });
  });

  app.use('/v1', eventsRouter(ctx));
  app.use('/auth', authRouter(ctx));
  app.use('/auth/google', googleRouter(ctx));
  app.use('/auth/entra', entraRouter(ctx));
  app.use('/setup', setupRouter(ctx));
  app.use('/v1/admin', adminRouter(ctx));
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
    const API_PREFIXES = ['/v1', '/auth', '/setup', '/healthz', '/hub'];
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
    initialAdminEmail: process.env.AGENFK_HUB_INITIAL_ADMIN_EMAIL,
    initialAdminPassword: process.env.AGENFK_HUB_INITIAL_ADMIN_PASSWORD,
    backend,
    pgUrl: process.env.AGENFK_HUB_PG_URL,
  };
}

export type { HubServerConfig, SessionPayload } from './types.js';
export { openDb, openHubDb } from './db.js';
export type { HubBackend } from './db.js';
