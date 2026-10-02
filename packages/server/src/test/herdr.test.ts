/**
 * The herdr adapter: finding sessions that are already open, and reading one
 * (dafbb59e / CGLAB-266).
 *
 * Nothing in this file touches a real filesystem or a real socket. Discovery
 * takes its two filesystem questions as arguments and the transport is
 * injected, which is what lets the protocol's sharp edges be exercised at all:
 * a server that never answers, a response that is an error, and a request one
 * byte over the ceiling are all trivial to stage and impossible to stage
 * reliably against a live herdr.
 *
 * The protocol facts pinned here come from two independent sources, not from
 * guessing: collie's HERDR_API.md (MIT, reverse-engineered and verified against
 * herdr protocol 16 and 20) and a read-only probe of herdr 0.7.5 on this
 * machine, which answered `session.snapshot` with 12 workspaces, 48 panes and
 * 42 agents.
 */
import { describe, it, expect } from 'vitest';
import {
  deriveConfigRoot,
  discoverSessionSockets,
  herdrConfigRoot,
  encodeRequest,
  parseResponse,
  parseStreamLine,
  readSnapshot,
  readPane,
  subscribeEvents,
  EVENT_TYPES,
  SAFE_EVENT_TYPES,
  MAX_REQUEST_BYTES,
  HERDR_SOCKET_FILE,
} from '../herdr';

/* ── where the sockets are ─────────────────────────────────────────────── */

describe('finding the config root', () => {
  it('honours HERDR_SOCKET_PATH, because herdr itself injects it', () => {
    /*
     * A process launched inside a herdr pane is handed HERDR_SOCKET_PATH,
     * HERDR_WORKSPACE_ID, HERDR_TAB_ID and HERDR_PANE_ID. Ignoring the first
     * would make us scan the default location while running inside a session
     * that lives somewhere else entirely.
     */
    expect(herdrConfigRoot({ HERDR_SOCKET_PATH: '/run/h/herdr.sock' }, '/home/x'))
      .toBe('/run/h');
  });

  it('falls back to ~/.config/herdr when the variable is absent', () => {
    expect(herdrConfigRoot({}, '/home/x')).toBe('/home/x/.config/herdr');
  });

  it('treats an empty variable as absent rather than as the root "/"', () => {
    // `HERDR_SOCKET_PATH=` in a shell profile is set-but-empty, and dirname('')
    // is '.', which would make discovery scan the process's cwd.
    expect(herdrConfigRoot({ HERDR_SOCKET_PATH: '   ' }, '/home/x')).toBe('/home/x/.config/herdr');
  });
});

describe('deriving the config root from a socket path', () => {
  it('reads a named session back to the root that holds it', () => {
    // <root>/sessions/<name>/herdr.sock  ->  <root>
    expect(deriveConfigRoot('/home/x/.config/herdr/sessions/work/herdr.sock'))
      .toBe('/home/x/.config/herdr');
  });

  it('reads the default session as its own directory', () => {
    expect(deriveConfigRoot('/home/x/.config/herdr/herdr.sock')).toBe('/home/x/.config/herdr');
  });

  it('does not mistake a directory merely CALLED sessions further up', () => {
    // Only the segment directly above the session name counts. A path like
    // <root>/sessions/a/b/herdr.sock is not a session layout.
    expect(deriveConfigRoot('/srv/sessions/a/b/herdr.sock')).toBe('/srv/sessions/a/b');
  });
});

