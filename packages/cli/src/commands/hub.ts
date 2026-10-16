import { Command } from 'commander';
import chalk from 'chalk';
import axios from 'axios';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { exec, execFileSync, execSync, spawn } from 'child_process';
import { getApiUrl, getInstallationId } from '@agenfk/telemetry';
import {
  parseDeadletterLines,
  deadletterReasonOf,
  deadletterIndicator,
  indicatorHint,
  refusalHint,
  validateRequeueFilters,
  type DeadletterEntry,
  type DeadletterLine,
  type DeadletterIndicator,
  type RequeueFilters,
  type RequeueSummary,
} from '@agenfk/core';

function readGitConfig(key: string): string | null {
  try {
    return execFileSync('git', ['config', '--get', key], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500,
      windowsHide: true,
    }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Warn when this machine has no git email. The hub attributes events with
 * `gitEmail || osUser`, so without one the person's entire history is filed
 * under an OS username — and setting user.email later creates a SECOND identity
 * that an admin has to merge. Cheap to fix now, awkward to fix later.
 */
function warnIfNoGitEmail(identity: { osUser: string; gitEmail: string | null }): void {
  if (identity.gitEmail) return;
  console.log();
  console.log(chalk.yellow('⚠ No git email configured on this machine.'));
  console.log(chalk.gray(`  Your work will be attributed to the OS username "${identity.osUser}" instead of you,`));
  console.log(chalk.gray('  and setting it later creates a second identity an admin has to merge.'));
  console.log(chalk.gray('  Fix it first with: git config --global user.email "you@company.com"'));
  console.log();
}

function localInstallationIdentity(): { installationId: string; osUser: string; gitName: string | null; gitEmail: string | null } {
  return {
    installationId: getInstallationId(),
    osUser: os.userInfo().username,
    gitName: readGitConfig('user.name'),
    gitEmail: readGitConfig('user.email'),
  };
}

// Home-dir files resolved AT CALL TIME, not module load: importing this
// module must not freeze a snapshot of the environment (tests sandbox HOME
// after import; a long-lived CLI process could see HOME change).
function hubConfigFile(): string { return path.join(os.homedir(), '.agenfk', 'hub.json'); }
function verifyTokenFile(): string { return path.join(os.homedir(), '.agenfk', 'verify-token'); }
// Kept in sync with the server flusher's defaultDeadletterPath() (the writer);
// same duplication idiom as hub.json across hubClient/server/CLI.
function deadletterFile(): string { return path.join(os.homedir(), '.agenfk', 'hub-deadletter.jsonl'); }
function auditFile(): string { return path.join(os.homedir(), '.agenfk', 'hub-audit.jsonl'); }

interface HubConfig { url: string; token: string; orgId: string }

// One line of ~/.agenfk/hub-deadletter.jsonl (written by the server flusher),
// and one physical line of the file: an unparseable line keeps entry null and
// is preserved verbatim through partial discards (review F2). Shared with the
// server's requeue (#223).
export type { DeadletterEntry } from '@agenfk/core';

export interface DeadletterOrgSummary {
  org: string;
  count: number;
  firstAt: string | null;
  lastAt: string | null;
  reasons: Record<string, number>;
}

function deadletterOrgOf(e: DeadletterEntry): string {
  const orgId = (e?.payload && typeof e.payload === 'object') ? (e.payload as any).orgId : undefined;
  return typeof orgId === 'string' && orgId.length > 0 ? orgId : '(unknown)';
}

/**
 * Group deadletter entries by the org stamped on the preserved payload:
 * count, occurred-at range and reason tallies per org. Exported (and unit
 * tested) so the list command's math is testable without a real home dir.
 */
export function summarizeDeadletter(entries: DeadletterEntry[]): DeadletterOrgSummary[] {
  const byOrg = new Map<string, DeadletterOrgSummary>();
  for (const e of entries) {
    const org = deadletterOrgOf(e);
    let g = byOrg.get(org);
    if (!g) {
      g = { org, count: 0, firstAt: null, lastAt: null, reasons: {} };
      byOrg.set(org, g);
    }
    g.count++;
    const at = typeof e?.occurredAt === 'string' ? e.occurredAt : null;
    if (at) {
      if (!g.firstAt || at < g.firstAt) g.firstAt = at;
      if (!g.lastAt || at > g.lastAt) g.lastAt = at;
    }
    const reason = typeof e?.reason === 'string' && e.reason ? e.reason : 'unknown';
    g.reasons[reason] = (g.reasons[reason] ?? 0) + 1;
  }
  return [...byOrg.values()];
}

/**
 * The entries that SURVIVE a discard: --all keeps nothing, --org keeps
 * everything not stamped with that org. Exported for unit tests.
 */
export function filterDeadletterForDiscard(entries: DeadletterEntry[], opts: { org?: string; all?: boolean }): DeadletterEntry[] {
  if (opts.all) return [];
  if (opts.org) return entries.filter(e => deadletterOrgOf(e) !== opts.org);
  return entries;
}

/**
 * Line-level discard filter (review F2): unparseable lines are nobody's org,
 * so --org preserves them; --all (typed confirmation covers the whole file)
 * does not.
 *
 * --reason narrows to those refusal reasons (with --org: lines matching both),
 * and --unparseable removes the unreadable lines — so the lines a requeue can
 * never move go without taking requeueable events with them (#223).
 */
export function filterDeadletterLinesForDiscard(
  lines: DeadletterLine[],
  opts: { org?: string; all?: boolean; reasons?: string[]; unparseable?: boolean },
): DeadletterLine[] {
  if (opts.all) return [];
  const selects = !!opts.org || !!opts.reasons?.length;
  return lines.filter(l => {
    if (l.entry === null) return !opts.unparseable;
    if (!selects) return true;
    const orgMatches = !opts.org || deadletterOrgOf(l.entry) === opts.org;
    const reasonMatches = !opts.reasons?.length || opts.reasons.includes(deadletterReasonOf(l.entry));
    return !(orgMatches && reasonMatches);
  });
}

function readDeadletterLines(): DeadletterLine[] {
  let raw: string;
  try { raw = fs.readFileSync(deadletterFile(), 'utf8'); } catch { return []; }
  return parseDeadletterLines(raw);
}

function writeDeadletterLines(kept: DeadletterLine[]): void {
  if (kept.length === 0) {
    try { fs.unlinkSync(deadletterFile()); } catch { /* already gone */ }
    return;
  }
  // tmp + rename: a truncate-then-fail on the survivor set would destroy the
  // very file this feature exists to protect (review F3).
  const tmp = deadletterFile() + '.tmp';
  fs.mkdirSync(path.dirname(deadletterFile()), { recursive: true });
  fs.writeFileSync(tmp, kept.map(l => l.raw).join('\n') + '\n', { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* ignore */ }
  fs.renameSync(tmp, deadletterFile());
}

function appendHubAuditLine(line: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(auditFile()), { recursive: true });
  fs.appendFileSync(auditFile(), JSON.stringify(line) + '\n', { mode: 0o600 });
  try { fs.chmodSync(auditFile(), 0o600); } catch { /* ignore */ }
}

async function askLine(question: string): Promise<string> {
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => rl.question(question, (a: string) => resolve(a.trim())));
  } finally {
    rl.close();
  }
}

/**
 * Interactive confirmation is impossible without a TTY: readline's question
 * callback never fires at EOF, so an unpiped `--yes`-less run would wedge
 * forever (review F8). Refuse instead — the repo gates on isTTY elsewhere.
 */
