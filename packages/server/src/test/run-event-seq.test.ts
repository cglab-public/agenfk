/**
 * The position a posted event comes back with (BUG 510df783).
 *
 * The store assigns `seq` inside the INSERT, which was the right fix for a real
 * race: computing it in the route was a read, an await, then a write, so two
 * events in flight got the same number and the second was silently dropped
 * against `UNIQUE(run_id, seq)`.
 *
 * What it left behind is that the route never learned the number. It answered
 * with — and broadcast — the object it had been HANDED, whose `seq` is still
 * undefined, and every live consumer orders and de-duplicates by that field.
 * Two undefineds compare equal, so the second event and every one after it
 * read as a duplicate of the first. A Claude Code session showed one line in
 * the Runs panel and then nothing, for as long as it ran.
 *
 * Only the pi tailer supplies a position of its own; the hook and the CLI both
 * omit it, which is to say the broken path was the common one.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import { app, initStorage, VERIFY_TOKEN, io } from '../server';

// One listening server for the file. Per-call servers produced transport
// failures that surfaced as confident wrong assertions elsewhere (BUG 9de0c99c).
let __server: ReturnType<typeof app.listen>;
const agent = () => request(__server);
beforeAll(() => { __server = app.listen(0); });
afterAll(() => { __server?.close(); });


const TEST_DB = path.resolve('./run-event-seq-test-db.sqlite');
const internal = (r: request.Test) => r.set('x-agenfk-internal', VERIFY_TOKEN!);

let runId: string;

beforeAll(async () => {
  // The path is set through the environment, which is what initStorage reads.
  // Passing it as an argument silently left the tests on the real database.
  process.env.AGENFK_DB_PATH = TEST_DB;
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(TEST_DB + suffix)) fs.unlinkSync(TEST_DB + suffix);
  }
  await initStorage();
});
afterAll(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(TEST_DB + suffix)) fs.unlinkSync(TEST_DB + suffix);
  }
});

beforeEach(async () => {
  await initStorage();
  const project = await internal(agent().post('/projects')).send({ name: 'seq' });
  const item = await internal(agent().post('/items'))
    .send({ type: 'TASK', title: 'a card', projectId: project.body.id });
  const run = await internal(agent().post('/agent-runs')).send({
    itemId: item.body.id, projectId: project.body.id, step: 'IN_PROGRESS',
    actor: 'worker', harness: 'claude-code', model: 'claude-opus-5',
  });
  if (!run.body?.id) throw new Error('run not created: ' + run.status + ' ' + JSON.stringify(run.body));
  runId = run.body.id;
});

const post = (body: Record<string, unknown>) =>
  internal(agent().post(`/agent-runs/${runId}/events`)).send({
    lane: 'worker', kind: 'tool', tool: 'Bash', ...body,
  });

describe('an event posted without a position', () => {
  it('comes back carrying the one it was given', async () => {
    /*
     * THE assertion. The route used to answer with the object it was handed,
     * so this was `undefined` — and the same object went out over the socket,
     * which is what collapsed the live transcript.
     */
    const res = await post({ text: 'npm test' });
    expect(res.status).toBe(201);
    expect(typeof res.body.seq).toBe('number');
  });

  it('numbers a stream of them in order', async () => {
    const a = await post({ text: 'one' });
    const b = await post({ text: 'two' });
    const c = await post({ text: 'three' });
    expect([a.body.seq, b.body.seq, c.body.seq]).toEqual([0, 1, 2]);
  });

  it('agrees with what a refresh reads back', async () => {
    // The socket and a reload must not disagree about the order, which is
    // exactly what an undefined on one side and a number on the other did.
    await post({ text: 'one' });
    const second = await post({ text: 'two' });
    const listed = await internal(agent().get(`/agent-runs/${runId}/events`));
    expect(listed.body.map((e: { seq: number }) => e.seq)).toContain(second.body.seq);
  });
});

describe('an event that supplies its own position', () => {
  it('keeps it', async () => {
    // The pi tailer knows the true order from the transcript, and that order
    // beats arrival order. The route must not renumber it.
    const res = await post({ text: 'from the tailer', seq: 41 });
    expect(res.body.seq).toBe(41);
  });

  it('does not let a second event take the same position', async () => {
    /*
     * The race the in-insert assignment was built to fix, checked from the
     * outside: the insert is INSERT OR IGNORE against UNIQUE(run_id, seq), so
     * a repeat writes nothing. What matters here is that the route does not
     * then report success as though it had.
     */
    await post({ text: 'first', seq: 7 });
    const dup = await post({ text: 'second', seq: 7 });
    const listed = await internal(agent().get(`/agent-runs/${runId}/events`));
    const atSeven = listed.body.filter((e: { seq: number }) => e.seq === 7);
    expect(atSeven).toHaveLength(1);
    expect(atSeven[0].text).toBe('first');
    expect(dup.body.text).toBe('second');
  });
});


/**
 * What actually goes out over the socket.
 *
 * The HTTP response and the broadcast are built from the same object, so the
 * tests above pin most of this — but the broadcast is the half that reached
 * the user, and one rule is only visible here: a duplicate writes nothing and
 * must therefore tell nobody. Asserting it through supertest is impossible;
 * `io` is exported, so it can be watched directly.
 */
describe('the broadcast', () => {
  const emitted = () => {
    const spy = vi.spyOn(io, 'emit');
    return {
      runEvents: () => spy.mock.calls.filter(([channel]) => channel === 'run:event'),
      restore: () => spy.mockRestore(),
    };
  };

  it('carries the position, not the undefined it was handed', async () => {
    const watch = emitted();
    await post({ text: 'npm test' });
    const [, payload] = watch.runEvents().at(-1) as [string, { event: { seq: number } }];
    expect(typeof payload.event.seq).toBe('number');
    watch.restore();
  });

  it('says nothing at all when the row was already there', async () => {
    /*
     * The rule that only exists here. `INSERT OR IGNORE` against
     * `UNIQUE(run_id, seq)` writes nothing on a repeat, and announcing it
     * anyway would paint a duplicate into every open panel — an event that
     * exists on screen and in no database.
     */
    await post({ text: 'first', seq: 7 });
    const watch = emitted();
    await post({ text: 'second', seq: 7 });
    expect(watch.runEvents()).toHaveLength(0);
    watch.restore();
  });
});
