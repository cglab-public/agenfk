import { Router, Request, Response } from 'express';
import { HubServerContext } from '../server.js';
import { requireAdmin } from '../auth/session.js';
import { asyncRoute } from '../util/asyncRoute.js';
import { listAudit, auditCsvLines, AUDIT_CSV_HEADER, AUDIT_PAGE_MAX, type AuditFilter } from '../services/configAudit.js';

/** Most rows one CSV export carries: the filtered view, not an unbounded dump. */
const CSV_MAX_ROWS = 100_000;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/;

/** The filters a request asks for, or the reason they cannot be read. */
function filterOf(q: Request['query']): AuditFilter | { error: string } {
  const str = (k: string) => (typeof q[k] === 'string' && (q[k] as string).trim() ? (q[k] as string).trim() : undefined);
  const bound = (k: 'from' | 'to'): string | undefined | null => {
    const v = str(k);
    if (v === undefined) return undefined;
    if (DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))) return k === 'from' ? `${v}T00:00:00.000Z` : `${v}T23:59:59.999Z`;
    if (INSTANT.test(v) && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
    return null;
  };
  const from = bound('from'), to = bound('to');
  if (from === null || to === null) return { error: 'from and to are dates (YYYY-MM-DD) or UTC instants (…Z)' };
  const rawLimit = str('limit');
  let limit: number | undefined;
  if (rawLimit !== undefined) {
    if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1) return { error: 'limit is a whole number of at least 1' };
    limit = Math.min(Number(rawLimit), AUDIT_PAGE_MAX);
  }
  return { area: str('area'), actor: str('actor'), from, to, limit, cursor: str('cursor') };
}

/**
 * The config audit log, for admins (STORY a89af514). Read-only: no route here
 * or anywhere edits or deletes a row.
 */
export function auditRouter(ctx: HubServerContext): Router {
  const router = Router();
  const guard = requireAdmin(ctx.config.sessionSecret, ctx.db);

  router.get('/audit', guard, asyncRoute(async (req: Request, res: Response) => {
    const f = filterOf(req.query);
    if ('error' in f) return res.status(400).json({ error: f.error });
    res.json(await listAudit(ctx.db, req.session!.orgId, f));
  }));

  router.get('/audit.csv', guard, asyncRoute(async (req: Request, res: Response) => {
    const f = filterOf(req.query);
    if ('error' in f) return res.status(400).json({ error: f.error });
    const lines = [AUDIT_CSV_HEADER.join(',')];
    let cursor: string | undefined;
    let rows = 0;
    do {
      const page = await listAudit(ctx.db, req.session!.orgId, { ...f, limit: AUDIT_PAGE_MAX, cursor });
      lines.push(...auditCsvLines(page.rows));
      rows += page.rows.length;
      cursor = page.next ?? undefined;
    } while (cursor && rows < CSV_MAX_ROWS);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="hub-audit-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(`${lines.join('\r\n')}\r\n`);
  }));

  return router;
}
