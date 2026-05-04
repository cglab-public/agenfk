// Hub data layer. Two backends: SQLite (default) and Postgres (enterprise).
// Backend selection is via the AGENFK_HUB_DB env var, overridable by passing
// `backend` in the openHubDb opts. All call sites talk to the HubDb interface
// — SQLite-flavoured SQL is rewritten at the PG adapter boundary.

export type { HubDb, RunResult, Params } from './db/types.js';
export { openSqliteDb } from './db/sqlite.js';
export { openPgDb } from './db/postgres.js';

import type { HubDb } from './db/types.js';
import { openSqliteDb } from './db/sqlite.js';
import { openPgDb } from './db/postgres.js';

export type DB = HubDb;
export type HubBackend = 'sqlite' | 'postgres';

export interface OpenHubDbOpts {
  /** Path to the SQLite database file. Used when backend is 'sqlite'. */
  dbPath: string;
  /**
   * Override the backend. If omitted, AGENFK_HUB_DB is consulted; if that is
   * also unset, defaults to 'sqlite'.
   */
  backend?: HubBackend;
  /**
   * Postgres connection string. Required when backend resolves to 'postgres'.
   * If omitted, falls back to AGENFK_HUB_PG_URL.
   */
  pgUrl?: string;
}

function resolveBackend(opts: OpenHubDbOpts): HubBackend {
  if (opts.backend) return opts.backend;
  const env = process.env.AGENFK_HUB_DB?.trim().toLowerCase();
  if (!env) return 'sqlite';
  if (env === 'sqlite' || env === 'postgres') return env;
  throw new Error(
    `AGENFK_HUB_DB must be 'sqlite' or 'postgres' (got '${env}'). Unset to use the default.`,
  );
}

export async function openHubDb(opts: OpenHubDbOpts): Promise<HubDb> {
  const backend = resolveBackend(opts);
  if (backend === 'sqlite') {
    return openSqliteDb(opts.dbPath);
  }
  const pgUrl = opts.pgUrl ?? process.env.AGENFK_HUB_PG_URL;
  if (!pgUrl) {
    throw new Error(
      'AGENFK_HUB_DB=postgres requires AGENFK_HUB_PG_URL (or opts.pgUrl) to be set ' +
      "to a Postgres connection string (e.g. 'postgres://user:pass@host:5432/agenfk_hub').",
    );
  }
  return openPgDb(pgUrl);
}

/**
 * Back-compat: existing call sites import `openDb` from this module. The
 * SQLite-only signature is preserved here; new code should call openHubDb.
 */
export async function openDb(dbPath: string): Promise<HubDb> {
  return openHubDb({ dbPath });
}
