/**
 * Sessions that are already open in herdr (dafbb59e / CGLAB-266).
 *
 * A developer running agents in herdr has work this product cannot see. On the
 * machine this was written on, one read-only probe of herdr 0.7.5 answered with
 * 12 workspaces, 48 panes and 42 agents - none of which AgEnFK launched, and
 * none of which any of its screens can show. That is the population
 * `Work Without a Window` calls the runs with no terminal: work in progress
 * that no surface displays.
 *
 * READ ONLY, DELIBERATELY. The protocol can also type into a pane
 * (`pane.send_text`, `agent.send`) and move the operator's real screen
 * (`pane.focus`). None of that is here. Writing into another tool's terminal is
 * an action with a consequence, and it belongs behind an explicit gesture in a
 * separate change rather than arriving as a side effect of a listing.
 *
 * WHERE THE PROTOCOL FACTS COME FROM. Two independent sources, because one
 * would be a guess: collie's `HERDR_API.md` (MIT, reverse-engineered and stated
 * against herdr protocol 16 and 20) and a read-only probe of herdr 0.7.5 here,
 * which speaks protocol 17 - between the two they verified, and it works.
 * herdr itself is Apache-2.0; this repository already credits it in
 * `agentState.ts` for the OSC rules.
 *
 * PURE WHERE IT CAN BE. Discovery takes its two filesystem questions as
 * arguments and the transport is injected, so the sharp edges - a server that
 * never answers, an error response, a request one byte over the ceiling - are
 * exercised in tests without a real herdr and without a real socket.
 */
import { createConnection } from 'net';
import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

/** The socket file every herdr session listens on, whichever directory holds it. */
export const HERDR_SOCKET_FILE = 'herdr.sock';

/** The directory that holds named sessions under a config root. */
const SESSIONS_DIR = 'sessions';

/** What the default session is called when herdr does not name it. */
const DEFAULT_SESSION_NAME = 'default';

/**
 * The ceiling on one request line.
 *
 * Live-probed by collie against herdr 0.7.5: 1 048 575 bytes still gets a
 * normal reply; 1 048 576 gets NO reply at all - the server drops the
 * connection or simply never answers. So going over does not fail, it HANGS,
 * which is why this is checked before a byte leaves.
 */
export const MAX_REQUEST_BYTES = 1024 * 1024;

/** How long to wait for the single response an RPC is allowed. */
export const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * The ceiling on one RESPONSE, which the protocol does not give us.
 *
 * The request side has a documented 1 MiB cap; the answer side has none, and the
 * stream has no timeout either because it is meant to stay open. Measured: a
 * server flooding without a newline moved RSS from 50 MB to 150 MB in three
 * seconds. A cap that destroys the socket and reports the truncation is the only
 * thing standing between a misbehaving herdr and the server's memory.
 */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface HerdrSession {
  readonly name: string;
  readonly socketPath: string;
}

export interface HerdrError {
  readonly code: string;
  readonly message: string;
}

export type ParsedResponse =
  | { readonly ok: true; readonly result: { readonly type?: string; readonly [k: string]: unknown } }
  | { readonly ok: false; readonly error: HerdrError };

/**
 * One pane, as herdr describes it.
 *
 * MEASURED, not transcribed: these are the fourteen fields a live 0.7.5 answered
 * with. Two of them are worth naming because this repository derives them the
 * hard way today - `agent_status` is what `agentState.ts` and
 * `screenActivity.ts` scrape off the screen, and `terminal_title_stripped` is
 * the OSC title already cleaned. herdr answers both outright, including for
 * agents like `pi` that publish no OSC title at all.
 *
 * The index signature stays: a newer herdr may add fields, and dropping them
 * silently would be worse than carrying them untyped.
 */
export interface HerdrPane {
  readonly pane_id: string;
  readonly terminal_id?: string;
  readonly workspace_id?: string;
  readonly tab_id?: string;
  readonly cwd?: string;
  readonly foreground_cwd?: string;
  readonly agent?: string;
  readonly agent_status?: string;
  readonly agent_session?: Record<string, unknown>;
  readonly terminal_title?: string;
  readonly terminal_title_stripped?: string;
  readonly focused?: boolean;
  readonly revision?: number;
  readonly scroll?: number;
  readonly [k: string]: unknown;
}

