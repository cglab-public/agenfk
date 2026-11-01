import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import {
  AdminCliError, adminAction, adminRequest, covers, emit, onOff, printTable, readStdin, requireYes,
} from './client';

/**
 * Fleet (CGLAB-702 S3): the board's Flows, Upgrades and Address change pages.
 * Flow definitions travel as JSON files, so a change can be reviewed (and kept
 * in git) before it is applied.
 */
type Json = { json?: boolean };
const enc = encodeURIComponent;
const collect = (v: string, prev: string[] = []) => [...prev, v];

/** A flow definition from a file: the definition itself, or an exported flow wrapping it. */
function readDefinition(file: string): any {
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e: any) { throw new AdminCliError(`Cannot read ${file}: ${e?.message ?? e}`); }
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch (e: any) { throw new AdminCliError(`${file} is not JSON: ${e?.message ?? e}`); }
  return parsed && typeof parsed === 'object' && parsed.definition && typeof parsed.definition === 'object' ? parsed.definition : parsed;
}

/** What a registry copy did; a partial copy is said plainly, with the way to finish it. */
function reportCopy(d: { copied?: number; skipped?: number; failed?: string[]; truncated?: boolean }): void {
  if (d.copied !== undefined) console.log(`  Copied ${d.copied} community flow(s)${d.skipped ? `, ${d.skipped} already there` : ''}.`);
  if (d.failed?.length) console.log(chalk.yellow(`  ${d.failed.length} could not be copied: ${d.failed.join(', ')}. Run \`agenfk hub admin flows registry sync\` to retry.`));
  if (d.truncated) console.log(chalk.yellow('  The copy stopped early (too many flows for one pass). Run `agenfk hub admin flows registry sync` to continue.'));
}

