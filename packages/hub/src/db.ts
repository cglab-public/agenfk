// Back-compat shim. The Hub's data layer now lives in ./db/. This module
// re-exports the HubDb interface as `DB` and `openDb` so existing call sites
// continue to compile while we add Postgres support.

export type { HubDb, RunResult, Params } from './db/types.js';
export { openSqliteDb as openDb } from './db/sqlite.js';

import type { HubDb } from './db/types.js';
export type DB = HubDb;