describe('discovering which sessions are live', () => {
  const root = '/cfg/herdr';
  const sock = (...p: string[]): string => [root, ...p].join('/');

  it('finds the default session', () => {
    const found = discoverSessionSockets(root, () => [], p => p === sock(HERDR_SOCKET_FILE));
    expect(found).toEqual([{ name: 'default', socketPath: sock('herdr.sock') }]);
  });

  it('finds named sessions alongside it', () => {
    const live = new Set([sock('herdr.sock'), sock('sessions/work/herdr.sock')]);
    const found = discoverSessionSockets(root, () => ['work', 'stale'], p => live.has(p));
    expect(found.map(f => f.name)).toEqual(['default', 'work']);
  });

  it('SKIPS a named session whose socket is gone, because that is the liveness signal', () => {
    /*
     * THE herdr FACT THIS WHOLE MODULE LEANS ON: a cleanly stopped session
     * removes its socket. So a directory under sessions/ with no socket in it
     * is a session that ENDED, not one we failed to reach. This is not general
     * - tmux keeps its socket file after `kill-server` - which is exactly why
     * this lives in a herdr-specific module.
     */
    const found = discoverSessionSockets(root, () => ['ended'], () => false);
    expect(found).toEqual([]);
  });

  it('treats a missing sessions directory as the common case, not an error', () => {
    // One session and nothing named is what most installs look like.
    const listDirs = (): string[] => { throw new Error('ENOENT'); };
    expect(() => discoverSessionSockets(root, listDirs, p => p === sock('herdr.sock'))).not.toThrow();
  });

  it('answers empty when herdr is not running at all', () => {
    // Not an error. The setting that turns this on is meant to be harmless on a
    // machine that has never installed herdr, and "nothing found" is the answer
    // that lets the screen say so instead of showing a failure.
    expect(discoverSessionSockets(root, () => [], () => false)).toEqual([]);
  });

  it('never lets a session NAME escape the root it was found under', () => {
    /*
     * Names come from a directory listing of a trusted root, and the only thing
     * this module does with one is join it back under that same root. A name
     * like '../../..' - however it got on disk - must not walk out. `join` does
     * NOT give that for free: it resolves the `..` and leaves the tree.
     *
     * The property is containment in the CONFIG ROOT, not in `sessions/`: the
     * default session's socket sits directly in the root and is not a traversal.
     * Asserting the narrower thing failed on the legitimate row, which is how
     * this comment came to exist.
     */
    const found = discoverSessionSockets(root, () => ['../../../etc'], () => true);
    for (const f of found) expect(f.socketPath.startsWith(`${root}/`), f.socketPath).toBe(true);
    // And specifically: the traversal produced no row at all.
    expect(found.map(f => f.name)).toEqual(['default']);
  });
});

/* ── the wire ──────────────────────────────────────────────────────────── */

describe('encoding a request', () => {
  it('is one line of JSON, newline-terminated', () => {
    const line = encodeRequest({ id: 'probe-1', method: 'session.snapshot', params: {} });
    expect(line.endsWith('\n')).toBe(true);
    expect(line.indexOf('\n')).toBe(line.length - 1);
    expect(JSON.parse(line)).toEqual({ id: 'probe-1', method: 'session.snapshot', params: {} });
  });

  it('REFUSES a non-string id here, rather than learning it from the server', () => {
    // herdr answers `invalid_request` for an integer id. Catching it locally
    // turns a round trip and an opaque error code into a thrown mistake at the
    // call site that made it.
    expect(() => encodeRequest({ id: 7 as unknown as string, method: 'x', params: {} })).toThrow(/id/i);
  });

  it('refuses a line over the 1 MiB ceiling BEFORE sending it', () => {
    /*
     * Live-probed by collie against herdr 0.7.5: 1 048 575 bytes still gets a
     * normal reply, 1 048 576 gets NO reply at all - the server drops the
     * connection or never answers. So the failure mode for going over is a
     * hang, and a hang is worth trading for a thrown error.
     */
    const huge = 'x'.repeat(MAX_REQUEST_BYTES);
    expect(() => encodeRequest({ id: 'a', method: 'pane.send_text', params: { text: huge } }))
      .toThrow(/1 MiB|too large|ceiling/i);
  });
});

describe('parsing a response', () => {
  it('returns the result of a success', () => {
    const r = parseResponse('{"id":"a","result":{"type":"session_snapshot","snapshot":{"panes":[]}}}');
    expect(r.ok).toBe(true);
    expect(r.ok && r.result.type).toBe('session_snapshot');
  });

  it('surfaces an error response as an error, not as a crash', () => {
    // herdr answers `{"id":"","error":{"code","message"}}` - note the id is
    // blanked, so it cannot be correlated and must not be relied on.
    const r = parseResponse('{"id":"","error":{"code":"pane_not_found","message":"no such pane"}}');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe('pane_not_found');
  });

  it('treats a malformed line as a failure with the line quoted, not a throw', () => {
    // A malformed request makes herdr close the connection, and the serde error
    // names the offending field. Whatever comes back, a parse failure here is a
    // diagnosis to report, never an exception through the route.
    const r = parseResponse('not json at all');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.message).toMatch(/not json at all/);
  });
});

/* ── reading one session ───────────────────────────────────────────────── */

