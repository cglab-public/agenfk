/**
 * CGLAB-696 task 2: the host side of a machine's network. smolvm hands every
 * outbound TCP flow of the guest to a decider on the host's loopback (mediated
 * egress, protocol v2) and waits for allow or deny. In enforce mode smolvm also
 * gets the policy's allow list, so the guest's DNS answers only allowed names
 * and a flow to an address no allowed name gave is dropped before the decider
 * (measured, smolvm 1.32.4); those refusals are read from smolvm's own audit.
 * Every decision, allow and deny, reaches the session's report.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { realBroker, smolvmTestsEnabled } from './fixtures/smolvm-real';
import { normalizeAirlockPolicy } from '@agenfk/core';
import { buildSandboxSpec, type SandboxSession, type SandboxSpec } from '../airlock/spec';
import type { ProxyDecision } from '../airlock/runtime';
import {
  parseFlow,
  serverNameOf,
  decideFlow,
  allowListArgs,
  DnsNames,
  auditDecision,
  EgressService,
  HelperEgressBroker,
  FLOW_MAGIC,
  GATEWAY,
  readRoutes,
  followNetwork,
  resolverTokenOf,
  RESOLVER_REPORT_PORT,
  type Flow,
  type Route,
} from '../airlock/egress';
import { writeAll } from '../airlock/egressMain';
import { vmTestBase } from './helpers/vmTestBase';

const TOKEN = Buffer.alloc(32, 7);
const MACHINE = Buffer.alloc(16, 1);
const PARENT = Buffer.alloc(16, 0);

/** One flow as smolvm writes it (protocol v2). */
function frame(o: { token?: Buffer; family?: 4 | 6; ip?: number[]; port?: number; payload?: Buffer } = {}): Buffer {
  const family = o.family ?? 4;
  const ip = Buffer.from(o.ip ?? (family === 4 ? [93, 184, 216, 34] : Array(16).fill(0).map((_, i) => (i === 15 ? 1 : 0))));
  const payload = o.payload ?? Buffer.alloc(0);
  const port = Buffer.alloc(2);
  port.writeUInt16BE(o.port ?? 443);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(payload.length);
  return Buffer.concat([Buffer.from(FLOW_MAGIC, 'latin1'), o.token ?? TOKEN, MACHINE, PARENT, Buffer.from([family]), port, ip, len, payload]);
}

/** A TLS ClientHello carrying `name` as its server name. */
function clientHello(name: string): Buffer {
  const host = Buffer.from(name, 'latin1');
  const sniEntry = Buffer.concat([Buffer.from([0]), u16(host.length), host]);
  const sniList = Buffer.concat([u16(sniEntry.length), sniEntry]);
  const ext = Buffer.concat([u16(0), u16(sniList.length), sniList]);
  const exts = Buffer.concat([u16(ext.length), ext]);
  const body = Buffer.concat([Buffer.from([3, 3]), Buffer.alloc(32), Buffer.from([0]), u16(2), Buffer.from([0x13, 0x01]), Buffer.from([1, 0]), exts]);
  const hs = Buffer.concat([Buffer.from([1]), u24(body.length), body]);
  return Buffer.concat([Buffer.from([0x16, 3, 1]), u16(hs.length), hs]);
}
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u24 = (n: number) => Buffer.from([(n >> 16) & 255, (n >> 8) & 255, n & 255]);

const session: SandboxSession = {
  client: 'pi',
  home: '/home/u',
  workspace: '/work/repo',
  tempDirs: ['/tmp/x'],
  inferenceHosts: ['api.openai.com'],
  serverPort: 3123,
  installDirs: ['/home/u/.agenfk-system'],
};
/** A session's network: the policy's hosts, plus an inference endpoint on its own port (db.example.com:5432). */
const network = (mode: 'observe' | 'enforce', hosts: { allow?: string[]; deny?: string[] } = {}): SandboxSpec['network'] =>
  buildSandboxSpec(
    normalizeAirlockPolicy({ mode, hosts: { allow: hosts.allow ?? ['api.github.com', '*.npmjs.org', '10.1.2.3'], deny: hosts.deny ?? ['evil.example.net', '192.168.0.0/16'] } }),
    { ...session, inferenceHosts: ['api.openai.com', 'db.example.com:5432'] },
  ).network;

describe('buildSandboxSpec: the network mode', () => {
  it('carries the policy mode, for a runtime that decides each flow', () => {
    expect(network('observe').mode).toBe('observe');
    expect(network('enforce').mode).toBe('enforce');
  });
});

describe('parseFlow (protocol v2)', () => {
  it('reads a whole flow: token, ids, address, port, first bytes', () => {
    const payload = Buffer.from('GET / HTTP/1.1\r\nHost: api.github.com\r\n\r\n');
    const r = parseFlow(frame({ port: 8080, payload }));
    expect(r.kind).toBe('flow');
    const f = (r as { flow: Flow }).flow;
    expect(f.token.equals(TOKEN)).toBe(true);
    expect(f.machineId).toBe('01'.repeat(16));
    expect(f.ip).toBe('93.184.216.34');
    expect(f.port).toBe(8080);
    expect(f.payload.equals(payload)).toBe(true);
  });

  it('reads an IPv6 destination', () => {
    const r = parseFlow(frame({ family: 6 }));
    expect((r as { flow: Flow }).flow.ip).toBe('::1');
  });

  it('asks for more until the whole flow, payload included, has arrived', () => {
    const whole = frame({ payload: Buffer.from('hello') });
    for (const cut of [0, 7, 40, 72, 75, whole.length - 1]) expect(parseFlow(whole.subarray(0, cut)).kind).toBe('more');
  });

  it('refuses another magic and an unknown address family', () => {
    const bad = frame();
    bad.write('SMOLMEG1', 0, 'latin1');
    expect(parseFlow(bad).kind).toBe('invalid');
    const fam = frame();
    fam[8 + 32 + 32] = 5;
    expect(parseFlow(fam).kind).toBe('invalid');
  });
});

describe('serverNameOf', () => {
  it('reads the TLS server name', () => {
    expect(serverNameOf(clientHello('api.github.com'))).toBe('api.github.com');
  });

  it('reads the HTTP Host, without its port', () => {
    expect(serverNameOf(Buffer.from('GET / HTTP/1.1\r\nUser-Agent: x\r\nHost: Registry.NPMJS.org:8080\r\n\r\n'))).toBe('registry.npmjs.org');
  });

  it('is null for anything else: a postgres startup, ssh, nothing, a truncated hello', () => {
    expect(serverNameOf(Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]))).toBeNull();
    expect(serverNameOf(Buffer.from('SSH-2.0-OpenSSH_9.6\r\n'))).toBeNull();
    expect(serverNameOf(Buffer.alloc(0))).toBeNull();
    expect(serverNameOf(clientHello('api.github.com').subarray(0, 30))).toBeNull();
  });

  it('refuses a name that is not one', () => {
    expect(serverNameOf(Buffer.from('GET / HTTP/1.1\r\nHost: a b;c\r\n\r\n'))).toBeNull();
  });
});

