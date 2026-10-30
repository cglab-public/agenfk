/**
 * CGLAB-696 task 8: the resolver Airlock runs inside the machine (user decision 2026-10-30).
 * smolvm cannot refuse a DNS name, so a lookup of a denied or IOC name would leave the machine
 * (a DNS exfiltration channel, observe mode included). The guest's resolv.conf points at this
 * resolver instead: it answers a denied name NXDOMAIN without asking anyone and passes every other
 * question to smolvm's resolver, over UDP and TCP. It runs on the image's node from its own file,
 * so it may need nothing but Node's built-ins.
 */
import { describe, it, expect, afterEach } from 'vitest';
import dgram from 'dgram';
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { questionName, nameDenied, refusalOf, startResolver, followConfig, type Resolver, type ResolverConfig } from '../airlock/guestDns';

/** A DNS query for `name` (type A), as a stub resolver sends it. */
function query(name: string, id = 0x1234): Buffer {
  const labels = name.split('.').filter(Boolean).flatMap((l) => [Buffer.from([l.length]), Buffer.from(l)]);
  const header = Buffer.from([id >> 8, id & 0xff, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]);
  return Buffer.concat([header, ...labels, Buffer.from([0, 0, 1, 0, 1])]);
}
const rcodeOf = (b: Buffer) => b[3] & 0x0f;

describe('questionName', () => {
  it('reads the name asked, lower-cased, without a trailing dot', () => {
    expect(questionName(query('API.GitHub.com'))).toBe('api.github.com');
  });

  it('is null for anything that is not one well-formed question', () => {
    expect(questionName(Buffer.from([1, 2, 3]))).toBeNull();
    const two = query('a.example');
    two.writeUInt16BE(2, 4);
    expect(questionName(two)).toBeNull();
    // A label running past the end.
    expect(questionName(Buffer.concat([query('a.example').subarray(0, 12), Buffer.from([40, 97])]))).toBeNull();
    // A compression pointer: a query has none.
    expect(questionName(Buffer.concat([query('a.example').subarray(0, 12), Buffer.from([0xc0, 0x0c, 0, 1, 0, 1])]))).toBeNull();
    // A response, not a query.
    const resp = query('a.example');
    resp[2] |= 0x80;
    expect(questionName(resp)).toBeNull();
  });
});

describe('nameDenied', () => {
  it('denies the names the policy denies: exact, and a wildcard\'s subdomains (not the domain itself)', () => {
    const deny = ['evil.example', '*.ioc.test'];
    expect(nameDenied('evil.example', deny)).toBe(true);
    expect(nameDenied('EVIL.example', deny)).toBe(true);
    expect(nameDenied('x.y.ioc.test', deny)).toBe(true);
    expect(nameDenied('ioc.test', deny)).toBe(false);
    expect(nameDenied('notevil.example', deny)).toBe(false);
  });

  it('a deny of every host denies every name', () => {
    expect(nameDenied('anything.example', ['*'])).toBe(true);
  });

  it('ignores address entries: they are no names', () => {
    expect(nameDenied('169.254.169.254', ['169.254.169.254'])).toBe(false);
  });
});

describe('refusalOf', () => {
  it('answers the query NXDOMAIN, with its id and question, no answers', () => {
    const q = query('evil.example', 0xbeef);
    const r = refusalOf(q)!;
    expect(r.readUInt16BE(0)).toBe(0xbeef);
    expect(r[2] & 0x80).toBe(0x80);
    expect(rcodeOf(r)).toBe(3);
    expect(r.readUInt16BE(4)).toBe(1);
    expect(r.readUInt16BE(6)).toBe(0);
    expect(r.subarray(12)).toEqual(q.subarray(12));
  });
});

