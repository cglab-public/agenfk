import { Command } from 'commander';
import chalk from 'chalk';
import {
  AdminCliError, adminAction, adminRequest, covers, emit, onOff, printTable, readStdin, requireYes,
} from './client';

/**
 * People & access (CGLAB-702 S2): the board's Users, Identities, Installations,
 * Sign-in and "API keys & invites" pages, plus CI tokens.
 */
type Json = { json?: boolean };
const enc = encodeURIComponent;

interface HubUser { id: string; email: string; role: string; active: number | boolean; provider: string; created_at: string; last_login_at: string | null }

/**
 * A user named by id, exact email, or email in any case - in that order. The
 * hub's email column is case-sensitive, so two accounts can differ only in
 * case: an inexact match that names more than one is refused, never guessed.
 */
async function resolveUser(ref: string): Promise<HubUser> {
  const users = await adminRequest<HubUser[]>('GET', '/v1/admin/users');
  const exact = users.find(x => x.id === ref) ?? users.find(x => x.email === ref.trim());
  if (exact) return exact;
  const want = ref.trim().toLowerCase();
  const loose = users.filter(x => x.email.toLowerCase() === want);
  if (loose.length > 1) {
    throw new AdminCliError(`"${ref}" matches ${loose.length} users that differ only in case (${loose.map(u => `${u.email} = ${u.id}`).join(', ')}). Name one by id.`);
  }
  if (loose.length === 0) throw new AdminCliError(`No user ${ref} on this hub (\`agenfk hub admin users list\`).`);
  return loose[0];
}

function role(value: string): 'admin' | 'viewer' {
  if (value === 'admin' || value === 'viewer') return value;
  throw new AdminCliError(`Role must be admin or viewer, not "${value}".`);
}

