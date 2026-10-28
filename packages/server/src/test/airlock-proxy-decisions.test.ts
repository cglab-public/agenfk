/**
 * Sandbox proxy decisions reach the decision log (GH-294, TEL-1).
 *
 * POST /airlock/proxy-decisions takes a batch of the allow/deny decisions the
 * launcher's sandbox proxy made, records each in the decision log as
 * source 'proxy' with its client, forwards the redacted record to the hub as
 * airlock.decision (the session id stays here) and tells the board. It answers
 * this machine only, like POST /airlock/evaluate, AND only a caller holding the
 * report token in x-agenfk-airlock-report: the sandboxed agent reaches the port
 * from loopback too, but cannot read that token, so it cannot forge proxy rows.
 * verify-token, which the agent can read, is refused in either header.
 * It drops an identical decision repeated within AIRLOCK_PROXY_DEDUPE_MS (a
 * bounded memory) and caps each client's rate, so a retry loop does not flood
 * the log.
 *
 * The handlers are driven directly with fake requests, so the caller's address
 * and the clock can be anything.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { DEFAULT_AIRLOCK_POLICY, normalizeAirlockPolicy } from '@agenfk/core';
import {
  registerAirlockRoutes,
  AIRLOCK_PROXY_DEDUPE_MS,
  AIRLOCK_PROXY_DEDUPE_CAP,
  AIRLOCK_PROXY_RATE_PER_MIN,
  MAX_PROXY_DECISIONS,
} from '../airlock/routes';

const TOKEN = 'airlock-report-token-0123456789abcdef';
/** Stands for the server's VERIFY_TOKEN: readable by the agent, so never accepted here. */
const VERIFY = 'verify-token-fedcba9876543210';

function harness(over: {
  activeWork?: (sessionId?: string) => any;
  reportToken?: (() => string) | null;
  proxyLimits?: { dedupeCap?: number; ratePerMin?: number };
} = {}) {
  const handlers: Record<string, (req: any, res: any, next: any) => Promise<void>> = {};
  const app = {
    get: (p: string, ...h: any[]) => { handlers[`GET ${p}`] = h.at(-1); },
    put: (p: string, ...h: any[]) => { handlers[`PUT ${p}`] = h.at(-1); },
    post: (p: string, ...h: any[]) => { handlers[`POST ${p}`] = h.at(-1); },
    use: () => {},
  };
  const records: any[] = [];
  const recordAirlockDecision = vi.fn(async (d: any) => { records.push(d); });
  const recordHubEvent = vi.fn();
  const emit = vi.fn();
  const enforce = { scope: 'local', revision: 4, policy: normalizeAirlockPolicy({ ...DEFAULT_AIRLOCK_POLICY, mode: 'enforce' }), updatedAt: '', updatedBy: '', authority: 'local' };
  const storage: any = {
    getAirlockPolicy: async (scope: string) => (scope === 'local' ? enforce : null),
    getAirlockApproval: async () => null,
    recordAirlockDecision,
  };
  let clock = Date.UTC(2026, 9, 27, 12, 0, 0);
  const activeWork = vi.fn(over.activeWork ?? ((sessionId?: string) => (sessionId === 'sess-1' ? { itemId: 'card-1', projectId: 'proj-1' } : null)));
  registerAirlockRoutes(app, {
    storage: () => storage,
    hubJoined: () => false,
    recordHubEvent,
    emit,
    activeWork,
    now: () => clock,
    ...(over.reportToken === null ? {} : { reportToken: over.reportToken ?? (() => TOKEN) }),
    ...(over.proxyLimits ? { proxyLimits: over.proxyLimits } : {}),
  });
  const call = async (route: string, body: unknown, remoteAddress = '127.0.0.1', headers: Record<string, string> = {}) => {
    const res: any = { statusCode: 200, body: undefined };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.body = b; return res; };
    const next = vi.fn();
    await handlers[route]({ socket: { remoteAddress }, body, query: {}, headers }, res, next);
    expect(next).not.toHaveBeenCalled();
    return res;
  };
  const report = (
    body: Record<string, unknown>,
    remoteAddress?: string,
    headers: Record<string, string> = { 'x-agenfk-airlock-report': TOKEN },
  ) => call('POST /airlock/proxy-decisions', {
    client: 'pi',
    model: 'openai/gpt-x',
    sessionId: 'sess-1',
    ...body,
  }, remoteAddress, headers);
  return {
    report,
    call,
    records,
    recordAirlockDecision,
    recordHubEvent,
    emit,
    activeWork,
    advance: (ms: number) => { clock += ms; },
  };
}