/** A transport that answers with `reply`, or never answers when it is null. */
function fakeTransport(reply: string | null): Parameters<typeof readSnapshot>[1] {
  return async (_path, _line, signal) => {
    if (reply !== null) return reply;
    return new Promise<string>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  };
}

describe('reading a snapshot', () => {
  const SNAP = JSON.stringify({
    id: 'x',
    result: {
      type: 'session_snapshot',
      snapshot: {
        protocol: 20,
        workspaces: [{ id: 'w1' }],
        tabs: [{ id: 'w1:t1' }],
        panes: [{ id: 'w1:p1', cwd: '/repo', agent: 'claude' }],
        agents: [{ pane_id: 'w1:p1' }],
        focused_pane_id: 'w1:p1',
      },
    },
  });

  it('returns the panes, with the cwd and agent the probe actually saw', async () => {
    const r = await readSnapshot('/cfg/herdr/herdr.sock', fakeTransport(SNAP), 5_000);
    expect(r.ok).toBe(true);
    expect(r.ok && r.snapshot.panes[0]).toMatchObject({ cwd: '/repo', agent: 'claude' });
  });

  it('gives up on a server that never answers, instead of hanging the event loop', async () => {
    /*
     * THE FAILURE MODE THAT COSTS AN HOUR. RPC is one-shot: herdr closes the
     * connection after a single response, so a second request on the same
     * connection never replies - and an oversized line does not reply either.
     * Both present as silence, not as an error. Without a timeout, a route on
     * this single-threaded server waits forever.
     */
    const r = await readSnapshot('/cfg/herdr/herdr.sock', fakeTransport(null), 20);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe('timeout');
  });

  it('reports an unreachable socket as unreachable, not as an empty session', async () => {
    // A socket that is gone means the session ended. Answering "no panes" would
    // read as a live, idle herdr - the opposite of the truth.
    const r = await readSnapshot('/gone.sock', async () => { throw new Error('ENOENT'); }, 50);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe('unreachable');
  });

  it('sends a string id and the snapshot method, and nothing else', async () => {
    let sent = '';
    await readSnapshot('/s.sock', async (_p, line) => { sent = line; return SNAP; }, 5_000);
    const req = JSON.parse(sent);
    expect(typeof req.id).toBe('string');
    expect(req.method).toBe('session.snapshot');
    expect(req.params).toEqual({});
  });
});

/* ── reading a pane's content ──────────────────────────────────────────── */

describe('pane.read', () => {
  const READ = JSON.stringify({
    id: 'x',
    result: { type: 'pane_read', read: { text: 'two\nlines', truncated: false, revision: 9 } },
  });

  it('asks with the params herdr actually accepts', async () => {
    let sent = '';
    await readPane('/s.sock', { paneId: 'w1:p1', lines: 50 },
      async (_p, line) => { sent = line; return READ; }, 5_000);
    expect(JSON.parse(sent)).toMatchObject({
      method: 'pane.read',
      params: { pane_id: 'w1:p1', source: 'visible', lines: 50, format: 'text' },
    });
  });

  it('sends the source in SNAKE_CASE, because the hyphen is rejected on the wire', async () => {
    /*
     * `recent-unwrapped` answers `invalid_request: unknown variant` - live
     * probed against 0.7.5, and the variant list herdr accepts was quoted back
     * out of that very error. The kebab spelling is the one a JS caller reaches
     * for, so the translation has to happen here rather than in every call.
     */
    let sent = '';
    await readPane('/s.sock', { paneId: 'p', source: 'recent-unwrapped' },
      async (_p, line) => { sent = line; return READ; }, 5_000);
    expect(JSON.parse(sent).params.source).toBe('recent_unwrapped');
  });

  it('returns the text, and says when it was truncated', async () => {
    const r = await readPane('/s.sock', { paneId: 'p' }, async () => READ, 5_000);
    expect(r.ok && r.read).toMatchObject({ text: 'two\nlines', truncated: false, revision: 9 });
  });

  it('surfaces pane_not_found as an error rather than as empty text', async () => {
    // Empty text would read as a live, blank pane. A pane that is gone is a
    // different fact and the caller has to be able to tell them apart.
    const gone = JSON.stringify({ id: '', error: { code: 'pane_not_found', message: 'no such pane' } });
    const r = await readPane('/s.sock', { paneId: 'nope' }, async () => gone, 5_000);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe('pane_not_found');
  });
});

