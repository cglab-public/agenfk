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
    const cap = ctx.config.auditCsvMaxRows ?? CSV_MAX_ROWS;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="hub-audit-${new Date().toISOString().slice(0, 10)}.csv"`);
    // Streamed a page at a time (BUG 91d2941d): rows carry whole flow definitions, twice.
    // BUG 915f76ed: a reader that stops reading is waited for, one that leaves stops the
    // export, and a failure after the first byte ends the response instead of leaving it open.
    let gone = false;
    req.on('close', () => { gone = true; });
    const send = (chunk: string) => (res.write(chunk) ? Promise.resolve() : new Promise<void>(resolve => {
      const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
      res.on('drain', done); res.on('close', done);
    }));
    try {
      await send(`${AUDIT_CSV_HEADER.join(',')}\r\n`);
      let cursor: string | undefined;
      let rows = 0;
      let truncated = false;
      while (!gone) {
        const page = await listAudit(ctx.db, req.session!.orgId, { ...f, limit: Math.min(AUDIT_PAGE_MAX, cap - rows), cursor });
        const lines = auditCsvLines(page.rows);
        if (lines.length) await send(`${lines.join('\r\n')}\r\n`);
        rows += page.rows.length;
        cursor = page.next ?? undefined;
        if (!cursor) break;
        if (rows >= cap) { truncated = true; break; }
      }
      // Said in the file itself, where whoever opens it will see it.
      if (truncated && !gone) await send(`truncated: this export stops at ${cap} rows; narrow the filters to see the rest\r\n`);
      res.end();
    } catch (err) {
      console.error('[HUB] audit CSV export failed:', (err as Error).message);
      // The status line is gone already: cut the download so the client sees it fail, not a short file.
      res.destroy(err as Error);
    }
  }));

  return router;
}
