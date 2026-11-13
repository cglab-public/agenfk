/**
 * One terminal's cockpit: the probe's answer plus the agent's usage, read
 * incrementally from its transcript (INFRA-425).
 *
 * Kept per session: where the transcript is, how far it has been read, and
 * what has been counted. Each refresh reads only what was appended, because a
 * long session's transcript runs to megabytes.
 *
 * Nothing here blocks: every file operation is a promise, because the main
 * process also carries every window's IPC and terminal output, and a WSL
 * transcript is read over \\wsl.localhost, where a synchronous call stalls
 * all of it.
 *
 * Everything that touches a process or a disk is a dependency, so the joining
 * logic is tested without either; index.ts supplies the real ones.
 */
import { StringDecoder } from 'string_decoder';
import { parseCockpitProbe, type ProbeResult } from './probe.js';
import { piContextWindow, UsageAccumulator, type TranscriptKind, type UsageSnapshot } from './transcript.js';
import type { EnvReport } from './envReport.js';
import type { WslTarget } from '../wsl.js';

export interface CockpitContext {
  /** The terminal's directory, or null for one that belongs to none. */
  readonly cwd: string | null;
  readonly agentId: string;
  readonly agentSessionId?: string;
  readonly wsl: WslTarget | null;
  /** Under tmux every pane shares one server's environment: no AWS by scan. */
  readonly tmux: boolean;
  /** When the terminal opened, so a resumed conversation's file can be told apart. */
  readonly spawnedAt: number;
  /** Opened to resume a conversation: Claude's --continue may pick another id. */
  readonly resumed: boolean;
  /** What the terminal's own shell last reported (envReport.ts), if it does. */
  readonly reported: EnvReport | null;
}

export type CockpitSnapshot = ProbeResult & { readonly usage: UsageSnapshot | null };

export interface CockpitDeps {
  /** Run COCKPIT_PROBE_SCRIPT where the terminal runs, with these arguments; '' when it cannot. */
  probe(ctx: CockpitContext, args: readonly string[]): Promise<string>;
  /** $HOME inside the terminal's runtime, or null when unknown. */
  home(ctx: CockpitContext): Promise<string | null>;
  /** A path inside the terminal's runtime, as this process must open it. */
  hostPath(ctx: CockpitContext, path: string): Promise<string>;
  readonly fs: {
    readdir(path: string): Promise<string[]>;
    stat(path: string): Promise<{ size: number; mtimeMs: number }>;
    /** Up to `length` bytes from `offset`; fewer when the file or the transport gives fewer. */
    read(path: string, offset: number, length: number): Promise<Buffer>;
    readText(path: string): Promise<string | null>;
  };
  readonly now?: () => number;
  /** Tests only: how long a transcript read may take before the last answer is used. */
  readonly usageTimeoutMs?: number;
}

const KIND: Readonly<Record<string, TranscriptKind>> = { 'claude-code': 'claude', pi: 'pi' };

/** The first read of a long session is capped; the cost is then a lower bound. */
const MAX_READ = 16 * 1024 * 1024;
/** A transcript not found yet is looked for again after this long, not every poll. */
const MISS_BACKOFF_MS = 60_000;
/** Answers within this long of the last one are the last one: one probe per terminal at a time. */
const MIN_INTERVAL_MS = 10_000;
/**
 * The transcript side gives up after this long, keeping the probe's answer: a
 * read over \\wsl.localhost can hang while a distro stops, and a promise that
 * never settles would be returned to every later ask.
 */
const USAGE_TIMEOUT_MS = 20_000;
/** A provisional transcript is re-checked for the conversation's own file every this many polls. */
const RECHECK_EVERY = 4;

interface Reader {
  offset: number;
  readonly decoder: StringDecoder;
  readonly acc: UsageAccumulator;
}

interface Tracker {
  readonly path: string;
  /**
   * Chosen as the newest file rather than by the conversation's id (a resume
   * under another id). Provisional: the id's own file wins as soon as it
   * appears.
   */
  readonly provisional: boolean;
  main: Reader;
  /** Read from somewhere past the start: what came before was not counted. */
  truncated: boolean;
  /** Claude Code's subagents, each in its own file beside the session's. */
  readonly subagents: Map<string, Reader>;
}

const reader = (kind: TranscriptKind): Reader => ({ offset: 0, decoder: new StringDecoder('utf8'), acc: new UsageAccumulator(kind) });

/** How each agent names a project directory after the working directory. */
const claudeProjectDir = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-');
const piSessionDir = (cwd: string): string => `--${cwd.replace(/^[/\\]+/, '').replace(/[/\\:]/g, '-')}--`;

export class CockpitService {
  private readonly trackers = new Map<string, Tracker>();
  private readonly misses = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<CockpitSnapshot>>();
  private readonly last = new Map<string, { at: number; snap: CockpitSnapshot }>();
  private readonly ended = new Set<string>();
  /** The physical cwd each terminal's last probe reported (agents name directories by it). */
  private readonly physical = new Map<string, string>();
  /**
   * The transcript read in progress, per terminal. ONE at a time: a read that
   * outlived its timeout keeps running, and a second one on the same reader
   * would count the same bytes twice. Later asks get the last usage instead.
   */
  private readonly reading = new Map<string, Promise<UsageSnapshot | null>>();
  private readonly lastUsage = new Map<string, UsageSnapshot | null>();
  /** Polls since a provisional transcript was last re-checked. */
  private readonly sinceRecheck = new Map<string, number>();