export interface HerdrSnapshot {
  readonly protocol?: number;
  readonly workspaces: readonly Record<string, unknown>[];
  readonly tabs: readonly Record<string, unknown>[];
  readonly panes: readonly HerdrPane[];
  /** Same shape as a pane, plus `state_change_seq`. herdr repeats the pane row here. */
  readonly agents: readonly HerdrPane[];
  readonly focused_pane_id?: string;
  readonly [k: string]: unknown;
}

export type SnapshotResult =
  | { readonly ok: true; readonly snapshot: HerdrSnapshot }
  | { readonly ok: false; readonly error: HerdrError };

/* ── where the sockets are ─────────────────────────────────────────────── */

/**
 * The config root a socket path belongs to. Pure.
 *
 * `<root>/sessions/<name>/herdr.sock` is a named session and its root is the
 * prefix before `/sessions/`; anything else is the default session's own
 * directory.
 */
export function deriveConfigRoot(socketPath: string): string {
  const dir = path.dirname(socketPath);
  const parent = path.dirname(dir);
  if (path.basename(parent) === SESSIONS_DIR) return path.dirname(parent);
  return dir;
}


/**
 * The config root to scan.
 *
 * `HERDR_SOCKET_PATH` wins because herdr injects it into every process it
 * launches, alongside `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID` and `HERDR_PANE_ID`.
 * Ignoring it would scan the default location while running inside a session
 * that lives somewhere else.
 *
 * An empty value reads as absent rather than as a path: `HERDR_SOCKET_PATH=` in
 * a shell profile is set-but-empty, and `dirname('')` is `'.'`, which would
 * point discovery at the server's working directory.
 */
export function herdrConfigRoot(env: NodeJS.ProcessEnv, home: string): string {
  const declared = env.HERDR_SOCKET_PATH?.trim();
  /*
   * `dirname` IS NOT THE ROOT when we are inside a NAMED session. herdr injects
   * HERDR_SOCKET_PATH into every process it launches, and for a named session
   * that path is `<root>/sessions/<name>/herdr.sock` - so dirname gives
   * `<root>/sessions/<name>`, discovery then scans
   * `<root>/sessions/<name>/sessions`, finds nothing, and answers with the one
   * session it started from, labelled `default`. Every sibling disappears and
   * the survivor carries the wrong name.
   *
   * `deriveConfigRoot` is the function that knows this, and for a while it was
   * exported, tested, and called by nobody.
   */
  if (declared) return deriveConfigRoot(declared);
  /*
   * The same trap this function guards for HERDR_SOCKET_PATH, one line down:
   * an empty HOME makes `join('', '.config', 'herdr')` the RELATIVE path
   * `.config/herdr`, and discovery would scan the server's working directory -
   * inside the user's repository. A daemon launched by launchd or systemd
   * without HOME in its environment is exactly that case.
   */
  const base = home.trim() || homedir();
  return path.join(base, '.config', 'herdr');
}

/**
 * Every herdr session currently live under a config root.
 *
 * THE LIVENESS SIGNAL IS THE SOCKET FILE, because a cleanly stopped herdr
 * session removes it. That is a fact about herdr and not a general one - tmux
 * keeps its socket after `kill-server` - which is why this module is named
 * after herdr rather than after multiplexers.
 *
 * `listSessionDirs` and `exists` are injected so the only filesystem input is
 * the trusted config root, and so a name discovered on disk is only ever joined
 * back UNDER that root - it never becomes a path of its own.
 */
export function discoverSessionSockets(
  configRoot: string,
  listSessionDirs: (dir: string) => string[],
  exists: (p: string) => boolean,
): HerdrSession[] {
  const found: HerdrSession[] = [];

  const defaultSock = path.join(configRoot, HERDR_SOCKET_FILE);
  if (exists(defaultSock)) found.push({ name: DEFAULT_SESSION_NAME, socketPath: defaultSock });

  const sessionsDir = path.join(configRoot, SESSIONS_DIR);
  let names: string[] = [];
  try {
    names = listSessionDirs(sessionsDir);
  } catch {
    // A missing sessions directory is the common case - one session and nothing
    // named - not a failure worth reporting.
    names = [];
  }

  for (const name of names) {
    /*
     * A NAME MUST BE ONE SEGMENT. `join` is not containment: `..` walks out of
     * the tree entirely, and `.` stays inside while naming no session at all -
     * it resolves to `<sessions>/herdr.sock`, which the separator check alone
     * accepts. A real `readdir` never returns either, but `listSessionDirs` is
     * injected, so the guard states the rule rather than trusting the caller.
     */
    if (name === '.' || name === '..' || name.includes(path.sep) || name.includes('/')) continue;
    const socketPath = path.join(sessionsDir, name, HERDR_SOCKET_FILE);
    // Belt after braces: the segment check above already refuses anything that
    // could leave, so this is unreachable today. Kept because the containment
    // property is the one worth stating twice, and a future relaxation of the
    // name rule would otherwise silently remove it.
    /* c8 ignore next */
    if (!socketPath.startsWith(`${sessionsDir}${path.sep}`)) continue;
    if (exists(socketPath)) found.push({ name, socketPath });
  }

  return found;
}

