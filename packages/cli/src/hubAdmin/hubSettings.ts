import { Command } from 'commander';
import chalk from 'chalk';
import {
  AdminCliError, adminAction, adminRequest, covers, emit, printTable, readAdminCreds, readStdin, requireYes, writeAdminCreds,
} from './client';

/**
 * The hub's own settings (CGLAB-702 S5): Organization, Federation (this hub's
 * parent, and its child hubs) and the JIRA integration.
 */
type Json = { json?: boolean };
const enc = encodeURIComponent;

function identityPolicy(value: string, allowInherit: boolean): 'keep' | 'pseudonymize' | null {
  if (value === 'keep' || value === 'pseudonymize') return value;
  if (allowInherit && value === 'inherit') return null;
  throw new AdminCliError(`Identity policy is keep or pseudonymize${allowInherit ? ' (or inherit, to follow the group\'s)' : ''}, not "${value}".`);
}

export function registerHubSettingsCommands(admin: Command): void {
  // ── Organization ─────────────────────────────────────────────────────────
  const org = admin.command('org').description('The hub\'s organization');
  covers('POST /v1/admin/orgs/rename', 'GET /v1/admin/system/pending', 'POST /v1/admin/system/pending/ack');

  org.command('rename <newId>').description('Change the org id (every installation and record moves with it)')
    .option('--from <id>', 'The current org id (default: the one this CLI is signed in to)')
    .option('--yes', 'Confirm').option('--json', 'Print as JSON')
    .action(adminAction(async (to: string, opts: Json & { from?: string; yes?: boolean }) => {
      const creds = readAdminCreds();
      const from = opts.from ?? creds?.orgId;
      if (!from) throw new AdminCliError('Pass --from <current org id>.');
      requireYes(opts, `rename org ${from} to ${to}`);
      const r = await adminRequest('POST', '/v1/admin/orgs/rename', { body: { from, to } });
      // The CLI's token moved with the org; keep the local record in step.
      if (creds) writeAdminCreds({ ...creds, orgId: r.orgId ?? to });
      emit(r, opts, d => {
        console.log(chalk.green(`✓ Org ${from} is now ${d.orgId}.`));
        if (d.requiresEnvUpdate) console.log(chalk.yellow(`  Set ${d.envVar}=${d.orgId} in the hub's environment before its next restart.`));
      });
    }));

  org.command('pending').description('Notices the hub is holding for the operator').option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json) => {
      emit(await adminRequest('GET', '/v1/admin/system/pending'), opts, d => console.log(d.pendingEnvOrgId
        ? chalk.yellow(`The org was renamed to ${d.pendingEnvOrgId}: set AGENFK_HUB_ORG_ID=${d.pendingEnvOrgId} in the hub's environment, then run \`agenfk hub admin org pending-ack\`.`)
        : 'Nothing pending.'));
    }));

  org.command('pending-ack').description('Dismiss the pending notice (after updating the environment)')
    .action(adminAction(async () => {
      await adminRequest('POST', '/v1/admin/system/pending/ack');
      console.log(chalk.green('✓ Acknowledged.'));
    }));

  // ── Federation: this hub's parent ────────────────────────────────────────
  const fed = admin.command('federation').description('This hub\'s parent hub, and the group\'s identity policy');
  covers(
    'GET /v1/admin/federation', 'POST /v1/admin/federation/join', 'POST /v1/admin/federation/release-request',
    'DELETE /v1/admin/federation', 'GET /v1/admin/federation/identity-policy', 'PUT /v1/admin/federation/identity-policy',
  );

  fed.command('status').description('Whether this hub has a parent, and how it stands').option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json) => {
      emit(await adminRequest('GET', '/v1/admin/federation'), opts, d => {
        if (!d.bound) { console.log(`No parent hub.${d.outboxDepth ? ` (${d.outboxDepth} event(s) still queued for a former parent)` : ''}`); return; }
        if (d.unreadable) { console.log(chalk.red(`Bound to a parent, but the binding cannot be read: ${d.error}`)); return; }
        console.log(`Parent ${d.parentUrl} (this hub is ${d.childHubId}), ${d.state} since ${d.enrolledAt}; identity policy ${d.identityPolicy ?? '-'}; ${d.outboxDepth} event(s) queued.`);
        if (d.releaseRequested) console.log(chalk.gray('A release has been requested from the parent.'));
        if (d.canLeave) console.log(chalk.yellow('The parent has released this hub: `agenfk hub admin federation leave --yes` completes it.'));
      });
    }));

  // The token only ever arrives on stdin: it is a credential good for 14 days,
  // and an argument lands in shell history and the process list.
  fed.command('join').description('Join a parent hub with the token its admin gave you (`child-hubs invite` there), read from stdin')
    .requiredOption('--token-stdin', 'Read the invite token from stdin (e.g. `< token-file`)')
    .option('--yes', 'Confirm: this hub reports to the parent, and the parent can send it flows and upgrades')
    .option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json & { yes?: boolean }) => {
      requireYes(opts, 'join a parent hub');
      const inviteToken = await readStdin('invite token');
      const r = await adminRequest('POST', '/v1/admin/federation/join', { body: { inviteToken } });
      emit(r, opts, d => console.log(chalk.green(`✓ Joined ${d.parentUrl ?? 'the parent hub'}${d.childHubId ? ` as ${d.childHubId}` : ''}.`)));
    }));

  fed.command('release-request').description('Ask the parent to release this hub from the group')
    .option('--reason <text>', 'Why, for the parent\'s admin').option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json & { reason?: string }) => {
      const r = await adminRequest('POST', '/v1/admin/federation/release-request', { body: { reason: opts.reason } });
      emit(r, opts, () => console.log(chalk.green('✓ Release requested; the parent\'s admin decides.')));
    }));

  fed.command('leave').description('Leave the group once the parent has released this hub')
    .option('--yes', 'Confirm').option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json & { yes?: boolean }) => {
      requireYes(opts, 'leave the parent hub\'s group');
      const r = await adminRequest('DELETE', '/v1/admin/federation');
      emit(r, opts, () => console.log(chalk.green('✓ This hub has left the group; flows the parent sent stay, and become editable.')));
    }));

  const fedPolicy = fed.command('identity-policy').description('Whether child hubs send people\'s identities, or pseudonyms');
  fedPolicy.command('show').description('The group policy and each child hub\'s').option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json) => {
      emit(await adminRequest('GET', '/v1/admin/federation/identity-policy'), opts, d => {
        console.log(`Group: ${d.groupPolicy ?? '(not set)'}`);
        printTable(d.childHubs ?? [], { HUB: (c: any) => c.name, ID: (c: any) => c.id, OWN: (c: any) => c.policy ?? 'inherit', EFFECTIVE: (c: any) => c.effective });
      });
    }));
  fedPolicy.command('set <policy>').description('Set the group policy: keep or pseudonymize (keep needs --yes)')
    .option('--yes', 'Confirm keep: child hubs then send people\'s real identities, and that cannot be taken back')
    .option('--json', 'Print as JSON')
    .action(adminAction(async (value: string, opts: Json & { yes?: boolean }) => {
      const policy = identityPolicy(value, false);
      if (policy === 'keep') requireYes(opts, 'let child hubs send people\'s real identities (already-sent identities cannot be taken back)');
      emit(await adminRequest('PUT', '/v1/admin/federation/identity-policy', { body: { policy } }), opts,
        () => console.log(chalk.green(`✓ Group identity policy: ${policy}.`)));
    }));

  // ── Federation: this hub's children ──────────────────────────────────────
  const kids = admin.command('child-hubs').description('Hubs that report to this one');
  covers(
    'GET /v1/admin/child-hubs', 'POST /v1/admin/child-hubs/invite', 'PUT /v1/admin/child-hubs/:id',
    'POST /v1/admin/child-hubs/:id/detach', 'PUT /v1/admin/child-hubs/:id/identity-policy',
  );

  kids.command('list').description('Child hubs').option('--include-detached', 'Include detached hubs').option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json & { includeDetached?: boolean }) => {
      const { childHubs } = await adminRequest<{ childHubs: any[] }>('GET', '/v1/admin/child-hubs', { params: { includeDetached: opts.includeDetached ? '1' : undefined } });
      emit(childHubs, opts, rows => printTable(rows, {
        ID: r => r.id, NAME: r => r.name, VERSION: r => r.hubVersion, LAST_SEEN: r => r.lastSeen,
        STATE: r => (r.detached ? 'detached' : r.releaseRequested ? 'release requested' : r.live ? 'live' : 'quiet'),
      }, 'No child hubs.'));
    }));

  kids.command('invite').description('A single-use token another hub uses to join this one').option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json) => {
      emit(await adminRequest('POST', '/v1/admin/child-hubs/invite'), opts, d => {
        console.log(chalk.green(`✓ Child-hub invite (single use, valid until ${d.expiresAt}). Treat it as a credential.`));
        console.log(`  ${d.inviteToken}`);
        console.log(chalk.gray('On the other hub, save it to a file only you can read, then as its admin run:'));
        console.log(chalk.gray('  agenfk hub admin federation join --token-stdin --yes < <token-file>'));
      });
    }));

  kids.command('rename <id> <name>').description('Rename a child hub').option('--json', 'Print as JSON')
    .action(adminAction(async (id: string, name: string, opts: Json) => {
      emit(await adminRequest('PUT', `/v1/admin/child-hubs/${enc(id)}`, { body: { name } }), opts, () => console.log(chalk.green(`✓ ${id} is "${name}".`)));
    }));

  kids.command('detach <id>').description('Remove a child hub from the group and revoke its keys')
    .option('--yes', 'Confirm').option('--json', 'Print as JSON')
    .action(adminAction(async (id: string, opts: Json & { yes?: boolean }) => {
      requireYes(opts, `detach child hub ${id} and revoke its keys`);
      const r = await adminRequest('POST', `/v1/admin/child-hubs/${enc(id)}/detach`);
      emit(r, opts, d => console.log(chalk.green(`✓ Detached ${id}${d.revokedKeys !== undefined ? `; revoked ${d.revokedKeys} key(s)` : ''}.`)));
    }));

  kids.command('identity-policy <id> <policy>').description('A child hub\'s own identity policy: keep, pseudonymize, or inherit (keep and inherit need --yes)')
    .option('--yes', 'Confirm keep or inherit: either can let the hub send real identities, which cannot be taken back')
    .option('--json', 'Print as JSON')
    .action(adminAction(async (id: string, value: string, opts: Json & { yes?: boolean }) => {
      const policy = identityPolicy(value, true);
      if (policy !== 'pseudonymize') requireYes(opts, `let ${id} send real identities${policy === null ? ' if the group policy is keep' : ''} (already-sent identities cannot be taken back)`);
      emit(await adminRequest('PUT', `/v1/admin/child-hubs/${enc(id)}/identity-policy`, { body: { policy } }), opts,
        () => console.log(chalk.green(`✓ ${id}: ${policy ?? 'follows the group policy'}.`)));
    }));

  // ── JIRA ─────────────────────────────────────────────────────────────────
  const jira = admin.command('jira').description('The org\'s Atlassian app, through which people connect their JIRA');
  covers('GET /v1/admin/jira', 'PUT /v1/admin/jira', 'POST /v1/admin/jira/disconnect-all');

  jira.command('show').description('The JIRA app (the secret is never shown)').option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json) => {
      emit(await adminRequest('GET', '/v1/admin/jira'), opts, d => {
        console.log(d.configured ? `Atlassian app ${d.clientId}` : 'No Atlassian app configured.');
        if (d.redirectUri) console.log(chalk.gray(`Callback URL to register in the Atlassian console: ${d.redirectUri}`));
      });
    }));

  jira.command('set').description('Set the Atlassian app (a new app needs its secret)')
    .requiredOption('--client-id <id>', 'OAuth client id').option('--client-secret-stdin', 'Read the client secret from stdin')
    .option('--json', 'Print as JSON')
    .option('--yes', 'Confirm replacing a configured app (it disconnects everyone\'s JIRA)')
    .action(adminAction(async (opts: Json & { clientId: string; clientSecretStdin?: boolean; yes?: boolean }) => {
      const current = await adminRequest('GET', '/v1/admin/jira');
      if (current.configured && current.clientId !== opts.clientId.trim()) {
        requireYes(opts, `replace Atlassian app ${current.clientId} with ${opts.clientId}: every person's JIRA connection is removed and they must reconnect`);
      }
      const body: Record<string, unknown> = { clientId: opts.clientId };
      if (opts.clientSecretStdin) body.clientSecret = await readStdin('client secret');
      emit(await adminRequest('PUT', '/v1/admin/jira', { body }), opts, () => console.log(chalk.green(`✓ Atlassian app ${opts.clientId} saved.`)));
    }));

  jira.command('disconnect-all').description('Disconnect every person\'s JIRA account')
    .option('--yes', 'Confirm').option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json & { yes?: boolean }) => {
      requireYes(opts, 'disconnect every person\'s JIRA account');
      emit(await adminRequest('POST', '/v1/admin/jira/disconnect-all'), opts, () => console.log(chalk.green('✓ Every JIRA connection is removed; people reconnect from the board.')));
    }));
}
