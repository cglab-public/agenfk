/**
 * `agenfk airlock learn --import-pi-sessions` (GH-294, TEL-3): a one-off
 * import of the hosts existing pi sessions reached, for Airlock's proposed
 * allowlist. The logs are read here, on this machine, line by line; what goes
 * to the server is host names, counts, first/last seen and the client - never
 * a command, a URL's path or query, a file path or any session text.
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
import { AIRLOCK_IMPORT_MAX_BYTES, MAX_IMPORT_HOSTS, redactLog, tallyPiSessionLine, type AirlockHostScreen, type AirlockImportTally } from '@agenfk/core';

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
}

/** The hosts the tool calls in every pi session log under `dir` reached, within the caps. */
export async function collectPiSessionHosts(dir: string, opts: CollectOptions = {}): Promise<CollectResult> {
  const hosts = new Map<string, AirlockImportTally>();
  const stats = { droppedHosts: 0 };
  let longLines = 0;
  let unreadableLines = 0;
  const tally = opts.tally ?? tallyPiSessionLine;
  const screen = importScreen(opts.env);
  const files = sessionFiles(dir);
  for (const file of files) {
    for await (const line of linesOf(file, opts.maxLineBytes ?? MAX_LINE_BYTES, () => { longLines++; })) {
      try {
        tally(line, hosts, { screen, maxHosts: opts.maxHosts ?? MAX_IMPORT_HOSTS, stats });
      } catch {
        unreadableLines++;
      }
    }
  }
  return { files: files.length, hosts, longLines, droppedHosts: stats.droppedHosts, unreadableLines };
}

export interface ImportBatch {
  client: 'pi';
  hosts: Array<{ host: string; hits: number; firstSeen: string | null; lastSeen: string | null }>;
}

/**
 * The tally as the requests the server takes: four fields per host, one batch
 * at a time, each at most MAX_IMPORT_BATCH hosts AND `maxBytes` serialised
 * (long host names fill the body limit long before the count).
 */
export function* importBatches(tally: Map<string, AirlockImportTally>, maxBytes: number = AIRLOCK_IMPORT_MAX_BYTES): Generator<ImportBatch> {
  const envelope = Buffer.byteLength(JSON.stringify({ client: 'pi', hosts: [] }));
  let hosts: ImportBatch['hosts'] = [];
  let bytes = envelope;
  for (const [host, t] of tally) {
    const entry = { host, hits: t.hits, firstSeen: t.firstSeen, lastSeen: t.lastSeen };
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
  post: (url: string, body: ImportBatch) => Promise<{ data: { recorded?: number; invalid?: number; excluded?: number } }>;
  apiUrl: string;
  log: (message: string) => void;
  env?: NodeJS.ProcessEnv;
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
}

export async function runLearnImport(opts: { dir?: string } & CollectOptions, deps: LearnImportDeps): Promise<LearnImportResult> {
  const dir = opts.dir ?? defaultPiSessionsDir();
  const { files, hosts, longLines, droppedHosts, unreadableLines } = await collectPiSessionHosts(dir, { ...opts, env: opts.env ?? deps.env });
  deps.log(`Read ${files} pi session log${files === 1 ? '' : 's'} under ${dir}: ${hosts.size} host${hosts.size === 1 ? '' : 's'}.`);
  if (longLines) deps.log(`Skipped ${longLines} line${longLines === 1 ? '' : 's'} longer than ${MAX_LINE_BYTES} bytes.`);
  if (unreadableLines) deps.log(`Skipped ${unreadableLines} line${unreadableLines === 1 ? '' : 's'} that could not be read.`);
  if (droppedHosts) deps.log(`Left out ${droppedHosts} sighting${droppedHosts === 1 ? '' : 's'} of hosts past the ${opts.maxHosts ?? MAX_IMPORT_HOSTS}-host limit.`);
  let recorded = 0;
  let invalid = 0;
  let excluded = 0;
  // A batch the server still finds too large (413) is halved and sent again,
  // down to one host; any other failure ends the import.
  const send = async (batch: ImportBatch): Promise<void> => {
    let data: { recorded?: number; invalid?: number; excluded?: number };
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
  };
  for (const batch of importBatches(hosts)) await send(batch);
  return { files, hosts: hosts.size, recorded, invalid, excluded, longLines, droppedHosts, unreadableLines };
}