/** Discovery against the real filesystem. Nothing above this decides where to look. */
export function liveHerdrSessions(
  env: NodeJS.ProcessEnv = process.env,
  // Reads the env it was HANDED, not the process's. The two disagreeing is part
  // of why this function had no test worth the name.
  home: string = env.HOME ?? '',
): HerdrSession[] {
  return discoverSessionSockets(
    herdrConfigRoot(env, home),
    dir => readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name),
    existsSync,
  );
}

/* ── the wire ──────────────────────────────────────────────────────────── */

/** A request id that is unique per call without needing a clock or randomness. */
let requestCounter = 0;


export interface HerdrRequest {
  readonly id: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/**
 * One request, as the single newline-terminated JSON line herdr expects.
 *
 * Two refusals happen here rather than on the far side. An integer `id` earns
 * an `invalid_request` round trip, and a line over the ceiling earns silence -
 * so both are cheaper to catch at the call site that made them.
 */
export function encodeRequest(req: HerdrRequest): string {
  if (typeof req.id !== 'string' || req.id.length === 0) {
    throw new TypeError(`herdr request id must be a non-empty string, got ${typeof req.id}`);
  }
  const line = `${JSON.stringify(req)}\n`;
  const bytes = Buffer.byteLength(line, 'utf8');
  // `>=`, not `>`: the probe says 1 048 575 answers and 1 048 576 does NOT, so
  // the ceiling itself is the first refused size.
  if (bytes >= MAX_REQUEST_BYTES) {
    throw new RangeError(
      `herdr request is ${bytes} bytes, at or over the 1 MiB ceiling. There the server does not `
      + 'answer at all, so this would hang rather than fail.',
    );
  }
  return line;
}

/**
 * One response line.
 *
 * Never throws. A malformed line is a diagnosis to report - herdr closes the
 * connection on a malformed request and its serde message names the offending
 * field - and an exception through a route would lose that.
 *
 * The `id` on an error is blanked by the server, so it cannot be correlated and
 * is deliberately not read here.
 */
export function parseResponse(line: string): ParsedResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, error: { code: 'malformed_response', message: `could not parse: ${line}` } };
  }
  const body = parsed as { result?: unknown; error?: { code?: unknown; message?: unknown } };
  if (body?.error) {
    return {
      ok: false,
      error: {
        code: typeof body.error.code === 'string' ? body.error.code : 'unknown',
        message: typeof body.error.message === 'string' ? body.error.message : line,
      },
    };
  }
  if (body?.result && typeof body.result === 'object') {
    return { ok: true, result: body.result as Record<string, unknown> };
  }
  return { ok: false, error: { code: 'malformed_response', message: `no result or error in: ${line}` } };
}

/* ── reading one session ───────────────────────────────────────────────── */

/**
 * Send one line, read one line back.
 *
 * ASYNC, AND WITH A DEADLINE, because this runs on a single-threaded server. A
 * blocking read here stalls every other request, and silence is a real answer
 * from this protocol rather than an unlikely one: RPC is one-shot - the server
 * closes after a single response - so a reused connection never replies, and an
 * oversized line never replies either. Both present as nothing at all.
 */
export type HerdrTransport = (
  socketPath: string,
  line: string,
  signal: AbortSignal,
) => Promise<string>;

