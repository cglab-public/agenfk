import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHubApp } from '../server';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-repo-migration-${process.pid}.sqlite`);
const SECRET = 'a'.repeat(64);

const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

afterEach(() => cleanup());

describe('boot migration: legacy scope=project → scope=repo', () => {
  it('creates a repo assignment from a legacy project row using the project events remote_url', async () => {
    cleanup();
    // First boot: seed a legacy project-scoped assignment + events that map the
    // projectId to a repo remote URL.
    let out = await createHubApp({ dbPath: TEST_DB, secretKey: SECRET, sessionSecret: 's', defaultOrgId: 'org-a' });
    await out.ctx.db.run(
      "INSERT INTO flow_assignments (org_id, scope, target_id, flow_id) VALUES ('org-a','project','p-1','flow-x')",
    );
    await out.ctx.db.run(
      `INSERT INTO events (event_id, org_id, installation_id, user_key, occurred_at, received_at, type, project_id, remote_url, payload)
       VALUES ('e1','org-a','inst','u','2026-05-01T10:00:00Z', datetime('now'),'item.created','p-1','git@github.com:acme/web.git','{}')`,
    );
    await out.ctx.db.close();

    // Second boot: the migration should synthesize a scope='repo' row.
    out = await createHubApp({ dbPath: TEST_DB, secretKey: SECRET, sessionSecret: 's', defaultOrgId: 'org-a' });
    const repoRow = await out.ctx.db.get<{ target_id: string; flow_id: string }>(
      "SELECT target_id, flow_id FROM flow_assignments WHERE org_id='org-a' AND scope='repo'",
    );
    expect(repoRow).toBeTruthy();
    expect(repoRow!.target_id).toBe('git@github.com:acme/web.git');
    expect(repoRow!.flow_id).toBe('flow-x');
    // Legacy project row is retained for back-compat.
    const projRow = await out.ctx.db.get(
      "SELECT 1 AS ok FROM flow_assignments WHERE org_id='org-a' AND scope='project' AND target_id='p-1'",
    );
    expect(projRow).toBeTruthy();
    await out.ctx.db.close();
  });

  it('is idempotent across boots (no duplicate/throw on the second migration)', async () => {
    cleanup();
    let out = await createHubApp({ dbPath: TEST_DB, secretKey: SECRET, sessionSecret: 's', defaultOrgId: 'org-a' });
    await out.ctx.db.run(
      "INSERT INTO flow_assignments (org_id, scope, target_id, flow_id) VALUES ('org-a','project','p-1','flow-x')",
    );
    await out.ctx.db.run(
      `INSERT INTO events (event_id, org_id, installation_id, user_key, occurred_at, received_at, type, project_id, remote_url, payload)
       VALUES ('e1','org-a','inst','u','2026-05-01T10:00:00Z', datetime('now'),'item.created','p-1','git@github.com:acme/web.git','{}')`,
    );
    await out.ctx.db.close();
    out = await createHubApp({ dbPath: TEST_DB, secretKey: SECRET, sessionSecret: 's', defaultOrgId: 'org-a' });
    await out.ctx.db.close();
    out = await createHubApp({ dbPath: TEST_DB, secretKey: SECRET, sessionSecret: 's', defaultOrgId: 'org-a' });
    const rows = await out.ctx.db.all(
      "SELECT target_id FROM flow_assignments WHERE org_id='org-a' AND scope='repo'",
    );
    expect(rows.length).toBe(1);
    await out.ctx.db.close();
  });

  it('resolves a repo collision deterministically to the most-recently-active clone flow', async () => {
    cleanup();
    let out = await createHubApp({ dbPath: TEST_DB, secretKey: SECRET, sessionSecret: 's', defaultOrgId: 'org-a' });
    // Two local projectIds → same repo, different legacy flows.
    await out.ctx.db.run("INSERT INTO flow_assignments (org_id, scope, target_id, flow_id) VALUES ('org-a','project','p-old','flow-old')");
    await out.ctx.db.run("INSERT INTO flow_assignments (org_id, scope, target_id, flow_id) VALUES ('org-a','project','p-new','flow-new')");
    // p-new is more recently active.
    await out.ctx.db.run(
      `INSERT INTO events (event_id, org_id, installation_id, user_key, occurred_at, received_at, type, project_id, remote_url, payload)
       VALUES ('e-old','org-a','i','u','2026-05-01T10:00:00Z', datetime('now'),'item.created','p-old','git@github.com:acme/web.git','{}')`,
    );
    await out.ctx.db.run(
      `INSERT INTO events (event_id, org_id, installation_id, user_key, occurred_at, received_at, type, project_id, remote_url, payload)
       VALUES ('e-new','org-a','i','u','2026-06-01T10:00:00Z', datetime('now'),'item.created','p-new','git@github.com:acme/web.git','{}')`,
    );
    await out.ctx.db.close();
    out = await createHubApp({ dbPath: TEST_DB, secretKey: SECRET, sessionSecret: 's', defaultOrgId: 'org-a' });
    const repoRow = await out.ctx.db.get<{ flow_id: string }>(
      "SELECT flow_id FROM flow_assignments WHERE org_id='org-a' AND scope='repo' AND target_id='git@github.com:acme/web.git'",
    );
    expect(repoRow!.flow_id).toBe('flow-new');
    await out.ctx.db.close();
  });

  it('leaves a legacy project row with no known remote alone', async () => {
    cleanup();
    let out = await createHubApp({ dbPath: TEST_DB, secretKey: SECRET, sessionSecret: 's', defaultOrgId: 'org-a' });
    await out.ctx.db.run(
      "INSERT INTO flow_assignments (org_id, scope, target_id, flow_id) VALUES ('org-a','project','p-orphan','flow-x')",
    );
    await out.ctx.db.close();
    out = await createHubApp({ dbPath: TEST_DB, secretKey: SECRET, sessionSecret: 's', defaultOrgId: 'org-a' });
    const repoRows = await out.ctx.db.all(
      "SELECT target_id FROM flow_assignments WHERE org_id='org-a' AND scope='repo'",
    );
    expect(repoRows.length).toBe(0);
    await out.ctx.db.close();
  });
});