/* ── the event stream ──────────────────────────────────────────────────── */

describe('telling an ack from an event', () => {
  it('reads the ack, which carries a result and an id', () => {
    const f = parseStreamLine('{"id":"a","result":{"type":"subscription_started"}}');
    expect(f.kind).toBe('ack');
  });

  it('reads an event, which carries NEITHER id nor result', () => {
    /*
     * The two frames are shaped differently and that is the whole hazard: a
     * reader that expects `result` on every line drops every event silently.
     * Real line, quoted from the reverse-engineered contract.
     */
    const line = '{"data":{"pane_id":"w6:p3","type":"pane_agent_detected","workspace_id":"w6"},"event":"pane_agent_detected"}';
    const f = parseStreamLine(line);
    expect(f.kind).toBe('event');
    expect(f.kind === 'event' && f.event).toBe('pane_agent_detected');
    expect(f.kind === 'event' && f.data.pane_id).toBe('w6:p3');
  });

  it('reports a malformed line instead of throwing mid-stream', () => {
    // A stream that dies on one bad line takes the whole subscription with it.
    expect(parseStreamLine('{oops').kind).toBe('malformed');
  });
});

describe('subscribing', () => {
  it('subscribes in DOT form, even though the frames come back in snake_case', async () => {
    /*
     * Two spellings of the same name in one protocol: `pane.created` going out,
     * `pane_created` coming back. Sending the snake form subscribes to nothing,
     * and nothing is exactly what a silent failure looks like here - an open
     * connection that never delivers.
     */
    let sent = '';
    await subscribeEvents('/s.sock', ['pane.created'], () => {},
      async (_p, line) => { sent = line; return { close: () => {} }; });
    expect(JSON.parse(sent).params.subscriptions).toEqual([{ type: 'pane.created' }]);
  });

  it('REFUSES a pane-scoped type with no pane_id, which is what the live server taught', async () => {
    /*
     * MEASURED, NOT READ. Subscribing to the whole catalog with bare `{type}`
     * entries earned exactly one line back and then silence:
     *
     *   {"id":"","error":{"code":"invalid_request",
     *    "message":"invalid request: missing field `pane_id` at line 1 column 709"}}
     *
     * `pane.agent_status_changed` is scoped to ONE pane - collie subscribes to
     * it once per agent pane. Sent bare, the whole subscribe is rejected, and
     * the caller is left holding a connection that will never deliver anything.
     */
    await expect(
      subscribeEvents('/s.sock', ['pane.agent_status_changed'], () => {},
        async () => ({ close: () => {} })),
    ).rejects.toThrow(/pane_id/i);
  });

  it('carries the pane_id when the caller scopes one', async () => {
    let sent = '';
    await subscribeEvents('/s.sock', [{ type: 'pane.agent_status_changed', pane_id: 'w2:p1' }],
      () => {}, async (_p, line) => { sent = line; return { close: () => {} }; });
    expect(JSON.parse(sent).params.subscriptions)
      .toEqual([{ type: 'pane.agent_status_changed', pane_id: 'w2:p1' }]);
  });

  it('the safe default set leaves out the 0.7.2 additions, because ONE unknown type kills it all', () => {
    /*
     * herdr rejects the ENTIRE subscribe over a single unrecognised type. So a
     * list that includes `workspace.moved`, `tab.moved`, `layout.updated` or
     * `pane.scroll_changed` keeps the stream permanently down on any server
     * older than 0.7.2 - and down silently, since the failure is one error line
     * on a connection that then says nothing. They are not worth that: none of
     * them changes what a fleet listing renders.
     */
    for (const late of ['workspace.moved', 'tab.moved', 'layout.updated', 'pane.scroll_changed']) {
      expect(EVENT_TYPES, late).toContain(late);          // the catalog knows them
      expect(SAFE_EVENT_TYPES, late).not.toContain(late); // the default does not use them
    }
    expect(SAFE_EVENT_TYPES).toContain('pane.created');
    expect(SAFE_EVENT_TYPES).toContain('pane.agent_detected');
  });

  it('REFUSES an empty subscription list, because herdr acks it and then never speaks', async () => {
    // `subscriptions: []` gets an ack and no events, ever. An open socket that
    // will never deliver is worse than an error: it looks like it worked.
    await expect(subscribeEvents('/s.sock', [], () => {}, async () => ({ close: () => {} })))
      .rejects.toThrow(/empty|at least one/i);
  });

  it('refuses a type that is not in herdr\'s catalog', async () => {
    await expect(
      subscribeEvents('/s.sock', ['pane.exploded'], () => {}, async () => ({ close: () => {} })),
    ).rejects.toThrow(/pane\.exploded/);
  });

  it('carries the catalog herdr publishes, including the 0.7.2 additions', () => {
    for (const t of ['pane.created', 'pane.closed', 'pane.exited', 'pane.agent_detected',
      'pane.agent_status_changed', 'workspace.created', 'tab.renamed',
      'layout.updated', 'pane.scroll_changed', 'worktree.created']) {
      expect(EVENT_TYPES, t).toContain(t);
    }
  });

  it('delivers events to the callback and swallows the ack', async () => {
    const seen: string[] = [];
    let feed: (line: string) => void = () => {};
    await subscribeEvents('/s.sock', ['pane.created'], e => seen.push(e.event),
      async (_p, _line, onLine) => { feed = onLine; return { close: () => {} }; });
    feed('{"id":"a","result":{"type":"subscription_started"}}');
    feed('{"event":"pane_created","data":{"pane_id":"w1:p2"}}');
    expect(seen).toEqual(['pane_created']);
  });

  it('keeps delivering after a malformed line', async () => {
    const seen: string[] = [];
    let feed: (line: string) => void = () => {};
    await subscribeEvents('/s.sock', ['pane.created'], e => seen.push(e.event),
      async (_p, _line, onLine) => { feed = onLine; return { close: () => {} }; });
    feed('{oops');
    feed('{"event":"pane_closed","data":{}}');
    expect(seen).toEqual(['pane_closed']);
  });
});