export const socketTransport: HerdrTransport = (socketPath, line, signal) =>
  new Promise<string>((resolve, reject) => {
    const socket = createConnection(socketPath);
    /*
     * DECODE ACROSS CHUNKS, NOT PER CHUNK. `chunk.toString('utf8')` on a buffer
     * that ends mid-character yields U+FFFD and the next chunk starts mid-
     * sequence - so a pane full of box-drawing characters comes back subtly
     * wrong with `truncated: false` and no error. Measured over 48 reads and
     * 160 chunk boundaries: four responses silently corrupted. setEncoding
     * holds the partial bytes back until the character completes.
     */
    socket.setEncoding('utf8');
    let buffer = '';
    let settled = false;

    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn();
    };

    signal.addEventListener('abort', () => done(() => reject(new Error('aborted'))), { once: true });
    socket.on('error', err => done(() => reject(err)));
    socket.on('connect', () => socket.write(line));
    socket.on('data', chunk => {
      buffer += chunk;
      // BYTES, not code units. After setEncoding the buffer is a string, and
      // `.length` counts UTF-16 units - box-drawing characters are three bytes
      // and one unit, so the cap fired at 40 MiB while announcing 8.
      if (Buffer.byteLength(buffer, 'utf8') > MAX_RESPONSE_BYTES) {
        done(() => reject(new Error(
          `herdr sent over ${MAX_RESPONSE_BYTES} bytes with no newline; refusing to buffer more`)));
        return;
      }
      const nl = buffer.indexOf('\n');
      // One response per connection, so the first line is the whole answer.
      if (nl >= 0) done(() => resolve(buffer.slice(0, nl)));
    });
    socket.on('close', () => done(() => {
      // Closed with no newline: herdr drops the connection on a malformed
      // request, and on an oversized one. Whatever arrived is the diagnosis.
      if (buffer) resolve(buffer);
      else reject(new Error('herdr closed the connection without answering'));
    }));
  });

/* ── reading a pane's content ──────────────────────────────────────────── */

/**
 * What to read out of a pane.
 *
 * `recent_unwrapped` re-joins soft-wrapped rows, which is how a URL longer than
 * the pane gets repaired. It is a no-op for Claude panes - Claude Code runs on
 * the alt screen and hard-wraps at the pane width, so there is nothing to
 * unwrap - and only differs on panes that accumulate scrollback, like shells.
 */
export type PaneSource = 'visible' | 'recent' | 'recent_unwrapped' | 'detection';

export interface ReadPaneOptions {
  readonly paneId: string;
  /** Kebab is accepted here and translated; the wire only takes snake_case. */
  readonly source?: PaneSource | 'recent-unwrapped';
  readonly lines?: number;
  readonly format?: 'text' | 'ansi';
}

export type PaneReadResult =
  | { readonly ok: true; readonly read: { text: string; truncated: boolean; revision?: number } }
  | { readonly ok: false; readonly error: HerdrError };

/**
 * One pane's content.
 *
 * THE SOURCE IS SNAKE_CASE ON THE WIRE and there is no forgiveness for the
 * other spelling: `recent-unwrapped` earns `invalid_request: unknown variant`.
 * A JS caller reaches for the hyphen, so the translation happens here once
 * rather than at every call site.
 */
