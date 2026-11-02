/**
 * `agenfk airlock learn --import-pi-sessions` (GH-294, TEL-3): a one-off
 * import of the hosts existing pi sessions reached, for Airlock's proposed
 * allowlist. The logs are read here, on this machine, line by line; what goes
 * to the server is host names, counts, first/last seen, the client and each
 * host's context - never a command, a URL's path or query, a file path or any
 * session text.
 *
 * The context (user decisions 2026-11-02) is what a person needs to decide on
 * a host: the projects whose sessions reached it (the working folder's name,
 * never its path), an address's reverse DNS name, and - only with --hints - a
 * sentence a model the person picked wrote from a few of its commands
 * (learnHints.ts). The commands go to that model and nowhere else.
 *
 * A host whose written spelling carries a secret (core redactLog, the
 * server's own rules) is not sent. Memory is bounded: a line over
 * MAX_LINE_BYTES is skipped as it streams, distinct hosts stop at
 * MAX_IMPORT_HOSTS, both counted and reported, and batches are built one at a
 * time as they are sent.
 *
 * The server keeps an import as a snapshot (it replaces the imported count),
 * so importing the same logs again does not double anything.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promises as dns } from 'dns';
import {
  AIRLOCK_IMPORT_MAX_BYTES, DEFAULT_AIRLOCK_POLICY, EMPTY_HOST_CONTEXT, MAX_CONTEXT_PROJECTS, MAX_PROJECT_CHARS, MAX_IMPORT_HOSTS, isAddressHost, learningExclusionOf, normalizeAirlockPolicy,
  redactLog, sanitizeHostContext, tallyPiSessionLine,
  type AirlockHostContext, type AirlockHostScreen, type AirlockImportTally,
} from '@agenfk/core';
import { MAX_EXAMPLE_CHARS, MAX_HINT_EXAMPLES, hintRunner, scrubCredentials, writeHints, type HintProvider, type HintRunner } from './learnHints';

/** Hosts per request; the server accepts at most this many (MAX_LEARNING_IMPORT_HOSTS). */
export const MAX_IMPORT_BATCH = 1000;
/** A session-log line longer than this is skipped (and counted), never held whole. */
export const MAX_LINE_BYTES = 1024 * 1024;

export const defaultPiSessionsDir = (): string => path.join(os.homedir(), '.pi', 'agent', 'sessions');

/**
 * Does a host, as written in the log, carry a secret? The server's own
 * rules (core redactLog: known secret formats and this machine's secret env
 * values), so nothing the server would refuse to keep is even sent.
 */
export const importScreen = (env: NodeJS.ProcessEnv = process.env): AirlockHostScreen =>
  (spelling) => redactLog(spelling, { home: null, env }).count > 0;

/** Every *.jsonl file under `dir`, links not followed. A missing directory has none. */
export function sessionFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * The lines of a file, streamed. A line past `maxBytes` is dropped as it
 * streams (never buffered whole) and reported through `onLong`.
 */
export async function* linesOf(file: string, maxBytes: number, onLong: () => void): AsyncGenerator<string> {
  let parts: Buffer[] = [];
  let size = 0;
  let long = false;
  for await (const chunk of fs.createReadStream(file) as AsyncIterable<Buffer>) {
    let from = 0;
    for (let nl = chunk.indexOf(10, from); ; nl = chunk.indexOf(10, from)) {
      const end = nl < 0 ? chunk.length : nl;
      if (!long) {
        if (size + (end - from) > maxBytes) { long = true; parts = []; size = 0; }
        else { parts.push(chunk.subarray(from, end)); size += end - from; }
      }
      if (nl < 0) break;
      if (long) onLong();
      else yield Buffer.concat(parts).toString('utf8');
      parts = []; size = 0; long = false;
      from = nl + 1;
    }
  }
  if (long) onLong();
  else if (size > 0) yield Buffer.concat(parts).toString('utf8');
}

export interface CollectOptions {
  maxLineBytes?: number;
  maxHosts?: number;
  env?: NodeJS.ProcessEnv;
  /** Keep a few example commands per host, secrets removed, for --hints. */
  examples?: boolean;
  /** How one line is tallied (core's tallyPiSessionLine); a test passes one that fails. */
  tally?: typeof tallyPiSessionLine;
}

