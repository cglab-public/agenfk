import { Command } from 'commander';
import chalk from 'chalk';
import {
  AdminCliError, adminAction, adminDownload, adminRequest, covers, emit, printTable, requireYes,
} from './client';

/**
 * The read side (CGLAB-702 S6): the fleet's events and the board's charts as
 * data, the audit log, and the rollup repair. Every query takes the board's own
 * filters and returns exactly what the board gets, as JSON or CSV, so it can be
 * scripted and piped.
 */

/** `agenfk hub admin data <query>` -> the board route it reads. */
/** The board's event filters, which every query but `people` reads. */
const EVENT = ['from', 'to', 'users', 'types', 'projects', 'itemTypes', 'childHub'] as const;
type FilterKey = typeof EVENT[number] | 'model' | 'pr' | 'bucket' | 'tz' | 'tzOffset' | 'limit' | 'offset' | 'before';
/**
 * Each query, the route it reads, and the filters that route actually APPLIES
 * (packages/hub/src/routes/queries.ts) - several parse the board's filters and
 * then use only some of them. A filter a route ignores is refused
 * rather than sent: an unfiltered answer must not pass for a filtered one.
 */
const QUERIES: Record<string, { route: string; about: string; filters: readonly FilterKey[] }> = {
  timeline: { route: '/v1/timeline', about: 'events, newest first (also `agenfk hub admin events`)', filters: [...EVENT, 'limit', 'offset', 'before'] },
  metrics: { route: '/v1/metrics', about: 'daily series and totals', filters: EVENT },
  histogram: { route: '/v1/histogram', about: 'events per bucket (--bucket)', filters: [...EVENT, 'bucket', 'tz', 'tzOffset'] },
  adherence: { route: '/v1/adherence', about: 'workflow adherence', filters: EVENT },
  // The overview counts PRs whatever their event or item type; --users picks developers.
  prs: { route: '/v1/prs/overview', about: 'the PR overview (--model, --pr)', filters: ['from', 'to', 'users', 'projects', 'childHub', 'model', 'pr', 'tz', 'tzOffset'] },
  // The people list itself is never narrowed by --users (it is what a user filter is picked from).
  users: { route: '/v1/users', about: 'people and their activity', filters: ['from', 'to', 'types', 'projects', 'itemTypes', 'childHub', 'tz'] },
  people: { route: '/v1/people/names', about: 'people\'s names (takes no filters)', filters: [] },
  // Pickers: they list what can be chosen, narrowed only by which hubs are read.
  projects: { route: '/v1/projects', about: 'repositories seen', filters: ['childHub'] },
  'event-types': { route: '/v1/event-types', about: 'event types seen', filters: ['childHub'] },
  'item-types': { route: '/v1/item-types', about: 'item types seen, with counts', filters: ['from', 'to', 'users', 'types', 'projects', 'childHub'] },
  // Counts for the time window; --child-hub adds selected hubs that have no events in it.
  'child-hubs': { route: '/v1/child-hubs', about: 'child hubs with their event counts', filters: ['from', 'to', 'childHub'] },
};
const FLAG_OF: Record<FilterKey, string> = {
  from: '--from', to: '--to', users: '--users', types: '--types', projects: '--projects', itemTypes: '--item-types',
  childHub: '--child-hub', model: '--model', pr: '--pr', bucket: '--bucket', tz: '--tz', tzOffset: '--tz-offset',
  limit: '--limit', offset: '--offset', before: '--before',
};
covers(...Object.values(QUERIES).map(q => `GET ${q.route}`));

interface FilterOpts {
  from?: string; to?: string; users?: string; types?: string; projects?: string; itemTypes?: string;
  childHub?: string; model?: string; pr?: string; bucket?: string; tz?: string; tzOffset?: string;
  limit?: string; offset?: string; before?: string; json?: boolean; csv?: boolean;
}

/** The board's filters, as options. Lists are comma-separated, the way the board sends them. */
function withFilters(cmd: Command): Command {
  return cmd
    .option('--from <date>', 'From (YYYY-MM-DD or an ISO instant)')
    .option('--to <date>', 'To (YYYY-MM-DD or an ISO instant)')
    .option('--users <list>', 'People (user keys, comma-separated)')
    .option('--types <list>', 'Event types (comma-separated)')
    .option('--projects <list>', 'Repositories (comma-separated)')
    .option('--item-types <list>', 'Item types (comma-separated)')
    .option('--child-hub <list>', 'Child hubs to read (comma-separated)')
    .option('--model <list>', 'Models (comma-separated; prs)')
    .option('--pr <ref>', 'One PR (prs)')
    .option('--bucket <b>', 'Bucket size (histogram)')
    .option('--tz <zone>', 'Time zone for day boundaries')
    .option('--tz-offset <min>', 'Time zone offset in minutes')
    .option('--limit <n>', 'Page size (timeline)')
    .option('--offset <n>', 'Page offset (timeline)')
    .option('--before <cursor>', 'Page before (timeline)')
    .option('--json', 'Print as JSON (the default)')
    .option('--csv', 'Print list rows as CSV');
}

function paramsOf(o: FilterOpts): Record<string, string | undefined> {
  return {
    from: o.from, to: o.to, users: o.users, types: o.types, projects: o.projects, itemTypes: o.itemTypes,
    childHubId: o.childHub, model: o.model, pr: o.pr, bucket: o.bucket, tz: o.tz, tzOffsetMin: o.tzOffset,
    limit: o.limit, offset: o.offset, before: o.before,
  };
}

/**
 * One CSV cell, as the hub's own audit CSV writes it: a text cell a
 * spreadsheet would run as a formula (=, +, -, @, tab, CR) is prefixed with a
 * quote. Event text is written by agents, so it is not trusted. Real numbers
 * are left as they are, negative ones included.
 */
