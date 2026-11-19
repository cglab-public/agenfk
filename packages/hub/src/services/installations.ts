import type { HubDb } from '../db/types.js';

/**
 * Record a sighting of an installation: create its row, or refresh last_seen
 * and any identity field it now reports. A row that belongs to another org is
 * left alone (the WHERE on the update), so a client-chosen id can never move
 * an installation between orgs.
 *
 * Written by event ingest AND by joining (invite redeem, device token
 * collection): a machine that had joined but not yet reported had no row, so
 * an admin could not make it a repository's producer (GH-256).
 */
const UPSERT_INSTALLATION_SQL = `
  INSERT INTO installations (id, org_id, first_seen, last_seen, os_user, git_name, git_email)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    last_seen = excluded.last_seen,
    os_user = COALESCE(excluded.os_user, installations.os_user),
    git_name = COALESCE(excluded.git_name, installations.git_name),
    git_email = COALESCE(excluded.git_email, installations.git_email)
  WHERE installations.org_id = excluded.org_id
`;

export async function upsertInstallation(
  db: Pick<HubDb, 'run'>,
  orgId: string,
  installation: { installationId: string; osUser?: string | null; gitName?: string | null; gitEmail?: string | null },
  seenAt: string = new Date().toISOString(),
): Promise<void> {
  await db.run(UPSERT_INSTALLATION_SQL, [
    installation.installationId, orgId, seenAt, seenAt,
    installation.osUser ?? null, installation.gitName ?? null, installation.gitEmail ?? null,
  ]);
}