/* ── the real transports, against real unix sockets ────────────────────── */

/*
 * THE THREE BLOCKERS OF THE FIRST REVIEW ALL LIVED HERE, and none of the tests
 * above could see them: every one injects a fake transport, so the two functions
 * that actually touch a socket had zero coverage. These use a real server on a
 * real unix socket, which is the only way to stage a chunk boundary, a mid-
 * stream death, or a server that refuses.
 */
import { createServer, type Server } from 'net';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach } from 'vitest';
import { socketTransport, socketStreamTransport, MAX_RESPONSE_BYTES } from '../herdr';

const openServers: Server[] = [];
let sockDir: string | null = null;

afterEach(() => {
  // `server.close()` only stops ACCEPTING; live connections outlive it, and the
  // socket directory was being removed out from under them.
  for (const c of openSockets.splice(0)) c.destroy();
  for (const s of openServers.splice(0)) s.close();
  if (sockDir) { rmSync(sockDir, { recursive: true, force: true }); sockDir = null; }
});

/** A unix socket server that runs `behave` on each connection. Cleaned up after. */
const openSockets: import('net').Socket[] = [];

async function serve(behave: (c: import('net').Socket) => void): Promise<string> {
  sockDir ??= mkdtempSync(join(tmpdir(), 'herdr-test-'));
  const p = join(sockDir, `s${openServers.length}.sock`);
  const server = createServer(c => {
    /*
     * WITHOUT THIS THE WHOLE SUITE EXITS 1 WHILE REPORTING 51 PASSED. When the
     * client hits the response cap it destroys its end; a write already queued
     * on this side then completes with EPIPE, and a socket with no `error`
     * listener turns that into an uncaught exception. vitest counts every test
     * as passing, prints one unhandled error, and returns a failing code - and
     * it blames whichever test happened to be running.
     */
    c.on('error', () => { /* the client hanging up is the point of these tests */ });
    openSockets.push(c);
    behave(c);
  });
  openServers.push(server);
  await new Promise<void>(r => server.listen(p, r));
  return p;
}

