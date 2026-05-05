import { Router, Request, Response } from 'express';
import { HubServerContext } from '../server.js';
import { requireApiKey } from '../auth/apiKey.js';

interface FlowRow {
  id: string;
  name: string;
  description: string | null;
  definition_json: string;
  source: 'hub' | 'community';
  version: number;
  updated_at: string;
}

/**
 * Client-facing flow distribution: a connected agenfk installation calls
 * `GET /v1/flows/active` (auth'd by api_key → org) to fetch the org's
 * currently-assigned flow. Honours `If-None-Match` for cheap polling.
 */
export function flowsRouter(ctx: HubServerContext): Router {
  const router = Router();
  const requireKey = requireApiKey(ctx.db);

  router.get('/flows/active', requireKey, async (req: Request, res: Response) => {
    const orgId = req.hubApiKey!.orgId;
    const assignment = await ctx.db.get<{ flow_id: string }>(
      "SELECT flow_id FROM flow_assignments WHERE org_id = ? AND scope = 'org'",
      [orgId],
    );
    if (!assignment) {
      return res.json({ flow: null });
    }
    const row = await ctx.db.get<FlowRow>(
      'SELECT id, name, description, definition_json, source, version, updated_at FROM flows WHERE id = ? AND org_id = ?',
      [assignment.flow_id, orgId],
    );
    if (!row) {
      // Assigned flow has been deleted out-of-band — surface "no assignment"
      // rather than 500 so clients keep their existing local cache.
      return res.json({ flow: null });
    }
    const etag = `W/"${row.version}"`;
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    res.json({
      flow: {
        id: row.id,
        name: row.name,
        description: row.description,
        ...JSON.parse(row.definition_json),
      },
      hubVersion: row.version,
    });
  });

  return router;
}
