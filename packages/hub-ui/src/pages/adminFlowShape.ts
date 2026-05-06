import type { Flow } from '@agenfk/flow-editor';

/**
 * Hub admin endpoints return flows nested under `definition` — the persistence
 * shape on the server. The FlowEditor consumes a flat `Flow` with `steps` at
 * the top level. We flatten here at the seam so the editor never sees the
 * server-internal shape.
 */
export function flattenAdminFlow(row: any): Flow {
  const def = row?.definition ?? {};
  return {
    id: row.id,
    name: row.name ?? def.name ?? '',
    description: row.description ?? def.description ?? '',
    version: typeof row.version === 'number' ? String(row.version) : (row.version ?? def.version),
    steps: Array.isArray(def.steps) ? def.steps : [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    source: row.source,
    hubVersion: typeof row.version === 'number' ? row.version : undefined,
  };
}