const csvCell = (v: unknown): string => {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  let s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The rows of a result: the result itself when it is a list, else its one list field. */
function rowsOf(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const lists = Object.values(data).filter(Array.isArray);
    if (lists.length === 1) return lists[0] as unknown[];
  }
  return null;
}

function printCsv(data: unknown): void {
  const rows = rowsOf(data);
  if (!rows) throw new AdminCliError('This result is not a list; use --json.');
  const objects = rows.map(r => (r && typeof r === 'object' && !Array.isArray(r) ? r as Record<string, unknown> : { value: r }));
  const cols = [...new Set(objects.flatMap(o => Object.keys(o)))];
  console.log(cols.map(csvCell).join(','));
  for (const o of objects) console.log(cols.map(c => csvCell(o[c])).join(','));
}

async function runQuery(name: string, opts: FilterOpts): Promise<void> {
  const q = QUERIES[name];
  if (!q) throw new AdminCliError(`No query "${name}". Queries: ${Object.keys(QUERIES).join(', ')}.`);
  const ignored = (Object.keys(FLAG_OF) as FilterKey[]).filter(k => opts[k] !== undefined && !q.filters.includes(k));
  if (ignored.length) {
    throw new AdminCliError(`${name} does not read ${ignored.map(k => FLAG_OF[k]).join(', ')}${q.filters.length ? `; it reads ${q.filters.map(k => FLAG_OF[k]).join(', ')}` : '; it takes no filters'}.`);
  }
  const data = await adminRequest('GET', q.route, { params: paramsOf(opts) });
  if (opts.csv) printCsv(data);
  else console.log(JSON.stringify(data, null, 2));
}

export function registerDataCommands(admin: Command): void {
  withFilters(admin.command('events').description('The fleet\'s events, newest first (the board\'s timeline)'))
    .action(adminAction(async (opts: FilterOpts) => runQuery('timeline', opts)));

  withFilters(admin.command('data <query>').description(
    `The board's charts and lists as data. Queries: ${Object.entries(QUERIES).map(([n, q]) => `${n} (${q.about})`).join('; ')}`,
  )).action(adminAction(async (name: string, opts: FilterOpts) => runQuery(name, opts)));

  covers('POST /v1/admin/rollups/recompute');
  admin.command('rollups').description('The daily rollups the board\'s charts read').command('recompute').description('Rebuild the daily rollups the charts read (after a crash, or a merge that did not finish)')
    .option('--since <day>', 'From this day (YYYY-MM-DD)')
    .option('--full', 'The whole history (needs --yes: it can take a while on a large hub)')
    .option('--yes', 'Confirm --full').option('--json', 'Print as JSON')
    .action(adminAction(async (opts: { since?: string; full?: boolean; yes?: boolean; json?: boolean }) => {
      if (!opts.since && !opts.full) throw new AdminCliError('Pass --since YYYY-MM-DD, or --full for the whole history.');
      if (opts.since && opts.full) throw new AdminCliError('Pass --since or --full, not both.');
      if (opts.full) requireYes(opts, 'recompute every daily rollup');
      const r = await adminRequest('POST', '/v1/admin/rollups/recompute', { body: opts.full ? { full: true } : { since: opts.since } });
      emit(r, opts, d => console.log(chalk.green(`✓ Recomputed ${d.days} day(s)${d.full ? ' (full history)' : ` since ${d.since}`}.`)));
    }));

  // ── Audit log ────────────────────────────────────────────────────────────
  const audit = admin.command('audit').description('Who changed which setting, when, from where');
  covers('GET /v1/admin/audit', 'GET /v1/admin/audit.csv');
  const auditFilters = (cmd: Command) => cmd
    .option('--area <area>', 'Area (users, api-keys, flows, ...)')
    .option('--actor <text>', 'Part of the actor\'s email')
    .option('--from <date>', 'From (YYYY-MM-DD or a UTC instant)')
    .option('--to <date>', 'To (YYYY-MM-DD or a UTC instant)');

  auditFilters(audit.command('list').description('Audit rows, newest first'))
    .option('--limit <n>', 'Page size').option('--cursor <c>', 'Continue from a previous page').option('--json', 'Print as JSON')
    .action(adminAction(async (opts: { area?: string; actor?: string; from?: string; to?: string; limit?: string; cursor?: string; json?: boolean }) => {
      const r = await adminRequest('GET', '/v1/admin/audit', {
        params: { area: opts.area, actor: opts.actor, from: opts.from, to: opts.to, limit: opts.limit, cursor: opts.cursor },
      });
      emit(r, opts, d => {
        printTable(d.rows, {
          AT: (x: any) => x.at, ACTOR: (x: any) => x.actorEmail, SOURCE: (x: any) => x.source, AREA: (x: any) => x.area,
          ACTION: (x: any) => x.action, TARGET: (x: any) => x.target,
        }, 'No audit rows.');
        if (d.next) console.log(chalk.gray(`More: --cursor ${d.next}`));
      });
    }));

  auditFilters(audit.command('export').description('The audit log as CSV (the board\'s download)'))
    .option('--out <file>', 'Write to this file (default: stdout)')
    .action(adminAction(async (opts: { area?: string; actor?: string; from?: string; to?: string; out?: string }) => {
      const bytes = await adminDownload('/v1/admin/audit.csv', { area: opts.area, actor: opts.actor, from: opts.from, to: opts.to }, opts.out);
      if (opts.out) console.error(chalk.green(`✓ Wrote the audit log (${bytes} bytes) to ${opts.out}.`));
    }));
}
