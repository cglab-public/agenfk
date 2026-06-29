import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { HubServerContext } from '../server.js';
import { requireAdmin } from '../auth/session.js';

interface SavedQueryRow {
  id: string;
  org_id: string;
  user_id: string;
  name: string;
  sql_text: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

function toApi(row: SavedQueryRow) {
  return {
    id: row.id,
    name: row.name,
    sql: row.sql_text,
    description: row.description ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function savedQueriesRouter(ctx: HubServerContext): Router {
  const router = Router();
  const guard = requireAdmin(ctx.config.sessionSecret);

  // List the current user's saved queries (own rows only).
  router.get('/', guard, async (req: Request, res: Response) => {
    const rows = await ctx.db.all<SavedQueryRow>(
      `SELECT id, org_id, user_id, name, sql_text, description, created_at, updated_at
       FROM saved_queries
       WHERE org_id = ? AND user_id = ?
       ORDER BY updated_at DESC`,
      [req.session!.orgId, req.session!.userId],
    );
    res.json(rows.map(toApi));
  });

  // Create a saved query owned by the current user.
  router.post('/', guard, async (req: Request, res: Response) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const sql = typeof req.body?.sql === 'string' ? req.body.sql : '';
    const description = typeof req.body?.description === 'string' ? req.body.description : null;
    if (!name || !sql.trim()) {
      res.status(400).json({ error: 'Both "name" and "sql" are required.' });
      return;
    }
    const id = randomUUID();
    await ctx.db.run(
      `INSERT INTO saved_queries (id, org_id, user_id, name, sql_text, description)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, req.session!.orgId, req.session!.userId, name, sql, description],
    );
    const row = await ctx.db.get<SavedQueryRow>(
      `SELECT id, org_id, user_id, name, sql_text, description, created_at, updated_at
       FROM saved_queries WHERE id = ?`,
      [id],
    );
    res.status(201).json(toApi(row!));
  });

  // Update an owned saved query (partial: name / sql / description).
  router.put('/:id', guard, async (req: Request, res: Response) => {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (typeof req.body?.name === 'string') { sets.push('name = ?'); params.push(req.body.name.trim()); }
    if (typeof req.body?.sql === 'string') { sets.push('sql_text = ?'); params.push(req.body.sql); }
    if (typeof req.body?.description === 'string' || req.body?.description === null) {
      sets.push('description = ?'); params.push(req.body.description ?? null);
    }
    if (sets.length === 0) {
      res.status(400).json({ error: 'No updatable fields provided.' });
      return;
    }
    sets.push("updated_at = datetime('now')");
    // Ownership is part of the WHERE clause: a non-owner (or unknown id) matches
    // zero rows → 404, so users can never touch another user's query.
    const result = await ctx.db.run(
      `UPDATE saved_queries SET ${sets.join(', ')}
       WHERE id = ? AND org_id = ? AND user_id = ?`,
      [...params, req.params.id, req.session!.orgId, req.session!.userId],
    );
    if (result.changes === 0) {
      res.status(404).json({ error: 'Saved query not found.' });
      return;
    }
    const row = await ctx.db.get<SavedQueryRow>(
      `SELECT id, org_id, user_id, name, sql_text, description, created_at, updated_at
       FROM saved_queries WHERE id = ?`,
      [req.params.id],
    );
    res.json(toApi(row!));
  });

  // Delete an owned saved query.
  router.delete('/:id', guard, async (req: Request, res: Response) => {
    const result = await ctx.db.run(
      `DELETE FROM saved_queries WHERE id = ? AND org_id = ? AND user_id = ?`,
      [req.params.id, req.session!.orgId, req.session!.userId],
    );
    if (result.changes === 0) {
      res.status(404).json({ error: 'Saved query not found.' });
      return;
    }
    res.status(204).end();
  });

  return router;
}