function refuseWithoutTty(flag: string): boolean {
  if (process.stdin.isTTY) return false;
  console.error(chalk.red('Refusing: interactive confirmation is required but stdin is not a TTY.'));
  console.error(chalk.gray(`  Review the summary above, then re-run with ${flag} for scripted use.`));
  return true;
}

/** Thrown by rewriteOutboxAndAudit when the POST itself fails; the caller
 *  decides the error channel (carry-over exits red, repoint warns and moves
 *  on). Anything else thrown (e.g. the confirmation/exit signals) must NOT be
 *  caught as a rewrite failure. */
class HubRewriteFailed extends Error {
  constructor(public readonly cause: unknown) {
    super('hub outbox rewrite failed');
  }
}

/**
 * The shared tenancy-crossing sequence: POST the rewrite, then audit it —
 * in that order, with the audit OUTSIDE the POST's error channel so an audit
 * failure can never be downgraded to a rewrite warning (review F4 and the
 * bug the story-4 mutation run caught). Returns the rewritten count.
 */
async function rewriteOutboxAndAudit(from: string, to: string, verifyToken: string): Promise<number> {
  let rewritten: number;
  try {
    const { data } = await axios.post(
      `${getApiUrl()}/internal/hub/rewrite-outbox-org`,
      { from, to },
      { headers: { 'x-agenfk-internal': verifyToken }, timeout: 15_000 },
    );
    rewritten = Number(data?.rewritten ?? 0);
  } catch (e: any) {
    throw new HubRewriteFailed(e);
  }
  let osUser = 'unknown';
  try { osUser = os.userInfo().username; } catch { /* no passwd entry (containers) */ }
  try {
    appendHubAuditLine({ at: new Date().toISOString(), from, to, rewritten, osUser });
  } catch (ae: any) {
    console.error(chalk.red.bold(`!! REWRITE SUCCEEDED (${rewritten} event(s)) BUT THE AUDIT LINE FAILED TO WRITE: ${ae?.message ?? ae}`));
    console.error(chalk.red(`   Append it manually to ${auditFile()} before anyone reads this output as "nothing happened".`));
    process.exit(1);
  }
  return rewritten;
}

/** "a (2), b (1)": a count map, largest first. */
function countList(counts: Record<string, number>): string {
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} (${n})`).join(', ');
}

/** The refusal indicator from the deadletter file itself, for when the local server cannot be asked. */
function localDeadletterIndicator(): DeadletterIndicator {
  return deadletterIndicator(readDeadletterLines());
}

/**
 * The sticky `Refused` line of `hub status` (#223). It reads the deadletter
 * file, so unlike `Last error` it does not clear on the next flush: only a
 * requeue or a discard that empties the file clears it.
 */
function printRefusals(ind: DeadletterIndicator | undefined): void {
  if (!ind || !(Number(ind.count) > 0)) return;
  const byCount = Object.entries(ind.reasons ?? {}).sort((a, b) => b[1] - a[1]);
  const parts = byCount.map(([r, n]) => `${r} ${n}`);
  if (ind.unparseable > 0) parts.push(`unparseable ${ind.unparseable}`);
  const line = `Refused:   ${ind.count} since ${ind.since ?? '?'} (${parts.join(', ')})`;
  console.log(ind.actionable > 0 ? chalk.red(line) : chalk.yellow(line));
  // Nothing actionable (hidden_user only): still say what those lines are.
  const hint = indicatorHint(ind) ?? (byCount[0] ? refusalHint(byCount[0][0]) : null);
  if (hint) console.log(chalk.gray(`  → ${hint}`));
}

/** Why a deadletter line was left out of a requeue, for the summary. */
function describeExclusion(cause: string): string {
  if (cause === 'unparseable') return 'unparseable lines (only `agenfk hub deadletter discard --all` removes them)';
  if (cause === 'unreplayable') return 'lines without a usable eventId — they cannot be sent again';
  if (cause === 'org') return 'stamped with another org than --org';
  if (cause === 'type') return 'other event types than --type';
  if (cause === 'since') return 'older than --since';
  const reason = cause.startsWith('reason:') ? cause.slice('reason:'.length) : cause;
  return `${reason} — left out unless named with --reason ${reason}`;
}

/** The requeue's dry-run summary: what moves, what stays and why, and what will still need a carry-over. */
function printRequeueSummary(summary: RequeueSummary, excluded: Array<[string, number]>, configuredOrg: string): void {
  console.log(`About to requeue ${chalk.bold(String(summary.count))} event(s) from the deadletter, ${summary.firstAt} .. ${summary.lastAt}`);
  console.log(`  reasons:       ${countList(summary.byReason)}`);
  console.log(`  types:         ${countList(summary.byType)}`);
  console.log(`  orgs:          ${countList(summary.byOrg)}`);
  console.log(`  installations: ${countList(summary.byInstallation)}`);
  if (excluded.length > 0) {
    console.log(chalk.gray('  Left in the deadletter:'));
    for (const [cause, n] of excluded) console.log(chalk.gray(`    ${describeExclusion(cause)}: ${n}`));
  }
  for (const [org, n] of Object.entries(summary.byOrg)) {
    if (org === configuredOrg || org === '(none)') continue;
    console.log(chalk.yellow(
      `  ${n} event(s) are stamped with org "${org}": they will wait in the outbox as stale rows. `
      + `Move them with \`agenfk hub carry-over --from ${org} --to ${configuredOrg}\`.`,
    ));
  }
}

/** What /v1/ping told us, or why it could not. */
export type HubPingResult =
  | { ok: true; data: { orgId?: unknown; installationId?: unknown; [k: string]: unknown } }
  | { ok: false; status: number | null; message: string };

/**
 * Will the hub accept the selected events under this machine's key? (#223)
 *
 * A bound key refuses every event whose installationId is not its own
 * (foreign_installation), so requeueing into a wrong binding only sends the
 * same events straight back to the deadletter. `abort` lists what makes the
 * requeue pointless (overridable with --force); `warn` lists what could not
 * be checked.
 */
export function requeueBindingVerdict(
  ping: HubPingResult,
  cfg: { orgId: string },
  summary: Pick<RequeueSummary, 'byInstallation'>,
  localInstallationId: string,
): { abort: string[]; warn: string[] } {
  const abort: string[] = [];
  const warn: string[] = [];
  if (!ping.ok) {
    if (ping.status === 401 || ping.status === 403) {
      abort.push(`The hub refused this machine's key (HTTP ${ping.status}). Ask a hub admin for a new invite and run \`agenfk hub join\`.`);
    } else {
      warn.push(`Could not reach the hub (${ping.message}), so it cannot verify the key's binding. The events wait in the outbox until the hub answers.`);
    }
    return { abort, warn };
  }
  if (ping.data.orgId !== cfg.orgId) {
    abort.push(`The hub answers for org "${String(ping.data.orgId)}", but ~/.agenfk/hub.json says "${cfg.orgId}". Fix the hub configuration first (\`agenfk hub status\`).`);
    return { abort, warn };
  }
  if (!('installationId' in ping.data)) {
    warn.push('This hub does not report key bindings (an older hub), so it cannot verify that it will accept these events.');
    return { abort, warn };
  }
  const bound = ping.data.installationId;
  if (bound === null || bound === undefined) {
    warn.push('This machine\'s key is not bound to an installation, so the hub cannot be checked ahead; it judges each event as it arrives.');
    return { abort, warn };
  }
  if (bound !== localInstallationId) {
    abort.push(
      `This machine's hub key is bound to installation ${String(bound)}, but this machine is ${localInstallationId}. `
      + 'The hub refuses every event from another installation under this key. Ask a hub admin for a new invite, '
      + 'run `agenfk hub join`, then requeue.',
    );
    return { abort, warn };
  }
  const foreign = Object.entries(summary.byInstallation ?? {}).filter(([inst]) => inst !== bound);
  if (foreign.length > 0) {
    const n = foreign.reduce((acc, [, c]) => acc + c, 0);
    abort.push(
      `${n} selected event(s) were recorded by ${foreign.map(([i, c]) => `${i} (${c})`).join(', ')}, but this key is bound to ${String(bound)}: `
      + 'the hub refuses them one by one. Narrow the selection, or pass --force to send them anyway.',
    );
  }
  return { abort, warn };
}