export async function readPane(
  socketPath: string,
  opts: ReadPaneOptions,
  transport: HerdrTransport = socketTransport,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<PaneReadResult> {
  const source = (opts.source ?? 'visible').replace(/-/g, '_') as PaneSource;
  const params = {
    pane_id: opts.paneId,
    source,
    lines: opts.lines ?? 200,
    format: opts.format ?? 'text',
  };
  const line = await sendOne(socketPath, 'pane.read', params, transport, timeoutMs);
  if (!line.ok) return line;
  const parsed = parseResponse(line.line);
  if (!parsed.ok) return parsed;
  const read = (parsed.result as { read?: unknown }).read;
  if (!read || typeof read !== 'object') {
    return { ok: false, error: { code: 'malformed_response', message: 'no read in the result' } };
  }
  const r = read as { text?: unknown; truncated?: unknown; revision?: unknown };
  return {
    ok: true,
    read: {
      text: typeof r.text === 'string' ? r.text : '',
      // Absent reads as "not truncated" rather than as unknown: a caller
      // deciding whether to ask for more lines needs a boolean either way.
      truncated: r.truncated === true,
      revision: typeof r.revision === 'number' ? r.revision : undefined,
    },
  };
}

/* ── the event stream ──────────────────────────────────────────────────── */

/**
 * Every event herdr will subscribe you to, in the DOT form the subscription
 * takes. The frames come back in snake_case - two spellings of one name in one
 * protocol - which is why `parseStreamLine` reads `event` rather than matching
 * against this list.
 *
 * Quoted from the published catalog; the last four arrived in 0.7.2.
 */
export const EVENT_TYPES = [
  'workspace.created', 'workspace.updated', 'workspace.renamed', 'workspace.closed',
  'workspace.focused', 'workspace.moved',
  'worktree.created', 'worktree.opened', 'worktree.removed',
  'tab.created', 'tab.closed', 'tab.focused', 'tab.renamed', 'tab.moved',
  'pane.created', 'pane.closed', 'pane.focused', 'pane.moved', 'pane.exited',
  'pane.agent_detected', 'pane.output_matched', 'pane.agent_status_changed',
  'layout.updated', 'pane.scroll_changed',
] as const;

export type HerdrEventType = typeof EVENT_TYPES[number];

/**
 * The types that are scoped to ONE pane and are refused without a `pane_id`.
 *
 * Learned from the server, not from the document, and then counted: subscribing
 * to each of the 24 catalog types alone, 21 are accepted and exactly these three
 * answer `invalid_request: missing field \`pane_id\``. The first version of this
 * list held only `pane.agent_status_changed` - the one collie happens to use -
 * and the other two would have sailed past every local guard into a subscription
 * the server rejects whole.
 */
export const PANE_SCOPED_EVENT_TYPES: readonly string[] = [
  'pane.agent_status_changed',
  'pane.output_matched',
  'pane.scroll_changed',
];

/**
 * What to subscribe to when the caller has no opinion.
 *
 * DELIBERATELY SMALLER THAN THE CATALOG, and the reason is not the one first
 * written here. herdr rejects the ENTIRE subscribe over one unrecognised type,
 * so a list is only as safe as its least-supported member - but a probe of this
 * 0.7.5 shows `workspace.moved`, `tab.moved` and `layout.updated` are all
 * ACCEPTED, so version is not what excludes them here. Two things do:
 *
 *   • `pane.output_matched` and `pane.scroll_changed` are PANE-SCOPED and
 *     cannot appear in a global list at all.
 *   • the rest buy nothing a fleet listing renders, and every extra type is one
 *     more chance that an older server rejects the whole subscription.
 *
 * Callers that want a scoped type pass `{ type, pane_id }` explicitly.
 */
export const SAFE_EVENT_TYPES: readonly string[] = [
  'workspace.created', 'workspace.updated', 'workspace.renamed', 'workspace.closed',
  'workspace.focused',
  'tab.created', 'tab.closed', 'tab.focused', 'tab.renamed',
  'pane.created', 'pane.closed', 'pane.focused', 'pane.moved', 'pane.exited',
  'pane.agent_detected',
];

/** A subscription entry: global (just `type`) or pane-scoped (needs `pane_id`). */
export interface Subscription {
  readonly type: string;
  readonly pane_id?: string;
}

export interface HerdrEvent {
  /** snake_case, e.g. `pane_agent_status_changed`. NOT the subscription's spelling. */
  readonly event: string;
  readonly data: Record<string, unknown>;
}

export type StreamFrame =
  | { readonly kind: 'ack' }
  | { readonly kind: 'event'; readonly event: string; readonly data: Record<string, unknown> }
  /** The server refusing the subscription. NOT malformed - it is the server answering. */
  | { readonly kind: 'error'; readonly error: HerdrError }
  | { readonly kind: 'malformed'; readonly line: string };

/**
 * One line off the stream.
 *
 * THE ACK AND AN EVENT ARE SHAPED DIFFERENTLY, and that is the hazard worth
 * naming: the ack is `{id, result:{type:'subscription_started'}}` while an
 * event is `{event, data}` with neither id nor result. A reader that expects
 * `result` on every line drops every event and reports nothing wrong.
 *
 * Never throws. A stream that dies on one bad line takes the subscription with
 * it, and the next event would have been fine.
 */
export function parseStreamLine(line: string): StreamFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: 'malformed', line };
  }
  const body = parsed as { event?: unknown; data?: unknown; result?: unknown };
  if (typeof body?.event === 'string') {
    const data = body.data && typeof body.data === 'object' ? body.data as Record<string, unknown> : {};
    return { kind: 'event', event: body.event, data };
  }
  if (body?.result) return { kind: 'ack' };
  /*
   * A REJECTION IS NOT A MALFORMED LINE. herdr answers a refused subscribe with
   * `{"id":"","error":{...}}` and then says nothing more. Classing that as
   * garbage and dropping it is how "an open connection that never delivers"
   * becomes indistinguishable from a quiet herd - the exact outcome the rest of
   * this module is built to prevent.
   */
  const err = (body as { error?: { code?: unknown; message?: unknown } })?.error;
  if (err) {
    return {
      kind: 'error',
      error: {
        code: typeof err.code === 'string' ? err.code : 'unknown',
        message: typeof err.message === 'string' ? err.message : line,
      },
    };
  }
  return { kind: 'malformed', line };
}