export function registerFleetCommands(admin: Command): void {
  // ── Flows ────────────────────────────────────────────────────────────────
  const flows = admin.command('flows').description('Workflow flows the hub offers its fleet');
  covers(
    'GET /v1/admin/flows', 'GET /v1/admin/flows/:id', 'GET /v1/admin/flows/default', 'POST /v1/admin/flows',
    'PUT /v1/admin/flows/:id', 'POST /v1/admin/flows/contract', 'PUT /v1/admin/flows/:id/availability',
    'DELETE /v1/admin/flows/:id',
  );

  flows.command('list').description('List flows').option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json) => {
      emit(await adminRequest<any[]>('GET', '/v1/admin/flows'), opts, rows => printTable(rows, {
        ID: r => r.id, NAME: r => r.name, VERSION: r => r.version, SOURCE: r => r.source,
        ORG_AVAILABLE: r => (r.orgAvailable ? 'yes' : 'no'), UPDATED: r => r.updatedAt,
      }, 'No flows.'));
    }));

  flows.command('get <id>').description('Show a flow; --out writes its definition to a file for `update`')
    .option('--out <file>', 'Write the definition (JSON) to this file').option('--json', 'Print as JSON')
    .action(adminAction(async (id: string, opts: Json & { out?: string }) => {
      const flow = await adminRequest('GET', `/v1/admin/flows/${enc(id)}`);
      if (opts.out) {
        fs.writeFileSync(opts.out, JSON.stringify(flow.definition, null, 2) + '\n');
        console.log(chalk.green(`✓ Wrote ${flow.name} (v${flow.version}) to ${opts.out}.`));
        return;
      }
      emit(flow, opts, f => {
        console.log(`${chalk.bold(f.name)}  v${f.version}  ${f.source}${f.orgAvailable ? '  (available to the org)' : ''}`);
        for (const s of f.definition.steps ?? []) console.log(`  ${s.order}. ${s.name}${s.exitCriteria ? chalk.gray(` - ${String(s.exitCriteria).split('\n')[0]}`) : ''}`);
      });
    }));

  flows.command('default').description('Show the built-in default flow').option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json) => {
      emit(await adminRequest('GET', '/v1/admin/flows/default'), opts, f => {
        for (const s of f.steps ?? []) console.log(`  ${s.order}. ${s.name}`);
      });
    }));

  flows.command('create').description('Create a flow from a definition file')
    .requiredOption('--file <file>', 'Flow definition (JSON)')
    .option('--community', 'Mark it as coming from the community registry')
    .option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json & { file: string; community?: boolean }) => {
      const definition = readDefinition(opts.file);
      const r = await adminRequest('POST', '/v1/admin/flows', { body: { definition, source: opts.community ? 'community' : 'hub' } });
      emit(r, opts, f => console.log(chalk.green(`✓ Created flow ${f.name} (${f.id}).`)));
    }));

  flows.command('update <id>').description('Replace a flow\'s definition from a file')
    .requiredOption('--file <file>', 'Flow definition (JSON)').option('--json', 'Print as JSON')
    .action(adminAction(async (id: string, opts: Json & { file: string }) => {
      const r = await adminRequest('PUT', `/v1/admin/flows/${enc(id)}`, { body: { definition: readDefinition(opts.file) } });
      emit(r, opts, f => console.log(chalk.green(`✓ Updated ${f.name} to v${f.version}.`)));
    }));

  flows.command('contract').description('What a definition\'s steps require of an agent (its contract)')
    .requiredOption('--file <file>', 'Flow definition (JSON)').option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json & { file: string }) => {
      const def = readDefinition(opts.file);
      emit(await adminRequest('POST', '/v1/admin/flows/contract', { body: { steps: def.steps } }), opts, c => console.log(JSON.stringify(c, null, 2)));
    }));

  flows.command('available <id> <onOff>').description('Offer the flow to the org\'s projects, or stop offering it')
    .option('--json', 'Print as JSON')
    .action(adminAction(async (id: string, value: string, opts: Json) => {
      const r = await adminRequest('PUT', `/v1/admin/flows/${enc(id)}/availability`, { body: { available: onOff(value, 'available') } });
      emit(r, opts, d => console.log(chalk.green(`✓ ${id} is ${d.orgAvailable ? 'now' : 'no longer'} available to the org.`)));
    }));

  flows.command('delete <id>').description('Delete a flow').option('--yes', 'Confirm')
    .action(adminAction(async (id: string, opts: { yes?: boolean }) => {
      requireYes(opts, `delete flow ${id}`);
      await adminRequest('DELETE', `/v1/admin/flows/${enc(id)}`);
      console.log(chalk.green(`✓ Deleted flow ${id}.`));
    }));

  // Assignments: which flow a scope (org / repo / project / installation) runs.
  covers('GET /v1/admin/flow-assignments', 'PUT /v1/admin/flow-assignments', 'GET /v1/admin/projects');
  flows.command('projects').description('Projects seen in the fleet: the targets of --scope project').option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json) => {
      emit(await adminRequest<any[]>('GET', '/v1/admin/projects'), opts, rows => printTable(rows, {
        PROJECT: r => r.projectId, LAST_SEEN: r => r.lastSeen,
      }, 'No projects seen yet.'));
    }));

  flows.command('assignments').description('Which flow each scope runs').option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json) => {
      emit(await adminRequest<any[]>('GET', '/v1/admin/flow-assignments'), opts, rows => printTable(rows, {
        SCOPE: r => r.scope, TARGET: r => r.targetId || '(org)', FLOW: r => r.flowId, UPDATED: r => r.updatedAt,
      }, 'No assignments: every project runs its own flow.'));
    }));

  flows.command('assign').description('Assign a flow to a scope (--flow none clears it)')
    .requiredOption('--scope <scope>', 'org, repo, project or installation')
    .option('--target <id>', 'The repo URL, project id or installation id (not for org)')
    .requiredOption('--flow <id>', 'Flow id, or "none" to clear')
    .option('--yes', 'Confirm (required for --scope org: it changes every project without its own assignment)')
    .option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json & { scope: string; target?: string; flow: string; yes?: boolean }) => {
      if (!['org', 'repo', 'project', 'installation'].includes(opts.scope)) throw new AdminCliError('--scope must be org, repo, project or installation.');
      if (opts.scope !== 'org' && !opts.target) throw new AdminCliError(`--target is required for --scope ${opts.scope}.`);
      const flowId = opts.flow === 'none' ? null : opts.flow;
      if (opts.scope === 'org') requireYes(opts, flowId ? `make ${flowId} the flow of every project in the org` : 'clear the org-wide flow assignment');
      const r = await adminRequest('PUT', '/v1/admin/flow-assignments', { body: { scope: opts.scope, targetId: opts.target ?? '', flowId } });
      emit(r, opts, d => console.log(chalk.green(d.flowId ? `✓ ${d.scope}${d.targetId ? ` ${d.targetId}` : ''} now runs ${d.flowId}.` : `✓ Cleared the ${d.scope} assignment.`)));
    }));

  // Registry: where the org's flows are published and installed from.
  const registry = flows.command('registry').description('The flow registry this org publishes to and installs from');
  covers(
    'GET /v1/admin/registry-config', 'PUT /v1/admin/registry-config', 'POST /v1/admin/registry-config/sync',
    'GET /v1/admin/registry/pulls', 'GET /v1/admin/registry/flows', 'POST /v1/admin/flows/install',
  );
  registry.command('show').description('Show the registry configuration (the token is never shown)').option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json) => {
      emit(await adminRequest('GET', '/v1/admin/registry-config'), opts, c => console.log(`${c.repo}@${c.branch}${c.isPublic ? ' (public community registry)' : ''}`));
    }));

  registry.command('set').description('Use a GitHub repo of your own as the org registry')
    .requiredOption('--repo <owner/repo>', 'GitHub repository')
    .option('--branch <branch>', 'Branch')
    .option('--token-stdin', 'Read a GitHub token (contents:write) from stdin')
    .option('--yes', 'Confirm: every installation browses and installs flows from this registry')
    .option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json & { repo: string; branch?: string; tokenStdin?: boolean; yes?: boolean }) => {
      requireYes(opts, `point the org's flow registry at ${opts.repo}`);
      const body: Record<string, unknown> = { repo: opts.repo };
      if (opts.branch) body.branch = opts.branch;
      if (opts.tokenStdin) body.token = await readStdin('GitHub token');
      emit(await adminRequest('PUT', '/v1/admin/registry-config', { body }), opts, c => {
        console.log(chalk.green(`✓ Registry is ${c.repo}@${c.branch}.`));
        reportCopy(c);
      });
    }));

  registry.command('sync').description('Copy the public registry\'s flows into the org registry').option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json) => {
      emit(await adminRequest('POST', '/v1/admin/registry-config/sync'), opts, reportCopy);
    }));

  registry.command('pulls').description('Open pull requests on the org registry').option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json) => {
      emit(await adminRequest('GET', '/v1/admin/registry/pulls'), opts, d => {
        printTable(d.pulls ?? [], {
          '#': (r: any) => r.number, TITLE: (r: any) => `${r.draft ? '[draft] ' : ''}${r.title}`, BY: (r: any) => r.author, URL: (r: any) => r.url,
        }, d.isPublic ? 'The org is on the public community registry; it has no pull requests of its own.' : 'No open pull requests.');
        if (d.truncated) console.log(chalk.gray(`More at ${d.allUrl}`));
      });
    }));

  registry.command('list').description('Flows in the registry')
    .option('--source <source>', 'org or community').option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json & { source?: string }) => {
      emit(await adminRequest<any[]>('GET', '/v1/admin/registry/flows', { params: { source: opts.source } }), opts, rows => printTable(rows, {
        FILE: r => r.filename, NAME: r => r.name, VERSION: r => r.version, STEPS: r => r.stepCount, AUTHOR: r => r.author,
      }, 'The registry has no flows.'));
    }));

  registry.command('install <filename>').description('Install a flow from the registry into the hub')
    .option('--source <source>', 'org or community').option('--json', 'Print as JSON')
    .action(adminAction(async (filename: string, opts: Json & { source?: string }) => {
      const r = await adminRequest('POST', '/v1/admin/flows/install', { body: { filename, source: opts.source } });
      emit(r, opts, f => console.log(chalk.green(`✓ Installed ${f.name ?? filename}${f.id ? ` (${f.id})` : ''}.`)));
    }));

  // Dispatches: send a flow down to child hubs (federation).
  covers('POST /v1/admin/flow-dispatches', 'GET /v1/admin/flow-dispatches', 'POST /v1/admin/flow-dispatches/:id/cancel');
  flows.command('dispatch <flowId>').description('Send a flow to child hubs: those named with --child, or (without it) every current AND future child hub until cancelled')
    .option('--child <id>', 'A child hub id (repeatable); omit for all current and future child hubs', collect)
    .option('--yes', 'Confirm').option('--json', 'Print as JSON')
    .action(adminAction(async (flowId: string, opts: Json & { child?: string[]; yes?: boolean }) => {
      const children = opts.child ?? [];
      requireYes(opts, `send flow ${flowId} to ${children.length ? `${children.length} child hub(s)` : 'every current and future child hub (until cancelled)'}`);
      const r = await adminRequest('POST', '/v1/admin/flow-dispatches', {
        body: { flowId, scope: children.length ? 'selected' : 'all', childHubIds: children },
      });
      emit(r, opts, d => console.log(chalk.green(`✓ Dispatch ${d.id}: flow ${d.flowId} v${d.flowVersion} to ${d.scope === 'all' ? 'every current and future child hub, until cancelled' : 'the named hubs'}.`)));
    }));

  flows.command('dispatches').description('Flow dispatches to child hubs and how each landed').option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json) => {
      const { dispatches } = await adminRequest<{ dispatches: any[] }>('GET', '/v1/admin/flow-dispatches');
      emit(dispatches, opts, rows => printTable(rows, {
        ID: r => r.id, FLOW: r => `${r.flowId} v${r.flowVersion}`, SCOPE: r => r.scope, BY: r => r.createdByEmail,
        AT: r => r.createdAt, TARGETS: r => (r.targets ?? []).map((t: any) => `${t.name}:${t.state}`).join(' '), CANCELLED: r => r.cancelledAt,
      }, 'No flow dispatches.'));
    }));

  flows.command('dispatch-cancel <id>').description('Stop delivering a flow dispatch (hubs that already installed it keep it)')
    .option('--yes', 'Confirm')
    .action(adminAction(async (id: string, opts: { yes?: boolean }) => {
      requireYes(opts, `cancel flow dispatch ${id}`);
      await adminRequest('POST', `/v1/admin/flow-dispatches/${enc(id)}/cancel`);
      console.log(chalk.green(`✓ Cancelled flow dispatch ${id}: no further hub will receive it. Hubs that already installed the flow keep it.`));
    }));

  // ── Upgrades ─────────────────────────────────────────────────────────────
  const up = admin.command('upgrades').description('Fleet upgrades of agenfk');
  covers(
    'GET /v1/admin/upgrade/available-versions', 'POST /v1/admin/upgrade', 'GET /v1/admin/upgrade',
    'POST /v1/admin/upgrade/:directiveId/cancel', 'POST /v1/admin/upgrade-dispatches', 'GET /v1/admin/upgrade-dispatches',
    'POST /v1/admin/upgrade-dispatches/:id/cancel',
  );

  up.command('versions').description('Releases the fleet can move to (newest first)')
    .option('--refresh', 'Re-read the release list now').option('--all', 'Include releases older than the fleet\'s oldest install')
    .option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json & { refresh?: boolean; all?: boolean }) => {
      const r = await adminRequest('GET', '/v1/admin/upgrade/available-versions', {
        params: { refresh: opts.refresh ? '1' : undefined, unfiltered: opts.all ? '1' : undefined },
      });
      emit(r, opts, d => {
        if (d.fleetFloor) console.log(chalk.gray(`Oldest install in the fleet: ${d.fleetFloor}`));
        for (const v of d.versions) console.log(v);
      });
    }));

  up.command('list').description('Upgrade directives and where each installation is').option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json) => {
      const { directives } = await adminRequest<{ directives: any[] }>('GET', '/v1/admin/upgrade');
      emit(directives, opts, rows => {
        if (rows.length === 0) { console.log('No upgrades.'); return; }
        for (const d of rows) {
          console.log(`${chalk.bold(d.directiveId)}  -> ${d.targetVersion}  (${d.scope.type})  by ${d.createdByEmail ?? '-'} at ${d.createdAt}`);
          for (const t of d.targets ?? []) console.log(`    ${t.installationId}  ${t.state}${t.errorMessage ? chalk.red(`  ${t.errorMessage}`) : ''}`);
        }
      });
    }));

  up.command('start <version>').description('Upgrade the fleet (or the installations named with --installation)')
    .option('--installation <id>', 'An installation id (repeatable); omit for the whole fleet', collect)
    .option('--confirm-downgrade', 'Allow moving installations to an older version')
    .option('--yes', 'Confirm').option('--json', 'Print as JSON')
    .action(adminAction(async (version: string, opts: Json & { installation?: string[]; confirmDowngrade?: boolean; yes?: boolean }) => {
      const ids = opts.installation ?? [];
      requireYes(opts, `upgrade ${ids.length ? `${ids.length} installation(s)` : 'the whole fleet'} to ${version}`);
      const scope = ids.length === 0 ? { type: 'all' }
        : ids.length === 1 ? { type: 'installation', installationId: ids[0] }
          : { type: 'installations', installationIds: ids };
      const r = await adminRequest('POST', '/v1/admin/upgrade', { body: { targetVersion: version, scope, confirmDowngrade: !!opts.confirmDowngrade } });
      emit(r, opts, d => console.log(chalk.green(`✓ Upgrade ${d.directiveId}: ${d.targetCount} installation(s) to ${d.targetVersion}.`)));
    }));

  up.command('cancel <directiveId>').description('Cancel an upgrade for the installations it has not reached')
    .option('--force', 'Also cancel installations already upgrading').option('--yes', 'Confirm').option('--json', 'Print as JSON')
    .action(adminAction(async (id: string, opts: Json & { force?: boolean; yes?: boolean }) => {
      requireYes(opts, `cancel upgrade ${id}`);
      const r = await adminRequest('POST', `/v1/admin/upgrade/${enc(id)}/cancel`, { body: { force: !!opts.force } });
      emit(r, opts, d => {
        // The hub's cancelledCount already includes the forced ones.
        const forced = Number(d.forcedCount ?? 0);
        console.log(chalk.green(`✓ Cancelled ${Number(d.cancelledCount ?? 0) - forced} pending target(s)${forced ? `, and force-cancelled ${forced} in progress` : ''}.`));
        const left = d.leftAlone ?? {};
        if (left.in_progress) console.log(chalk.yellow(`  ${left.in_progress} installation(s) are still upgrading and were left alone; --force cancels those too.`));
        if (left.succeeded || left.failed) console.log(chalk.gray(`  Already finished: ${left.succeeded ?? 0} succeeded, ${left.failed ?? 0} failed.`));
      });
    }));

  up.command('dispatch <version>').description('Upgrade child hubs\' fleets: those named with --child, or (without it) every current AND future child hub until cancelled')
    .option('--child <id>', 'A child hub id (repeatable); omit for all current and future child hubs', collect)
    .option('--confirm-downgrade', 'Allow moving to an older version')
    .option('--yes', 'Confirm').option('--json', 'Print as JSON')
    .action(adminAction(async (version: string, opts: Json & { child?: string[]; confirmDowngrade?: boolean; yes?: boolean }) => {
      const children = opts.child ?? [];
      requireYes(opts, `upgrade ${children.length ? `${children.length} child hub(s)` : 'every current and future child hub (until cancelled)'} to ${version}`);
      const r = await adminRequest('POST', '/v1/admin/upgrade-dispatches', {
        body: { targetVersion: version, scope: children.length ? 'selected' : 'all', childHubIds: children, confirmDowngrade: !!opts.confirmDowngrade },
      });
      emit(r, opts, d => console.log(chalk.green(`✓ Upgrade dispatch ${d.id} to ${d.targetVersion} for ${d.scope === 'all' ? 'every current and future child hub, until cancelled' : 'the named hubs'}.`)));
    }));

  up.command('dispatches').description('Group upgrade dispatches to child hubs').option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json) => {
      const { dispatches } = await adminRequest<{ dispatches: any[] }>('GET', '/v1/admin/upgrade-dispatches');
      emit(dispatches, opts, rows => printTable(rows, {
        ID: r => r.id, VERSION: r => r.targetVersion, SCOPE: r => r.scope, BY: r => r.createdByEmail, AT: r => r.createdAt,
        TARGETS: r => (r.targets ?? []).map((t: any) => `${t.name}:${t.state}`).join(' '), CANCELLED: r => r.cancelledAt,
      }, 'No upgrade dispatches.'));
    }));

  up.command('dispatch-cancel <id>').description('Cancel a group upgrade dispatch').option('--yes', 'Confirm')
    .action(adminAction(async (id: string, opts: { yes?: boolean }) => {
      requireYes(opts, `cancel upgrade dispatch ${id}`);
      await adminRequest('POST', `/v1/admin/upgrade-dispatches/${enc(id)}/cancel`);
      console.log(chalk.green(`✓ Cancelled upgrade dispatch ${id}.`));
    }));

  // ── Address change ───────────────────────────────────────────────────────
  const rp = admin.command('repoint').description('Move the fleet to a new hub address');
  covers('GET /v1/admin/repoint', 'POST /v1/admin/repoint', 'POST /v1/admin/repoint/:id/close');

  rp.command('status').description('The address change under way, and where each installation is').option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json) => {
      emit(await adminRequest('GET', '/v1/admin/repoint'), opts, d => {
        if (!d.campaign) { console.log('No address change under way.'); return; }
        console.log(`${chalk.bold(d.campaign.id)}  -> ${d.campaign.targetUrl}  started ${d.campaign.createdAt}${d.drained ? chalk.green('  (every installation has moved)') : ''}`);
        printTable(d.targets, { INSTALLATION: (t: any) => t.installationId, WHO: (t: any) => t.gitEmail, STATE: (t: any) => t.state, ERROR: (t: any) => t.errorMessage });
      });
    }));

  rp.command('start <targetUrl>').description('Tell every installation to move to a new hub address')
    .option('--yes', 'Confirm').option('--json', 'Print as JSON')
    .action(adminAction(async (targetUrl: string, opts: Json & { yes?: boolean }) => {
      requireYes(opts, `move the whole fleet to ${targetUrl}`);
      const r = await adminRequest('POST', '/v1/admin/repoint', { body: { targetUrl } });
      emit(r, opts, d => console.log(chalk.green(`✓ Address change ${d.id} to ${d.targetUrl} started for ${d.targeted} installation(s).`)));
    }));

  rp.command('close <id>').description('End an address change').option('--yes', 'Confirm')
    .action(adminAction(async (id: string, opts: { yes?: boolean }) => {
      requireYes(opts, `end address change ${id}`);
      await adminRequest('POST', `/v1/admin/repoint/${enc(id)}/close`);
      console.log(chalk.green(`✓ Ended address change ${id}.`));
    }));
}