/** "a,b" and repeated flags alike: commander's variadic values, split on commas. */
function splitList(values: string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  const out = values.flatMap(v => v.split(',')).map(v => v.trim()).filter(Boolean);
  return out.length > 0 ? out : undefined;
}

/**
 * Identity gate (CGLAB-117 story 4): never persist a hub.json — or send a
 * token to — an endpoint that has not identified itself as an AgenFK Hub.
 * The 31 Aug fixture clobber began with exactly this: a hub.json whose URL
 * was not a hub. Same gate `hub repoint` already had, now on every login
 * path. Returns true when the endpoint is a hub; reports and exits otherwise.
 */
async function isHubEndpoint(url: string, verb: string): Promise<boolean> {
  try {
    const { data, status } = await axios.get(`${url}/healthz`, { timeout: 10_000 });
    if (status === 200 && data && data.service === 'agenfk-hub') return true;
    console.error(chalk.red(`Refusing ${verb}: ${url}/healthz did not identify as agenfk-hub (got service=${data?.service ?? 'absent'}).`));
    console.error(chalk.gray('  Nothing was written. Confirm the Hub URL with your administrator.'));
  } catch (e: any) {
    console.error(chalk.red(`Refusing ${verb}: cannot reach ${url}/healthz — ${e?.message ?? e}`));
    console.error(chalk.gray('  Nothing was written. A hub that does not answer /healthz is not a hub.'));
  }
  return false;
}

/**
 * After login/join write a new credential, surface outbox rows still stamped
 * with some OTHER org (the stale-org backlog). Guidance only — an automatic
 * re-stamp would be exactly the cross-org leak this epic exists to prevent.
 * Best-effort: an unreachable local server must not fail the login.
 */
async function reportStaleOrgRows(orgId: string): Promise<void> {
  const token = readVerifyToken();
  if (!token) return;
  let orgs: Record<string, { count: number }> | undefined;
  try {
    const { data } = await axios.get(`${getApiUrl()}/internal/hub/status`, {
      headers: { 'x-agenfk-internal': token }, timeout: 5_000,
    });
    orgs = data?.orgs;
  } catch { return; }
  if (!orgs) return;
  const stale = Object.entries(orgs)
    .filter(([k, v]) => k !== orgId && k !== '' && Number(v?.count) > 0)
    .sort((a, b) => Number(b[1]?.count) - Number(a[1]?.count));
  if (stale.length === 0) return;
  console.log();
  console.log(chalk.yellow(`  ⚠ The local outbox holds events stamped for other orgs — they will NOT be delivered:`));
  for (const [org, v] of stale) {
    console.log(chalk.yellow(`    ${v.count} event(s) still stamped "${org}" → agenfk hub carry-over --from ${org} --to ${orgId}`));
  }
  console.log(chalk.gray('  Or drop them for good with `agenfk hub deadletter` (list) / `... discard`.'));
  console.log();
}

function readHubConfig(): HubConfig | null {
  try {
    return JSON.parse(fs.readFileSync(hubConfigFile(), 'utf8')) as HubConfig;
  } catch {
    return null;
  }
}

