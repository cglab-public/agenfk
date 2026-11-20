import * as path from 'path';
import type { StorageProvider } from '@agenfk/core';
import { ingestOnce, type IngestionSource } from './watcher';
import { parseClaudeCodeJsonl } from './parsers/claude-code';
import { parseCodexJsonl } from './parsers/codex';
import { parsePiJsonl } from './parsers/pi';

const jsonl = (rel: string) => rel.endsWith('.jsonl');

/**
 * Where each harness keeps its session logs (GH-389). Claude Code's folder
 * also holds `<session>/subagents/agent-*.jsonl`, whose records carry the
 * parent's session id, so a subagent's usage goes to the parent's card.
 */
export function defaultIngestionSources(
  home: string,
  env: Record<string, string | undefined>,
): IngestionSource[] {
  const claudeDir = env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, '.claude');
  const codexDir = env.CODEX_HOME?.trim() || path.join(home, '.codex');
  return [
    { client: 'claude-code', rootDir: path.join(claudeDir, 'projects'), matches: jsonl, parser: parseClaudeCodeJsonl },
    { client: 'codex', rootDir: path.join(codexDir, 'sessions'), matches: jsonl, parser: parseCodexJsonl },
    { client: 'pi', rootDir: path.join(home, '.pi', 'agent', 'sessions'), matches: jsonl, parser: parsePiJsonl },
  ];
}

export interface SessionRef {
  client: string;
  sessionId: string;
}

export interface UsageIngestion {
  /** One pass over every source. */
  runOnce(): Promise<number>;
  /** Ingest just these sessions' logs now, so their usage is current. */
  flush(sessions: SessionRef[]): Promise<number>;
  /** Poll every `intervalMs` until stop(). */
  start(): void;
  stop(): void;
}

/**
 * Local token ingestion (GH-389). Per-turn events are written to the local
 * store only: this service has no hub hook, by design - per-turn forwarding is
 * what flooded the hub in beta.10 (BUG 9c27faf6). The hub sees usage only as
 * the per-transition totals the workflow attaches to its own events, and the
 * turns on no card as a few daily totals per project (usage/noCardUsage.ts).
 *
 * Passes never overlap: a flush asked for while a poll runs waits for it, so
 * the two cannot read the same appended bytes and race on the file's state.
 * Every session file name carries its session id (Claude Code
 * `<id>.jsonl` and `<id>/subagents/...`, pi `<ts>_<id>.jsonl`, Codex
 * `rollout-<ts>-<id>.jsonl`), which is how a flush finds them.
 */
export function createUsageIngestion(opts: {
  storage: StorageProvider;
  sources: IngestionSource[];
  intervalMs?: number;
  now?: () => Date;
}): UsageIngestion {
  const now = opts.now ?? (() => new Date());
  // Stored when ingestion is set up, not at its first pass: a log written
  // between the two would otherwise count as backlog and never be read.
  const epoch: Promise<string> = opts.storage.ensureIngestionEpoch(now().toISOString());
  epoch.catch((e: Error) => console.error('[USAGE] could not store the ingestion epoch:', e.message));
  const getEpoch = () => epoch;

  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };

  const pass = (fileFilter?: (client: string, abs: string, rel: string) => boolean) =>
    serial(async () => ingestOnce({
      storage: opts.storage,
      sources: opts.sources,
      attributeEvents: true,
      epoch: await getEpoch(),
      ...(fileFilter ? { fileFilter } : {}),
    }));

  let timer: NodeJS.Timeout | null = null;
  let stopped = true;
  const tick = async () => {
    try { await pass(); } catch (e) {
      console.error('[USAGE] ingestion pass failed:', (e as Error).message);
    }
    if (!stopped) timer = setTimeout(tick, opts.intervalMs ?? 30_000);
  };

  return {
    runOnce: () => pass(),
    flush: async (sessions) => {
      if (!sessions.length) return 0;
      return pass((client, _abs, rel) => sessions.some((s) => s.client === client && rel.includes(s.sessionId)));
    },
    start: () => {
      if (!stopped) return;
      stopped = false;
      timer = setTimeout(tick, 0);
    },
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