/**
 * A stream transport: writes one line, then hands every line back as it arrives,
 * and says when it dies.
 *
 * `onClose` is not decoration. Without it a stream that ends - herdr restarted,
 * upgraded, crashed - leaves the caller holding a handle that looks alive while
 * nothing arrives ever again. A fleet panel frozen on its last state, with no
 * error anywhere, is indistinguishable from a quiet herd.
 */
export type HerdrStreamTransport = (
  socketPath: string,
  line: string,
  onLine: (line: string) => void,
  onClose: (why: string) => void,
) => Promise<{ close: () => void }>;

export const socketStreamTransport: HerdrStreamTransport = (socketPath, line, onLine, onClose) =>
  new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    // Same cross-chunk decoding as the one-shot transport, for the same reason.
    socket.setEncoding('utf8');
    let buffer = '';
    let opened = false;
    let shut = false;

    /** Every death funnels here, so the caller hears about it exactly once. */
    const died = (why: string): void => {
      if (shut) return;
      shut = true;
      socket.destroy();
      // Before `connect` there is no caller yet, so a failure is a rejection;
      // after it, the caller holds a handle and must be TOLD rather than left.
      if (opened) onClose(why); else reject(new Error(why));
    };

    socket.on('error', err => died(err.message));
    socket.on('close', () => died('herdr closed the event stream'));
    socket.on('connect', () => {
      socket.write(line);
      opened = true;
      resolve({ close: () => { shut = true; socket.destroy(); } });
    });
    socket.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_RESPONSE_BYTES) {
        died(`herdr sent over ${MAX_RESPONSE_BYTES} bytes with no newline`);
        return;
      }
      // Frames are newline-delimited and a chunk can hold part of one, so the
      // tail stays in the buffer until its newline arrives.
      for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        const one = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (one) onLine(one);
      }
    });
  });

/**
 * Subscribe to herdr's events. The one call that keeps its connection open.
 *
 * TWO REFUSALS BEFORE THE SOCKET, because both failures are silent on the far
 * side. An empty subscription list is ACKED and then never speaks - an open
 * connection that will never deliver looks exactly like one that works. And a
 * type spelled in snake_case subscribes to nothing at all, for the same
 * invisible outcome.
 */
export interface SubscribeOptions {
  /** Called when the stream dies or the server refuses it. Silence otherwise. */
  readonly onDown?: (why: HerdrError) => void;
  readonly transport?: HerdrStreamTransport;
}

