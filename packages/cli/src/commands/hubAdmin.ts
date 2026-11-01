import { Command } from 'commander';
import chalk from 'chalk';
import axios from 'axios';
import { openUrlInBrowser } from '../openUrl';
import {
  AdminCliError, adminAction, adminRequest, clearAdminCreds, covers, emit, readAdminCreds, requireAdminCreds,
  requireYes, writeAdminCreds,
} from '../hubAdmin/client';
import { registerPeopleCommands } from '../hubAdmin/people';

/**
 * `agenfk hub admin …` (CGLAB-702): what the hub's admin pages do, from the
 * command line. This file holds the session commands; each area of the admin
 * UI registers its own group on the `admin` command it is handed.
 */
export interface HubAdminDeps {
  /** The hub URL hub.json names, for `login` without --url. */
  defaultHubUrl: () => string | null;
  /** The endpoint identity gate shared with `hub login`: true when `url` is an AgEnFK hub. */
  isHubEndpoint: (url: string, verb: string) => Promise<boolean>;
}

export function registerHubAdminCommands(hub: Command, deps: HubAdminDeps): Command {
  const admin = hub.command('admin').description('Administer the hub from the command line: everything its admin pages do');

  admin
    .command('login')
    .description('Sign in as a hub admin: approve the code in the browser, get a 12-hour admin session')
    .option('--url <url>', 'Hub base URL (default: the hub in ~/.agenfk/hub.json)')
    .option('--no-open', 'Do not open the browser; just print the URL')
    .action(adminAction(async (opts: { url?: string; open?: boolean }) => {
      const url = (opts.url ?? deps.defaultHubUrl() ?? '').replace(/\/$/, '');
      if (!url) throw new AdminCliError('No hub to sign in to: pass --url <hub url>, or connect this machine first with `agenfk hub login`.');
      if (!await deps.isHubEndpoint(url, 'hub admin login')) process.exit(1);

      let start: any;
      try {
        start = (await axios.post(`${url}/hub/admin-device/start`, {}, { timeout: 10_000 })).data;
      } catch (e: any) {
        throw new AdminCliError(`Could not start the sign-in at ${url}: ${e?.response?.data?.error ?? e?.message ?? e}`);
      }
      console.log();
      console.log(chalk.bold('Admin sign-in code: ') + chalk.cyan(start.userCode));
      console.log(chalk.gray('Open this URL, signed in to the hub as an admin, and approve:'));
      console.log('  ' + chalk.underline(start.verificationUri));
      if (opts.open !== false && !openUrlInBrowser(String(start.verificationUri))) {
        console.log(chalk.yellow('Not opening that URL automatically (it is not http/https); check it before opening it yourself.'));
      }

      const interval = Math.max(1, Number(start.interval) || 2);
      const expiresAt = Date.now() + Math.max(60, Number(start.expiresIn) || 600) * 1000;
      process.stdout.write(chalk.gray('Waiting for approval'));
      let approved: any = null;
      while (!approved && Date.now() < expiresAt) {
        await new Promise(r => setTimeout(r, interval * 1000));
        process.stdout.write(chalk.gray('.'));
        let data: any;
        try {
          data = (await axios.post(`${url}/hub/admin-device/poll`, { deviceCode: start.deviceCode }, { timeout: 10_000 })).data;
        } catch (e: any) {
          const status = e?.response?.status;
          // 404/410: the code is gone (the hub restarted, or the token was taken). Waiting cannot help.
          if (status === 404 || status === 410) throw new AdminCliError(`\nThe sign-in ended on the hub (${status}). Run \`agenfk hub admin login\` again.`);
          continue; // a dropped poll; try again on the next tick
        }
        if (data?.status === 'expired') throw new AdminCliError('\nThe code expired before it was approved. Run `agenfk hub admin login` again.');
        if (data?.status === 'approved') approved = data;
      }
      console.log();
      if (!approved) throw new AdminCliError('Timed out waiting for approval.');

      // The hub names the URL the token is for: gate THAT one before keeping it.
      const hubUrl = String(approved.hubUrl ?? url).replace(/\/$/, '');
      if (hubUrl !== url && !await deps.isHubEndpoint(hubUrl, 'hub admin login')) process.exit(1);
      writeAdminCreds({
        url: hubUrl,
        token: String(approved.token),
        orgId: String(approved.orgId),
        email: approved.user?.email ?? null,
        role: approved.user?.role ?? null,
        expiresAt: String(approved.expiresAt),
      });
      console.log(chalk.green(`✓ Signed in to ${hubUrl} as ${approved.user?.email ?? 'admin'} (org ${approved.orgId}).`));
      console.log(chalk.gray(`  The session ends at ${new Date(approved.expiresAt).toLocaleString()}; \`agenfk hub admin logout\` ends it now.`));
    }));

  admin
    .command('whoami')
    .description('Who the admin CLI is signed in as, and where')
    .option('--json', 'Print as JSON')
    .action(adminAction(async (opts: { json?: boolean }) => {
      const creds = requireAdminCreds();
      const me = await adminRequest<{ email: string | null; role: string; orgId: string; userId: string }>('GET', '/auth/me');
      const out = { email: me.email, role: me.role, orgId: me.orgId, userId: me.userId, url: creds.url, expiresAt: creds.expiresAt };
      emit(out, opts, (d) => {
        console.log(`Signed in to ${chalk.bold(d.url)} as ${chalk.bold(d.email ?? d.userId)} (${d.role}), org ${d.orgId}.`);
        console.log(chalk.gray(`Session ends at ${new Date(d.expiresAt).toLocaleString()}.`));
        if (d.role !== 'admin') console.log(chalk.yellow('This user is no longer an admin: admin commands will be refused.'));
      });
    }));

  admin
    .command('logout')
    .description('End the admin CLI session: revoke its token on the hub and forget it here')
    .action(adminAction(async () => {
      const creds = readAdminCreds();
      if (!creds) { console.log('Not signed in; nothing to do.'); return; }
      try {
        await axios.post(`${creds.url}/auth/logout`, {}, { headers: { Authorization: `Bearer ${creds.token}` }, timeout: 10_000 });
        clearAdminCreds();
        console.log(chalk.green(`✓ Signed out of ${creds.url}.`));
      } catch (e: any) {
        // The local copy goes regardless: keeping a credential the user asked to drop is worse.
        clearAdminCreds();
        console.error(chalk.yellow(`Removed the local credential, but the hub could not be reached (${e?.message ?? e}), so the token was NOT revoked.`));
        console.error(chalk.yellow(`It stays valid until ${new Date(creds.expiresAt).toLocaleString()}, or until an admin revokes it (\`agenfk hub admin sessions revoke\`).`));
      }
    }));

  const sessions = admin.command('sessions').description('Admin CLI sessions of this org');
  covers('GET /v1/admin/cli-sessions', 'DELETE /v1/admin/cli-sessions/:id');

  sessions
    .command('list')
    .description('List live admin CLI sessions')
    .option('--json', 'Print as JSON')
    .action(adminAction(async (opts: { json?: boolean }) => {
      const rows = await adminRequest<Array<{ id: string; userEmail: string | null; createdAt: string; expiresAt: string; current: boolean }>>('GET', '/v1/admin/cli-sessions');
      emit(rows, opts, (list) => {
        if (list.length === 0) { console.log('No live admin CLI sessions.'); return; }
        for (const s of list) {
          console.log(`${s.id}  ${s.userEmail ?? '(deleted user)'}  started ${s.createdAt}  ends ${s.expiresAt}${s.current ? chalk.cyan('  (this one)') : ''}`);
        }
      });
    }));

  sessions
    .command('revoke <id>')
    .description('Revoke an admin CLI session at once')
    .option('--yes', 'Confirm the revocation')
    .action(adminAction(async (id: string, opts: { yes?: boolean }) => {
      requireYes(opts, `revoke admin CLI session ${id}`);
      await adminRequest('DELETE', `/v1/admin/cli-sessions/${encodeURIComponent(id)}`);
      console.log(chalk.green(`✓ Revoked admin CLI session ${id}.`));
    }));

  registerPeopleCommands(admin);
  return admin;
}