export interface CollectResult {
  files: number;
  hosts: Map<string, AirlockImportTally>;
  /** Lines over the size cap, skipped. */
  longLines: number;
  /** Sightings of new hosts past the distinct-host cap, left out. */
  droppedHosts: number;
  /** Lines the tally failed on, skipped: one line never ends the import. */
  unreadableLines: number;
  /** Per host: the projects that reached it, and its example commands when asked for. */
  context: Map<string, { projects: string[]; examples: string[] }>;
}

/**
 * A session header's working folder, as its name only: null when there is
 * none, it carries a secret, or it is not a name a context may keep (too long,
 * control characters) - checked here, before it reaches the model's prompt.
 */
function projectOf(line: string, screen: AirlockHostScreen): string | null {
  try {
    const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd;
    const name = typeof cwd === 'string' ? path.basename(cwd).trim() : '';
    return name && name.length <= MAX_PROJECT_CHARS && !/[\u0000-\u001f\u007f]/.test(name) && !screen(name) ? name : null;
  } catch { return null; }
}

/** The hosts the tool calls in every pi session log under `dir` reached, within the caps. */
export async function collectPiSessionHosts(dir: string, opts: CollectOptions = {}): Promise<CollectResult> {
  const hosts = new Map<string, AirlockImportTally>();
  const stats = { droppedHosts: 0 };
  let longLines = 0;
  let unreadableLines = 0;
  const tally = opts.tally ?? tallyPiSessionLine;
  const env = opts.env ?? process.env;
  const screen = importScreen(env);
  const maxHosts = opts.maxHosts ?? MAX_IMPORT_HOSTS;
  const context = new Map<string, { projects: string[]; examples: string[] }>();
  const files = sessionFiles(dir);
  for (const file of files) {
    let project: string | null = null;
    // Each call's hosts: the projects that reached them, and (when asked) the call itself, secrets removed, then cut.
    const onCall = ({ hosts: reached, text }: { hosts: string[]; text: string }): void => {
      for (const host of reached) {
        if (!context.has(host) && context.size >= maxHosts) continue;
        const c = context.get(host) ?? { projects: [], examples: [] };
        if (project && !c.projects.includes(project) && c.projects.length < MAX_CONTEXT_PROJECTS) c.projects.push(project);
        if (opts.examples && c.examples.length < MAX_HINT_EXAMPLES) {
          // Redacted and scrubbed whole, then cut: a cut first could leave a secret's head that no rule knows.
          const example = scrubCredentials(redactLog(text, { home: os.homedir(), env }).text).slice(0, MAX_EXAMPLE_CHARS);
          if (!c.examples.includes(example)) c.examples.push(example);
        }
        context.set(host, c);
      }
    };
    for await (const line of linesOf(file, opts.maxLineBytes ?? MAX_LINE_BYTES, () => { longLines++; })) {
      if (line.startsWith('{"type":"session"')) project = projectOf(line, screen);
      try {
        tally(line, hosts, { screen, maxHosts, stats, onCall });
      } catch {
        unreadableLines++;
      }
    }
  }
  return { files: files.length, hosts, longLines, droppedHosts: stats.droppedHosts, unreadableLines, context };
}

export interface ImportBatch {
  client: 'pi';
  hosts: Array<{ host: string; hits: number; uploads: number; firstSeen: string | null; lastSeen: string | null; context: AirlockHostContext }>;
}

/**
 * The tally as the requests the server takes: five fields per host and its
 * context - empty when the import found nothing, so the server clears a stale
 * one - one batch at a time, each at most MAX_IMPORT_BATCH
 * hosts AND `maxBytes` serialised (long host names and hints fill the body
 * limit long before the count).
 */
export function* importBatches(
  tally: Map<string, AirlockImportTally>, maxBytes: number = AIRLOCK_IMPORT_MAX_BYTES, contexts: ReadonlyMap<string, AirlockHostContext> = new Map(),
): Generator<ImportBatch> {
  const envelope = Buffer.byteLength(JSON.stringify({ client: 'pi', hosts: [] }));
  let hosts: ImportBatch['hosts'] = [];
  let bytes = envelope;
  for (const [host, t] of tally) {
    const context = sanitizeHostContext(contexts.get(host)) ?? { ...EMPTY_HOST_CONTEXT, projects: [] };
    const entry = { host, hits: t.hits, uploads: t.uploads ?? 0, firstSeen: t.firstSeen, lastSeen: t.lastSeen, context };
    const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (hosts.length && (hosts.length === MAX_IMPORT_BATCH || bytes + size > maxBytes)) {
      yield { client: 'pi', hosts };
      hosts = [];
      bytes = envelope;
    }
    hosts.push(entry);
    bytes += size;
  }
  if (hosts.length) yield { client: 'pi', hosts };
}

