import { Router, Request, Response } from 'express';
import { HubServerContext } from '../server.js';
import { requireAdmin } from '../auth/session.js';
import { validateReadOnlySql, wrapWithLimit } from '../queries/sql-readonly.js';

const DEFAULT_ROW_CAP = 1000;
const MAX_ROW_CAP = 5000;

export interface SchemaColumn {
  name: string;
  type: string;
  nullable: boolean;
  pk: boolean;
}
export interface SchemaTable {
  name: string;
  columns: SchemaColumn[];
}

// Defensive identifier guard for the SQLite PRAGMA path (table names can't be
// bound as parameters). Names come from our own sqlite_master, so this is
// belt-and-suspenders, but it keeps the interpolation provably safe.
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

async function introspectSqlite(ctx: HubServerContext): Promise<SchemaTable[]> {
  const tables = await ctx.db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const out: SchemaTable[] = [];
  for (const { name } of tables) {
    if (!SAFE_IDENT.test(name)) continue;
    const cols = await ctx.db.all<{ name: string; type: string; notnull: number; pk: number }>(
      `PRAGMA table_info("${name}")`,
    );
    out.push({
      name,
      columns: cols.map(c => ({
        name: c.name,
        type: c.type || 'unknown',
        nullable: !c.notnull,
        pk: !!c.pk,
      })),
    });
  }
  return out;
}

async function introspectPostgres(ctx: HubServerContext): Promise<SchemaTable[]> {
  const tables = await ctx.db.all<{ name: string }>(
    `SELECT table_name AS name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
  );
  // Primary-key columns per table (one round-trip).
  const pkRows = await ctx.db.all<{ table_name: string; column_name: string }>(
    `SELECT tc.table_name, kcu.column_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
     WHERE tc.table_schema = 'public' AND tc.constraint_type = 'PRIMARY KEY'`,
  );
  const pkSet = new Set(pkRows.map(r => `${r.table_name}.${r.column_name}`));
  const out: SchemaTable[] = [];
  for (const { name } of tables) {
    const cols = await ctx.db.all<{ name: string; type: string; is_nullable: string }>(
      `SELECT column_name AS name, data_type AS type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = ?
       ORDER BY ordinal_position`,
      [name],
    );
    out.push({
      name,
      columns: cols.map(c => ({
        name: c.name,
        type: c.type || 'unknown',
        nullable: c.is_nullable !== 'NO',
        pk: pkSet.has(`${name}.${c.name}`),
      })),
    });
  }
  return out;
}

export function dbConsoleRouter(ctx: HubServerContext): Router {
  const router = Router();
  const guard = requireAdmin(ctx.config.sessionSecret);

  // Browse the schema: every table and its columns. Powers the visual query
  // builder / schema browser in the UI.
  router.get('/schema', guard, async (_req: Request, res: Response) => {
    try {
      const tables = ctx.db.backend === 'postgres'
        ? await introspectPostgres(ctx)
        : await introspectSqlite(ctx);
      res.json({ backend: ctx.db.backend, tables });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Run a read-only query. Read-only enforcement + admin gating are the
  // security boundary; results are capped so a runaway SELECT can't OOM the hub.
  router.post('/query', guard, async (req: Request, res: Response) => {
    const sql = typeof req.body?.sql === 'string' ? req.body.sql : '';
    const rawLimit = Number.parseInt(String(req.body?.limit ?? ''), 10);
    const cap = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, MAX_ROW_CAP)
      : DEFAULT_ROW_CAP;

    const verdict = validateReadOnlySql(sql);
    if (!verdict.ok) {
      res.status(400).json({ error: verdict.reason });
      return;
    }

    const started = Date.now();
    try {
      // Fetch cap + 1 so we can tell whether the result was truncated.
      // readonlyAll enforces read-only at the engine level (the keyword guard
      // above is only the first line of defence).
      const rows = await ctx.db.readonlyAll<Record<string, unknown>>(wrapWithLimit(sql, cap + 1));
      const truncated = rows.length > cap;
      const page = truncated ? rows.slice(0, cap) : rows;
      const columns = page.length > 0 ? Object.keys(page[0] as object) : [];
      res.json({
        columns,
        rows: page,
        rowCount: page.length,
        truncated,
        elapsedMs: Date.now() - started,
      });
    } catch (err) {
      // Surface the DB error message (syntax error, missing table, etc.) so the
      // admin can fix their query. Admin-only route, so no info-leak concern.
      res.status(400).json({ error: (err as Error).message });
    }
  });

  return router;
}