export function registerPeopleCommands(admin: Command): void {
  // ── Users ────────────────────────────────────────────────────────────────
  const users = admin.command('users').description('People who can sign in to the hub');
  covers('GET /v1/admin/users', 'POST /v1/admin/users/invite', 'PUT /v1/admin/users/:id', 'DELETE /v1/admin/users/:id');

  users.command('list').description('List users').option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json) => {
      emit(await adminRequest<HubUser[]>('GET', '/v1/admin/users'), opts, rows => printTable(rows, {
        EMAIL: r => r.email, ROLE: r => r.role, ACTIVE: r => (Number(r.active) ? 'yes' : 'no'),
        SIGN_IN: r => r.provider, LAST_LOGIN: r => r.last_login_at, ID: r => r.id,
      }, 'No users.'));
    }));

  users.command('invite <email>').description('Add a user (SSO-only unless --password-stdin)')
    .requiredOption('--role <role>', 'admin or viewer')
    .option('--password-stdin', 'Read an initial password from stdin')
    .option('--json', 'Print as JSON')
    .action(adminAction(async (email: string, opts: Json & { role: string; passwordStdin?: boolean }) => {
      const body: Record<string, unknown> = { email, role: role(opts.role) };
      if (opts.passwordStdin) body.password = await readStdin('password');
      const created = await adminRequest('POST', '/v1/admin/users/invite', { body });
      emit(created, opts, c => console.log(chalk.green(`✓ Added ${c.email} as ${c.role}.`)));
    }));

  users.command('set-role <user> <role>').description('Make a user an admin or a viewer (demoting needs --yes)')
    .option('--yes', 'Confirm a demotion to viewer')
    .action(adminAction(async (ref: string, r: string, opts: { yes?: boolean }) => {
      const next = role(r);
      if (next === 'viewer') requireYes(opts, `demote ${ref} to viewer`);
      const u = await resolveUser(ref);
      await adminRequest('PUT', `/v1/admin/users/${enc(u.id)}`, { body: { role: next } });
      console.log(chalk.green(`✓ ${u.email} is now ${r}.`));
    }));

  users.command('activate <user>').description('Let a deactivated user sign in again')
    .action(adminAction(async (ref: string) => {
      const u = await resolveUser(ref);
      await adminRequest('PUT', `/v1/admin/users/${enc(u.id)}`, { body: { active: true } });
      console.log(chalk.green(`✓ ${u.email} can sign in.`));
    }));

  users.command('deactivate <user>').description('Stop a user signing in (their sessions end at once)')
    .option('--yes', 'Confirm')
    .action(adminAction(async (ref: string, opts: { yes?: boolean }) => {
      requireYes(opts, `deactivate ${ref}`);
      const u = await resolveUser(ref);
      await adminRequest('PUT', `/v1/admin/users/${enc(u.id)}`, { body: { active: false } });
      console.log(chalk.green(`✓ ${u.email} is deactivated.`));
    }));

  users.command('set-password <user>').description('Set a password-sign-in user\'s password (read from stdin)')
    .requiredOption('--password-stdin', 'Read the password from stdin')
    .action(adminAction(async (ref: string) => {
      const u = await resolveUser(ref);
      const password = await readStdin('password');
      if (password.length < 8) throw new AdminCliError('A password must be at least 8 characters.');
      await adminRequest('PUT', `/v1/admin/users/${enc(u.id)}`, { body: { password } });
      console.log(chalk.green(`✓ Password set for ${u.email}.`));
    }));

  users.command('delete <user>').description('Delete a user')
    .option('--yes', 'Confirm')
    .action(adminAction(async (ref: string, opts: { yes?: boolean }) => {
      requireYes(opts, `delete user ${ref}`);
      const u = await resolveUser(ref);
      await adminRequest('DELETE', `/v1/admin/users/${enc(u.id)}`);
      console.log(chalk.green(`✓ Deleted ${u.email}.`));
    }));

  // ── Identities ───────────────────────────────────────────────────────────
  const ids = admin.command('identities').description('Who is who in the fleet\'s events: merges and hidden people');
  covers(
    'GET /v1/admin/identity-suggestions', 'GET /v1/admin/user-keys/merges', 'POST /v1/admin/user-keys/merge',
    'POST /v1/admin/user-keys/merges/:id/revert', 'GET /v1/admin/hidden-users', 'POST /v1/admin/hidden-users',
    'DELETE /v1/admin/hidden-users/:userKey',
  );

  ids.command('suggestions').description('Identities the hub thinks are the same person').option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json) => {
      emit(await adminRequest<any[]>('GET', '/v1/admin/identity-suggestions'), opts, rows => printTable(rows, {
        FROM: r => r.from, TO: r => r.to, EVENTS: r => r.events, CONFIDENCE: r => r.confidence,
        BLOCKED: r => (r.blockedByLiveKey ? 'live key' : ''), INSTALLATIONS: r => (r.installations ?? []).join(','),
      }, 'No suggestions.'));
    }));

  ids.command('merges').description('Merges made so far').option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json) => {
      emit(await adminRequest<any[]>('GET', '/v1/admin/user-keys/merges'), opts, rows => printTable(rows, {
        ID: r => r.id, FROM: r => r.from, TO: r => r.to, EVENTS: r => r.eventsMoved, BY: r => r.mergedByEmail,
        AT: r => r.createdAt, REVERTED: r => r.revertedAt,
      }, 'No merges.'));
    }));

  ids.command('merge <from> <to>').description('Fold one user key\'s history into another\'s')
    .option('--yes', 'Confirm').option('--json', 'Print as JSON')
    .action(adminAction(async (from: string, to: string, opts: Json & { yes?: boolean }) => {
      requireYes(opts, `merge ${from} into ${to}`);
      const r = await adminRequest('POST', '/v1/admin/user-keys/merge', { body: { from, to } });
      emit(r, opts, d => console.log(chalk.green(d.alreadyMerged
        ? `✓ ${d.from} was already merged into ${d.to}.`
        : `✓ Merged ${d.from} into ${d.to} (${d.eventsMoved} events moved; merge ${d.mergeId}).`)));
    }));

  ids.command('revert <mergeId>').description('Undo a merge')
    .option('--yes', 'Confirm').option('--json', 'Print as JSON')
    .action(adminAction(async (id: string, opts: Json & { yes?: boolean }) => {
      requireYes(opts, `revert merge ${id}`);
      const r = await adminRequest('POST', `/v1/admin/user-keys/merges/${enc(id)}/revert`);
      emit(r, opts, () => console.log(chalk.green(`✓ Reverted merge ${id}.`)));
    }));

  ids.command('hidden').description('People hidden from the hub\'s views').option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json) => {
      emit(await adminRequest<any[]>('GET', '/v1/admin/hidden-users'), opts, rows => printTable(rows, {
        USER: r => r.userKey, BY: r => r.hiddenByEmail, AT: r => r.createdAt,
      }, 'Nobody is hidden.'));
    }));

  ids.command('hide <userKey>').description('Hide a person and revoke their machines\' API keys')
    .option('--yes', 'Confirm').option('--json', 'Print as JSON')
    .action(adminAction(async (userKey: string, opts: Json & { yes?: boolean }) => {
      requireYes(opts, `hide ${userKey} and revoke their machines' keys`);
      const r = await adminRequest('POST', '/v1/admin/hidden-users', { body: { userKey } });
      emit(r, opts, d => console.log(chalk.green(`✓ Hid ${d.userKey}; revoked ${d.revokedApiKeys} API key(s).`)));
    }));

  ids.command('unhide <userKey>').description('Show a hidden person again').option('--json', 'Print as JSON')
    .action(adminAction(async (userKey: string, opts: Json) => {
      const r = await adminRequest('DELETE', `/v1/admin/hidden-users/${enc(userKey.trim().toLowerCase())}`);
      emit(r, opts, d => console.log(d.unhidden ? chalk.green(`✓ ${d.userKey} is visible again.`) : `${d.userKey} was not hidden.`));
    }));

  // ── Installations ────────────────────────────────────────────────────────
  const inst = admin.command('installations').description('Machines reporting to the hub');
  covers('GET /v1/admin/installations', 'POST /v1/admin/installations/:id/retire', 'DELETE /v1/admin/installations/:id/retire');

  inst.command('list').description('List installations')
    .option('--include-retired', 'Include retired installations')
    .option('--include-hidden', 'Include hidden people\'s installations')
    .option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json & { includeRetired?: boolean; includeHidden?: boolean }) => {
      const rows = await adminRequest<any[]>('GET', '/v1/admin/installations', {
        params: { includeRetired: opts.includeRetired ? '1' : undefined, includeHidden: opts.includeHidden ? '1' : undefined },
      });
      emit(rows, opts, list => printTable(list, {
        ID: r => r.id, WHO: r => r.gitEmail ?? r.osUser, VERSION: r => r.agenfkVersion, LAST_SEEN: r => r.lastSeen,
        STATE: r => (r.retired ? 'retired' : r.hidden ? 'hidden' : 'active'),
      }, 'No installations.'));
    }));

  inst.command('retire <id>').description('Retire a machine: revoke its keys and stop fleet directives to it')
    .option('--yes', 'Confirm').option('--json', 'Print as JSON')
    .action(adminAction(async (id: string, opts: Json & { yes?: boolean }) => {
      requireYes(opts, `retire installation ${id}`);
      const r = await adminRequest('POST', `/v1/admin/installations/${enc(id)}/retire`);
      emit(r, opts, d => console.log(chalk.green(`✓ Retired ${id}; revoked ${d.revokedApiKeys ?? 0} API key(s).`)));
    }));

  covers('POST /hub/device/approve');
  inst.command('approve <code>').description('Approve the code a machine\'s `agenfk hub login` shows: it gets an API key bound to it')
    .option('--yes', 'Confirm: only approve a code you know comes from a machine you trust').option('--json', 'Print as JSON')
    .action(adminAction(async (code: string, opts: Json & { yes?: boolean }) => {
      requireYes(opts, `give the machine showing code ${code} an API key for this hub`);
      const r = await adminRequest('POST', '/hub/device/approve', { body: { userCode: code } });
      emit(r, opts, d => {
        const who = d.installation?.gitEmail ?? d.installation?.osUser ?? d.installation?.installationId;
        console.log(chalk.green(`✓ Approved ${code}${who ? ` (${who})` : ''}; the machine picks up its key within a few seconds.`));
      });
    }));

  inst.command('unretire <id>').description('Bring a retired installation back').option('--json', 'Print as JSON')
    .action(adminAction(async (id: string, opts: Json) => {
      const r = await adminRequest('DELETE', `/v1/admin/installations/${enc(id)}/retire`);
      emit(r, opts, () => console.log(chalk.green(`✓ ${id} is no longer retired.`)));
    }));

  // ── Sign-in ──────────────────────────────────────────────────────────────
  const signIn = admin.command('sign-in').description('How people sign in to the hub: password, Google, Entra, allowlist');
  covers('GET /v1/admin/auth-config', 'PUT /v1/admin/auth-config');

  signIn.command('show').description('Show the sign-in configuration (secrets are never shown)').option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json) => {
      emit(await adminRequest('GET', '/v1/admin/auth-config'), opts, c => {
        console.log(`Password: ${c.passwordEnabled ? 'on' : 'off'}`);
        console.log(`Google:   ${c.googleEnabled ? 'on' : 'off'}  client ${c.google.clientId || '-'}  secret ${c.google.clientSecretSet ? 'set' : 'not set'}`);
        console.log(`Entra:    ${c.entraEnabled ? 'on' : 'off'}  tenant ${c.entra.tenantId || '-'}  client ${c.entra.clientId || '-'}  secret ${c.entra.clientSecretSet ? 'set' : 'not set'}`);
        console.log(`Allowlist: ${c.emailAllowlist.length ? c.emailAllowlist.join(', ') : '(anyone the provider admits)'}`);
      });
    }));

  signIn.command('set').description('Change the sign-in configuration (only the options given change)')
    .option('--password <on|off>', 'Password sign-in')
    .option('--google <on|off>', 'Google sign-in')
    .option('--google-client-id <id>', 'Google OAuth client id')
    .option('--google-client-secret-stdin', 'Read the Google client secret from stdin')
    .option('--entra <on|off>', 'Microsoft Entra sign-in')
    .option('--entra-tenant-id <id>', 'Entra tenant id')
    .option('--entra-client-id <id>', 'Entra client id')
    .option('--entra-client-secret-stdin', 'Read the Entra client secret from stdin')
    .option('--allowlist <list>', 'Comma-separated emails or domains allowed to sign in with SSO')
    .option('--clear-allowlist', 'Remove the allowlist')
    .option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json & Record<string, any>) => {
      if (opts.googleClientSecretStdin && opts.entraClientSecretStdin) {
        throw new AdminCliError('Set one client secret per call: stdin carries only one.');
      }
      const body: Record<string, any> = {};
      if (opts.password !== undefined) body.passwordEnabled = onOff(opts.password, '--password');
      if (opts.google !== undefined) body.googleEnabled = onOff(opts.google, '--google');
      if (opts.entra !== undefined) body.entraEnabled = onOff(opts.entra, '--entra');
      if (opts.googleClientId !== undefined || opts.googleClientSecretStdin) {
        body.google = {};
        if (opts.googleClientId !== undefined) body.google.clientId = opts.googleClientId;
        if (opts.googleClientSecretStdin) body.google.clientSecret = await readStdin('Google client secret');
      }
      if (opts.entraTenantId !== undefined || opts.entraClientId !== undefined || opts.entraClientSecretStdin) {
        body.entra = {};
        if (opts.entraTenantId !== undefined) body.entra.tenantId = opts.entraTenantId;
        if (opts.entraClientId !== undefined) body.entra.clientId = opts.entraClientId;
        if (opts.entraClientSecretStdin) body.entra.clientSecret = await readStdin('Entra client secret');
      }
      if (opts.allowlist !== undefined && opts.clearAllowlist) throw new AdminCliError('Pass --allowlist or --clear-allowlist, not both.');
      if (opts.allowlist !== undefined) {
        const entries = String(opts.allowlist).split(',').map((s: string) => s.trim()).filter(Boolean);
        // An empty allowlist means ANYONE the provider admits: say so with
        // --clear-allowlist, never by an unset shell variable.
        if (entries.length === 0) throw new AdminCliError('--allowlist names no one; to remove the allowlist (admit anyone the provider admits), pass --clear-allowlist.');
        body.emailAllowlist = entries;
      }
      if (opts.clearAllowlist) body.emailAllowlist = [];
      if (Object.keys(body).length === 0) throw new AdminCliError('Nothing to change: pass at least one option (see --help).');
      const saved = await adminRequest('PUT', '/v1/admin/auth-config', { body });
      emit(saved, opts, () => console.log(chalk.green('✓ Sign-in configuration saved.')));
    }));

  // ── API keys & invites ───────────────────────────────────────────────────
  const keys = admin.command('api-keys').description('Org-wide installation API keys');
  covers('GET /v1/admin/api-keys', 'POST /v1/admin/api-keys', 'DELETE /v1/admin/api-keys/:tokenHashPreview');

  keys.command('list').description('List API keys (by hash prefix; the keys themselves are never stored)').option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json) => {
      emit(await adminRequest<any[]>('GET', '/v1/admin/api-keys'), opts, rows => printTable(rows, {
        PREFIX: r => r.tokenHashPreview, LABEL: r => r.label, WHO: r => r.gitEmail ?? r.osUser, CREATED: r => r.createdAt,
        REVOKED: r => r.revokedAt,
      }, 'No API keys.'));
    }));

  keys.command('create').description('Issue an unbound API key (prefer `invites create` to onboard a machine)')
    .option('--label <label>', 'What the key is for').option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json & { label?: string }) => {
      const r = await adminRequest('POST', '/v1/admin/api-keys', { body: { label: opts.label } });
      emit(r, opts, d => {
        console.log(chalk.green('✓ API key (shown once; store it now):'));
        console.log(`  ${d.token}`);
        if (d.warning) console.log(chalk.yellow(d.warning));
      });
    }));

  keys.command('revoke <prefix>').description('Revoke the API key whose hash starts with <prefix>')
    .option('--yes', 'Confirm').option('--json', 'Print as JSON')
    .action(adminAction(async (prefix: string, opts: Json & { yes?: boolean }) => {
      requireYes(opts, `revoke API key ${prefix}`);
      const r = await adminRequest('DELETE', `/v1/admin/api-keys/${enc(prefix)}`);
      emit(r, opts, d => console.log(d.revoked ? chalk.green(`✓ Revoked ${d.revoked} key(s).`) : `No live key starts with ${prefix}.`));
    }));

  const invites = admin.command('invites').description('One-line invites that onboard a machine');
  covers('POST /hub/invite/create');
  invites.command('create').description('Create an installation invite and print its `agenfk hub join` command').option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json) => {
      const r = await adminRequest('POST', '/hub/invite/create');
      emit(r, opts, d => {
        console.log(chalk.green(`✓ Invite created (single use, expires ${d.expiresAt}). On the machine, run:`));
        console.log(`  ${d.joinCommand}`);
      });
    }));

  // ── CI tokens ────────────────────────────────────────────────────────────
  const ci = admin.command('ci-tokens').description('Read-only tokens CI uses to fetch receipts');
  covers('GET /v1/admin/ci-tokens', 'POST /v1/admin/ci-tokens', 'DELETE /v1/admin/ci-tokens/:tokenHashPreview');

  ci.command('list').description('List CI tokens').option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json) => {
      const { tokens } = await adminRequest<{ tokens: any[] }>('GET', '/v1/admin/ci-tokens');
      emit(tokens, opts, rows => printTable(rows, {
        PREFIX: r => r.tokenHashPreview, LABEL: r => r.label, SCOPE: r => (r.scope === 'repo' ? r.repo : 'org'),
        BY: r => r.createdByEmail, CREATED: r => r.createdAt, REVOKED: r => r.revokedAt,
      }, 'No CI tokens.'));
    }));

  ci.command('create').description('Issue a CI token')
    .option('--label <label>', 'What the token is for')
    .option('--scope <scope>', 'repo (default) or org', 'repo')
    .option('--repo <url>', 'The repository a repo-scoped token reads')
    .option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json & { label?: string; scope: string; repo?: string }) => {
      const r = await adminRequest('POST', '/v1/admin/ci-tokens', { body: { label: opts.label, scope: opts.scope, repo: opts.repo } });
      emit(r, opts, d => {
        console.log(chalk.green(`✓ CI token for ${d.scope === 'repo' ? d.repo : 'the whole org'} (shown once; store it now):`));
        console.log(`  ${d.token}`);
      });
    }));

  ci.command('revoke <prefix>').description('Revoke the CI token whose hash starts with <prefix>')
    .option('--yes', 'Confirm').option('--json', 'Print as JSON')
    .action(adminAction(async (prefix: string, opts: Json & { yes?: boolean }) => {
      requireYes(opts, `revoke CI token ${prefix}`);
      const r = await adminRequest('DELETE', `/v1/admin/ci-tokens/${enc(prefix)}`);
      emit(r, opts, d => console.log(d.revoked ? chalk.green(`✓ Revoked CI token ${prefix}.`) : chalk.yellow(`No live CI token starts with ${prefix}; nothing was revoked.`)));
    }));
}