const deny = { host: 'evil.example', port: 443, decision: 'deny', rule: 'not-on-allow-list' };
const allow = { host: 'api.openai.com', port: 443, decision: 'allow', rule: 'allow-list' };

afterEach(() => { delete process.env.AIRLOCK_PROXY_TEST_TOKEN; });

describe('POST /airlock/proxy-decisions', () => {
  it('records each decision as source proxy, with its client, model, target, rule, mode and card', async () => {
    const h = harness();
    const res = await h.report({ decisions: [deny, allow] });
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ recorded: 2, skipped: 0 });
    expect(h.activeWork).toHaveBeenCalledWith('sess-1');
    expect(h.records).toHaveLength(2);
    expect(h.records[0]).toMatchObject({
      source: 'proxy',
      client: 'pi',
      model: 'openai/gpt-x',
      tool: 'proxy',
      capabilityKind: 'host',
      target: 'evil.example:443',
      decision: 'deny',
      rule: 'not-on-allow-list',
      mode: 'enforce',
      itemId: 'card-1',
      sessionId: 'sess-1',
    });
    expect(h.records[1]).toMatchObject({ source: 'proxy', decision: 'allow', rule: 'allow-list', target: 'api.openai.com:443' });
  });

  it('forwards each record to the hub as airlock.decision with source and client, never the session id', async () => {
    const h = harness();
    await h.report({ client: 'opencode', decisions: [deny] });
    const events = h.recordHubEvent.mock.calls.map(c => c[0]).filter(e => e.type === 'airlock.decision');
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      source: 'proxy',
      client: 'opencode',
      decision: 'deny',
      rule: 'not-on-allow-list',
      target: 'evil.example:443',
      revision: 4,
      policySource: 'local',
    });
    expect(events[0].payload).not.toHaveProperty('sessionId');
    expect(JSON.stringify(h.recordHubEvent.mock.calls)).not.toContain('sess-1');
    expect(h.emit).toHaveBeenCalledWith('airlock_decision', expect.objectContaining({ decision: 'deny', rule: 'not-on-allow-list', source: 'proxy' }));
  });

  it('redacts the target before it is stored or sent: a secret smuggled into a host name does not leave', async () => {
    const secret = 'zq81Ksecretvalue77';
    process.env.AIRLOCK_PROXY_TEST_TOKEN = secret;
    const h = harness();
    const res = await h.report({ decisions: [{ ...deny, host: `${secret}.exfil.example` }] });
    expect(res.statusCode).toBe(200);
    expect(h.records[0].target).not.toContain(secret);
    expect(h.records[0].target).toContain('[REDACTED');
    expect(JSON.stringify(h.recordHubEvent.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(h.emit.mock.calls)).not.toContain(secret);
  });

  it('a decision with no port logs the host alone; a session with no card logs none', async () => {
    const h = harness();
    await h.report({ sessionId: undefined, decisions: [{ ...deny, port: null }] });
    expect(h.records[0]).toMatchObject({ target: 'evil.example', itemId: null, sessionId: null });
  });

  // null: the socket gave no address (a default parameter would turn undefined into loopback).
  for (const addr of ['192.168.1.20', '10.0.0.5', '2001:db8::1', '::ffff:192.168.1.20', null]) {
    it(`refuses ${addr ?? 'an unknown address'} with 403 and records nothing`, async () => {
      const h = harness();
      const res = await h.report({ decisions: [deny] }, addr as unknown as string);
      expect(res.statusCode).toBe(403);
      expect(h.recordAirlockDecision).not.toHaveBeenCalled();
      expect(h.recordHubEvent).not.toHaveBeenCalled();
      expect(h.emit).not.toHaveBeenCalled();
    });
  }

  const forged: Array<[string, Record<string, string>]> = [
    ['no token', {}],
    ['a wrong token', { 'x-agenfk-airlock-report': 'not-the-token' }],
    ['an empty token', { 'x-agenfk-airlock-report': '' }],
    ['the report token in the internal header', { 'x-agenfk-internal': TOKEN }],
    ['the report token in another header', { 'x-agenfk-ui': TOKEN }],
    ['the verify token in the internal header', { 'x-agenfk-internal': VERIFY }],
    ['the verify token in the report header', { 'x-agenfk-airlock-report': VERIFY }],
  ];
  for (const [what, headers] of forged) {
    it(`a loopback caller with ${what} (the sandboxed agent) is refused with 403 and nothing is logged`, async () => {
      const h = harness();
      const res = await h.report({ decisions: [deny] }, '127.0.0.1', headers);
      expect(res.statusCode).toBe(403);
      expect(h.recordAirlockDecision).not.toHaveBeenCalled();
      expect(h.recordHubEvent).not.toHaveBeenCalled();
      expect(h.emit).not.toHaveBeenCalled();
    });
  }

  it('a server wired with no token refuses every report (fails closed)', async () => {
    const h = harness({ reportToken: null });
    const res = await h.report({ decisions: [deny] });
    expect(res.statusCode).toBe(403);
    expect(h.recordAirlockDecision).not.toHaveBeenCalled();
  });

  it('a server whose token is empty accepts no empty header', async () => {
    const h = harness({ reportToken: () => '' });
    const res = await h.report({ decisions: [deny] }, '127.0.0.1', { 'x-agenfk-airlock-report': '' });
    expect(res.statusCode).toBe(403);
    expect(h.recordAirlockDecision).not.toHaveBeenCalled();
  });

  it('answers ::1 and ::ffff:127.0.0.1', async () => {
    for (const addr of ['::1', '::ffff:127.0.0.1']) {
      const h = harness();
      expect((await h.report({ decisions: [deny] }, addr)).statusCode).toBe(200);
      expect(h.records).toHaveLength(1);
    }
  });

  // The envelope is refused whole: nothing of the batch is recorded.
  const envelope: Array<[string, Record<string, unknown>]> = [
    ['an unknown client', { client: 'claude', decisions: [deny] }],
    ['no decisions array', { decisions: undefined }],
    ['a decisions object', { decisions: { 0: deny } }],
    ['too many decisions', { decisions: Array.from({ length: MAX_PROXY_DECISIONS + 1 }, (_, i) => ({ ...deny, host: `h${i}.example` })) }],
    ['an overlong session id', { sessionId: 's'.repeat(300), decisions: [deny] }],
    ['a malformed model', { model: 42, decisions: [deny] }],
  ];
  for (const [what, body] of envelope) {
    it(`400 for ${what}, and nothing of the batch is recorded`, async () => {
      const h = harness();
      const res = await h.report(body);
      expect(res.statusCode).toBe(400);
      expect(h.recordAirlockDecision).not.toHaveBeenCalled();
      expect(h.recordHubEvent).not.toHaveBeenCalled();
    });
  }

  // One entry that does not fit is skipped and counted; the rest of the batch is recorded.
  const badEntries: Array<[string, Record<string, unknown>]> = [
    ['a decision that is neither allow nor deny', { ...deny, decision: 'maybe' }],
    ['a port out of range', { ...deny, port: 70000 }],
    ['a fractional port', { ...deny, port: 44.3 }],
    ['an empty host', { ...deny, host: '' }],
    ['a host with spaces', { ...deny, host: 'a b.example' }],
    ['an overlong host', { ...deny, host: `${'a'.repeat(300)}.example` }],
    ['an overlong rule', { ...deny, rule: 'r'.repeat(300) }],
    ['a null entry', null as unknown as Record<string, unknown>],
  ];
  for (const [what, entry] of badEntries) {
    it(`${what} is skipped and counted as invalid; the rest of the batch is recorded`, async () => {
      const h = harness();
      const res = await h.report({ decisions: [entry, allow] });
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({ recorded: 1, invalid: 1 });
      expect(h.records.map(r => r.target)).toEqual(['api.openai.com:443']);
      expect(h.recordHubEvent.mock.calls.filter(c => c[0].type === 'airlock.decision')).toHaveLength(1);
    });
  }

  it('at ASRT\'s boundary: a 255-character host is recorded, a 256-character one is skipped, the batch goes on', async () => {
    const h = harness();
    const host255 = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}`;
    expect(host255).toHaveLength(255);
    const res = await h.report({ decisions: [{ ...deny, host: host255 }, { ...deny, host: `${host255}e` }, { ...deny, host: 'ok.example' }] });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ recorded: 2, invalid: 1 });
    expect(h.records.map(r => r.target)).toEqual([`${host255}:443`, 'ok.example:443']);
  });

  it('an empty batch is fine and records nothing', async () => {
    const h = harness();
    const res = await h.report({ decisions: [] });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ recorded: 0, skipped: 0, dropped: 0, invalid: 0 });
  });
});

describe('proxy decisions: bounded memory and rate', () => {
  it('the dedupe is capped and forgets the oldest decision first; one logged again counts as new', async () => {
    expect(AIRLOCK_PROXY_DEDUPE_CAP).toBe(5_000);
    const h = harness({ proxyLimits: { dedupeCap: 3 } });
    const at = (host: string) => ({ ...deny, host });
    await h.report({ decisions: [at('a.example'), at('b.example'), at('c.example')] });
    // a is the oldest; d pushes it out, so within the window a is logged again...
    await h.report({ decisions: [at('d.example')] });
    expect((await h.report({ decisions: [at('a.example')] })).body).toMatchObject({ recorded: 1, skipped: 0 });
    // ...which evicted b (now the oldest), while c and d are still remembered.
    expect((await h.report({ decisions: [at('c.example'), at('d.example')] })).body).toMatchObject({ recorded: 0, skipped: 2 });
    expect((await h.report({ decisions: [at('b.example')] })).body).toMatchObject({ recorded: 1, skipped: 0 });
  });

  it('a decision logged again after its window becomes the newest, so the cap evicts an older one first', async () => {
    const h = harness({ proxyLimits: { dedupeCap: 2 } });
    const at = (host: string) => ({ ...deny, host });
    await h.report({ decisions: [at('a.example')] });
    await h.report({ decisions: [at('b.example')] });
    h.advance(AIRLOCK_PROXY_DEDUPE_MS);
    // b is past its window too; only a is logged again here...
    await h.report({ decisions: [at('a.example')] });
    // ...so c evicts b, the oldest, and a is still remembered.
    await h.report({ decisions: [at('c.example')] });
    expect((await h.report({ decisions: [at('a.example')] })).body).toMatchObject({ recorded: 0, skipped: 1 });
  });

  it('the real cap holds memory flat: far more distinct decisions than the cap still dedupe the newest', async () => {
    const h = harness({ proxyLimits: { ratePerMin: Number.MAX_SAFE_INTEGER } });
    const total = AIRLOCK_PROXY_DEDUPE_CAP + 2 * MAX_PROXY_DECISIONS;
    for (let i = 0; i < total; i += MAX_PROXY_DECISIONS) {
      await h.report({ decisions: Array.from({ length: MAX_PROXY_DECISIONS }, (_, j) => ({ ...deny, host: `h${i + j}.example` })) });
    }
    expect(h.records).toHaveLength(total);
    // The newest are remembered; the first ones were forgotten.
    expect((await h.report({ decisions: [{ ...deny, host: `h${total - 1}.example` }] })).body.skipped).toBe(1);
    expect((await h.report({ decisions: [{ ...deny, host: 'h0.example' }] })).body.recorded).toBe(1);
  });

  it('per client, at most AIRLOCK_PROXY_RATE_PER_MIN decisions a minute are logged; the rest are dropped and counted', async () => {
    const h = harness();
    const batches = Math.ceil((AIRLOCK_PROXY_RATE_PER_MIN + 10) / MAX_PROXY_DECISIONS);
    let dropped = 0;
    let n = 0;
    for (let b = 0; b < batches; b++) {
      const res = await h.report({ decisions: Array.from({ length: MAX_PROXY_DECISIONS }, () => ({ ...deny, host: `r${n++}.example` })) });
      dropped += res.body.dropped;
    }
    expect(h.records).toHaveLength(AIRLOCK_PROXY_RATE_PER_MIN);
    expect(dropped).toBe(batches * MAX_PROXY_DECISIONS - AIRLOCK_PROXY_RATE_PER_MIN);
    // Another client has its own allowance.
    const other = await h.report({ client: 'opencode', decisions: [deny] });
    expect(other.body).toMatchObject({ recorded: 1, dropped: 0 });
    // And the next minute, the first one again.
    h.advance(60_000);
    const later = await h.report({ decisions: [{ ...deny, host: 'later.example' }] });
    expect(later.body).toMatchObject({ recorded: 1, dropped: 0 });
  });
});

describe('proxy decisions: dedupe', () => {
  it('an identical decision repeated within the window is recorded once, in one batch or across batches', async () => {
    const h = harness();
    const first = await h.report({ decisions: [deny, deny, deny] });
    expect(first.body).toMatchObject({ recorded: 1, skipped: 2 });
    h.advance(AIRLOCK_PROXY_DEDUPE_MS - 1);
    const again = await h.report({ decisions: [deny] });
    expect(again.body).toMatchObject({ recorded: 0, skipped: 1 });
    expect(h.records).toHaveLength(1);
    expect(h.recordHubEvent.mock.calls.filter(c => c[0].type === 'airlock.decision')).toHaveLength(1);
  });

  it('once the window has passed since the last record, the same decision is recorded again', async () => {
    const h = harness();
    await h.report({ decisions: [deny] });
    h.advance(AIRLOCK_PROXY_DEDUPE_MS);
    await h.report({ decisions: [deny] });
    expect(h.records).toHaveLength(2);
  });

  it('decisions that differ in host, port, verdict, rule, client or session are each recorded', async () => {
    const h = harness();
    await h.report({ decisions: [
      deny,
      { ...deny, host: 'other.example' },
      { ...deny, port: 80 },
      { ...deny, decision: 'allow', rule: 'allow-list' },
      { ...deny, rule: 'deny-list' },
    ] });
    await h.report({ client: 'opencode', decisions: [deny] });
    await h.report({ sessionId: 'sess-2', decisions: [deny] });
    expect(h.records).toHaveLength(7);
  });

  it('a tool-call decision through /airlock/evaluate is recorded as source tool, not deduped against the proxy', async () => {
    const h = harness();
    await h.report({ decisions: [deny] });
    const res = await h.call('POST /airlock/evaluate', {
      client: 'pi', model: 'p/m', toolName: 'bash', args: { command: 'curl http://169.254.169.254/' },
    });
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    const tool = h.records.find(r => r.tool === 'bash');
    expect(tool).toMatchObject({ source: 'tool', client: 'pi' });
    const events = h.recordHubEvent.mock.calls.map(c => c[0]).filter(e => e.type === 'airlock.decision');
    expect(events.map(e => e.payload.source)).toEqual(['proxy', 'tool']);
    expect(events[1].payload).toMatchObject({ policySource: 'local', revision: 4 });
  });
});