function writeHubConfig(cfg: HubConfig): void {
  fs.mkdirSync(path.dirname(hubConfigFile()), { recursive: true });
  fs.writeFileSync(hubConfigFile(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
  // Re-apply mode in case the file already existed without 600 perms.
  try { fs.chmodSync(hubConfigFile(), 0o600); } catch { /* ignore */ }
}

function readVerifyToken(): string | null {
  try { return fs.readFileSync(verifyTokenFile(), 'utf8').trim() || null; } catch { return null; }
}

/**
 * Best-effort: stamp events queued while the hub was disconnected (pending-org
 * sentinel '') with the just-configured orgId, via the running API server.
 * Without this, stamping only happens at the NEXT server boot — and the
 * still-running server would keep cap-pruning the very pre-login history the
 * outbox-while-disconnected feature preserves. Failure is fine (server not
 * running / old server): boot-time stamping remains the backstop.
 */
async function stampPendingOutbox(orgId: string): Promise<void> {
  const token = readVerifyToken();
  if (!token) return;
  try {
    const { data } = await axios.post(
      `${getApiUrl()}/internal/hub/rewrite-outbox-org`,
      { from: '', to: orgId },
      { headers: { 'x-agenfk-internal': token }, timeout: 5000 },
    );
    if (data?.rewritten > 0) {
      console.log(chalk.gray(`  Stamped ${data.rewritten} event(s) queued before login with org=${orgId}.`));
    }
  } catch { /* best-effort — boot-time stamping covers this */ }
}


/**
 * Ask the running API server to adopt the hub.json we just wrote. Without this
 * the Flusher keeps presenting the credential it was constructed with, so a
 * re-login left the outbox stranded until a restart. Best-effort: if the server
 * is not running, the next `agenfk up` reads the file anyway.
 */
async function reloadServerHubConfig(): Promise<'reloaded' | 'unchanged' | 'unavailable'> {
  const token = readVerifyToken();
  if (!token) return 'unavailable';
  try {
    const { data } = await axios.post(
      `${getApiUrl()}/internal/hub/reload`,
      {},
      { headers: { 'x-agenfk-internal': token }, timeout: 5000 },
    );
    return data?.changed ? 'reloaded' : 'unchanged';
  } catch {
    return 'unavailable';
  }
}

export function registerHubCommands(program: Command): void {
  const hub = program.command('hub').description('Corporate Hub: forward events to a self-hosted fleet metrics server');

  hub
    .command('login')
    .description('Configure this installation to push events to a corporate Hub')
    .requiredOption('--url <url>', 'Hub base URL, e.g. https://hub.acme.com')
    .option('--token <token>', 'Installation API key (legacy: skips browser flow)')
    .option('--org <orgId>', 'Org identifier (only required with --token)')
    .option('--no-open', 'Do not auto-open the browser; just print the URL')
    .action(async (opts) => {
      const url = String(opts.url).replace(/\/$/, '');

      // Legacy path — explicit token + org, no browser.
      if (opts.token) {
        if (!opts.org) {
          console.error(chalk.red('--org is required when using --token.'));
          process.exit(1);
        }
        const cfg: HubConfig = { url, token: String(opts.token), orgId: String(opts.org) };
        // Identity gate BEFORE the token leaves this machine (CGLAB-117).
        if (!await isHubEndpoint(cfg.url, 'hub login')) {
          process.exit(1);
        }
        try {
          await axios.get(`${cfg.url}/v1/ping`, {
            headers: { Authorization: `Bearer ${cfg.token}`, 'X-Installation-Id': 'cli-login' },
            timeout: 10_000,
          });
        } catch (e: any) {
          console.error(chalk.red(`Hub /v1/ping failed: ${e?.response?.status ?? ''} ${e?.message}`));
          console.error(chalk.gray('Refusing to write hub.json — fix the URL/token and try again.'));
          process.exit(1);
        }
        writeHubConfig(cfg);
        await stampPendingOutbox(cfg.orgId);
        const applied = await reloadServerHubConfig();
        console.log(chalk.green(`✓ Hub configured at ${cfg.url} (org=${cfg.orgId}).`));
        console.log(applied === 'unavailable'
          ? chalk.gray('  Local API server not reachable; the next `agenfk up` will pick it up.')
          : chalk.gray('  Running server is now pushing events with this config.'));
        await reportStaleOrgRows(cfg.orgId);
        return;
      }

      // Device-code flow.
      warnIfNoGitEmail(localInstallationIdentity());
      if (!await isHubEndpoint(url, 'hub login')) {
        process.exit(1);
      }
      let start;
      try {
        // Send who we are: the hub binds this onto the issued key, and an
        // unbound key is never handed a fleet directive — that made
        // device-onboarded installs invisible to upgrades and repoints.
        start = (await axios.post(
          `${url}/hub/device/start`,
          { installation: localInstallationIdentity() },
          { timeout: 10_000 },
        )).data;
      } catch (e: any) {
        console.error(chalk.red(`Could not reach ${url}: ${e?.message ?? 'unknown'}`));
        console.error(chalk.gray('Tip: pass --token <key> --org <id> to skip the browser flow.'));
        process.exit(1);
      }
      console.log();
      console.log(chalk.bold('Device code: ') + chalk.cyan(start.userCode));
      console.log(chalk.gray('Open this URL in your browser to approve:'));
      console.log('  ' + chalk.underline(start.verificationUri));
      if (opts.open !== false) {
        const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
        exec(`${opener} ${JSON.stringify(start.verificationUri)}`, { windowsHide: true }, () => { /* best-effort */ });
      }

      const interval = Math.max(1, Number(start.interval) || 2);
      const expiresAt = Date.now() + Math.max(60, Number(start.expiresIn) || 600) * 1000;
      process.stdout.write(chalk.gray('Waiting for approval'));
      let approved: any = null;
      while (Date.now() < expiresAt) {
        await new Promise(r => setTimeout(r, interval * 1000));
        process.stdout.write(chalk.gray('.'));
        try {
          const { data } = await axios.post(`${url}/hub/device/poll`, { deviceCode: start.deviceCode }, { timeout: 10_000 });
          if (data.status === 'approved') {
            approved = data;
            break;
          }
          if (data.status === 'expired') {
            console.log();
            console.error(chalk.red('Device code expired. Re-run `agenfk hub login --url <hub>`.'));
            process.exit(1);
          }
        } catch (e: any) {
          // 404/410/etc — keep going until expiry, surface message at end.
          if (e?.response?.status === 410) {
            console.log();
            console.error(chalk.red('Login session ended unexpectedly. Re-run the command.'));
            process.exit(1);
          }
        }
      }
      if (!approved) {
        console.log();
        console.error(chalk.red('Timed out waiting for approval.'));
        process.exit(1);
      }
      // Config handling lives OUTSIDE the poll loop's try/catch: a thrown
      // exit/abort signal there was being swallowed as a transient poll
      // error, turning a refusal into an endless wait (same bug class as
      // the audit-exit swallow the story-4 mutation run caught).
      console.log();
      // The hub gets to NAME the url it wrote the token for — so gate
      // THAT url, not the one we typed: a (compromised or malicious)
      // hub returning hubUrl=evil.example would otherwise persist an
      // unverified endpoint and start streaming this org's events and
      // token there (CGLAB-117 story 4).
      const cfg: HubConfig = { url: String(approved.hubUrl ?? url).replace(/\/$/, ''), token: String(approved.token), orgId: String(approved.orgId) };
      if (!await isHubEndpoint(cfg.url, 'hub login')) {
        process.exit(1);
      }
      writeHubConfig(cfg);
      await stampPendingOutbox(cfg.orgId);
      const applied = await reloadServerHubConfig();
      console.log(chalk.green(`✓ Hub configured at ${cfg.url} (org=${cfg.orgId}).`));
      console.log(applied === 'unavailable'
        ? chalk.gray('  Local API server not reachable; the next `agenfk up` will pick it up.')
        : chalk.gray('  Running server is now pushing events with this config.'));
      await reportStaleOrgRows(cfg.orgId);
    });

  hub
    .command('join <urlOrToken> [token]')
    .description('Redeem a magic-link invite issued by your Hub admin. Forms: `hub join <url> <token>` or `hub join <token>` (uses AGENFK_HUB_URL or existing hub.json).')
    .option('--no-restart', 'Do not restart the local API server after a successful join (useful for scripted/CI flows that manage services themselves).')
    .action(async (urlOrToken: string, token: string | undefined, opts: { restart?: boolean }) => {
      // Two-arg form: `hub join <url> <token>` puts the hub URL inline so receivers don't need env vars.
      // One-arg form: `hub join <token>` falls back to AGENFK_HUB_URL or existing hub.json.
      const hasUrlArg = typeof token === 'string' && token.length > 0;
      const inviteToken = hasUrlArg ? (token as string) : urlOrToken;

      warnIfNoGitEmail(localInstallationIdentity());

      const existing = readHubConfig();
      const candidates: string[] = [];
      if (hasUrlArg) {
        candidates.push(urlOrToken.replace(/\/$/, ''));
      } else {
        if (existing?.url) candidates.push(existing.url);
        if (process.env.AGENFK_HUB_URL) candidates.unshift(process.env.AGENFK_HUB_URL.replace(/\/$/, ''));
      }
      if (candidates.length === 0) {
        console.error(chalk.red('No Hub URL known. Use `agenfk hub join <url> <token>`, set AGENFK_HUB_URL, or run `agenfk hub login --url <hub>` first.'));
        process.exit(1);
      }
      for (const url of candidates) {
        try {
          // Identity gate BEFORE the one-time invite token leaves this
          // machine — symmetric with the device flow, which gates before
          // /hub/device/start for the same reason (CGLAB-117 story 4).
          if (!await isHubEndpoint(url, 'hub join')) {
            continue;
          }
          const { data } = await axios.post(
            `${url}/hub/invite/redeem`,
            { inviteToken, installation: localInstallationIdentity() },
            { timeout: 10_000 },
          );
          const cfg: HubConfig = { url: String(data.hubUrl ?? url).replace(/\/$/, ''), token: String(data.token), orgId: String(data.orgId) };
          // Same gate as login: the redeemed response's hubUrl is
          // server-supplied and must identify as agenfk-hub BEFORE the
          // joined token is persisted against it (CGLAB-117 story 4).
          if (!await isHubEndpoint(cfg.url, 'hub join')) {
            process.exit(1);
          }
          writeHubConfig(cfg);
          console.log(chalk.green(`✓ Joined ${cfg.url} (org=${cfg.orgId}).`));
          await reportStaleOrgRows(cfg.orgId);

          // Story 6: probe the local API server and bounce it so the new
          // hub.json is picked up without manual intervention. --no-restart
          // (commander parses to `opts.restart === false`) skips this for
          // scripted flows.
          if (opts.restart === false) {
            console.log(chalk.gray('Skipping restart per --no-restart. Run `agenfk down && agenfk up` when convenient.'));
            return;
          }
          let servicesRunning = false;
          try {
            await axios.get(`${getApiUrl()}/`, { timeout: 2_000 });
            servicesRunning = true;
          } catch { /* not running — leave alone */ }
          if (!servicesRunning) {
            console.log(chalk.gray('Local API server is not running; the next `agenfk up` will pick up the new hub config.'));
            return;
          }
          const rootDir = path.resolve(__dirname, '../../../..');
          console.log(chalk.blue('Restarting local API server so it picks up the new hub config...'));
          try {
            execSync('node packages/cli/bin/agenfk.js down', { cwd: rootDir, stdio: 'inherit', windowsHide: true });
          } catch { /* may already be down */ }
          try {
            const start = spawn('node', ['packages/cli/bin/agenfk.js', 'up'], {
              cwd: rootDir, detached: true, stdio: 'inherit',
              windowsHide: true,
            });
            start.unref();
            console.log(chalk.green('✓ Restarted local API server.'));
          } catch (e: any) {
            console.error(chalk.red(`Auto-restart failed: ${e?.message ?? e}. Run \`agenfk up\` manually.`));
          }
          return;
        } catch (e: any) {
          const msg = e?.response?.data?.error ?? e?.message;
          console.error(chalk.red(`Redeem at ${url} failed: ${msg}`));
        }
      }
      process.exit(1);
    });

  hub
    .command('status')
    .description('Show hub configuration and outbox state')
    .action(async () => {
      const cfg = readHubConfig();
      if (!cfg) {
        console.log(chalk.gray('Hub: not configured (no ~/.agenfk/hub.json).'));
        // Refusals outlive a logout: the events are still not on the hub.
        printRefusals(localDeadletterIndicator());
        return;
      }
      console.log(`Hub URL:   ${cfg.url}`);
      console.log(`Org:       ${cfg.orgId}`);
      console.log(`Token:     ${cfg.token.slice(0, 8)}…`);
      const verifyToken = readVerifyToken();
      if (!verifyToken) {
        console.log(chalk.yellow('  (cannot reach local server: ~/.agenfk/verify-token missing)'));
        printRefusals(localDeadletterIndicator());
        return;
      }
      try {
        const { data } = await axios.get(`${getApiUrl()}/internal/hub/status`, {
          headers: { 'x-agenfk-internal': verifyToken }, timeout: 5_000,
        });
        console.log(`Outbox:    ${data.outboxDepth} pending`);
        if (data.orgs && Object.keys(data.orgs).length > 0) {
          const parts = Object.entries(data.orgs as Record<string, { count: number }>)
            .sort((a, b) => Number(b[1]?.count) - Number(a[1]?.count))
            .map(([org, v]) => `${org === '' ? '(pre-login)' : org}: ${v.count}`);
          console.log(`By org:    ${parts.join(', ')}`);
        }
        if (data.staleOrgDepth !== undefined) {
          console.log(`Stale-org rows: ${data.staleOrgDepth}${Number(data.staleOrgDepth) > 0 ? chalk.yellow(' (different org — carry-over or discard)') : ''}`);
        }
        if (data.deadletterDepth !== undefined) {
          console.log(`Deadlettered: ${data.deadletterDepth}${Number(data.deadletterDepth) > 0 ? chalk.yellow(' (hub-rejected, preserved — see `agenfk hub deadletter`)') : ''}`);
        }
        printRefusals(data.deadletter ?? localDeadletterIndicator());
        console.log(`Last flush: ${data.lastFlushAt ?? 'never'}`);
        console.log(`Last error: ${data.lastError ?? 'none'}`);
        console.log(`Halted:    ${data.halted ? 'YES (hub rejected us repeatedly)' : 'no'}`);
        console.log(`Failures:  ${data.consecutiveFailures ?? 0} consecutive`);
        if (data.nextRetryAt) console.log(`Next retry: ${data.nextRetryAt}`);
        if (!data.halted && Number(data.consecutiveFailures) > 0) {
          // Not halted but not delivering either — the case that used to be silent.
          console.log(chalk.yellow('  Events are queued and retrying. If the hub moved, run `agenfk hub repoint --url <hub>`.'));
        }
      } catch (e: any) {
        console.log(chalk.gray(`  (API server not reachable: ${e?.message ?? 'unknown error'})`));
        printRefusals(localDeadletterIndicator());
      }
    });

  hub
    .command('flush')
    .description('Force the local server to attempt a flush cycle now')
    .action(async () => {
      const verifyToken = readVerifyToken();
      if (!verifyToken) {
        console.error(chalk.red('Cannot flush: ~/.agenfk/verify-token not found. Is the framework installed?'));
        process.exit(1);
      }
      try {
        const { data } = await axios.post(`${getApiUrl()}/internal/hub/flush`, {}, {
          headers: { 'x-agenfk-internal': verifyToken }, timeout: 30_000,
        });
        // A flush that ended with lastError SET is a failed flush. Printing it
        // green was how the 31 Aug rejections stayed invisible (review F8).
        if (data?.lastError) {
          console.error(chalk.red(`✗ Flush ended with an error: ${data.lastError}`));
          console.error(chalk.gray(`  Outbox ${data.outboxDepth} pending, deadlettered ${data.deadletterDepth ?? 0}. See \`agenfk hub status\` / \`agenfk hub deadletter\`.`));
          process.exit(1);
        }
        if (Number(data?.staleOrgDepth) > 0) {
          console.log(chalk.yellow(`⚠ Flush completed, but ${data.staleOrgDepth} event(s) carry a stale org stamp and will not be delivered — agenfk hub carry-over / agenfk hub deadletter. Outbox now ${data.outboxDepth}.`));
          return;
        }
        console.log(chalk.green(`✓ Flush completed. Outbox now ${data.outboxDepth}, last error: ${data.lastError ?? 'none'}`));
      } catch (e: any) {
        const msg = e?.response?.data?.error ?? e?.message;
        console.error(chalk.red(`Flush failed: ${msg}`));
        process.exit(1);
      }
    });

  hub
    .command('repoint')
    .description('Re-point this installation at a new Hub URL and/or org id (e.g. after a hub admin renames the org during a staging→prod move). Verifies the new endpoint is an Agenfk Hub before swapping the local config; rewrites the local outbox so queued events use the new orgId.')
    .option('--url <url>', 'New hub base URL')
    .option('--org-id <orgId>', 'New org id (required when the hub admin renamed it)')
    .option('--token <token>', 'Replacement API token (rare; carry the existing token over by default)')
    .option('--carry-over', 'Also rewrite queued outbox events from the old org stamp to the new one (tenancy-crossing operation: typed confirmation unless --yes, audited to ~/.agenfk/hub-audit.jsonl). Without it the outbox is left untouched and carry-over guidance is printed.')
    .option('--yes', 'Skip the carry-over confirmation (scripted use; only meaningful with --carry-over)')
    .option('--no-restart', 'Do not restart the local API server after a successful repoint')
    .action(async (opts: { url?: string; orgId?: string; token?: string; carryOver?: boolean; yes?: boolean; restart?: boolean }) => {
      const existing = readHubConfig();
      if (!existing) {
        console.error(chalk.red('No existing hub config at ~/.agenfk/hub.json. Run `agenfk hub login` or `agenfk hub join <invite>` first.'));
        process.exit(1);
        return;
      }
      const candidate: HubConfig = {
        url: opts.url ? String(opts.url).replace(/\/$/, '') : existing.url,
        token: opts.token ? String(opts.token) : existing.token,
        orgId: opts.orgId ? String(opts.orgId) : existing.orgId,
      };
      if (candidate.url === existing.url && candidate.orgId === existing.orgId && candidate.token === existing.token) {
        console.log(chalk.gray('Nothing to change — supply at least one of --url, --org-id, --token.'));
        return;
      }

      try {
        const { data, status } = await axios.get(`${candidate.url}/healthz`, { timeout: 10_000 });
        if (status !== 200 || !data || data.service !== 'agenfk-hub') {
          console.error(chalk.red(`Refusing repoint: ${candidate.url}/healthz did not identify as agenfk-hub (got service=${data?.service ?? 'absent'}).`));
          process.exit(1);
          return;
        }
      } catch (e: any) {
        console.error(chalk.red(`Refusing repoint: cannot reach ${candidate.url}/healthz — ${e?.message ?? e}`));
        process.exit(1);
        return;
      }

      try {
        const { data } = await axios.get(`${candidate.url}/v1/ping`, {
          headers: { Authorization: `Bearer ${candidate.token}`, 'X-Installation-Id': 'cli-repoint' },
          timeout: 10_000,
        });
        if (data?.orgId !== candidate.orgId) {
          console.error(chalk.red(`Refusing repoint: hub reports orgId=${data?.orgId} but you asked for orgId=${candidate.orgId}. Pass --org-id with the value the hub now uses.`));
          process.exit(1);
          return;
        }
      } catch (e: any) {
        const msg = e?.response?.data?.error ?? e?.message;
        console.error(chalk.red(`Refusing repoint: ${candidate.url}/v1/ping failed (${msg}). Is your token still valid for the new hub?`));
        process.exit(1);
        return;
      }

      if (candidate.orgId !== existing.orgId) {
        // CGLAB-117 story 4: an org rename must NOT silently move queued
        // events across the tenancy boundary. Rewriting happens only when
        // explicitly asked for, confirmed like carry-over's, and audited.
        if (!opts.carryOver) {
          console.log(chalk.yellow(`  Outbox events stamped "${existing.orgId}" were left untouched.`));
          console.log(chalk.gray(`  Move them deliberately: agenfk hub carry-over --from ${existing.orgId} --to ${candidate.orgId}`));
          console.log(chalk.gray(`  Or drop them: agenfk hub deadletter`));
        } else {
          let proceed = true;
          if (!opts.yes) {
            if (refuseWithoutTty('--yes')) {
              proceed = false;
            } else {
              const answer = await askLine(`Type the target org id (${chalk.bold(candidate.orgId)}) to confirm carrying queued events from "${existing.orgId}" across the org boundary, or anything else to skip: `);
              if (answer !== candidate.orgId) {
                console.log(chalk.gray('Aborted — outbox left untouched (the repoint itself stands).'));
                proceed = false;
              }
            }
          }
          if (proceed) {
            const verifyToken = readVerifyToken();
            if (!verifyToken) {
              console.warn(chalk.yellow('No verify-token — skipping local outbox rewrite. After `agenfk up`, run `agenfk hub carry-over --from ' + existing.orgId + ' --to ' + candidate.orgId + '`.'));
            } else {
              try {
                const rewritten = await rewriteOutboxAndAudit(existing.orgId, candidate.orgId, verifyToken);
                console.log(chalk.green(`✓ Carried over ${rewritten} queued outbox event(s) from org "${existing.orgId}" to "${candidate.orgId}" (audited).`));
              } catch (e: any) {
                if (!(e instanceof HubRewriteFailed)) throw e; // audit-failure exit propagates
                const orig: any = e.cause;
                console.warn(chalk.yellow(`Could not rewrite local outbox (${orig?.response?.data?.error ?? orig?.message ?? orig}). After \`agenfk up\`, run \`agenfk hub carry-over --from ${existing.orgId} --to ${candidate.orgId}\` again to drain stragglers.`));
              }
            }
          }
        }
      }

      writeHubConfig(candidate);
      console.log(chalk.green(`✓ Repointed to ${candidate.url} (org=${candidate.orgId}).`));

      if (opts.restart === false) {
        console.log(chalk.gray('Skipping restart per --no-restart. Run `agenfk down && agenfk up` when convenient.'));
        return;
      }
      // Prefer an in-place reload: it swaps the hub subsystems onto the new
      // config without dropping the API server, which a full down/up does.
      const applied = await reloadServerHubConfig();
      if (applied !== 'unavailable') {
        console.log(chalk.green('✓ Running server adopted the new hub config (no restart needed).'));
        return;
      }
      let servicesRunning = false;
      try {
        await axios.get(`${getApiUrl()}/`, { timeout: 2_000 });
        servicesRunning = true;
      } catch { /* not running — leave alone */ }
      if (!servicesRunning) {
        console.log(chalk.gray('Local API server is not running; the next `agenfk up` will pick up the new hub config.'));
        return;
      }
      const rootDir = path.resolve(__dirname, '../../../..');
      console.log(chalk.blue('Restarting local API server so it picks up the new hub config...'));
      try {
        execSync('node packages/cli/bin/agenfk.js down', { cwd: rootDir, stdio: 'inherit', windowsHide: true });
      } catch { /* may already be down */ }
      try {
        const start = spawn('node', ['packages/cli/bin/agenfk.js', 'up'], {
          cwd: rootDir, detached: true, stdio: 'inherit',
          windowsHide: true,
        });
        start.unref();
        console.log(chalk.green('✓ Restarted local API server.'));
      } catch (e: any) {
        console.error(chalk.red(`Auto-restart failed: ${e?.message ?? e}. Run \`agenfk up\` manually.`));
      }
    });

  hub
    .command('carry-over')
    .description('Move queued outbox events from one org stamp to another — the only path that rewrites an event\'s org stamp (the tenancy watermark) between two NAMED orgs; login/boot stamping of pre-login events and `hub repoint` org renames are separate, narrower paths. Prints a confirmation summary, demands explicit confirmation (or --yes), and audits every run to ~/.agenfk/hub-audit.jsonl.')
    .option('--from <orgId>', 'Org stamp currently on the queued events')
    .option('--to <orgId>', 'Org stamp the events should carry afterwards')
    .option('--yes', 'Skip the interactive confirmation (scripted use)')
    .action(async (opts: { from?: string; to?: string; yes?: boolean }) => {
      const from = opts.from ? String(opts.from).trim() : '';
      const to = opts.to ? String(opts.to).trim() : '';
      if (!from || !to) {
        console.error(chalk.red('Both --from and --to are required. Example: agenfk hub carry-over --from old-corp --to acme'));
        process.exit(1);
        return;
      }
      if (from === to) {
        console.error(chalk.red('Refusing carry-over: --from and --to are the same org — there is nothing to carry.'));
        process.exit(1);
        return;
      }
      const verifyToken = readVerifyToken();
      if (!verifyToken) {
        console.error(chalk.red('Cannot reach the local API server (~/.agenfk/verify-token not found). Is `agenfk up` running?'));
        process.exit(1);
        return;
      }
      let orgs: Record<string, { count: number; firstOccurredAt: string; lastOccurredAt: string; types: Record<string, number> }>;
      try {
        const { data } = await axios.get(`${getApiUrl()}/internal/hub/status`, {
          headers: { 'x-agenfk-internal': verifyToken }, timeout: 5_000,
        });
        orgs = data?.orgs ?? {};
      } catch (e: any) {
        console.error(chalk.red(`Cannot read the local outbox (${e?.response?.data?.error ?? e?.message ?? e}). Is the API server running?`));
        process.exit(1);
        return;
      }
      const summary = orgs[from];
      if (!summary || !summary.count) {
        console.error(chalk.red(`Refusing carry-over: no queued events stamped org "${from}" in the local outbox.`));
        process.exit(1);
        return;
      }
      const cfg = readHubConfig();
      console.log(`Carry-over: ${summary.count} queued event(s) stamped org "${from}" -> "${to}"`);
      console.log(chalk.gray(`  Time range : ${summary.firstOccurredAt} .. ${summary.lastOccurredAt}`));
      const typePairs = Object.entries(summary.types ?? {})
        .sort((a, b) => b[1] - a[1])
        .map(([t, n]) => `${t} (${n})`);
      if (typePairs.length) console.log(chalk.gray(`  Event types: ${typePairs.join(', ')}`));
      console.log();
      console.log(chalk.red.bold('  ⚠ This rewrites the TENANCY WATERMARK of those events — the one operation that'));  // cross-org warning
      console.log(chalk.red.bold('    moves data across an org boundary. It is audited to ~/.agenfk/hub-audit.jsonl.'));
      if (cfg && to !== cfg.orgId) {
        console.log(chalk.yellow(`  ⚠ Current credentials are for org "${cfg.orgId}": after the carry-over these rows`));
        console.log(chalk.yellow(`    are STILL not deliverable — carry over to "${cfg.orgId}" or discard them.`));
      }
      console.log();
      if (!opts.yes) {
        if (refuseWithoutTty('--yes')) {
          process.exit(1);
          return;
        }
        // Confirm the TENANCY-RELEVANT half: the operator types the target org.
        const answer = await askLine(`Type the target org id (${chalk.bold(to)}) to confirm carrying ${summary.count} event(s) from "${from}" across the org boundary, or anything else to abort: `);
        if (answer !== to) {
          console.log(chalk.gray('Aborted — nothing was rewritten.'));
          return;
        }
      }
      let rewritten: number;
      try {
        rewritten = await rewriteOutboxAndAudit(from, to, verifyToken);
      } catch (e: any) {
        if (!(e instanceof HubRewriteFailed)) throw e; // exit/abort signals propagate untouched
        const orig: any = e.cause;
        console.error(chalk.red(`Carry-over failed: ${orig?.response?.data?.error ?? orig?.message ?? orig}`));
        process.exit(1);
        return;
      }
      if (rewritten !== summary.count) {
        // The summary was a snapshot; the rewrite is set-based (review F5).
        console.log(chalk.yellow(`  Note: the summary showed ${summary.count} event(s) but ${rewritten} were rewritten — rows arrived or were delivered between the two calls.`));
      }
      console.log(chalk.green(`✓ Carried over ${rewritten} event(s) from "${from}" to "${to}" (audited).`));
      if (cfg && to === cfg.orgId) {
        console.log(chalk.gray('  They are deliverable now — run `agenfk hub flush` to send them.'));
      }
    });

  const deadletter = hub
    .command('deadletter')
    .description('List events the hub rejected and the spoke preserved in ~/.agenfk/hub-deadletter.jsonl, grouped by the org stamped on each payload')
    .action(() => {
      const lines = readDeadletterLines();
      const entries = lines.map(l => l.entry).filter((e): e is DeadletterEntry => e !== null);
      if (lines.length === 0) {
        console.log(chalk.gray(`No deadlettered events${fs.existsSync(deadletterFile()) ? ' (file is empty)' : ''}.`));
        return;
      }
      for (const g of summarizeDeadletter(entries)) {
        console.log(`Org ${chalk.bold(g.org)} — ${g.count} event(s), ${g.firstAt ?? '?'} .. ${g.lastAt ?? '?'}`);
        const reasons = Object.entries(g.reasons).map(([r, n]) => `${r} (${n})`).join(', ');
        console.log(chalk.gray(`  reasons: ${reasons}`));
      }
      const corrupt = lines.length - entries.length;
      if (corrupt > 0) {
        console.log(chalk.yellow(`  ${corrupt} unparseable line(s) — preserved on --org discards, removed only by --all.`));
      }
      console.log(chalk.gray(`Total: ${lines.length} line(s) in ${deadletterFile()} — discard with \`agenfk hub deadletter discard\`, `
        + 'or once the cause is fixed, send them again with `agenfk hub deadletter requeue`.'));
    });

  deadletter
    .command('discard')
    .description('Permanently remove deadlettered entries (see `agenfk hub deadletter`)')
    .option('--org <orgId>', 'Discard only entries stamped with this org')
    .option('--reason <reason...>', 'Discard only entries refused for these reasons (e.g. hidden_user, invalid)')
    .option('--unparseable', 'Discard the lines that cannot be read')
    .option('--all', 'Discard every deadlettered entry')
    .option('--yes', 'Skip the interactive confirmation (scripted use)')
    .action(async (opts: { org?: string; reason?: string[]; unparseable?: boolean; all?: boolean; yes?: boolean }) => {
      const reasons = splitList(opts.reason);
      if (!opts.org && !opts.all && !reasons && !opts.unparseable) {
        console.error(chalk.red('Choose --org <orgId> or --all (or narrow with --reason <reason...> / --unparseable).'));
        process.exit(1);
        return;
      }
      const target = { org: opts.org, all: !!opts.all, reasons, unparseable: !!opts.unparseable };
      const lines = readDeadletterLines();
      if (lines.length === 0) {
        console.log(chalk.gray('Nothing to discard.'));
        return;
      }
      const removedNow = lines.length - filterDeadletterLinesForDiscard(lines, target).length;
      if (removedNow === 0) {
        console.log(chalk.gray(`No deadlettered entries match — nothing discarded.`));
        return;
      }
      if (opts.all && !opts.yes) {
        console.log(chalk.red.bold(`About to permanently discard ALL ${removedNow} deadlettered line(s) (including any unparseable ones) — this cannot be undone.`));
        if (refuseWithoutTty('--yes')) {
          process.exit(1);
          return;
        }
        const answer = await askLine("Type 'discard all' to confirm, or anything else to abort: ");
        if (answer !== 'discard all') {
          console.log(chalk.gray('Aborted — nothing was discarded.'));
          return;
        }
      } else if (reasons && !opts.yes) {
        // --reason exists to clear what a requeue can never move. Naming a
        // reason that CAN be requeued deletes exactly the events requeue exists
        // to save, so that needs a person's yes (#223).
        const keptNow = new Set(filterDeadletterLinesForDiscard(lines, target));
        const requeueable = lines.filter(l => !keptNow.has(l) && l.entry !== null
          && !['hidden_user', 'invalid'].includes(deadletterReasonOf(l.entry))).length;
        if (requeueable > 0) {
          console.log(chalk.red.bold(
            `About to permanently discard ${requeueable} event(s) that \`agenfk hub deadletter requeue\` could still send to the hub — this cannot be undone.`,
          ));
          if (refuseWithoutTty('--yes')) {
            process.exit(1);
            return;
          }
          const answer = await askLine("Type 'discard' to confirm, or anything else to abort: ");
          if (answer !== 'discard') {
            console.log(chalk.gray('Aborted — nothing was discarded.'));
            return;
          }
        }
      }
      // Re-read IMMEDIATELY before writing (review F1): the flusher appends on
      // its own timer — anything that landed during the confirmation prompt is
      // already deleted from the outbox, and a stale rewrite would destroy it
      // here too. Re-filter the fresh contents instead.
      const fresh = readDeadletterLines();
      const kept = filterDeadletterLinesForDiscard(fresh, target);
      const removed = fresh.length - kept.length;
      if (removed === 0) {
        console.log(chalk.gray('No deadlettered entries match the current file — nothing discarded.'));
        return;
      }
      writeDeadletterLines(kept);
      console.log(chalk.green(`✓ Discarded ${removed} deadlettered entr${removed === 1 ? 'y' : 'ies'}; ${kept.length} remain.`));
    });

  deadletter
    .command('requeue')
    .description('Put deadlettered events back in the outbox, with their original eventId and occurredAt, so the next flush sends them again (#223)')
    .option('--reason <reason...>', 'Only these refusal reasons (default: all but hidden_user, org_mismatch and invalid)')
    .option('--org <orgId>', 'Only events stamped with this org (required for --reason org_mismatch)')
    .option('--type <type...>', 'Only these event types (e.g. pr.opened)')
    .option('--since <iso>', 'Only events that occurred at or after this date/time')
    .option('--force', 'Requeue even when the hub binding check says the hub will refuse them again')
    .option('--yes', 'Skip the interactive confirmation (scripted use)')
    .action(async (opts: { reason?: string[]; org?: string; type?: string[]; since?: string; force?: boolean; yes?: boolean }) => {
      const cfg = readHubConfig();
      if (!cfg) {
        console.error(chalk.red('Hub not configured (no ~/.agenfk/hub.json). Join it first: `agenfk hub join <url> <invite>`.'));
        process.exit(1);
        return;
      }
      const verifyToken = readVerifyToken();
      if (!verifyToken) {
        console.error(chalk.red('Cannot reach the local server: ~/.agenfk/verify-token is missing. Run `agenfk up` first.'));
        process.exit(1);
        return;
      }
      const raw: Record<string, unknown> = {};
      if (splitList(opts.reason)) raw.reasons = splitList(opts.reason);
      if (opts.org !== undefined) raw.org = opts.org;
      if (splitList(opts.type)) raw.types = splitList(opts.type);
      if (opts.since !== undefined) raw.since = opts.since;
      const parsed = validateRequeueFilters(raw);
      if (!parsed.ok) {
        console.error(chalk.red(parsed.error));
        process.exit(1);
        return;
      }
      const filters: RequeueFilters = parsed.filters;
      const headers = { 'x-agenfk-internal': verifyToken };

      // 1. Dry run: what would move, and what stays.
      let dry: any;
      try {
        ({ data: dry } = await axios.post(`${getApiUrl()}/internal/hub/requeue-deadletter`, { filters, dryRun: true }, { headers, timeout: 15_000 }));
      } catch (e: any) {
        console.error(chalk.red(`Could not ask the local server: ${e?.response?.data?.error ?? e?.message ?? e}`));
        process.exit(1);
        return;
      }
      const summary: RequeueSummary = dry.summary;
      const excluded = Object.entries((dry.excluded ?? {}) as Record<string, number>);
      if (!(summary?.count > 0)) {
        console.log(chalk.gray('Nothing to requeue.'));
        for (const [cause, n] of excluded) console.log(chalk.gray(`  ${describeExclusion(cause)}: ${n}`));
        return;
      }

      printRequeueSummary(summary, excluded, cfg.orgId);

      // 2. Will the hub take them? Checked against what the hub says about
      //    this key, not against what this machine believes.
      let ping: HubPingResult;
      try {
        const { data } = await axios.get(`${cfg.url}/v1/ping`, {
          headers: { Authorization: `Bearer ${cfg.token}`, 'X-Installation-Id': 'cli-requeue' },
          timeout: 10_000,
        });
        ping = { ok: true, data: data ?? {} };
      } catch (e: any) {
        ping = { ok: false, status: e?.response?.status ?? null, message: e?.response?.status ? `HTTP ${e.response.status}` : (e?.message ?? String(e)) };
      }
      const verdict = requeueBindingVerdict(ping, cfg, summary, getInstallationId());
      for (const w of verdict.warn) console.log(chalk.yellow(`  ! ${w}`));
      if (verdict.abort.length > 0) {
        for (const a of verdict.abort) console.error(chalk.red(`  ✗ ${a}`));
        if (!opts.force) {
          console.error(chalk.red('Not requeued: the hub would refuse these events again. Fix the above, or pass --force.'));
          process.exit(1);
          return;
        }
        console.log(chalk.yellow('  --force: requeueing anyway; refused events go straight back to the deadletter.'));
      }

      // 3. Confirm.
      if (!opts.yes) {
        if (refuseWithoutTty('--yes')) {
          process.exit(1);
          return;
        }
        const answer = await askLine(`Requeue these ${summary.count} event(s)? [y/N] `);
        if (!/^y(es)?$/i.test(answer)) {
          console.log(chalk.gray('Aborted — nothing was requeued.'));
          return;
        }
      }

      // 4. The real run, limited to the events just confirmed: the server
      //    re-reads the file, and refusals the flusher appended while the
      //    prompt was open have not been through the binding check above.
      let result: any;
      try {
        ({ data: result } = await axios.post(
          `${getApiUrl()}/internal/hub/requeue-deadletter`,
          { filters, dryRun: false, eventIds: dry.eventIds ?? [] },
          { headers, timeout: 30_000 },
        ));
      } catch (e: any) {
        const body = e?.response?.data;
        console.error(chalk.red(`Requeue failed: ${body?.error ?? e?.message ?? e}`));
        if (typeof body?.inserted === 'number') {
          console.error(chalk.yellow(
            `  ${body.inserted} event(s) were already put back in the outbox and are still in the deadletter. `
            + 'Run the same command again to finish: the outbox ignores what it already holds, and the hub dedups by eventId.',
          ));
        }
        process.exit(1);
        return;
      }
      const requeued = Number(result?.requeued ?? 0);
      const moved = Number(result?.summary?.count ?? requeued);
      if (moved !== summary.count) {
        console.log(chalk.yellow(`  Note: the summary showed ${summary.count} event(s) but ${moved} were requeued — the deadletter changed between the two calls.`));
      }
      if (Number(result?.excluded?.unconfirmed) > 0) {
        console.log(chalk.gray(`  ${result.excluded.unconfirmed} more were refused while you confirmed; run the requeue again to review them.`));
      }
      let osUser = 'unknown';
      try { osUser = os.userInfo().username; } catch { /* no passwd entry (containers) */ }
      try {
        appendHubAuditLine({
          at: new Date().toISOString(), action: 'deadletter-requeue', filters, requeued, eventIds: result?.eventIds ?? [], osUser,
          // A --force that overrode the binding check is part of what happened.
          ...(verdict.abort.length > 0 ? { force: true, overridden: verdict.abort } : {}),
        });
      } catch (ae: any) {
        console.error(chalk.red.bold(`!! REQUEUE SUCCEEDED (${requeued} event(s)) BUT THE AUDIT LINE FAILED TO WRITE: ${ae?.message ?? ae}`));
        console.error(chalk.red(`   Append it manually to ${auditFile()} before anyone reads this output as "nothing happened".`));
        process.exit(1);
        return;
      }
      console.log(chalk.green(`✓ Requeued ${requeued} event(s) (audited); ${result?.remaining ?? '?'} line(s) remain in the deadletter.`));
      if (Number(result?.alreadyQueued) > 0) {
        console.log(chalk.gray(`  ${result.alreadyQueued} were already in the outbox from an earlier run.`));
      }
      console.log(chalk.gray('  Run `agenfk hub flush` to send them now, or wait for the next flush.'));
    });

  hub
    .command('logout')
    .description('Disconnect from the Hub (preserves the local outbox)')
    .action(() => {
      try {
        fs.unlinkSync(hubConfigFile());
        console.log(chalk.green('✓ Removed ~/.agenfk/hub.json. Restart the API server to stop pushing.'));
      } catch {
        console.log(chalk.gray('Hub was not configured.'));
      }
    });
}
