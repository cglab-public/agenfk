import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import {
  AdminCliError, adminAction, adminDownload, adminRequest, covers, emit, printTable, requireYes,
} from './client';

/**
 * Policies (CGLAB-702 S4): the board's Airlock, Repositories and Models pages.
 * Policies travel as files, so a change is reviewed before it is applied, and
 * the Airlock policy is saved against the revision it was read at.
 */
type Json = { json?: boolean };
const enc = encodeURIComponent;

function readFile(file: string): string {
  try { return fs.readFileSync(file, 'utf8'); } catch (e: any) { throw new AdminCliError(`Cannot read ${file}: ${e?.message ?? e}`); }
}
function readJson(file: string): any {
  try { return JSON.parse(readFile(file)); } catch (e) {
    if (e instanceof AdminCliError) throw e;
    throw new AdminCliError(`${file} is not JSON: ${(e as Error).message}`);
  }
}
function intOption(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new AdminCliError(`${flag} takes a whole number, not "${value}".`);
  return n;
}

export function registerPolicyCommands(admin: Command): void {
  // ── Airlock ──────────────────────────────────────────────────────────────
  const airlock = admin.command('airlock').description('Airlock: which hosts sandboxed agents may reach');
  covers(
    'GET /v1/admin/airlock', 'PUT /v1/admin/airlock', 'PUT /v1/admin/airlock/ioc', 'GET /v1/admin/airlock/installations',
    'GET /v1/admin/airlock/history', 'GET /v1/admin/airlock/decisions', 'GET /v1/admin/airlock/dataset',
    'PUT /v1/admin/airlock/dataset', 'GET /v1/admin/airlock/dataset/export', 'GET /v1/admin/airlock/learning',
    'POST /v1/admin/airlock/learning/accept',
  );

  const policy = airlock.command('policy').description('The org\'s Airlock policy');
  policy.command('show').description('Show the policy; --out writes { revision, policy } for `policy set`')
    .option('--out <file>', 'Write the policy and its revision to this file').option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json & { out?: string }) => {
      const view = await adminRequest('GET', '/v1/admin/airlock');
      if (opts.out) {
        fs.writeFileSync(opts.out, JSON.stringify({ revision: view.revision, policy: view.policy }, null, 2) + '\n');
        console.log(chalk.green(`✓ Wrote policy revision ${view.revision} to ${opts.out}.`));
        return;
      }
      emit(view, opts, v => {
        if (!v.policy) { console.log('No Airlock policy yet.'); return; }
        console.log(`Revision ${v.revision} (IOC ${v.iocRevision}), mode ${v.policy.mode}, by ${v.updatedByEmail ?? '-'} at ${v.updatedAt ?? '-'}`);
        console.log(`  allow: ${(v.policy.hosts?.allow ?? []).join(', ') || '-'}`);
        console.log(`  deny:  ${(v.policy.hosts?.deny ?? []).join(', ') || '-'}`);
        console.log(`  IOC:   ${(v.policy.iocHosts?.hosts ?? []).length} host(s)`);
      });
    }));

  policy.command('set').description('Save a policy from a file (a bare policy, or what `policy show --out` wrote)')
    .requiredOption('--file <file>', 'Policy (JSON)')
    .option('--expected-revision <n>', 'The revision the policy was read at (default: the one in the file)')
    .option('--yes', 'Confirm: every sandboxed agent in the org follows it')
    .option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json & { file: string; expectedRevision?: string; yes?: boolean }) => {
      const doc = readJson(opts.file);
      const wrapped = doc && typeof doc === 'object' && 'policy' in doc;
      const body = wrapped ? doc.policy : doc;
      const expectedRevision = intOption(opts.expectedRevision, '--expected-revision') ?? (wrapped && Number.isInteger(doc.revision) ? doc.revision : undefined);
      if (expectedRevision === undefined) {
        throw new AdminCliError('Say which revision this policy replaces: --expected-revision <n> (0 for the first), or save it from `policy show --out`, which records it.');
      }
      requireYes(opts, `replace the org's Airlock policy (revision ${expectedRevision})`);
      const r = await adminRequest('PUT', '/v1/admin/airlock', { body: { policy: body, expectedRevision } });
      emit(r, opts, v => console.log(chalk.green(`✓ Saved Airlock policy revision ${v.revision}.`)));
    }));

  airlock.command('ioc').description('Indicator-of-compromise hosts every sandbox refuses')
    .command('set').description('Replace the IOC host list from a file (one host per line, # comments; or a JSON array)')
    .requiredOption('--file <file>', 'Host list').option('--yes', 'Confirm').option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json & { file: string; yes?: boolean }) => {
      const text = readFile(opts.file);
      const hosts: string[] = text.trim().startsWith('[')
        ? readJson(opts.file)
        : text.split(/\r?\n/).map(l => l.replace(/#.*/, '').trim()).filter(Boolean);
      requireYes(opts, `replace the IOC host list with ${hosts.length} host(s)`);
      const r = await adminRequest('PUT', '/v1/admin/airlock/ioc', { body: { hosts } });
      emit(r, opts, v => console.log(chalk.green(`✓ IOC list is revision ${v.iocRevision} (${hosts.length} host(s)).`)));
    }));

  airlock.command('installations').description('Which policy revision each installation runs').option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json) => {
      emit(await adminRequest('GET', '/v1/admin/airlock/installations'), opts, d => printTable(d.installations ?? [], {
        INSTALLATION: (r: any) => r.installationId, WHO: (r: any) => r.gitEmail ?? r.osUser, APPLIED: (r: any) => r.appliedRevision,
        IOC: (r: any) => r.appliedIocRevision, STATE: (r: any) => (r.refusedError ? `refused r${r.refusedRevision}: ${r.refusedError}` : r.behind ? 'behind' : 'current'),
        LAST_SEEN: (r: any) => r.lastSeen,
      }, 'No installations have fetched the policy.'));
    }));

  airlock.command('history').description('Past policy revisions')
    .option('--limit <n>', 'How many').option('--cursor <c>', 'Continue from a previous page').option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json & { limit?: string; cursor?: string }) => {
      const r = await adminRequest('GET', '/v1/admin/airlock/history', { params: { limit: intOption(opts.limit, '--limit'), cursor: opts.cursor } });
      emit(r, opts, d => {
        printTable(d.entries, {
          AT: (e: any) => e.at, ACTION: (e: any) => e.action, BY: (e: any) => e.actorEmail, SOURCE: (e: any) => e.source,
          REVISION: (e: any) => (e.after ? `${e.before?.revision ?? '-'} -> ${e.after.revision}` : ''),
          IOC: (e: any) => (e.after ? `${e.before?.iocRevision ?? '-'} -> ${e.after.iocRevision}` : ''),
        }, 'No history.');
        if (d.next) console.log(chalk.gray(`More: --cursor ${d.next}`));
      });
    }));

  airlock.command('decisions').description('What sandboxes allowed and denied')
    .option('--client <c>', 'Agent client').option('--installation <id>', 'Installation id')
    .option('--source <s>', 'Decision source').option('--alert <a>', 'Alert kind, or "any"').option('--mode <m>', 'Policy mode')
    .option('--limit <n>', 'How many').option('--cursor <c>', 'Continue from a previous page').option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json & Record<string, string | undefined>) => {
      const r = await adminRequest('GET', '/v1/admin/airlock/decisions', {
        params: {
          client: opts.client, installation: opts.installation, source: opts.source, alert: opts.alert, mode: opts.mode,
          limit: intOption(opts.limit, '--limit'), cursor: opts.cursor,
        },
      });
      emit(r, opts, d => {
        printTable(d.decisions, {
          AT: (x: any) => x.at, TARGET: (x: any) => x.target, DECISION: (x: any) => x.decision, RULE: (x: any) => x.rule,
          MODE: (x: any) => x.mode, SOURCE: (x: any) => x.source, ALERT: (x: any) => x.alert, CLIENT: (x: any) => x.client,
          INSTALLATION: (x: any) => x.installationId,
        }, 'No decisions.');
        if (d.next) console.log(chalk.gray(`More: --cursor ${d.next}`));
      });
    }));

  const dataset = airlock.command('dataset').description('The decision dataset the hub keeps for learning');
  dataset.command('show').description('Whether the dataset is collected, and its size').option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json) => {
      emit(await adminRequest('GET', '/v1/admin/airlock/dataset'), opts, d => {
        console.log(`Collection: ${d.enabled ? 'on' : 'off'}${d.updatedByEmail ? ` (set by ${d.updatedByEmail} at ${d.updatedAt})` : ''}`);
        console.log(`Rows: ${d.rows}, labelled: ${d.labels}${d.oldest ? `, from ${d.oldest} to ${d.newest}` : ''}`);
      });
    }));
  dataset.command('on').description('Start collecting the dataset').option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json) => {
      emit(await adminRequest('PUT', '/v1/admin/airlock/dataset', { body: { enabled: true } }), opts, () => console.log(chalk.green('✓ Dataset collection is on.')));
    }));
  dataset.command('off').description('Stop collecting the dataset').option('--yes', 'Confirm').option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json & { yes?: boolean }) => {
      requireYes(opts, 'stop collecting the Airlock dataset');
      emit(await adminRequest('PUT', '/v1/admin/airlock/dataset', { body: { enabled: false } }), opts, () => console.log(chalk.green('✓ Dataset collection is off.')));
    }));
  dataset.command('export').description('Export the dataset as JSON lines')
    .option('--out <file>', 'Write to this file (default: stdout)')
    .action(adminAction(async (opts: { out?: string }) => {
      const bytes = await adminDownload('/v1/admin/airlock/dataset/export', {}, opts.out);
      if (opts.out) console.error(chalk.green(`✓ Wrote the dataset (${bytes} bytes) to ${opts.out}.`));
    }));

  const learning = airlock.command('learning').description('Hosts sandboxes keep asking for, proposed for the allow list');
  learning.command('list').description('Proposed hosts').option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json) => {
      emit(await adminRequest('GET', '/v1/admin/airlock/learning'), opts, d => {
        console.log(chalk.gray(`Policy revision ${d.revision}`));
        printTable(d.hosts, {
          HOST: (h: any) => h.host, HITS: (h: any) => h.hits, PROXY: (h: any) => h.proxyHits, INSTALLATIONS: (h: any) => h.installations,
          CLIENTS: (h: any) => (h.clients ?? []).join(','), LAST_SEEN: (h: any) => h.lastSeen,
        }, 'No proposals.');
      });
    }));
  learning.command('accept <hosts...>').description('Allow proposed hosts (a new policy revision)')
    .requiredOption('--expected-revision <n>', 'The policy revision `learning list` showed the proposals at')
    .option('--yes', 'Confirm').option('--json', 'Print as JSON')
    .action(adminAction(async (hosts: string[], opts: Json & { expectedRevision: string; yes?: boolean }) => {
      // Never re-read the revision here: the admin reviewed the proposals at a
      // revision, and a policy change since then must surface as a conflict.
      const expectedRevision = intOption(opts.expectedRevision, '--expected-revision')!;
      requireYes(opts, `allow ${hosts.join(', ')} for every sandbox`);
      const r = await adminRequest('POST', '/v1/admin/airlock/learning/accept', { body: { hosts, expectedRevision } });
      emit(r, opts, v => console.log(chalk.green(`✓ Allowed ${hosts.length} host(s); policy revision ${v.revision}.`)));
    }));

  // ── Repositories ─────────────────────────────────────────────────────────
  const repos = admin.command('repos').description('Per-repository verification: command, receipts mode, producers');
  covers(
    'GET /v1/admin/repos', 'GET /v1/admin/repos/receipts', 'GET /v1/admin/repos/revisions', 'PUT /v1/admin/repos/command',
    'PUT /v1/admin/repos/mode', 'PUT /v1/admin/repos/producer-mode', 'PUT /v1/admin/repos/producers',
  );

  repos.command('list').description('Repositories the hub knows').option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json) => {
      const { repos: rows } = await adminRequest<{ repos: any[] }>('GET', '/v1/admin/repos');
      emit(rows, opts, list => printTable(list, {
        REPO: r => r.remoteUrl, COMMAND: r => r.verifyCommand, REV: r => r.revision,
        RECEIPTS: r => `${r.receiptsMode}${r.shadowThreshold !== null && r.shadowThreshold !== undefined ? `/${r.shadowThreshold}` : ''}`,
        PRODUCERS: r => (r.producerMode === 'all' ? 'all' : r.producers.join(',') || '(none)'), LAST_RECEIPT: r => r.lastReceiptAt,
      }, 'No repositories.'));
    }));

  repos.command('receipts').description('Recent verification receipts of a repository')
    .requiredOption('--repo <url>', 'Repository URL').option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json & { repo: string }) => {
      const { receipts } = await adminRequest<{ receipts: any[] }>('GET', '/v1/admin/repos/receipts', { params: { repo: opts.repo } });
      emit(receipts, opts, rows => printTable(rows, {
        ID: r => r.id, KIND: r => r.kind, COMMIT: r => r.commit, CMD_REV: r => r.commandRevision, INSTALLATION: r => r.installationId,
        PRODUCER: r => (r.producerAllowed ? 'allowed' : 'not allowed'), CARD: r => r.cardTitle ?? r.cardId, RECEIVED: r => r.receivedAt,
      }, 'No receipts.'));
    }));

  repos.command('revisions').description('The verify command\'s revisions')
    .requiredOption('--repo <url>', 'Repository URL').option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json & { repo: string }) => {
      const { revisions } = await adminRequest<{ revisions: any[] }>('GET', '/v1/admin/repos/revisions', { params: { repo: opts.repo } });
      emit(revisions, opts, rows => printTable(rows, {
        REV: r => r.revision, COMMAND: r => r.verifyCommand, SOURCE: r => r.source, BY: r => r.actorEmail ?? r.installationId, AT: r => r.createdAt,
      }, 'No revisions.'));
    }));

  repos.command('set-command').description('Change the command that verifies a repository')
    .requiredOption('--repo <url>', 'Repository URL').requiredOption('--command <cmd>', 'Verify command')
    .option('--yes', 'Confirm: every installation working on this repo runs it').option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json & { repo: string; command: string; yes?: boolean }) => {
      requireYes(opts, `make "${opts.command}" the verify command of ${opts.repo}`);
      const r = await adminRequest('PUT', '/v1/admin/repos/command', { body: { repo: opts.repo, verifyCommand: opts.command } });
      emit(r, opts, v => console.log(chalk.green(`✓ ${opts.repo} verifies with "${v.verifyCommand ?? opts.command}" (revision ${v.revision}).`)));
    }));

  repos.command('set-mode').description('How receipts gate a repository: off, shadow or enforce')
    .requiredOption('--repo <url>', 'Repository URL').requiredOption('--mode <mode>', 'off, shadow or enforce')
    .option('--shadow-threshold <n>', 'Shadow mode threshold')
    .option('--yes', 'Confirm (required for enforce: it can block merges)').option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json & { repo: string; mode: string; shadowThreshold?: string; yes?: boolean }) => {
      if (opts.mode === 'enforce') requireYes(opts, `enforce receipts on ${opts.repo}`);
      const body: Record<string, unknown> = { repo: opts.repo, mode: opts.mode };
      if (opts.shadowThreshold !== undefined) body.shadowThreshold = intOption(opts.shadowThreshold, '--shadow-threshold');
      const r = await adminRequest('PUT', '/v1/admin/repos/mode', { body });
      emit(r, opts, v => console.log(chalk.green(`✓ ${opts.repo}: receipts ${v.receiptsMode ?? opts.mode}.`)));
    }));

  repos.command('producer-mode').description('Who may produce receipts: the listed installations, or all')
    .requiredOption('--repo <url>', 'Repository URL').requiredOption('--mode <mode>', 'listed or all')
    .option('--yes', 'Confirm (required for all: every live installation\'s receipts are then trusted for reuse)')
    .option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json & { repo: string; mode: string; yes?: boolean }) => {
      if (opts.mode === 'all') requireYes(opts, `trust receipts from EVERY live installation for ${opts.repo}`);
      const r = await adminRequest('PUT', '/v1/admin/repos/producer-mode', { body: { repo: opts.repo, producerMode: opts.mode } });
      emit(r, opts, () => console.log(chalk.green(`✓ ${opts.repo}: producers are ${opts.mode === 'all' ? 'every installation' : 'the listed installations'}.`)));
    }));

  const producer = repos.command('producer').description('The list of installations allowed to produce receipts');
  for (const [verb, allowed] of [['allow', true], ['deny', false]] as const) {
    producer.command(verb).description(`${allowed ? 'Add an installation to' : 'Remove an installation from'} the list`)
      .requiredOption('--repo <url>', 'Repository URL').requiredOption('--installation <id>', 'Installation id').option('--json', 'Print as JSON')
      .action(adminAction(async (opts: Json & { repo: string; installation: string }) => {
        const r = await adminRequest('PUT', '/v1/admin/repos/producers', { body: { repo: opts.repo, installationId: opts.installation, allowed } });
        emit(r, opts, v => {
          if (v.producerMode === 'all') {
            // Under `all` the list does not decide: say so, rather than claim a revocation.
            console.log(chalk.yellow(`${allowed ? 'Added' : 'Removed'} ${opts.installation} ${allowed ? 'to' : 'from'} the list, but ${opts.repo} trusts EVERY live installation (producer mode all), so this changes nothing until \`repos producer-mode --mode listed\`.`));
            return;
          }
          console.log(chalk.green(`✓ ${opts.installation} ${allowed ? 'may' : 'may no longer'} produce receipts for ${opts.repo}.`));
        });
      }));
  }

  // ── Models ───────────────────────────────────────────────────────────────
  const models = admin.command('models').description('How the hub names and labels the models agents report');
  covers(
    'GET /v1/admin/models', 'PUT /v1/admin/models/meta', 'DELETE /v1/admin/models/meta/:model',
    'POST /v1/admin/models/mappings', 'DELETE /v1/admin/models/mappings/:aliasModel',
  );

  models.command('list').description('Models seen, their mappings and metadata').option('--json', 'Print as JSON')
    .action(adminAction(async (opts: Json) => {
      emit(await adminRequest('GET', '/v1/admin/models'), opts, d => {
        printTable(d.observed ?? [], { MODEL: (m: any) => m.model, PRS: (m: any) => m.prs, AS: (m: any) => (m.isMapped ? m.canonicalModel : '') }, 'No models reported yet.');
        if (d.mappings?.length) {
          console.log();
          printTable(d.mappings, { ALIAS: (m: any) => m.aliasModel, CANONICAL: (m: any) => m.canonicalModel, BY: (m: any) => m.createdByEmail });
        }
      });
    }));

  models.command('map <alias> <canonical>').description('Count an alias as another model').option('--json', 'Print as JSON')
    .action(adminAction(async (alias: string, canonical: string, opts: Json) => {
      const r = await adminRequest('POST', '/v1/admin/models/mappings', { body: { aliasModel: alias, canonicalModel: canonical } });
      emit(r, opts, () => console.log(chalk.green(`✓ ${alias} counts as ${canonical}.`)));
    }));

  models.command('unmap <alias>').description('Remove a mapping').option('--json', 'Print as JSON')
    .action(adminAction(async (alias: string, opts: Json) => {
      const r = await adminRequest('DELETE', `/v1/admin/models/mappings/${enc(alias)}`);
      emit(r, opts, d => console.log(d.removed ? chalk.green(`✓ Removed the mapping of ${alias}.`) : `${alias} was not mapped.`));
    }));

  const meta = models.command('meta').description('Provider and licence labels of a model');
  meta.command('set <model>').description('Label a model')
    .requiredOption('--provider <p>', 'Provider').requiredOption('--license-class <c>', 'open_weights or commercial')
    .requiredOption('--license <l>', 'Licence name').option('--json', 'Print as JSON')
    .action(adminAction(async (model: string, opts: Json & { provider: string; licenseClass: string; license: string }) => {
      const r = await adminRequest('PUT', '/v1/admin/models/meta', { body: { model, provider: opts.provider, licenseClass: opts.licenseClass, license: opts.license } });
      emit(r, opts, () => console.log(chalk.green(`✓ Labelled ${model}.`)));
    }));
  meta.command('delete <model>').description('Remove a model\'s labels (back to the built-in ones, if any)').option('--json', 'Print as JSON')
    .action(adminAction(async (model: string, opts: Json) => {
      const r = await adminRequest('DELETE', `/v1/admin/models/meta/${enc(model)}`);
      emit(r, opts, d => console.log(d.removed ? chalk.green(`✓ Removed the labels of ${model}.`) : `${model} had no labels of its own.`));
    }));
}