export async function subscribeEvents(
  socketPath: string,
  wanted: readonly (string | Subscription)[],
  onEvent: (e: HerdrEvent) => void,
  opts: SubscribeOptions | HerdrStreamTransport = {},
): Promise<{ close: () => void }> {
  // A bare transport is still accepted: it was the shape before onDown existed.
  const o: SubscribeOptions = typeof opts === 'function' ? { transport: opts } : opts;
  const transport = o.transport ?? socketStreamTransport;
  const downRaw = o.onDown ?? ((): void => {});
  const subs: Subscription[] = wanted.map(w => (typeof w === 'string' ? { type: w } : w));

  if (subs.length === 0) {
    throw new RangeError(
      'herdr acks an empty subscription list and then never sends an event. Subscribe to at '
      + 'least one type, or do not open the connection.',
    );
  }
  const unknown = subs.filter(s => !(EVENT_TYPES as readonly string[]).includes(s.type));
  if (unknown.length > 0) {
    throw new RangeError(
      `not in herdr's event catalog: ${unknown.map(u => u.type).join(', ')}. Subscription types `
      + 'are dot-form (pane.agent_status_changed); the snake_case spelling is what comes BACK, '
      + 'not what goes out. And ONE unknown type rejects the whole subscribe.',
    );
  }
  const unscoped = subs.filter(s => PANE_SCOPED_EVENT_TYPES.includes(s.type) && !s.pane_id);
  if (unscoped.length > 0) {
    throw new RangeError(
      `${unscoped.map(u => u.type).join(', ')} is scoped to one pane and herdr answers `
      + '`invalid_request: missing field pane_id` without it - rejecting the WHOLE subscribe. '
      + 'Pass { type, pane_id } once per pane you care about.',
    );
  }

  requestCounter += 1;
  const line = encodeRequest({
    id: `agenfk-sub-${requestCounter}`,
    method: 'events.subscribe',
    params: { subscriptions: subs },
  });

  // herdr answers a refused subscribe and THEN closes, so without this the
  // caller hears about one rejection twice - once as the refusal and once as
  // the close - and anything that tears down or retries on `onDown` does it
  // twice. Measured: ["invalid_request", "stream_closed"].
  let toldOnce = false;
  const down = (e: HerdrError): void => { if (toldOnce) return; toldOnce = true; downRaw(e); };

  return transport(socketPath, line, raw => {
    const frame = parseStreamLine(raw);
    if (frame.kind === 'error') { down(frame.error); return; }
    if (frame.kind === 'malformed') {
      down({ code: 'malformed_frame', message: `could not parse: ${frame.line}` });
      return;
    }
    // The ack is not proof of anything the caller lacks; the resolve happens at
    // TCP connect, BEFORE any byte arrives, so it is `onDown` that carries news.
    if (frame.kind !== 'event') return;
    /*
     * A CONSUMER BUG MUST NOT TAKE THE SERVER WITH IT. This runs synchronously
     * inside the socket's data handler, so a throw here is an uncaught exception
     * on a single-threaded server - process death, not a lost event.
     */
    try {
      onEvent({ event: frame.event, data: frame.data });
    } catch (err) {
      down({ code: 'consumer_threw', message: (err as Error).message });
    }
  }, why => down({ code: 'stream_closed', message: why }));
}

/** One request, one response, with the deadline every call on this server needs. */
async function sendOne(
  socketPath: string,
  method: string,
  params: Record<string, unknown>,
  transport: HerdrTransport,
  timeoutMs: number,
): Promise<{ ok: true; line: string } | { ok: false; error: HerdrError }> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  try {
    requestCounter += 1;
    const line = await transport(
      socketPath,
      encodeRequest({ id: `agenfk-${requestCounter}`, method, params }),
      controller.signal,
    );
    return { ok: true, line };
  } catch (err) {
    return controller.signal.aborted
      ? { ok: false, error: { code: 'timeout', message: `herdr at ${socketPath} did not answer within ${timeoutMs}ms` } }
      : { ok: false, error: { code: 'unreachable', message: `herdr at ${socketPath} could not be reached: ${(err as Error).message}` } };
  } finally {
    clearTimeout(deadline);
  }
}

/**
 * The whole session in one round trip.
 *
 * `session.snapshot` answers with workspaces, tabs, panes, agents and layouts
 * together, so a listing needs one request rather than one per kind.
 */
export async function readSnapshot(
  socketPath: string,
  transport: HerdrTransport = socketTransport,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<SnapshotResult> {
  const sent = await sendOne(socketPath, 'session.snapshot', {}, transport, timeoutMs);
  if (!sent.ok) return sent;

  const parsed = parseResponse(sent.line);
  if (!parsed.ok) return parsed;

  const snapshot = (parsed.result as { snapshot?: unknown }).snapshot;
  if (!snapshot || typeof snapshot !== 'object') {
    return { ok: false, error: { code: 'malformed_response', message: 'no snapshot in the result' } };
  }
  const s = snapshot as Record<string, unknown>;
  // Every list is read as a list or as empty. A herdr that answers a shape we
  // did not expect must not take a route down with it.
  const list = <T>(k: string): T[] => (Array.isArray(s[k]) ? s[k] : []) as T[];
  return {
    ok: true,
    snapshot: {
      ...s,
      workspaces: list<Record<string, unknown>>('workspaces'),
      tabs: list<Record<string, unknown>>('tabs'),
      panes: list<HerdrPane>('panes'),
      agents: list<HerdrPane>('agents'),
    },
  };
}