describe('decideFlow', () => {
  const at = (name: string | null, port: number, ip = '93.184.216.34') => ({ names: name ? [name] : [], port, ip });

  it('enforce: allows a name on the allow list, on any port when the entry names none', () => {
    expect(decideFlow(at('api.github.com', 443), network('enforce'))).toEqual({ host: 'api.github.com', port: 443, decision: 'allow', rule: 'allow-list' });
  });

  it('enforce: holds an entry with a port to that port', () => {
    expect(decideFlow(at('db.example.com', 5432), network('enforce')).decision).toBe('allow');
    expect(decideFlow(at('db.example.com', 5433), network('enforce'))).toMatchObject({ decision: 'deny', rule: 'not-on-allow-list' });
  });

  it('enforce: a wildcard entry admits subdomains, not the name itself', () => {
    expect(decideFlow(at('registry.npmjs.org', 443), network('enforce')).decision).toBe('allow');
    expect(decideFlow(at('npmjs.org', 443), network('enforce')).decision).toBe('deny');
  });

  it('enforce: an exact entry does not admit its subdomains', () => {
    expect(decideFlow(at('x.api.github.com', 443), network('enforce')).decision).toBe('deny');
  });

  it('enforce: an IP entry admits that address with no name', () => {
    expect(decideFlow(at(null, 22, '10.1.2.3'), network('enforce'))).toMatchObject({ host: '10.1.2.3', decision: 'allow' });
  });

  it('enforce: refuses a flow it cannot name, naming the address', () => {
    expect(decideFlow(at(null, 5432), network('enforce'))).toEqual({ host: '93.184.216.34', port: 5432, decision: 'deny', rule: 'unknown-host' });
  });

  it('refuses the deny list and denied addresses in both modes', () => {
    for (const mode of ['observe', 'enforce'] as const) {
      expect(decideFlow(at('evil.example.net', 443), network(mode))).toMatchObject({ decision: 'deny', rule: 'deny-list' });
      expect(decideFlow(at('api.github.com', 443, '192.168.1.9'), network(mode))).toMatchObject({ decision: 'deny', rule: 'denied-address' });
      // The built-in metadata hosts and ranges.
      expect(decideFlow(at(null, 80, '169.254.169.254'), network(mode)).decision).toBe('deny');
    }
  });

  it('observe: allows the rest, recording what enforce would have done', () => {
    expect(decideFlow(at('anything.example.com', 443), network('observe'))).toEqual({ host: 'anything.example.com', port: 443, decision: 'allow', rule: 'observe:not-on-allow-list' });
    expect(decideFlow(at('api.github.com', 443), network('observe'))).toMatchObject({ decision: 'allow', rule: 'observe:allow-list' });
    expect(decideFlow(at(null, 5432), network('observe'))).toMatchObject({ host: '93.184.216.34', decision: 'allow', rule: 'observe:unknown-host' });
  });

  it('a deny on any of the names a flow is known by wins over an allowed one', () => {
    const net = { ...network('enforce', { allow: ['*.example.com'] }), deny: [...network('enforce').deny, 'secret.example.com'] };
    expect(decideFlow({ names: ['www.example.com', 'secret.example.com'], ip: '93.184.216.34', port: 443 }, net)).toMatchObject({ decision: 'deny', rule: 'deny-list', host: 'secret.example.com' });
  });

  it('checks a name the flow claims against the deny side even when another name allows it', () => {
    const net = { ...network('enforce', { allow: ['*.cdn.example'] }), deny: [...network('enforce').deny, 'evil.cdn.example'] };
    expect(decideFlow({ names: ['www.cdn.example'], claimed: 'evil.cdn.example', ip: '93.184.216.34', port: 443 }, net)).toMatchObject({ decision: 'deny', rule: 'deny-list', host: 'evil.cdn.example' });
  });

  // Story review 3: a flow that claims a name is allowed by that name, never by another name its
  // address is also known by (a CDN address serves names off the list too).
  it('a claimed name off the allow list is denied, whatever else its address is known by', () => {
    const net = network('enforce', { allow: ['*.cdn.example'] });
    // not confirmed: refused, and the flow is reported by the name its address is known by
    expect(decideFlow({ names: ['www.cdn.example'], claimed: 'evil.other.example', ip: '93.184.216.34', port: 443 }, net))
      .toEqual({ host: 'www.cdn.example', port: 443, decision: 'deny', rule: 'not-on-allow-list' });
    // confirmed (it resolves to the address) and still off the list: denied all the same
    expect(decideFlow({ names: ['evil.other.example', 'www.cdn.example'], claimed: 'evil.other.example', ip: '93.184.216.34', port: 443 }, net))
      .toMatchObject({ host: 'evil.other.example', decision: 'deny', rule: 'not-on-allow-list' });
    // observe reports a confirmed claim
    expect(decideFlow({ names: ['evil.other.example', 'www.cdn.example'], claimed: 'evil.other.example', ip: '93.184.216.34', port: 443 }, network('observe', { allow: ['*.cdn.example'] })))
      .toEqual({ host: 'evil.other.example', port: 443, decision: 'allow', rule: 'observe:not-on-allow-list' });
  });

  it('a claimed name on the allow list is allowed; an allowed address still admits any claim', () => {
    const net = network('enforce', { allow: ['*.cdn.example', '10.1.2.3'] });
    expect(decideFlow({ names: ['other.cdn.example', 'www.cdn.example'], claimed: 'www.cdn.example', ip: '93.184.216.34', port: 443 }, net))
      .toEqual({ host: 'www.cdn.example', port: 443, decision: 'allow', rule: 'allow-list' });
    // one it cannot confirm, on an address another name is known by: not allowed by that other name
    expect(decideFlow({ names: ['other.cdn.example'], claimed: 'www.cdn.example', ip: '93.184.216.34', port: 443 }, net))
      .toMatchObject({ host: 'other.cdn.example', decision: 'deny', rule: 'not-on-allow-list' });
    expect(decideFlow({ names: [], claimed: 'anything.example', ip: '10.1.2.3', port: 22 }, net)).toMatchObject({ decision: 'allow' });
  });

  it('denies everything under a deny of *', () => {
    expect(decideFlow(at('api.github.com', 443), { ...network('enforce'), deny: ['*'] }).decision).toBe('deny');
  });
});

describe('allowListArgs: what smolvm is given', () => {
  it('enforce: each allowed name as an exact pattern (its subdomains not included), IPs as /32 CIDRs, from an empty list', () => {
    const args = allowListArgs(network('enforce'));
    expect(args[0]).toBe('--reset-allow-list');
    const pairs = args.slice(1).reduce<string[][]>((acc, a, i, all) => (i % 2 === 0 ? [...acc, [a, all[i + 1]]] : acc), []);
    expect(pairs).toContainEqual(['--allow-host-pattern', 'api.github.com']);
    expect(pairs).toContainEqual(['--allow-host-pattern', 'db.example.com']);
    expect(pairs).toContainEqual(['--allow-host-pattern', '*.npmjs.org']);
    expect(pairs).toContainEqual(['--allow-cidr', '10.1.2.3/32']);
    expect(pairs.some(([f]) => f === '--allow-host')).toBe(false);
  });

  it('enforce: lets the guest reach the gateway, where the decider relays to the launcher alone', () => {
    const args = allowListArgs(network('enforce'));
    expect(args.join(' ')).toContain(`--allow-cidr ${GATEWAY}/32`);
  });

  it('enforce: never an empty list, which smolvm reads as every host', () => {
    const none = { ...network('enforce'), allow: [] };
    const args = allowListArgs(none);
    expect(args.length).toBeGreaterThan(1);
    expect(args).toContain('--allow-cidr');
  });

  it('observe: an empty list, so every name resolves and every flow reaches the decider', () => {
    // --net: smolvm refuses to empty an allow list a machine had (one enforce set) unless every host is
    // asked for explicitly (measured, 1.32.4: "removing the last allowed host ... say so explicitly").
    expect(allowListArgs(network('observe'))).toEqual(['--reset-allow-list', '--net']);
  });
});