  constructor(private readonly deps: CockpitDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** One terminal's cockpit. Concurrent and too-frequent asks share one answer. */
  snapshot(marker: string, ctx: CockpitContext): Promise<CockpitSnapshot> {
    const recent = this.last.get(marker);
    if (recent && this.now() - recent.at < MIN_INTERVAL_MS) return Promise.resolve(recent.snap);
    const running = this.inflight.get(marker);
    if (running) return running;
    const work = this.compute(marker, ctx).finally(() => this.inflight.delete(marker));
    this.inflight.set(marker, work);
    return work;
  }

  forget(marker: string): void {
    this.ended.add(marker);
    this.trackers.delete(marker);
    this.misses.delete(marker);
    this.last.delete(marker);
    this.physical.delete(marker);
    this.lastUsage.delete(marker);
    this.sinceRecheck.delete(marker);
  }

  private async compute(marker: string, ctx: CockpitContext): Promise<CockpitSnapshot> {
    // Probe and transcript are independent: a slow or failed probe must not
    // take the agent's cost and context off the screen with it.
    const probing = this.deps.probe(ctx, this.probeArgs(marker, ctx)).catch(() => '').then(out => {
      const parsed = parseCockpitProbe(out);
      if (parsed.cwd && !this.ended.has(marker)) this.physical.set(marker, parsed.cwd);
      return parsed;
    });
    const [probed, usage] = await Promise.all([
      probing,
      this.usageOnce(marker, ctx),
    ]);
    /*
     * The probe says `shell` when it read the oldest process in the terminal
     * while nothing else ran in front. For a terminal that started an AGENT,
     * that process is the agent itself, whose environment is exactly what it
     * runs with - not a shell's possibly stale start environment.
     */
    const isAgent = ctx.agentId !== 'shell' && ctx.agentId !== 'herdr';
    const aws = probed.aws?.source === 'shell' && isAgent ? { ...probed.aws, source: 'foreground' as const } : probed.aws;
    const snap: CockpitSnapshot = { ...probed, aws, usage };
    if (!this.ended.has(marker)) this.last.set(marker, { at: this.now(), snap });
    return snap;
  }

  /** One transcript read per terminal, bounded in time; the last answer while one is running. */
  private usageOnce(marker: string, ctx: CockpitContext): Promise<UsageSnapshot | null> {
    if (this.reading.has(marker)) return Promise.resolve(this.lastUsage.get(marker) ?? null);
    const work = this.usage(marker, ctx).catch(() => null).then(u => {
      if (!this.ended.has(marker)) this.lastUsage.set(marker, u);
      return u;
    }).finally(() => this.reading.delete(marker));
    this.reading.set(marker, work);
    return Promise.race([
      work,
      new Promise<UsageSnapshot | null>(resolve => {
        setTimeout(() => resolve(this.lastUsage.get(marker) ?? null), this.deps.usageTimeoutMs ?? USAGE_TIMEOUT_MS).unref?.();
      }),
    ]);
  }

  private probeArgs(marker: string, ctx: CockpitContext): string[] {
    // '-' for empty: wsl.exe may drop an empty argument and shift the rest.
    if (ctx.reported) return [marker, 'reported', ctx.reported.awsProfile || '-', ctx.reported.kubeconfig || '-'];
    return [marker, ctx.tmux ? 'none' : 'scan', '-', '-'];
  }

  private async usage(marker: string, ctx: CockpitContext): Promise<UsageSnapshot | null> {
    const kind = KIND[ctx.agentId];
    if (!kind || !ctx.cwd) return null;
    let tracker = this.trackers.get(marker);
    // A provisional pin is re-checked every few polls, not every one: each
    // check stats the project directory, which over \\wsl.localhost adds up.
    const recheck = tracker?.provisional === true && ((this.sinceRecheck.get(marker) ?? 0) + 1) % RECHECK_EVERY === 0;
    if (tracker?.provisional) this.sinceRecheck.set(marker, (this.sinceRecheck.get(marker) ?? 0) + 1);
    if (!tracker || recheck) {
      const missedAt = this.misses.get(marker);
      if (!tracker && missedAt !== undefined && this.now() - missedAt < MISS_BACKOFF_MS) return null;
      const home = await this.deps.home(ctx);
      const physical = this.physical.get(marker) ?? null;
      const found = home ? await this.locate(kind, ctx, home, physical) : null;
      // The session may have ended while this was looking: keep nothing for it.
      if (this.ended.has(marker)) return null;
      if (!found && !tracker) {
        // Only back off once the physical cwd is known: the first poll runs
        // before any probe has said where the agent names its directory.
        if (physical) this.misses.set(marker, this.now());
        return null;
      }
      // A provisional pin moves only to the conversation's OWN file, never to
      // whichever other transcript happened to be written last.
      if (found && (!tracker || (found.path !== tracker.path && !found.provisional))) {
        tracker = { path: found.path, provisional: found.provisional, main: reader(kind), truncated: false, subagents: new Map() };
        this.trackers.set(marker, tracker);
        this.misses.delete(marker);
      }
    }
    if (!tracker) return null;

    const { size } = await this.deps.fs.stat(tracker.path);
    if (size < tracker.main.offset) {
      // Rewritten from the start (compaction, a resumed session): count again.
      tracker.main = reader(kind);
      tracker.truncated = false;
    }
    if (tracker.main.offset === 0 && size > MAX_READ) {
      tracker.main.offset = size - MAX_READ;
      tracker.truncated = true;
    }
    await this.advance(tracker.path, tracker.main, size);
    const main = tracker.main.acc.snapshot();

    /*
     * The session's cost includes its subagents, which Claude Code records in
     * <session>/subagents/*.jsonl and bills like any other turn. Their context
     * is their own, so only the cost is added.
     */
    let subCost = 0;
    let subComplete = true;
    if (kind === 'claude') {
      const sep = tracker.path.includes('\\') ? '\\' : '/';
      const dir = `${tracker.path.replace(/\.jsonl$/, '')}${sep}subagents`;
      const files = await this.deps.fs.readdir(dir).then(f => f.filter(n => n.endsWith('.jsonl')), () => [] as string[]);
      for (const file of files) {
        const full = `${dir}${sep}${file}`;
        let sub = tracker.subagents.get(file);
        if (!sub) { sub = reader('claude'); tracker.subagents.set(file, sub); }
        await this.advance(full, sub, (await this.deps.fs.stat(full)).size);
        const s = sub.acc.snapshot();
        subCost += s.cost;
        subComplete = subComplete && s.costComplete;
      }
    }

    const snap: UsageSnapshot = {
      ...main,
      cost: main.cost + subCost,
      costComplete: main.costComplete && subComplete && !tracker.truncated,
    };
    if (kind === 'pi' && snap.contextWindow === null && snap.model && snap.provider) {
      const home = await this.deps.home(ctx);
      const models = home ? await this.deps.fs.readText(await this.deps.hostPath(ctx, `${home}/.pi/agent/models.json`)) : null;
      return { ...snap, contextWindow: models ? piContextWindow(models, snap.provider, snap.model) : null };
    }
    return snap;
  }

  /** Read what was appended, advancing by the bytes actually read. */
  private async advance(path: string, r: Reader, size: number): Promise<void> {
    while (r.offset < size) {
      const buf = await this.deps.fs.read(path, r.offset, Math.min(size - r.offset, MAX_READ));
      if (buf.length === 0) return;
      r.offset += buf.length;
      // A decoder, not toString(): a character split across two reads stays whole.
      r.acc.feed(r.decoder.write(buf));
    }
  }

  /**
   * The conversation's file: in the project directory each agent derives from
   * the working directory, by the id the terminal started it with. Claude's
   * `--continue` may resume under ANOTHER id - the one it picked - so when the
   * stored one is missing, the newest file there written since this terminal
   * opened is the conversation.
   */
  private async locate(
    kind: TranscriptKind, ctx: CockpitContext, home: string, physical: string | null,
  ): Promise<{ path: string; provisional: boolean } | null> {
    const id = ctx.agentSessionId;
    if (!id || !ctx.cwd) return null;
    // The physical cwd the probe reported first (a Windows path opened in WSL
    // is /mnt/c/... there; a symlinked one resolves), then the one we know.
    for (const cwd of [...new Set([physical, ctx.cwd].filter((c): c is string => !!c))]) {
      const base = kind === 'claude'
        ? `${home}/.claude/projects/${claudeProjectDir(cwd)}`
        : `${home}/.pi/agent/sessions/${piSessionDir(cwd)}`;
      const dir = await this.deps.hostPath(ctx, base);
      const sep = dir.includes('\\') ? '\\' : '/';
      let files: string[];
      try { files = (await this.deps.fs.readdir(dir)).filter(f => f.endsWith('.jsonl')); } catch { continue; }
      const exact = files.find(f => (kind === 'claude' ? f === `${id}.jsonl` : f.endsWith(`_${id}.jsonl`)));
      if (exact) return { path: `${dir}${sep}${exact}`, provisional: false };
      /*
       * Only a RESUME may land under another id (--continue picks the
       * directory's latest conversation); a fresh session writes its own id
       * once the first exchange happens, and guessing before that would pin a
       * neighbour's transcript in a shared checkout.
       */
      if (kind !== 'claude' || !ctx.resumed) continue;
      let best: { path: string; mtime: number } | null = null;
      for (const f of files) {
        const path = `${dir}${sep}${f}`;
        const { mtimeMs } = await this.deps.fs.stat(path).catch(() => ({ mtimeMs: 0 }));
        if (mtimeMs >= ctx.spawnedAt && (!best || mtimeMs > best.mtime)) best = { path, mtime: mtimeMs };
      }
      if (best) return { path: best.path, provisional: true };
    }
    return null;
  }
}