const tooLarge = (e: unknown): boolean => (e as { response?: { status?: number } } | null)?.response?.status === 413;

export interface LearnImportDeps {
  post: (url: string, body: ImportBatch) => Promise<{ data: { recorded?: number; invalid?: number; excluded?: number; hubJoined?: boolean } }>;
  apiUrl: string;
  log: (message: string) => void;
  env?: NodeJS.ProcessEnv;
  /** An address's reverse DNS names (default: the system resolver). */
  reverse?: (ip: string) => Promise<string[]>;
  /** reverseNames' limits, for a test. */
  reverseOptions?: { timeoutMs?: number; budgetMs?: number; now?: () => number };
  /** The model that writes hints for a provider (default: learnHints' hintRunner). */
  hintRunnerFor?: (provider: HintProvider, model?: string) => HintRunner;
}

/** How long one reverse DNS lookup may take, how many run at once, and how long they may take in all. */
export const REVERSE_DNS_TIMEOUT_MS = 3000;
const REVERSE_DNS_CONCURRENCY = 8;
export const REVERSE_DNS_BUDGET_MS = 20_000;

/**
 * Each address's reverse DNS name; one that fails, has none or takes too long
 * is left out and counted. No lookup starts once `budgetMs` has passed: the
 * addresses left are counted as skipped, so a slow resolver costs an import
 * the budget, never minutes per address.
 */
export async function reverseNames(
  ips: readonly string[], reverse: (ip: string) => Promise<string[]>,
  opts: { timeoutMs?: number; budgetMs?: number; now?: () => number } = {},
): Promise<{ names: Map<string, string>; unnamed: number; skipped: number }> {
  const names = new Map<string, string>();
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.budgetMs ?? REVERSE_DNS_BUDGET_MS);
  let unnamed = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < ips.length && now() < deadline) {
      const ip = ips[next++];
      let timer: NodeJS.Timeout | undefined;
      try {
        const got = await Promise.race([
          reverse(ip),
          new Promise<string[]>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), opts.timeoutMs ?? REVERSE_DNS_TIMEOUT_MS); }),
        ]);
        if (got[0]) names.set(ip, got[0]);
        else unnamed++;
      } catch { unnamed++; } finally { clearTimeout(timer); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(REVERSE_DNS_CONCURRENCY, ips.length) }, worker));
  return { names, unnamed, skipped: ips.length - next };
}

export interface LearnImportResult {
  files: number;
  hosts: number;
  recorded: number;
  invalid: number;
  excluded: number;
  longLines: number;
  droppedHosts: number;
  unreadableLines: number;
  /** The server is joined to a hub: the proposal is sent to the hub from the board, not accepted here. */
  hubJoined: boolean;
  /** With --hints: how many hosts the model was asked about, and how many hints came back. */
  hints?: { asked: number; written: number };
}

/** What the command prints once the import is done: what was learned, and where a person takes it next. */
export function learnImportSummary(result: LearnImportResult, boardUrl: string): string[] {
  const n = result.recorded;
  const notes = [
    result.invalid && `${result.invalid} refused`,
    result.excluded && `${result.excluded} never proposed: already listed, blocked, private, a metadata endpoint or a reserved name`,
  ].filter(Boolean).join(', ');
  const lines = [`Learned ${n} host${n === 1 ? '' : 's'}${notes ? ` (${notes})` : ''}.`];
  if (result.hints) lines.push(`Wrote a hint for ${result.hints.written} of ${result.hints.asked} host${result.hints.asked === 1 ? '' : 's'}.`);
  if (!result.hubJoined) return [...lines, `Accept the hosts you want allowed on the board: ${boardUrl}`];
  return [
    ...lines,
    `Your organization's hub owns the Airlock policy: send the hosts you want allowed to the hub from the board: ${boardUrl}`,
    'An org admin accepts them on the hub (Admin -> Airlock, or agenfk hub admin airlock learning accept).',
  ];
}

export interface LearnImportOptions extends CollectOptions {
  dir?: string;
  /** Who writes a hint per host (--hints); none without it. */
  hints?: HintProvider;
  hintsModel?: string;
}

