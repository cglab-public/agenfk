import type { DB } from '../db.js';
import { sanitizeRemoteUrl } from '../util/remoteUrl.js';

export type ResolvedScope = 'installation' | 'repo' | 'project' | 'org';

export interface ResolvedFlow {
  scope: ResolvedScope;
  targetId: string;
  flow: {
    id: string;
    name: string;
    description: string | null;
    /** Parsed definition_json contents (steps, etc). */
    definition: unknown;
    version: number;
  };
}

interface ResolveArgs {
  db: DB;
  orgId: string;
  projectId?: string | null;
  /** Raw or canonical git remote URL; sanitized here for the 'repo' scope. */
  remoteUrl?: string | null;
  installationId?: string | null;
}

interface AssignmentRow {
  scope: ResolvedScope;
  target_id: string;
  flow_id: string;
}

/**
 * Resolve the flow that applies to a given (org, project, installation)
 * triple, honouring precedence: installation > project > org. The first
 * non-null scope-match wins; missing scopes fall through.
 *
 * Implemented as a single bounded query (`scope IN (...) AND target_id IN
 * (...)`) plus an in-memory ranking, rather than three round-trips. PG and
 * SQLite both round-trip cleanly through the dialect translator.
 */
export async function resolveEffectiveFlow(args: ResolveArgs): Promise<ResolvedFlow | null> {
  const { db, orgId, projectId, remoteUrl, installationId } = args;

  // Build the candidate list: each scope is included only when its target id
  // is known to the caller. We always probe org-default.
  const scopeFilters: string[] = ["scope = 'org' AND target_id = ''"];
  const params: unknown[] = [];
  if (projectId) {
    // Legacy per-installation project axis — retained for back-compat with
    // clients that still send ?projectId. Superseded by the repo scope.
    scopeFilters.push("(scope = 'project' AND target_id = ?)");
    params.push(projectId);
  }
  const repoKey = remoteUrl ? sanitizeRemoteUrl(remoteUrl) : null;
  if (repoKey) {
    scopeFilters.push("(scope = 'repo' AND target_id = ?)");
    params.push(repoKey);
  }
  if (installationId) {
    scopeFilters.push("(scope = 'installation' AND target_id = ?)");
    params.push(installationId);
  }
  const sql = `
    SELECT scope, target_id, flow_id FROM flow_assignments
    WHERE org_id = ? AND (${scopeFilters.join(' OR ')})
  `;
  const rows = await db.all<AssignmentRow>(sql, [orgId, ...params]);
  if (rows.length === 0) return null;

  // Rank by precedence (installation > repo > project-legacy > org).
  const weight = (s: ResolvedScope) =>
    s === 'installation' ? 4 : s === 'repo' ? 3 : s === 'project' ? 2 : 1;
  rows.sort((a, b) => weight(b.scope) - weight(a.scope));
  const winner = rows[0];

  // Fetch the flow row.
  const flow = await db.get<{
    id: string; name: string; description: string | null; definition_json: string; version: number;
  }>(
    'SELECT id, name, description, definition_json, version FROM flows WHERE id = ? AND org_id = ?',
    [winner.flow_id, orgId],
  );
  if (!flow) return null;

  return {
    scope: winner.scope,
    targetId: winner.target_id,
    flow: {
      id: flow.id,
      name: flow.name,
      description: flow.description,
      definition: JSON.parse(flow.definition_json),
      version: flow.version,
    },
  };
}
