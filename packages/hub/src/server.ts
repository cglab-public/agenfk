import express, { Express, Request, Response, NextFunction } from 'express';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cookieParser: (...a: any[]) => any = require('cookie-parser');
import { openDb, DB } from './db.js';
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

export interface HubServerContext {
  db: DB;
  config: HubServerConfig;
}

export function createHubApp(config: HubServerConfig): { app: Express; ctx: HubServerContext } {
  const db = openDb(config.dbPath);

  // Default org row (single-tenant v1).
  db.prepare('INSERT OR IGNORE INTO orgs (id, name) VALUES (?, ?)').run(config.defaultOrgId, config.defaultOrgId);
  // Default auth_config row for the default org.
  db.prepare('INSERT OR IGNORE INTO auth_config (org_id, password_enabled) VALUES (?, 1)').run(config.defaultOrgId);

  const ctx: HubServerContext = { db, config };

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());

  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({ ok: true, version: '0.2.28' });
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
  // production that gets copied into ../public alongside the hub bundle.
  const candidates = [
    process.env.AGENFK_HUB_UI_DIR,
    pathMod.resolve(__dirname, '../public'),
    pathMod.resolve(__dirname, '../../hub-ui/dist'),
  ].filter(Boolean) as string[];
  const uiDir = candidates.find((d) => fs.existsSync(pathMod.join(d, 'index.html')));
  if (uiDir) {
    app.use(express.static(uiDir));
    app.get(/^(?!\/(?:v1|auth|setup|healthz|hub)).*/, (_req: Request, res: Response) => {
      res.sendFile(pathMod.join(uiDir, 'index.html'));
    });
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

export function configFromEnv(): HubServerConfig {
  const secretKey = process.env.AGENFK_HUB_SECRET_KEY;
  const sessionSecret = process.env.AGENFK_HUB_SESSION_SECRET;
  if (!secretKey) throw new Error('AGENFK_HUB_SECRET_KEY is required (32-byte hex/base64).');
  if (!sessionSecret) throw new Error('AGENFK_HUB_SESSION_SECRET is required.');
  return {
    dbPath: process.env.AGENFK_HUB_DB_PATH || '/var/lib/agenfk-hub/hub.sqlite',
    secretKey,
    sessionSecret,
    defaultOrgId: process.env.AGENFK_HUB_ORG_ID || 'default',
    initialAdminEmail: process.env.AGENFK_HUB_INITIAL_ADMIN_EMAIL,
    initialAdminPassword: process.env.AGENFK_HUB_INITIAL_ADMIN_PASSWORD,
  };
}

export type { HubServerConfig, SessionPayload } from './types.js';
export { openDb } from './db.js';