export async function runLearnImport(opts: LearnImportOptions, deps: LearnImportDeps): Promise<LearnImportResult> {
  const dir = opts.dir ?? defaultPiSessionsDir();
  const env = opts.env ?? deps.env ?? process.env;
  const { files, hosts, longLines, droppedHosts, unreadableLines, context } = await collectPiSessionHosts(dir, { ...opts, env, examples: !!opts.hints });
  deps.log(`Read ${files} pi session log${files === 1 ? '' : 's'} under ${dir}: ${hosts.size} host${hosts.size === 1 ? '' : 's'}.`);
  if (longLines) deps.log(`Skipped ${longLines} line${longLines === 1 ? '' : 's'} longer than ${MAX_LINE_BYTES} bytes.`);
  if (unreadableLines) deps.log(`Skipped ${unreadableLines} line${unreadableLines === 1 ? '' : 's'} that could not be read.`);
  if (droppedHosts) deps.log(`Left out ${droppedHosts} sighting${droppedHosts === 1 ? '' : 's'} of hosts past the ${opts.maxHosts ?? MAX_IMPORT_HOSTS}-host limit.`);

  // Context only for hosts that could be proposed: a private, reserved or metadata host is never looked up or asked about.
  const open = normalizeAirlockPolicy(DEFAULT_AIRLOCK_POLICY);
  const eligible = [...hosts.keys()].filter(h => learningExclusionOf(h, open) === null);
  const addresses = eligible.filter(isAddressHost);
  const { names, unnamed, skipped } = await reverseNames(addresses, deps.reverse ?? dns.reverse, deps.reverseOptions);
  if (addresses.length) {
    deps.log(`Reverse DNS: named ${names.size} of ${addresses.length} address${addresses.length === 1 ? '' : 'es'}`
      + `${unnamed ? `; ${unnamed} had no name or did not answer` : ''}${skipped ? `; ${skipped} skipped, past the ${REVERSE_DNS_BUDGET_MS / 1000}s budget` : ''}.`);
  }
  const screen = importScreen(env);
  let hints = new Map<string, string>();
  let hintsBy: string | null = null;
  let hintStats: LearnImportResult['hints'];
  if (opts.hints) {
    const runner = (deps.hintRunnerFor ?? ((p, model) => hintRunner(p, { model, env })))(opts.hints, opts.hintsModel);
    hintsBy = runner.name;
    const subjects = eligible.map(host => ({
      host, hits: hosts.get(host)!.hits, uploads: hosts.get(host)!.uploads ?? 0,
      projects: context.get(host)?.projects ?? [], examples: context.get(host)?.examples ?? [],
    }));
    deps.log(`Hints for ${subjects.length} host${subjects.length === 1 ? '' : 's'} from ${runner.name}: up to ${MAX_HINT_EXAMPLES} example commands each, secrets removed, go to it.`);
    hints = await writeHints(subjects, runner, deps.log, { screen });
    hintStats = { asked: subjects.length, written: hints.size };
  }
  const contexts = new Map<string, AirlockHostContext>();
  for (const host of hosts.keys()) {
    const hint = hints.get(host) ?? null;
    const c = sanitizeHostContext({ projects: context.get(host)?.projects ?? [], reverseDns: names.get(host) ?? null, hint, hintBy: hint ? hintsBy : null }, screen);
    if (c) contexts.set(host, c);
  }

  let recorded = 0;
  let invalid = 0;
  let excluded = 0;
  let hubJoined = false;
  // A batch the server still finds too large (413) is halved and sent again,
  // down to one host; any other failure ends the import.
  const send = async (batch: ImportBatch): Promise<void> => {
    let data: { recorded?: number; invalid?: number; excluded?: number; hubJoined?: boolean };
    try {
      ({ data } = await deps.post(`${deps.apiUrl}/airlock/learning/import`, batch));
    } catch (e) {
      if (!tooLarge(e) || batch.hosts.length < 2) throw e;
      const half = Math.ceil(batch.hosts.length / 2);
      await send({ client: 'pi', hosts: batch.hosts.slice(0, half) });
      await send({ client: 'pi', hosts: batch.hosts.slice(half) });
      return;
    }
    recorded += data?.recorded ?? 0;
    invalid += data?.invalid ?? 0;
    excluded += data?.excluded ?? 0;
    hubJoined ||= data?.hubJoined === true;
  };
  for (const batch of importBatches(hosts, undefined, contexts)) await send(batch);
  return { files, hosts: hosts.size, recorded, invalid, excluded, longLines, droppedHosts, unreadableLines, hubJoined, ...(hintStats ? { hints: hintStats } : {}) };
}