describe('the real one-shot transport', () => {
  it('does NOT corrupt a character split across chunks', async () => {
    /*
     * THE FIRST BLOCKER. `chunk.toString('utf8')` decodes each chunk alone, so a
     * three-byte box-drawing character landing on a chunk boundary becomes
     * U+FFFD - and the JSON still parses, so nothing fails. Measured against the
     * live herdr: 48 reads, 160 boundaries, four responses silently corrupted.
     *
     * Staged here by writing the two halves of one character separately.
     */
    const text = '─│█─────';
    const payload = `${JSON.stringify({ id: 'a', result: { type: 'pane_read', read: { text } } })}\n`;
    const bytes = Buffer.from(payload, 'utf8');
    const cut = bytes.indexOf(Buffer.from('│', 'utf8')) + 1; // mid-character
    const p = await serve(c => {
      c.on('data', () => {
        c.write(bytes.subarray(0, cut));
        setTimeout(() => c.end(bytes.subarray(cut)), 5);
      });
    });
    const line = await socketTransport(p, 'x\n', new AbortController().signal);
    expect(JSON.parse(line).result.read.text).toBe(text);
    expect(line).not.toContain('�');
  });

  it('refuses to buffer a response past the cap instead of eating memory', async () => {
    // No newline ever arrives, so without a cap this grows until V8 throws
    // INSIDE the data handler - uncaught, on a single-threaded server. Measured
    // before the cap: RSS 50MB -> 150MB in three seconds.
    const p = await serve(c => {
      c.on('data', () => {
        // BOUNDED on purpose. An unbounded pump starves the event loop so hard
        // that the test runner itself stops reporting - which is its own small
        // lesson about synchronous work on a single-threaded server.
        const chunk = 'x'.repeat(1 << 20);
        let sent = 0;
        const pump = (): void => {
          if (c.destroyed || sent > MAX_RESPONSE_BYTES + (2 << 20)) return;
          c.write(chunk);
          sent += chunk.length;
          setTimeout(pump, 1);
        };
        pump();
      });
    });
    await expect(socketTransport(p, 'x\n', new AbortController().signal))
      .rejects.toThrow(new RegExp(String(MAX_RESPONSE_BYTES)));
  });

  it('reports a socket that is not there', async () => {
    sockDir ??= mkdtempSync(join(tmpdir(), 'herdr-test-'));
    await expect(socketTransport(join(sockDir, 'nope.sock'), 'x\n', new AbortController().signal))
      .rejects.toThrow();
  });
});

describe('the real stream transport', () => {
  it('TELLS the caller when the stream dies, instead of looking alive', async () => {
    /*
     * THE THIRD BLOCKER. herdr restarts - upgrade, crash - and the old code left
     * the caller holding a handle that never delivers again and never says why.
     * A fleet panel frozen on its last state is indistinguishable from a quiet
     * herd.
     */
    const p = await serve(c => { c.on('data', () => setTimeout(() => c.destroy(), 10)); });
    const why = await new Promise<string>(async resolve => {
      await socketStreamTransport(p, 'x\n', () => {}, resolve);
    });
    expect(why).toMatch(/clos|reset|EPIPE|ECONN/i);
  });

  it('surfaces a REFUSED subscription, which is an answer and not garbage', async () => {
    // herdr answers a rejected subscribe with {"id":"","error":{...}} and then
    // says nothing. Dropping that line is how a dead subscription passes for a
    // quiet one.
    const p = await serve(c => {
      c.on('data', () => c.write('{"id":"","error":{"code":"invalid_request","message":"missing field `pane_id`"}}\n'));
    });
    const seen: HerdrErrorLike[] = [];
    await subscribeEvents(p, ['pane.created'], () => {}, { onDown: e => seen.push(e) });
    await new Promise(r => setTimeout(r, 60));
    expect(seen.map(e => e.code)).toContain('invalid_request');
  });

  it('does not let a throwing consumer take the process down', async () => {
    // onEvent runs synchronously inside the socket's data handler: a throw there
    // is an uncaught exception, which on this server is process death.
    const p = await serve(c => {
      c.on('data', () => c.write('{"event":"pane_created","data":{}}\n'));
    });
    const seen: HerdrErrorLike[] = [];
    await subscribeEvents(p, ['pane.created'], () => { throw new Error('consumer bug'); },
      { onDown: e => seen.push(e) });
    await new Promise(r => setTimeout(r, 60));
    expect(seen.map(e => e.code)).toContain('consumer_threw');
  });

  it('delivers a frame split MID-CHARACTER, not merely mid-token', async () => {
    /*
     * The first version of this cut between `pane_cre` and `ated` - an ASCII
     * boundary, which reassembles with or without `setEncoding`. It proved the
     * fix existed and not that it worked, and a mutation removing setEncoding
     * from this transport survived it. The cut here lands inside a three-byte
     * character, which is the case that actually breaks.
     */
    const title = '─│█ done';
    const frame = `${JSON.stringify({ event: 'pane_created', data: { title } })}\n`;
    const bytes = Buffer.from(frame, 'utf8');
    const cut = bytes.indexOf(Buffer.from('│', 'utf8')) + 1;
    const p = await serve(c => {
      c.on('data', () => {
        c.write(bytes.subarray(0, cut));
        setTimeout(() => c.write(bytes.subarray(cut)), 5);
      });
    });
    const seen: { event: string; data: Record<string, unknown> }[] = [];
    const conn = await subscribeEvents(p, ['pane.created'], e => seen.push(e), {});
    await new Promise(r => setTimeout(r, 80));
    conn.close();
    expect(seen).toHaveLength(1);
    expect(seen[0].data.title, 'the character must survive the boundary').toBe(title);
  });

  it('caps the stream buffer too, and counts BYTES', async () => {
    // The one-shot transport had this test; the stream one did not, and a
    // mutation removing its cap survived.
    const p = await serve(c => {
      c.on('data', () => {
        const chunk = 'x'.repeat(1 << 20);
        let sent = 0;
        const pump = (): void => {
          if (c.destroyed || sent > MAX_RESPONSE_BYTES + (2 << 20)) return;
          c.write(chunk); sent += chunk.length; setTimeout(pump, 1);
        };
        pump();
      });
    });
    const why = await new Promise<HerdrErrorLike>(resolve => {
      void subscribeEvents(p, ['pane.created'], () => {}, { onDown: resolve });
    });
    expect(why.message).toMatch(new RegExp(String(MAX_RESPONSE_BYTES)));
  });

  it('says a refusal ONCE, though herdr refuses and then closes', async () => {
    // Measured before the fix: ["invalid_request", "stream_closed"]. A caller
    // that tears down or retries on onDown did it twice.
    const p = await serve(c => {
      c.on('data', () => {
        c.write('{"id":"","error":{"code":"invalid_request","message":"missing field `pane_id`"}}\n');
        setTimeout(() => c.destroy(), 10);
      });
    });
    const seen: HerdrErrorLike[] = [];
    await subscribeEvents(p, ['pane.created'], () => {}, { onDown: e => seen.push(e) });
    await new Promise(r => setTimeout(r, 90));
    expect(seen.map(e => e.code)).toEqual(['invalid_request']);
  });
});