describe('DnsNames: naming a flow from the names the guest looked up', () => {
  it('names an address by a name the guest asked for that resolves to it', async () => {
    const resolve = vi.fn(async (n: string) => (n === 'db.example.com' ? ['10.9.8.7'] : []));
    const names = new DnsNames(resolve);
    names.noteQuestion('db.example.com');
    expect(await names.namesOf('10.9.8.7')).toEqual(['db.example.com']);
    expect(await names.namesOf('10.9.8.8')).toEqual([]);
  });

  it('waits for a lookup still under way rather than answering null', async () => {
    let release: (v: string[]) => void = () => undefined;
    const names = new DnsNames(() => new Promise((r) => { release = r; }));
    names.noteQuestion('slow.example.com');
    const asking = names.namesOf('10.0.0.1');
    release(['10.0.0.1']);
    expect(await asking).toEqual(['slow.example.com']);
  });

  it('does not wait forever for a lookup that hangs', async () => {
    const names = new DnsNames(() => new Promise(() => undefined), { waitMs: 50 });
    names.noteQuestion('hang.example.com');
    expect(await names.namesOf('10.0.0.1')).toEqual([]);
  });

  it('forgets names after their time', async () => {
    let now = 0;
    const names = new DnsNames(async () => ['10.0.0.2'], { ttlMs: 1000, now: () => now });
    names.noteQuestion('a.example.com');
    expect(await names.namesOf('10.0.0.2')).toEqual(['a.example.com']);
    now = 2000;
    expect(await names.namesOf('10.0.0.2')).toEqual([]);
  });

  it('gives every name an address has, not only the first', async () => {
    const names = new DnsNames(async () => ['10.0.0.3']);
    names.noteQuestion('ok.example.com');
    names.noteQuestion('secret.example.com');
    expect((await names.namesOf('10.0.0.3')).sort()).toEqual(['ok.example.com', 'secret.example.com']);
  });

  it('looks a name up once while its lookup is under way or fresh', async () => {
    const resolve = vi.fn(async () => ['10.0.0.4']);
    const names = new DnsNames(resolve);
    for (let i = 0; i < 50; i++) names.noteQuestion('same.example.com');
    await names.namesOf('10.0.0.4');
    names.noteQuestion('same.example.com');
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('holds a bounded number of names and runs a bounded number of lookups, however many the guest asks', async () => {
    let running = 0;
    let most = 0;
    const names = new DnsNames(async () => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 1));
      running--;
      return [];
    });
    for (let i = 0; i < 5000; i++) {
      names.noteQuestion(`n${i}.example.com`);
      if (i % 100 === 0) await new Promise((r) => setTimeout(r, 5));
    }
    await new Promise((r) => setTimeout(r, 50));
    expect(most).toBeLessThanOrEqual(16);
    expect(names.size).toBeLessThanOrEqual(2048);
  });

  it('keeps at most 2048 names when every lookup finishes before the next question', async () => {
    const names = new DnsNames(async () => []);
    for (let i = 0; i < 3000; i++) {
      names.noteQuestion(`n${i}.example.com`);
      await new Promise((r) => setImmediate(r));
    }
    expect(names.size).toBeLessThanOrEqual(2048);
  });

  it('keeps one budget for looked-up and claimed names together', async () => {
    const names = new DnsNames(async () => []);
    for (let i = 0; i < 1500; i++) {
      names.noteQuestion(`q${i}.example.com`);
      await names.resolvesTo(`c${i}.example.com`, '10.0.0.1');
    }
    expect(names.size).toBeLessThanOrEqual(2048);
  });

  it('believes a claimed name only when it resolves to the address', async () => {
    const names = new DnsNames(async (n: string) => (n === 'db.example.com' ? ['10.9.8.7'] : []));
    expect(await names.resolvesTo('db.example.com', '10.9.8.7')).toBe(true);
    expect(await names.resolvesTo('db.example.com', '10.0.0.9')).toBe(false);
  });
});

describe('auditDecision: smolvm\'s own refusals, from its audit', () => {
  const line = (o: Record<string, unknown>) => JSON.stringify({ machineId: 'm', parentId: 'p', timestampMs: 1, ...o });

  it('reports a name smolvm refused to resolve', () => {
    expect(auditDecision(line({ transport: 'dns', action: 'deny', destination: 'github.com', reason: 'local_policy' })))
      .toEqual({ host: 'github.com', port: null, decision: 'deny', rule: 'not-on-allow-list' });
  });

  it('reports a flow smolvm dropped before the decider, by its address and port', () => {
    expect(auditDecision(line({ transport: 'tcp', action: 'deny', destination: 'to 1.1.1.1:443', reason: 'local_policy' })))
      .toEqual({ host: '1.1.1.1', port: 443, decision: 'deny', rule: 'not-on-allow-list' });
  });

  it('reports a UDP flow smolvm refused', () => {
    expect(auditDecision(line({ transport: 'udp', action: 'deny', destination: '8.8.8.8:53', reason: 'local_policy' })))
      .toMatchObject({ host: '8.8.8.8', port: 53, decision: 'deny', rule: 'udp-refused' });
  });

  it('skips what the decider reports itself, allowed lookups, and lines it cannot read', () => {
    expect(auditDecision(line({ transport: 'tcp', action: 'allow', destination: '1.2.3.4:443', reason: 'broker_decision' }))).toBeNull();
    expect(auditDecision(line({ transport: 'dns', action: 'allow', destination: 'nextjs.org', reason: 'local_policy' }))).toBeNull();
    expect(auditDecision('not json')).toBeNull();
  });
});

