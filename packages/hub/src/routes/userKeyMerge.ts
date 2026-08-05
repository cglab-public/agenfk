import { Router, Request, Response } from 'express';
import { HubServerContext } from '../server.js';
import { requireAdmin } from '../auth/session.js';

/**
 * POST /v1/admin/user-keys/merge — fold one or more event-attribution
 * identities into another.
 *
 * Why this exists: `user_key` is derived at ingest from the reporting client's
 * git identity (`routes/events.ts` → `actor.gitEmail?.toLowerCase() ||
 * actor.osUser || 'unknown'`). A misconfigured client therefore mints a
 * *permanent* second identity for a person who is already in the hub — e.g.
 * `git config user.email = "x"` stores the email as the literal `=`, and an
 * unset git email falls back to the OS username. The dashboard then credits
 * one human's work to two or three separate rows forever.
 *
 * Before this endpoint the only remedies were `hidden_users` (which discards
 * the work rather than crediting it) or hand-written SQL against the
 * deployment — the admin DB console is read-only by design. This is the
 * `orgs/rename` pattern applied to `user_key`: one transaction, every
 * `user_key`-bearing table, no data loss.
 *
 * Note that `rollups_daily` is *summed*, not repointed: its primary key is
 * (org_id, user_key, day), so two identities active on the same day collide.
 * Summing the stored rows (rather than recomputing them from `events`) also
 * preserves columns that a recompute would zero — `tokens_in`/`tokens_out` are
 * hardcoded to 0 by the aggregation in `rollup.ts`, so recomputing an old day
 * would silently drop token history the background timer never revisits.
 */

/**
 * Tables with a `user_key` column, and how a merge must treat each. Kept as a
 * literal so the companion regression test can pin it against runtime
 * introspection — if you add a `user_key`-bearing table, add it here.
 */
export const USER_KEY_TABLES = {
  /** Repointed: the source of truth every dashboard query groups on. */
  repoint: ['events'] as const,
  /** Summed on (org_id, day) — see the note above. */
  sum: ['rollups_daily'] as const,
  /** Source rows dropped: the key ceases to exist, so a hide of it is stale. */
  drop: ['hidden_users'] as const,
};

/** Guard against a pathological request fanning out an unbounded IN (...). */
const MAX_SOURCES = 50;

function normalizeKey(v: unknown): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

export function userKeyMergeRouter(ctx: HubServerContext): Router {
  const router = Router();
  const guard = requireAdmin(ctx.config.sessionSecret);

  router.post('/user-keys/merge', guard, async (req: Request, res: Response) => {
    const orgId = req.session!.orgId;

    const to = normalizeKey(req.body?.to);
    if (!to) {
      return res.status(400).json({ error: 'Body must include { to: string } (non-empty).' });
    }

    // Accept a bare string for the single-source case; both shapes normalize to
    // a deduped list that never contains `to` itself (merging a key into itself
    // is a no-op, not an error, so it is filtered rather than rejected).
    const rawFrom = req.body?.from;
    const fromList = Array.isArray(rawFrom) ? rawFrom : [rawFrom];
    const from = [...new Set(fromList.map(normalizeKey).filter((k) => k && k !== to))];

    if (from.length === 0) {
      return res.status(400).json({
        error: 'Body must include { from: string | string[] } with at least one key that differs from `to`.',
      });
    }
    if (from.length > MAX_SOURCES) {
      return res.status(400).json({ error: `\`from\` may list at most ${MAX_SOURCES} keys.` });
    }

    // `user_key` is stored lowercased for git emails but verbatim for the
    // `osUser` fallback, so every match is made case-insensitively via lower().
    const ph = from.map(() => '?').join(', ');

    let events = 0;
    let rollupsRemoved = 0;
    let installations = 0;
    let hiddenRemoved = 0;

    await ctx.db.transaction(async () => {
      const ev = await ctx.db.run(
        `UPDATE events SET user_key = ?
          WHERE org_id = ? AND lower(user_key) IN (${ph})`,
        [to, orgId, ...from],
      );
      events = ev.changes;

      // Fold the sources' daily rollups into the target's. `to` is included in
      // the source set so its own existing counts survive the DO UPDATE — the
      // summed row must be the total, not just the incoming half.
      await ctx.db.run(
        `INSERT INTO rollups_daily
           (org_id, user_key, day, events_count, items_closed, tokens_in, tokens_out, validate_passes, validate_fails, prs_opened)
         SELECT org_id, ?, day,
                SUM(events_count), SUM(items_closed), SUM(tokens_in), SUM(tokens_out),
                SUM(validate_passes), SUM(validate_fails), SUM(prs_opened)
           FROM rollups_daily
          WHERE org_id = ? AND lower(user_key) IN (${ph}, ?)
          GROUP BY org_id, day
         ON CONFLICT(org_id, user_key, day) DO UPDATE SET
           events_count = excluded.events_count,
           items_closed = excluded.items_closed,
           tokens_in = excluded.tokens_in,
           tokens_out = excluded.tokens_out,
           validate_passes = excluded.validate_passes,
           validate_fails = excluded.validate_fails,
           prs_opened = excluded.prs_opened`,
        [to, orgId, ...from, to],
      );

      const rr = await ctx.db.run(
        `DELETE FROM rollups_daily WHERE org_id = ? AND lower(user_key) IN (${ph})`,
        [orgId, ...from],
      );
      rollupsRemoved = rr.changes;

      // Cosmetic but load-bearing for the Installations admin page: the client
      // still reports its own actor on each event, so this does not change how
      // future keys are derived — it stops the old label lingering next to an
      // installation whose history now belongs to `to`.
      const inst = await ctx.db.run(
        `UPDATE installations SET git_email = ?
          WHERE org_id = ? AND lower(git_email) IN (${ph})`,
        [to, orgId, ...from],
      );
      installations = inst.changes;

      const hu = await ctx.db.run(
        `DELETE FROM hidden_users WHERE org_id = ? AND lower(user_key) IN (${ph})`,
        [orgId, ...from],
      );
      hiddenRemoved = hu.changes;
    });

    res.json({ ok: true, to, from, events, rollupsRemoved, installations, hiddenRemoved });
  });

  return router;
}