type HerdrErrorLike = { code: string; message: string };

/* ── what the first round of tests could not kill ──────────────────────── */

describe('guards the first review proved were untested', () => {
  it('refuses a SIBLING-PREFIX escape, not just an obvious traversal', () => {
    /*
     * The earlier containment test used only '../../../etc', which a guard
     * missing its path separator ALSO rejects - so it could not tell the correct
     * guard from the vulnerable one. `../sessions-evil` is the pair that does.
     */
    const root = '/cfg/herdr';
    for (const hostile of ['../sessions-evil', '..', '../../../etc', '.']) {
      const found = discoverSessionSockets(root, () => [hostile], () => true);
      expect(found.map(f => f.name), hostile).toEqual(['default']);
    }
  });

  it('says when a read WAS truncated, which nothing asserted before', async () => {
    const line = JSON.stringify({ id: 'x', result: { type: 'pane_read', read: { text: 'a', truncated: true } } });
    const r = await readPane('/s.sock', { paneId: 'p' }, async () => line, 5_000);
    expect(r.ok && r.read.truncated).toBe(true);
  });

  it('survives a snapshot whose lists are not lists', async () => {
    // The defensive `Array.isArray` had no test, so removing it changed nothing.
    const line = JSON.stringify({ id: 'x', result: { type: 'session_snapshot', snapshot: { panes: 'not a list' } } });
    const r = await readSnapshot('/s.sock', async () => line, 5_000);
    expect(r.ok && r.snapshot.panes).toEqual([]);
  });

  it('refuses a line of EXACTLY the ceiling, which is the first unanswered size', () => {
    // 1 048 575 answers; 1 048 576 does not. `>` let the ceiling itself through.
    // Measure the envelope once and solve for the payload, rather than walking
    // a byte at a time: each probe stringifies a megabyte, so the naive search
    // is quadratic. It took 328 seconds before this rewrite.
    const envelope = Buffer.byteLength(
      `${JSON.stringify({ id: 'a', method: 'm', params: { t: '' } })}\n`, 'utf8');
    const t = 'x'.repeat(MAX_REQUEST_BYTES - envelope);
    const line = `${JSON.stringify({ id: 'a', method: 'm', params: { t } })}\n`;
    expect(Buffer.byteLength(line, 'utf8')).toBe(MAX_REQUEST_BYTES);
    expect(() => encodeRequest({ id: 'a', method: 'm', params: { t } })).toThrow(/ceiling/i);
    // And one byte under still goes through, which is what makes it a boundary.
    expect(() => encodeRequest({ id: 'a', method: 'm', params: { t: t.slice(0, -1) } })).not.toThrow();
  });

  it('never derives a RELATIVE config root, whatever the environment lacks', () => {
    // A daemon started by launchd or systemd has no HOME.
    const root = herdrConfigRoot({}, '');
    expect(root.startsWith('/')).toBe(true);
    expect(root).not.toBe('.config/herdr');
  });

  it('knows all THREE pane-scoped types, not just the one collie uses', async () => {
    // Probed one by one against a live 0.7.5: 21 of 24 accepted, these three
    // answer `missing field pane_id`.
    for (const t of ['pane.agent_status_changed', 'pane.output_matched', 'pane.scroll_changed']) {
      await expect(
        subscribeEvents('/s.sock', [t], () => {}, async () => ({ close: () => {} })),
        t,
      ).rejects.toThrow(/pane_id/i);
    }
  });
});