describe('EgressService: the decider on the host loopback', () => {
  let svc: EgressService | null = null;
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-egress-')); });
  afterEach(async () => { await svc?.close(); svc = null; fs.rmSync(dir, { recursive: true, force: true }); });

  async function start(mode: 'observe' | 'enforce', over: Partial<ConstructorParameters<typeof EgressService>[0]> = {}) {
    const decisions: ProxyDecision[] = [];
    svc = new EgressService({
      token: TOKEN.toString('hex'),
      network: network(mode),
      auditPath: path.join(dir, 'audit.jsonl'),
      // As the internet answers: the names the flows below claim resolve to where they go.
      resolve: async (n: string) => (['api.github.com', 'elsewhere.example.com'].includes(n) ? ['93.184.216.34'] : []),
      onDecision: (d) => decisions.push(d),
      ...over,
    });
    const address = await svc.listen();
    return { address, decisions };
  }
  function ask(address: string, buf: Buffer): Promise<number | 'closed'> {
    const [host, port] = address.split(':');
    return new Promise((resolve) => {
      const s = net.connect(Number(port), host, () => s.write(buf));
      s.once('data', (d) => { resolve(d[0]); s.destroy(); });
      s.once('close', () => resolve('closed'));
      s.once('error', () => resolve('closed'));
    });
  }

  it('listens on the loopback only', async () => {
    const { address } = await start('enforce');
    expect(address).toMatch(/^127\.0\.0\.1:\d+$/);
  });

  it('answers 0 for an allowed flow and 1 for a refused one, and reports both', async () => {
    const { address, decisions } = await start('enforce');
    expect(await ask(address, frame({ payload: clientHello('api.github.com') }))).toBe(0);
    expect(await ask(address, frame({ payload: clientHello('elsewhere.example.com') }))).toBe(1);
    expect(decisions.map((d) => [d.host, d.decision])).toEqual([['api.github.com', 'allow'], ['elsewhere.example.com', 'deny']]);
  });

  // Story review 2 (LIFE-2): a policy changed while the machine runs reaches its decider.
  it('decides by the network it is given while it runs', async () => {
    const { address } = await start('enforce');
    expect(await ask(address, frame({ payload: clientHello('api.github.com') }))).toBe(0);
    svc!.setNetwork({ ...network('enforce'), allow: [] });
    expect(await ask(address, frame({ payload: clientHello('api.github.com') }))).toBe(1);
  });

  it('allows nothing on a wrong token: closes without an answer, and reports nothing', async () => {
    const { address, decisions } = await start('observe');
    expect(await ask(address, frame({ token: Buffer.alloc(32, 9), payload: clientHello('api.github.com') }))).toBe('closed');
    expect(decisions).toEqual([]);
  });

  it('closes a connection that never sends a whole flow', async () => {
    const { address } = await start('observe', { headerTimeoutMs: 100 });
    expect(await ask(address, Buffer.from(FLOW_MAGIC, 'latin1'))).toBe('closed');
  });

  it('names a raw TCP flow from a name the guest looked up, read from smolvm\'s audit', async () => {
    const auditPath = path.join(dir, 'audit.jsonl');
    const { address, decisions } = await start('enforce', { auditPath, resolve: async (n: string) => (n === 'db.example.com' ? ['93.184.216.34'] : []) });
    fs.appendFileSync(auditPath, `${JSON.stringify({ transport: 'dns', action: 'allow', destination: 'db.example.com', reason: 'local_policy' })}\n`);
    expect(await ask(address, frame({ port: 5432, payload: Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]) }))).toBe(0);
    expect(decisions[0]).toEqual({ host: 'db.example.com', port: 5432, decision: 'allow', rule: 'allow-list' });
  });

  it('reports smolvm\'s own refusals as they are appended to its audit', async () => {
    const auditPath = path.join(dir, 'audit.jsonl');
    fs.writeFileSync(auditPath, `${JSON.stringify({ transport: 'dns', action: 'deny', destination: 'old.example.com', reason: 'local_policy' })}\n`);
    const { decisions } = await start('enforce', { auditPath, auditPollMs: 10 });
    fs.appendFileSync(auditPath, `${JSON.stringify({ transport: 'dns', action: 'deny', destination: 'github.com', reason: 'local_policy' })}\n`);
    await vi.waitFor(() => expect(decisions.map((d) => d.host)).toContain('github.com'));
    // What the audit held before the service started is not this machine run's.
    expect(decisions.map((d) => d.host)).not.toContain('old.example.com');
  });

  // Story review 3: the host resolving a name the guest chose is a lookup the guest's DNS policy
  // never sees - an exfiltration channel (<secret>.attacker.example). Only a name the policy could
  // allow is resolved.
  it('never resolves a claimed name the policy cannot allow: not denied ones, not ones off the list', async () => {
    const asked: string[] = [];
    const { address, decisions } = await start('enforce', { resolve: async (n: string) => { asked.push(n); return n === 'api.github.com' ? ['93.184.216.34'] : []; } });
    for (const name of ['c2VjcmV0.attacker.example', 'x.evil.example.net', 'evil.example.net']) {
      expect(await ask(address, frame({ payload: clientHello(name) }))).toBe(1);
      expect(await ask(address, frame({ payload: Buffer.from(`GET / HTTP/1.1\r\nHost: ${name}\r\n\r\n`) }))).toBe(1);
    }
    expect(asked.filter((n) => /attacker|evil/.test(n))).toEqual([]);
    expect(decisions.map((d) => d.decision)).toEqual(Array(6).fill('deny'));
    // an allowed claim is still checked against where the flow goes
    expect(await ask(address, frame({ payload: clientHello('api.github.com') }))).toBe(0);
    expect(asked).toContain('api.github.com');
  });

  it('observe: reports a claimed name without resolving it on the host', async () => {
    const asked: string[] = [];
    const { address, decisions } = await start('observe', { resolve: async (n: string) => { asked.push(n); return []; } });
    expect(await ask(address, frame({ payload: clientHello('c2VjcmV0.attacker.example') }))).toBe(0);
    expect(asked.filter((n) => /attacker/.test(n))).toEqual([]);
    expect(decisions[0]).toMatchObject({ host: 'c2vjcmv0.attacker.example', decision: 'allow' });
  });

  it('a TLS server name off the list is refused on an address an allowed name shares', async () => {
    const { address, decisions } = await start('enforce', { resolve: async (n: string) => (['api.github.com', 'evil.cdn.example'].includes(n) ? ['93.184.216.34'] : []) });
    // the guest looked up the allowed name, then claims another one served at the same address
    fs.appendFileSync(path.join(dir, 'audit.jsonl'), `${JSON.stringify({ transport: 'dns', action: 'allow', destination: 'api.github.com', reason: 'local_policy' })}\n`);
    expect(await ask(address, frame({ payload: clientHello('evil.cdn.example') }))).toBe(1);
    expect(decisions[0]).toMatchObject({ host: 'api.github.com', decision: 'deny', rule: 'not-on-allow-list' });
  });

  it('does not believe a claimed name that resolves elsewhere: it cannot borrow another allowed name\'s port', async () => {
    // db.example.com:5432 is allowed; the flow goes to another address on 5432, claiming that name.
    const { address, decisions } = await start('enforce', { resolve: async (n: string) => (n === 'db.example.com' ? ['10.9.8.7'] : []) });
    const spoofed = Buffer.from('GET / HTTP/1.1\r\nHost: db.example.com\r\n\r\n');
    expect(await ask(address, frame({ port: 5432, payload: spoofed }))).toBe(1);
    expect(decisions[0]).toMatchObject({ host: 'db.example.com', decision: 'deny', rule: 'unverified-name' });
    // The same claim to the name's own address is believed.
    expect(await ask(address, frame({ port: 5432, ip: [10, 9, 8, 7], payload: spoofed }))).toBe(0);
  });

  it('holds a port-restricted host to its ports whatever name a flow to its address claims', async () => {
    // db.example.com (10.9.8.7) is allowed on 5432 only; a flow there on 22 claims api.github.com, allowed on every port.
    const { address, decisions } = await start('enforce', { resolve: async (n: string) => (n === 'db.example.com' ? ['10.9.8.7'] : []) });
    expect(await ask(address, frame({ port: 22, ip: [10, 9, 8, 7], payload: clientHello('api.github.com') }))).toBe(1);
    expect(decisions[0]).toMatchObject({ host: 'db.example.com', decision: 'deny', rule: 'not-on-allow-list' });
  });

  it('allows a claimed name it cannot confirm by an entry without a port: a CDN answers the host and the guest differently', async () => {
    const { address, decisions } = await start('enforce', { resolve: async () => ['198.51.100.1'] });
    expect(await ask(address, frame({ payload: clientHello('api.github.com') }))).toBe(0);
    expect(decisions[0]).toMatchObject({ host: 'api.github.com', decision: 'allow', rule: 'allow-list' });
  });

  it('refuses a flow whose decision cannot be recorded, and reports the refusal it sent', async () => {
    const { address, decisions } = await start('enforce', { record: () => { throw new Error('disk full'); } });
    expect(await ask(address, frame({ payload: clientHello('api.github.com') }))).toBe(1);
    expect(decisions).toEqual([{ host: 'api.github.com', port: 443, decision: 'deny', rule: 'not-recorded' }]);
  });

  it('cuts the flows still open when it closes, rather than waiting for them', async () => {
    const { address } = await start('observe', { headerTimeoutMs: 60_000 });
    const [host, port] = address.split(':');
    const sock = net.connect(Number(port), host, () => sock.write(Buffer.from(FLOW_MAGIC, 'latin1')));
    sock.on('error', () => undefined);
    await new Promise((r) => sock.once('connect', r));
    await new Promise((r) => setTimeout(r, 20));
    const t = Date.now();
    await svc!.close();
    svc = null;
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it('records each decision before answering', async () => {
    const recorded: ProxyDecision[] = [];
    const { address } = await start('enforce', { record: (d: ProxyDecision) => { recorded.push(d); } });
    expect(await ask(address, frame({ payload: clientHello('api.github.com') }))).toBe(0);
    expect(recorded).toEqual([{ host: 'api.github.com', port: 443, decision: 'allow', rule: 'allow-list' }]);
  });

  it('reads smolvm\'s last refusals when it closes', async () => {
    const auditPath = path.join(dir, 'audit.jsonl');
    const { decisions } = await start('enforce', { auditPath, auditPollMs: 60_000 });
    fs.appendFileSync(auditPath, `${JSON.stringify({ transport: 'dns', action: 'deny', destination: 'last.example.com', reason: 'local_policy' })}\n`);
    await svc!.close();
    svc = null;
    expect(decisions.map((d) => d.host)).toContain('last.example.com');
  });

  // Routes are Unix sockets: macOS and Linux only (Airlock refuses Windows).
  describe.skipIf(process.platform === 'win32')('routes: redirecting a flow to a service of the launcher', () => {
    let upstream: net.Server;
    let sock: string;
    let got: Buffer;
    const upstreamPort = 41123;
    beforeEach(async () => {
      got = Buffer.alloc(0);
      sock = path.join(dir, 'r.sock');
      upstream = net.createServer((s) => {
        s.on('data', (d) => {
          got = Buffer.concat([got, d]);
          if (got.toString().includes('PING')) s.write('PONG');
        });
      });
      await new Promise<void>((r) => upstream.listen(sock, () => r()));
    });
    afterEach(async () => { await new Promise<void>((r) => upstream.close(() => r())); });

    /** A flow whose answer is 2: the connection then carries the guest's stream. */
    function redirected(address: string, buf: Buffer, more: string): Promise<{ answer: number; reply: string }> {
      const [host, port] = address.split(':');
      return new Promise((resolve) => {
        let answer = -1;
        let reply = '';
        const s = net.connect(Number(port), host, () => s.write(buf));
        s.on('data', (d) => {
          if (answer < 0) {
            answer = d[0];
            reply += d.subarray(1).toString();
            if (answer === 2) s.write(more);
            else { s.destroy(); resolve({ answer, reply }); }
          } else reply += d.toString();
          if (reply.includes('PONG')) { s.destroy(); resolve({ answer, reply }); }
        });
        s.on('close', () => resolve({ answer, reply }));
        s.on('error', () => resolve({ answer, reply }));
      });
    }
    const gw = GATEWAY.split('.').map(Number);

    it('relays a flow to the gateway on a relay port to that port on the host loopback, first bytes first', async () => {
      const routes: Route[] = [{ kind: 'relay', port: upstreamPort, socket: sock }];
      const { address, decisions } = await start('enforce', { routes: () => routes });
      const r = await redirected(address, frame({ ip: gw, port: upstreamPort, payload: Buffer.from('GET /items ') }), 'PING');
      expect(r.answer).toBe(2);
      expect(r.reply).toBe('PONG');
      expect(got.toString()).toBe('GET /items PING');
      // Plumbing, not the agent's network: not reported.
      expect(decisions).toEqual([]);
    });

    it('refuses the gateway on any port no session relays, and reports it', async () => {
      const { address, decisions } = await start('observe', { routes: () => [{ kind: 'relay', port: upstreamPort, socket: sock }] });
      expect(await ask(address, frame({ ip: gw, port: 3000 }))).toBe(1);
      expect(decisions).toEqual([{ host: GATEWAY, port: 3000, decision: 'deny', rule: 'host-not-relayed' }]);
    });

    it('redirects a TLS flow to an inference host to the key injector, and reports it allowed', async () => {
      const routes: Route[] = [{ kind: 'inject', host: 'api.github.com', port: 443, socket: sock }];
      const { address, decisions } = await start('enforce', { routes: () => routes });
      const hello = clientHello('api.github.com');
      const r = await redirected(address, frame({ port: 443, payload: hello }), 'PING');
      expect(r.answer).toBe(2);
      // The address it approved first (story review 2: the injector connects there, never by name
      // again), then the flow's first bytes.
      const preface = Buffer.from('AGENFK-DEST 93.184.216.34\n');
      expect(got.subarray(0, preface.length).toString()).toBe(preface.toString());
      expect(got.subarray(preface.length, preface.length + hello.length).equals(hello)).toBe(true);
      expect(decisions[0]).toMatchObject({ host: 'api.github.com', port: 443, decision: 'allow' });
    });

    it('does not redirect a flow the policy refuses, even to an inference host', async () => {
      const routes: Route[] = [{ kind: 'inject', host: 'evil.example.net', port: 443, socket: sock }];
      const { address } = await start('enforce', { routes: () => routes });
      expect(await ask(address, frame({ port: 443, payload: clientHello('evil.example.net') }))).toBe(1);
      expect(got.length).toBe(0);
    });

    it('refuses a flow whose route\'s launcher is gone: its socket is dead, and nothing else can be there', async () => {
      const dead = path.join(dir, 'dead.sock');
      const routes: Route[] = [{ kind: 'relay', port: 41200, socket: dead }];
      const { address } = await start('enforce', { routes: () => routes });
      const r = await redirected(address, frame({ ip: gw, port: 41200 }), 'PING');
      expect(r.answer).not.toBe(2);
    });

    it('passes over a route whose launcher is gone to one that is live', async () => {
      const dead = path.join(dir, 'dead.sock');
      const routes: Route[] = [
        { kind: 'inject', host: 'api.github.com', port: 443, socket: dead },
        { kind: 'inject', host: 'api.github.com', port: 443, socket: sock },
      ];
      const { address } = await start('enforce', { routes: () => routes });
      const r = await redirected(address, frame({ port: 443, payload: clientHello('api.github.com') }), 'PING');
      expect(r.answer).toBe(2);
      expect(r.reply).toBe('PONG');
    });

    // a9bc650c: a model server on the host's loopback, reached from the machine through the gateway
    // (the guest's loopback port is redirected there).
    const withLoopback = (mode: 'observe' | 'enforce') => ({ ...network(mode), allow: [...network(mode).allow, 'localhost:18888'] });

    it('carries a flow to the gateway on a loopback inference port to its route, and reports it allowed', async () => {
      const routes: Route[] = [{ kind: 'forward', host: 'localhost', port: 18888, socket: sock }];
      const { address, decisions } = await start('enforce', { network: withLoopback('enforce'), routes: () => routes });
      const r = await redirected(address, frame({ ip: gw, port: 18888, payload: Buffer.from('GET /v1 ') }), 'PING');
      expect(r.answer).toBe(2);
      expect(r.reply).toBe('PONG');
      expect(got.toString()).toBe('GET /v1 PING');
      expect(decisions).toEqual([{ host: 'localhost', port: 18888, decision: 'allow', rule: 'allow-list' }]);
    });

    // The policy's deny side holds (it can change while the machine runs); the allow is the route's:
    // its session's own model, allowed when it launched.
    it('refuses a loopback inference flow the policy does not allow, and reports it', async () => {
      const routes: Route[] = [{ kind: 'forward', host: 'localhost', port: 18888, socket: sock }];
      const denying = { ...withLoopback('enforce'), deny: [...network('enforce').deny, 'localhost'] };
      const { address, decisions } = await start('enforce', { network: denying, routes: () => routes });
      expect(await ask(address, frame({ ip: gw, port: 18888, payload: Buffer.from('GET /v1 ') }))).toBe(1);
      expect(got.length).toBe(0);
      expect(decisions).toEqual([{ host: 'localhost', port: 18888, decision: 'deny', rule: 'deny-list' }]);
    });

    it('carries the loopback endpoint of a session that shares the machine, which the machine\'s network (another session\'s) does not name', async () => {
      const routes: Route[] = [{ kind: 'forward', host: '127.0.0.1', port: 18889, socket: sock }];
      const { address, decisions } = await start('enforce', { network: withLoopback('enforce'), routes: () => routes });
      const r = await redirected(address, frame({ ip: gw, port: 18889, payload: Buffer.from('GET /v1 ') }), 'PING');
      expect(r.answer).toBe(2);
      expect(decisions).toEqual([{ host: '127.0.0.1', port: 18889, decision: 'allow', rule: 'allow-list' }]);
    });

    it('hands a keyed TLS flow to a loopback inference host to the key injector, told the host loopback', async () => {
      const routes: Route[] = [{ kind: 'inject', host: 'localhost', port: 18888, socket: sock }];
      const { address } = await start('enforce', { network: withLoopback('enforce'), routes: () => routes });
      const hello = clientHello('localhost');
      const r = await redirected(address, frame({ ip: gw, port: 18888, payload: hello }), 'PING');
      expect(r.answer).toBe(2);
      const preface = Buffer.from('AGENFK-DEST 127.0.0.1\n');
      expect(got.subarray(0, preface.length).toString()).toBe(preface.toString());
      expect(got.subarray(preface.length, preface.length + hello.length).equals(hello)).toBe(true);
    });

    // Story review (Codex): the guest's 127.0.0.1:P and 127.0.0.2:P both arrive as the gateway's P, so
    // which one was meant cannot be told: refused, never carried to a destination it was not judged for.
    it('refuses a gateway port whose loopback routes name different destinations, carrying nothing', async () => {
      const routes: Route[] = [
        { kind: 'forward', host: '127.0.0.1', port: 18888, socket: path.join(dir, 'gone.sock') },
        { kind: 'forward', host: '127.0.0.2', port: 18888, socket: sock },
      ];
      const { address, decisions } = await start('observe', { routes: () => routes });
      expect(await ask(address, frame({ ip: gw, port: 18888, payload: Buffer.from('GET /v1 ') }))).toBe(1);
      expect(got.length).toBe(0);
      expect(decisions).toEqual([{ host: GATEWAY, port: 18888, decision: 'deny', rule: 'loopback-port-conflict' }]);
    });

    it('does not hand a gateway flow to an inference host off the loopback on that port', async () => {
      const routes: Route[] = [{ kind: 'inject', host: 'api.github.com', port: 18888, socket: sock }];
      const { address, decisions } = await start('observe', { routes: () => routes });
      expect(await ask(address, frame({ ip: gw, port: 18888, payload: Buffer.from('GET /v1 ') }))).toBe(1);
      expect(got.length).toBe(0);
      expect(decisions).toEqual([{ host: GATEWAY, port: 18888, decision: 'deny', rule: 'host-not-relayed' }]);
    });

    it('does not redirect an inference host on another port', async () => {
      const routes: Route[] = [{ kind: 'inject', host: 'api.github.com', port: 443, socket: sock }];
      const { address } = await start('enforce', { routes: () => routes });
      expect(await ask(address, frame({ port: 8443, payload: clientHello('api.github.com') }))).toBe(0);
      expect(got.length).toBe(0);
    });
  });

  // 85d37bd5: the machine resolver's refusals, sent to the gateway on its own port.
  describe('the machine resolver\'s refusals', () => {
    const gw = GATEWAY.split('.').map(Number);
    const report = (token: string, entries: string[]) => Buffer.from(`AGENFK-DNS ${token}\n${entries.join('\n')}\n`);

    it('records and reports each refusal sent under the machine\'s resolver token, as a lookup refused; answers 1', async () => {
      const recorded: ProxyDecision[] = [];
      const { address, decisions } = await start('enforce', { record: (d) => { recorded.push(d); } });
      const payload = report(resolverTokenOf(TOKEN.toString('hex')), ['{"name":"evil.example.net","rule":"deny-list"}', '{"name":"nextjs.org","rule":"not-on-allow-list"}', '{"dropped":4}']);
      expect(await ask(address, frame({ ip: gw, port: RESOLVER_REPORT_PORT, payload }))).toBe(1);
      const expected = [
        { host: 'evil.example.net', port: null, decision: 'deny', rule: 'deny-list' },
        { host: 'nextjs.org', port: null, decision: 'deny', rule: 'not-on-allow-list' },
        { host: '*', port: null, decision: 'deny', rule: 'resolver-overflow:4' },
      ];
      expect(decisions).toEqual(expected);
      expect(recorded).toEqual(expected);
    });

    it('takes nothing from a report under another token: that port is refused as any other', async () => {
      const { address, decisions } = await start('observe');
      const payload = report('f'.repeat(64), ['{"name":"framed.example","rule":"deny-list"}']);
      expect(await ask(address, frame({ ip: gw, port: RESOLVER_REPORT_PORT, payload }))).toBe(1);
      expect(decisions).toEqual([{ host: GATEWAY, port: RESOLVER_REPORT_PORT, decision: 'deny', rule: 'host-not-relayed' }]);
    });

    it('skips what is not a refusal: no host name, a rule it does not know, not JSON', async () => {
      const { address, decisions } = await start('enforce');
      const payload = report(resolverTokenOf(TOKEN.toString('hex')), ['{"name":"a b","rule":"deny-list"}', '{"name":"x.example","rule":"allow"}', 'junk', '{"dropped":"lots"}', '{"name":"ok.example","rule":"deny-list"}']);
      expect(await ask(address, frame({ ip: gw, port: RESOLVER_REPORT_PORT, payload }))).toBe(1);
      expect(decisions).toEqual([{ host: 'ok.example', port: null, decision: 'deny', rule: 'deny-list' }]);
    });
  });

  it('a decision hook that throws changes no answer', async () => {
    const { address } = await start('enforce', { onDecision: () => { throw new Error('boom'); } });
    expect(await ask(address, frame({ payload: clientHello('api.github.com') }))).toBe(0);
  });
});