describe('the resolver, on real sockets', () => {
  let resolver: Resolver | null = null;
  let upstream: dgram.Socket | null = null;
  const asked: string[] = [];
  afterEach(async () => {
    await resolver?.close();
    upstream?.close();
    resolver = null;
    asked.length = 0;
  });

  /** smolvm's resolver, as far as this goes: echoes the query back as an answer (rcode 0). TCP questions reach it over UDP too. */
  async function fakeUpstream(): Promise<number> {
    upstream = dgram.createSocket('udp4');
    upstream.on('message', (msg, rinfo) => {
      asked.push(questionName(msg) ?? '?');
      const reply = Buffer.from(msg);
      reply[2] |= 0x80;
      upstream!.send(reply, rinfo.port, rinfo.address);
    });
    await new Promise<void>((r) => upstream!.bind(0, '127.0.0.1', () => r()));
    const port = upstream.address().port;
    return port;
  }

  const udpAsk = (port: number, msg: Buffer) => new Promise<Buffer>((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    const t = setTimeout(() => { s.close(); reject(new Error('no answer')); }, 3000);
    s.on('message', (m) => { clearTimeout(t); s.close(); resolve(m); });
    s.send(msg, port, '127.0.0.1');
  });
  const tcpAsk = (port: number, msg: Buffer) => new Promise<Buffer>((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    let buf = Buffer.alloc(0);
    s.on('data', (d) => { buf = Buffer.concat([buf, d]); if (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) { s.end(); resolve(buf.subarray(2)); } });
    s.on('error', reject);
    const len = Buffer.alloc(2);
    len.writeUInt16BE(msg.length);
    s.write(Buffer.concat([len, msg]));
  });

  it('passes an allowed name to smolvm\'s resolver and its answer back, over UDP and TCP', async () => {
    const up = await fakeUpstream();
    resolver = await startResolver({ host: '127.0.0.1', port: 0, upstream: { host: '127.0.0.1', port: up }, deny: ['evil.example'] });
    const a = await udpAsk(resolver.port, query('api.github.com', 7));
    expect(a.readUInt16BE(0)).toBe(7);
    expect(rcodeOf(a)).toBe(0);
    const b = await tcpAsk(resolver.port, query('api.github.com', 8));
    expect(b.readUInt16BE(0)).toBe(8);
    expect(asked).toEqual(['api.github.com', 'api.github.com']);
  });

  // Story review 2 (LIFE-2): in enforce, the machine's resolver holds the allow list too, so a policy
  // turned to enforce while a session runs is enforced for lookups as well.
  it('in enforce, refuses a name off the allow list and passes one on it', async () => {
    const up = await fakeUpstream();
    resolver = await startResolver({ host: '127.0.0.1', port: 0, upstream: { host: '127.0.0.1', port: up }, deny: [], allow: ['api.github.com', '*.example.org'] });
    expect(rcodeOf(await udpAsk(resolver.port, query('nextjs.org', 1)))).toBe(3);
    expect(rcodeOf(await udpAsk(resolver.port, query('api.github.com', 2)))).toBe(0);
    expect(rcodeOf(await udpAsk(resolver.port, query('x.example.org', 3)))).toBe(0);
    expect(asked).toEqual(['api.github.com', 'x.example.org']);
  });

  it('follows its config file: lists changed while it runs apply to the next question, a broken file changes nothing', async () => {
    const up = await fakeUpstream();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-dns-'));
    const file = path.join(dir, 'config.json');
    const c: ResolverConfig = { host: '127.0.0.1', port: 0, upstream: { host: '127.0.0.1', port: up }, deny: [] };
    fs.writeFileSync(file, JSON.stringify(c));
    resolver = await startResolver(c);
    const stop = followConfig(file, c, 10);
    try {
      expect(rcodeOf(await udpAsk(resolver.port, query('api.github.com', 1)))).toBe(0);
      fs.writeFileSync(file, JSON.stringify({ ...c, deny: ['api.github.com'] }));
      await new Promise((r) => setTimeout(r, 100));
      expect(rcodeOf(await udpAsk(resolver.port, query('api.github.com', 2)))).toBe(3);
      fs.writeFileSync(file, '{"deny": [');
      await new Promise((r) => setTimeout(r, 100));
      expect(rcodeOf(await udpAsk(resolver.port, query('api.github.com', 3)))).toBe(3);
      fs.writeFileSync(file, JSON.stringify({ ...c, deny: [], allow: ['example.org'] }));
      await new Promise((r) => setTimeout(r, 100));
      expect(rcodeOf(await udpAsk(resolver.port, query('api.github.com', 4)))).toBe(3);
      expect(rcodeOf(await udpAsk(resolver.port, query('example.org', 5)))).toBe(0);
    } finally {
      stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('asks smolvm\'s resolver from the one source port it was given (the guest firewall lets only that port through), TCP questions too', async () => {
    const seenPorts: number[] = [];
    upstream = dgram.createSocket('udp4');
    upstream.on('message', (msg, rinfo) => {
      seenPorts.push(rinfo.port);
      const reply = Buffer.from(msg);
      reply[2] |= 0x80;
      upstream!.send(reply, rinfo.port, rinfo.address);
    });
    await new Promise<void>((r) => upstream!.bind(0, '127.0.0.1', () => r()));
    const sourcePort = await new Promise<number>((r) => { const t = dgram.createSocket('udp4'); t.bind(0, '127.0.0.1', () => { const p = t.address().port; t.close(() => r(p)); }); });
    resolver = await startResolver({ host: '127.0.0.1', port: 0, upstream: { host: '127.0.0.1', port: upstream.address().port }, upstreamSourcePort: sourcePort, deny: [] });
    const a = await udpAsk(resolver.port, query('one.example', 0x0101));
    const b = await tcpAsk(resolver.port, query('two.example', 0x0202));
    // Each answer carries the asker's own id, though another id went upstream.
    expect([a.readUInt16BE(0), b.readUInt16BE(0)]).toEqual([0x0101, 0x0202]);
    expect(seenPorts).toEqual([sourcePort, sourcePort]);
  });

  it('answers a denied name NXDOMAIN itself: the question never leaves', async () => {
    const up = await fakeUpstream();
    resolver = await startResolver({ host: '127.0.0.1', port: 0, upstream: { host: '127.0.0.1', port: up }, deny: ['evil.example', '*.ioc.test'] });
    expect(rcodeOf(await udpAsk(resolver.port, query('evil.example')))).toBe(3);
    expect(rcodeOf(await tcpAsk(resolver.port, query('a.b.ioc.test')))).toBe(3);
    expect(asked).toEqual([]);
  });

  it('a late answer to an earlier question is not taken for a later one\'s: the question must match (review 01a18ddc)', async () => {
    const held: Array<{ msg: Buffer; port: number; address: string }> = [];
    upstream = dgram.createSocket('udp4');
    upstream.on('message', (msg, rinfo) => { held.push({ msg, port: rinfo.port, address: rinfo.address }); });
    await new Promise<void>((r) => upstream!.bind(0, '127.0.0.1', () => r()));
    resolver = await startResolver({ host: '127.0.0.1', port: 0, upstream: { host: '127.0.0.1', port: upstream.address().port }, deny: [] });
    const first = udpAsk(resolver.port, query('first.example', 0x1111)).catch(() => null);
    await new Promise((r) => setTimeout(r, 100));
    const second = udpAsk(resolver.port, query('second.example', 0x2222));
    await new Promise((r) => setTimeout(r, 100));
    // An answer carrying the second question's upstream id but the first question: refused.
    const forged = Buffer.from(held[0].msg);
    forged.writeUInt16BE(held[1].msg.readUInt16BE(0), 0);
    forged[2] |= 0x80;
    upstream.send(forged, held[1].port, held[1].address);
    await new Promise((r) => setTimeout(r, 100));
    const real = Buffer.from(held[1].msg);
    real[2] |= 0x80;
    upstream.send(real, held[1].port, held[1].address);
    const a = await second;
    expect(a.readUInt16BE(0)).toBe(0x2222);
    expect(questionName(Buffer.concat([Buffer.from([0, 0, 0, 0]), a.subarray(4)]))).toBe('second.example');
    await first;
  });

  it('a TCP asker that does not read its answers is cut off, not buffered for without end (review 01a18ddc)', async () => {
    const up = await fakeUpstream();
    resolver = await startResolver({ host: '127.0.0.1', port: 0, upstream: { host: '127.0.0.1', port: up }, deny: ['evil.example'] });
    const s = net.connect(resolver.port, '127.0.0.1');
    await new Promise((r) => s.once('connect', r));
    s.pause();
    const q = query('evil.example');
    const len = Buffer.alloc(2);
    len.writeUInt16BE(q.length);
    const frame = Buffer.concat([len, q]);
    const closed = new Promise<void>((r) => s.once('close', () => r()));
    s.on('error', () => undefined);
    const flood = setInterval(() => { if (!s.destroyed) for (let i = 0; i < 2000; i++) s.write(frame); }, 5);
    await Promise.race([closed, new Promise((_, rej) => setTimeout(() => rej(new Error('never cut off')), 10_000))]);
    clearInterval(flood);
  }, 15_000);

  it('a TCP asker that asks slowly but never reads is cut off by the answers queued for it (review 01a18ddc, pass 2)', async () => {
    const up = await fakeUpstream();
    resolver = await startResolver({ host: '127.0.0.1', port: 0, upstream: { host: '127.0.0.1', port: up }, deny: ['evil.example'] });
    const s = net.connect(resolver.port, '127.0.0.1');
    await new Promise((r) => s.once('connect', r));
    s.pause();
    s.on('error', () => undefined);
    const q = query('evil.example');
    const len = Buffer.alloc(2);
    len.writeUInt16BE(q.length);
    const frame = Buffer.concat([len, q]);
    const closed = new Promise<void>((r) => s.once('close', () => r()));
    // Well under the in-flight limit each round: each denied question is answered at once, and the answers pile up unread.
    const pace = setInterval(() => { if (!s.destroyed) for (let i = 0; i < 16; i++) s.write(frame); }, 1);
    await Promise.race([closed, new Promise((_, rej) => setTimeout(() => rej(new Error('never cut off')), 20_000))]);
    clearInterval(pace);
  }, 30_000);

  it('a question it cannot read is not passed on', async () => {
    const up = await fakeUpstream();
    resolver = await startResolver({ host: '127.0.0.1', port: 0, upstream: { host: '127.0.0.1', port: up }, deny: [] });
    const two = query('a.example');
    two.writeUInt16BE(2, 4);
    const r = await udpAsk(resolver.port, two).catch(() => null);
    if (r) expect(rcodeOf(r)).not.toBe(0);
    expect(asked).toEqual([]);
  });
});

describe.skipIf(process.platform === 'win32')('the compiled resolver, run alone (as the guest runs it)', () => {
  const DIST = path.resolve(__dirname, '..', '..', 'dist', 'airlock', 'guestDns.js');

  it.skipIf(!fs.existsSync(DIST))('runs from a folder with nothing else in it, from its config, and answers', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-guestdns-'));
    try {
      fs.copyFileSync(DIST, path.join(dir, 'resolver.js'));
      const port = await new Promise<number>((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)); }); });
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ host: '127.0.0.1', port, upstream: { host: '127.0.0.1', port: 9 }, deny: ['evil.example'] }));
      const child = spawn(process.execPath, [path.join(dir, 'resolver.js'), path.join(dir, 'config.json')], { cwd: dir, env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
      try {
        await new Promise<void>((resolve, reject) => {
          child.stdout.on('data', (d) => { if (String(d).includes('ready')) resolve(); });
          child.on('exit', (c) => reject(new Error(`exited ${c}`)));
        });
        const s = dgram.createSocket('udp4');
        const answer = await new Promise<Buffer>((resolve) => { s.on('message', (m) => { s.close(); resolve(m); }); s.send(query('evil.example', 9), port, '127.0.0.1'); });
        expect(rcodeOf(answer)).toBe(3);
      } finally {
        child.kill('SIGKILL');
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