describe('running INSIDE a named session', () => {
  it('finds its siblings, instead of only itself under the wrong name', () => {
    /*
     * THE SECOND REVIEW'S SHARPEST FINDING, and the card's central promise.
     * herdr injects HERDR_SOCKET_PATH into everything it launches. For a named
     * session that is `<root>/sessions/<name>/herdr.sock`, so a plain `dirname`
     * makes the config root `<root>/sessions/<name>` - discovery then scans
     * `<root>/sessions/<name>/sessions`, finds nothing, and reports the one
     * session it started from as `default`.
     *
     * Every sibling vanishes and the survivor is mislabelled. `deriveConfigRoot`
     * knew this all along and was called by nobody.
     */
    const root = herdrConfigRoot({ HERDR_SOCKET_PATH: '/cfg/herdr/sessions/work/herdr.sock' }, '/home/x');
    expect(root, 'the root is above sessions/, not inside it').toBe('/cfg/herdr');

    const live = new Set([
      '/cfg/herdr/herdr.sock',
      '/cfg/herdr/sessions/work/herdr.sock',
      '/cfg/herdr/sessions/review/herdr.sock',
    ]);
    const found = discoverSessionSockets(root, () => ['work', 'review'], p => live.has(p));
    expect(found.map(f => f.name)).toEqual(['default', 'work', 'review']);
  });

  it('still reads the default session as its own directory', () => {
    expect(herdrConfigRoot({ HERDR_SOCKET_PATH: '/cfg/herdr/herdr.sock' }, '/home/x')).toBe('/cfg/herdr');
  });
});

describe('what the snapshot keeps that it does not model', () => {
  it('carries fields the type does not name, like layouts', async () => {
    /*
     * The real snapshot answers with `layouts` and `version` alongside the four
     * lists, and the spread that preserves them had no test - removing it left
     * the suite green. A newer herdr adding a field must not have it dropped in
     * silence.
     */
    const line = JSON.stringify({
      id: 'x',
      result: { type: 'session_snapshot', snapshot: { panes: [], layouts: [{ a: 1 }], version: '0.7.5' } },
    });
    const r = await readSnapshot('/s.sock', async () => line, 5_000);
    expect(r.ok && r.snapshot.layouts).toEqual([{ a: 1 }]);
    expect(r.ok && r.snapshot.version).toBe('0.7.5');
  });
});

describe('the defaults a caller inherits', () => {
  it('asks for 200 lines, not one', async () => {
    let sent = '';
    await readPane('/s.sock', { paneId: 'p' },
      async (_p, line) => { sent = line; return '{"id":"x","result":{"type":"pane_read","read":{"text":""}}}'; },
      5_000);
    expect(JSON.parse(sent).params.lines).toBe(200);
  });

  it('names an unreadable error code rather than leaving it undefined', () => {
    // A herdr that answers with a non-string code must still produce something
    // a screen can print.
    const r = parseResponse('{"id":"","error":{"code":42,"message":"weird"}}');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe('unknown');
  });
});