describe('readRoutes', () => {
  it('reads only routes to a Unix socket path, nothing else in the dir', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-routes-'));
    try {
      fs.writeFileSync(path.join(d, 'a.json'), JSON.stringify({ kind: 'relay', port: 41000, socket: '/tmp/x.sock' }));
      fs.writeFileSync(path.join(d, 'b.json'), JSON.stringify({ kind: 'relay', port: 41001 }));
      fs.writeFileSync(path.join(d, 'c.json'), JSON.stringify({ kind: 'inject', host: 'a.example', port: 443, socket: 'relative.sock' }));
      fs.writeFileSync(path.join(d, 'd.json'), 'nonsense');
      expect(readRoutes(d)).toEqual([{ kind: 'relay', port: 41000, socket: '/tmp/x.sock' }]);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  // a9bc650c: a forward route reaches the host's loopback, and nothing else.
  it('reads a forward route only to a loopback host', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-routes-'));
    try {
      fs.writeFileSync(path.join(d, 'a.json'), JSON.stringify({ kind: 'forward', host: '127.0.0.1', port: 18888, socket: '/tmp/x.sock' }));
      fs.writeFileSync(path.join(d, 'b.json'), JSON.stringify({ kind: 'forward', host: 'api.github.com', port: 443, socket: '/tmp/y.sock' }));
      fs.writeFileSync(path.join(d, 'c.json'), JSON.stringify({ kind: 'forward', host: '10.0.0.1', port: 80, socket: '/tmp/z.sock' }));
      expect(readRoutes(d)).toEqual([{ kind: 'forward', host: '127.0.0.1', port: 18888, socket: '/tmp/x.sock' }]);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('writeAll: the decision log line, whole or a failure', () => {
  it('writes on after a short write', () => {
    const chunks: string[] = [];
    const write = ((_fd: number, b: Buffer, off: number, len: number) => { const n = Math.min(3, len); chunks.push(b.toString('utf8', off, off + n)); return n; }) as unknown as typeof fs.writeSync;
    writeAll(1, Buffer.from('{"a":1}\n'), write);
    expect(chunks.join('')).toBe('{"a":1}\n');
  });

  it('throws when the log takes no more bytes', () => {
    const write = (() => 0) as unknown as typeof fs.writeSync;
    expect(() => writeAll(1, Buffer.from('x'), write)).toThrow(/no more bytes/);
  });
});

// The decider process, its private files and route sockets: macOS and Linux only (Airlock refuses Windows).
describe.skipIf(process.platform === 'win32')('HelperEgressBroker: one decider per running machine, outliving the session that started it', () => {
  let stateDir: string;
  // /tmp, not os.tmpdir(): macOS's is long, and route sockets are Unix socket paths (at most ~100 bytes).
  beforeEach(() => { stateDir = fs.mkdtempSync(path.join('/tmp', 'agenfk-broker-')); });
  afterEach(() => { fs.rmSync(stateDir, { recursive: true, force: true }); });

  function broker(over: Record<string, unknown> = {}) {
    const started: Array<{ machine: string; configPath: string }> = [];
    const killed: number[] = [];
    const b = new HelperEgressBroker({
      stateDir,
      auditPathOf: async (machine) => path.join(stateDir, `${machine}-audit.jsonl`),
      startHelper: async (machine, configPath) => {
        started.push({ machine, configPath });
        const dir = path.dirname(configPath);
        fs.writeFileSync(path.join(dir, 'address'), '127.0.0.1:47123');
        fs.writeFileSync(path.join(dir, 'follows-network'), '');
        return 4242;
      },
      pidAlive: (pid) => pid === 4242 && !killed.includes(pid),
      kill: (pid: number) => { killed.push(pid); },
      // The decider is the process started with its machine's config.
      commandLineOf: (pid: number) => (pid === 4242 && started.length ? `/usr/bin/node /x/egressMain.js ${started.at(-1)!.configPath}` : null),
      ...over,
    });
    return { b, started, killed };
  }
  const spec = { network: network('enforce') } as SandboxSpec;

  it('starts a decider with a fresh 64-hex token, kept in a file only the user can read, never on a command line', async () => {
    const { b, started } = broker();
    const r = await b.ensure('agenfk-m1', spec);
    expect(r.address).toBe('127.0.0.1:47123');
    expect(r.token).toMatch(/^[0-9a-f]{64}$/);
    const cfgPath = started[0].configPath;
    expect((fs.statSync(cfgPath).mode & 0o777).toString(8)).toBe('600');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    expect(cfg.token).toBe(r.token);
    expect(cfg.network).toEqual(spec.network);
    expect(cfg.auditPath).toBe(path.join(stateDir, 'agenfk-m1-audit.jsonl'));
  });

  // 85d37bd5: the token the machine's resolver reports under, derived from the running decider's.
  it('gives the resolver token of the machine\'s running decider, and none without one', async () => {
    const { b } = broker();
    expect(b.resolverToken('agenfk-m1')).toBeNull();
    const r = await b.ensure('agenfk-m1', spec);
    expect(b.resolverToken('agenfk-m1')).toBe(resolverTokenOf(r.token));
    expect(resolverTokenOf(r.token)).toMatch(/^[0-9a-f]{64}$/);
    expect(resolverTokenOf(r.token)).not.toBe(r.token);
  });

  it('does not reuse a running decider made for another policy (one a crash left before its machine started): it starts one for this (story review)', async () => {
    const { b, started, killed } = broker();
    await b.ensure('agenfk-m1', spec);
    const other = { network: { ...network('enforce'), allow: ['example.org'] } } as SandboxSpec;
    await b.ensure('agenfk-m1', other);
    expect(started).toHaveLength(2);
    expect(killed).toEqual([4242]);
    expect(JSON.parse(fs.readFileSync(started[1].configPath, 'utf8')).network).toEqual(other.network);
  });

  // Story review 2 (LIFE-3): after a crash or a reboot the recorded pid can be anyone's.
  it('never takes another process for the decider (a pid reused after a crash or reboot): not reused, never signalled', async () => {
    const { b, started, killed } = broker({ commandLineOf: () => '/Applications/Some.app/Contents/MacOS/Some' });
    await b.ensure('agenfk-m1', spec);
    await b.ensure('agenfk-m1', spec);
    expect(started).toHaveLength(2);
    await b.stop('agenfk-m1');
    expect(killed).toEqual([]);
  });

  it('hands the running decider a changed policy through its config, keeping its token and the file the user\'s alone', async () => {
    const { b, started } = broker();
    const r = await b.ensure('agenfk-m1', spec);
    const changed = { ...network('enforce'), deny: ['evil.example'] };
    await b.updateNetwork('agenfk-m1', changed);
    const cfgPath = started[0].configPath;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    expect(cfg.network).toEqual(changed);
    expect(cfg.token).toBe(r.token);
    expect((fs.statSync(cfgPath).mode & 0o777).toString(8)).toBe('600');
    expect(started).toHaveLength(1);
  });

  it('refuses to hand a policy to a decider that cannot follow it (an older AgEnFK\'s)', async () => {
    const { b, started } = broker();
    await b.ensure('agenfk-m1', spec);
    fs.rmSync(path.join(path.dirname(started[0].configPath), 'follows-network'));
    await expect(b.updateNetwork('agenfk-m1', { ...network('enforce'), deny: ['evil.example'] })).rejects.toMatchObject({ cannotFollow: true });
  });

  it('the decider follows its config: a changed network is set, a broken file changes nothing', async () => {
    const cfgPath = path.join(stateDir, 'follow.json');
    const base = { token: 't', network: network('enforce'), auditPath: null, decisionsPath: 'd', addressPath: 'a', routesDir: 'r' };
    fs.writeFileSync(cfgPath, JSON.stringify(base));
    const set: unknown[] = [];
    const stop = followNetwork(cfgPath, { setNetwork: (n: unknown) => set.push(n) }, 10);
    try {
      await new Promise((r) => setTimeout(r, 60));
      expect(set).toEqual([]);
      const changed = { ...network('enforce'), deny: ['evil.example'] };
      fs.writeFileSync(cfgPath, JSON.stringify({ ...base, network: changed }));
      await vi.waitFor(() => expect(set).toEqual([changed]));
      fs.writeFileSync(cfgPath, '{"network": ');
      await new Promise((r) => setTimeout(r, 60));
      expect(set).toHaveLength(1);
    } finally {
      stop();
    }
  });

  it('reuses a running decider for the same policy, whatever relay port a session has', async () => {
    const { b, started } = broker();
    await b.ensure('agenfk-m1', { network: { ...network('enforce'), allow: ['api.github.com', '127.0.0.1:4000', 'localhost:4000'] } } as SandboxSpec);
    await b.ensure('agenfk-m1', { network: { ...network('enforce'), allow: ['api.github.com', '127.0.0.1:5000', 'localhost:5000'] } } as SandboxSpec);
    expect(started).toHaveLength(1);
  });

  it('gives each start a new token', async () => {
    const { b } = broker();
    const a = await b.ensure('agenfk-m1', spec);
    await b.stop('agenfk-m1');
    const c = await b.ensure('agenfk-m1', spec);
    expect(c.token).not.toBe(a.token);
  });

  it('hands decisions the decider writes to every session watching the machine, from when it starts watching', async () => {
    const { b } = broker();
    await b.ensure('agenfk-m1', spec);
    const log = path.join(stateDir, 'egress', 'agenfk-m1', 'decisions.jsonl');
    fs.appendFileSync(log, `${JSON.stringify({ host: 'before.example.com', port: 443, decision: 'allow', rule: 'allow-list' })}\n`);
    const seen: string[] = [];
    const off = b.watch('agenfk-m1', (d) => seen.push(d.host), { pollMs: 10 });
    fs.appendFileSync(log, `${JSON.stringify({ host: 'api.github.com', port: 443, decision: 'allow', rule: 'allow-list' })}\n`);
    fs.appendFileSync(log, 'not json\n');
    await vi.waitFor(() => expect(seen).toEqual(['api.github.com']));
    off();
    fs.appendFileSync(log, `${JSON.stringify({ host: 'after.example.com', port: 443, decision: 'allow', rule: 'allow-list' })}\n`);
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual(['api.github.com']);
  });

  it('stop ends the decider and waits for it, keeping only its decisions for sessions still reading them', async () => {
    let alive = true;
    let checksAfterKill = 0;
    const { b, killed } = broker({
      pidAlive: () => { if (killed.length) checksAfterKill++; if (checksAfterKill > 3) alive = false; return alive; },
    });
    await b.ensure('agenfk-m1', spec);
    const dir = path.join(stateDir, 'egress', 'agenfk-m1');
    fs.writeFileSync(path.join(dir, 'decisions.jsonl'), '');
    await b.stop('agenfk-m1');
    expect(killed).toEqual([4242]);
    expect(alive).toBe(false);
    expect(fs.readdirSync(dir)).toEqual(['decisions.jsonl']);
  });

  it('kills a decider that ignores SIGTERM, and keeps its record when even that fails', async () => {
    const signals: string[] = [];
    let dies = true;
    const { b } = broker({
      stopTimeoutMs: 50,
      pidAlive: () => !(dies && signals.includes('SIGKILL')),
      kill: (_pid: number, sig: string) => { signals.push(sig); },
    });
    await b.ensure('agenfk-m1', spec);
    await b.stop('agenfk-m1');
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(fs.existsSync(path.join(stateDir, 'egress', 'agenfk-m1', 'pid'))).toBe(false);
    signals.length = 0;
    dies = false;
    await b.ensure('agenfk-m2', spec);
    await expect(b.stop('agenfk-m2')).rejects.toThrow(/did not end/);
    expect(fs.existsSync(path.join(stateDir, 'egress', 'agenfk-m2', 'pid'))).toBe(true);
  });

  it('adds a route for the decider to read, and takes it away again', async () => {
    const { b } = broker();
    await b.ensure('agenfk-m1', spec);
    const routesDir = JSON.parse(fs.readFileSync(path.join(stateDir, 'egress', 'agenfk-m1', 'config.json'), 'utf8')).routesDir;
    const socket = b.routeSocket('agenfk-m1');
    // A directory of its own, only the user's, and a path short enough for a Unix socket.
    expect((fs.statSync(path.dirname(socket)).mode & 0o777).toString(8)).toBe('700');
    expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(100);
    const remove = b.addRoute('agenfk-m1', { kind: 'relay', port: 41000, socket });
    const files = fs.readdirSync(routesDir).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(routesDir, files[0]), 'utf8'))).toEqual({ kind: 'relay', port: 41000, socket });
    remove();
    expect(fs.readdirSync(routesDir).filter((f) => f.endsWith('.json'))).toEqual([]);
    expect(fs.existsSync(path.dirname(socket))).toBe(false);
  });

  it('refuses when the decider does not come up, and leaves nothing running', async () => {
    const { b, killed } = broker({ startHelper: async () => 4242, readyTimeoutMs: 100, commandLineOf: () => `node egressMain.js ${path.join(stateDir, 'egress', 'agenfk-m1', 'config.json')}` });
    await expect(b.ensure('agenfk-m1', spec)).rejects.toThrow(/decider/);
    expect(killed).toEqual([4242]);
  });
});

// The real smolvm and the real decider process (the built egressMain.js), where they can run.
const smolvmHere = smolvmTestsEnabled();
/** The AgEnFK base image (docker save), which enforce needs since CGLAB-696 task 8: node and iptables for the machine's resolver. */
const baseImage = process.env.AGENFK_AIRLOCK_TEST_IMAGE;

describe.skipIf(!smolvmHere || !baseImage)('egress against the real smolvm (AGENFK_SMOLVM_TESTS=1, AGENFK_AIRLOCK_TEST_IMAGE, after npm run build)', () => {
  it('enforce: an allowed name works, an unlisted name does not resolve, an address is dropped, and each is reported', async () => {
    const { SmolvmRuntime } = await import('../airlock/smolvm');
    const root = fs.realpathSync(fs.mkdtempSync(path.join(vmTestBase(), 'agenfk-egress-vm-')));
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'repo');
    fs.mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    // smolvm keeps its sockets under HOME, and a vitest worker's sandbox HOME is past the socket path limit.
    const sandboxHome = process.env.HOME;
    process.env.HOME = os.userInfo().homedir;
    const stateDir = path.join(root, 'state');
    const broker = realBroker(stateDir);
    const rt = new SmolvmRuntime({ image: baseImage!, egress: broker, stateDir, isTTY: false, hostEnv: {} });
    const spec = buildSandboxSpec(normalizeAirlockPolicy({ mode: 'enforce', hosts: { allow: ['nextjs.org'] } }), {
      client: 'pi', home, workspace, tempDirs: [], inferenceHosts: ['api.openai.com'], serverPort: 3123, installDirs: [],
    });
    const seen: ProxyDecision[] = [];
    try {
      const out = path.join(workspace, 'probe.out');
      const probe = [
        'curl -s -o /dev/null --max-time 15 https://nextjs.org && echo allowed-ok || echo allowed-failed',
        'getent hosts github.com >/dev/null 2>&1 && echo unlisted-resolved || echo unlisted-refused',
        'curl -sk -o /dev/null --max-time 10 https://1.1.1.1/ && echo literal-open || echo literal-refused',
      ].join('; ');
      const launched = await rt.launch(spec, { file: 'sh', args: ['-c', `(${probe}) > ${out} 2>&1`], cwd: workspace }, { onProxyDecision: (d) => seen.push(d) });
      expect((await launched.exited).code).toBe(0);
      expect(fs.readFileSync(out, 'utf8').trim().split('\n')).toEqual(['allowed-ok', 'unlisted-refused', 'literal-refused']);
      expect(seen).toContainEqual(expect.objectContaining({ host: 'nextjs.org', decision: 'allow', rule: 'allow-list' }));
      expect(seen).toContainEqual(expect.objectContaining({ host: 'github.com', decision: 'deny', rule: 'not-on-allow-list' }));
      expect(seen).toContainEqual(expect.objectContaining({ host: '1.1.1.1', port: 443, decision: 'deny' }));
      // The decider ended with the machine: only its decisions are left, for late readers.
      const deciders = path.join(stateDir, 'egress');
      for (const m of fs.readdirSync(deciders)) expect(fs.readdirSync(path.join(deciders, m))).toEqual(['decisions.jsonl']);
    } finally {
      await rt.reset(workspace).catch(() => undefined);
      await rt.dispose();
      process.env.HOME = sandboxHome;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 240_000);
});
