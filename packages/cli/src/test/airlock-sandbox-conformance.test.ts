/**
 * Airlock sandbox conformance (GH-294 L2-3, on smolvm since CGLAB-696): the guarantees the
 * sandbox makes, checked against the PINNED smolvm with the spec AgEnFK really builds, the egress
 * decider AgEnFK really runs (dist/airlock/egressMain.js) and the AgEnFK base image - so a smolvm
 * bump, an image change or a decider change that breaks one goes red.
 *
 * It starts real machines, so it runs only with AGENFK_SMOLVM_TESTS=1 after `npm run build`, on
 * smolvm's platforms (Apple Silicon, Linux with KVM; CI runs it on Linux), with the base image
 * saved by `docker save` in AGENFK_AIRLOCK_TEST_IMAGE. It contacts api.github.com, nextjs.org,
 * example.org, 1.1.1.1 and the metadata address, plus loopback servers of its own. Credential files are dummies
 * in a temp home.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { spawnSync } from 'child_process';
import { normalizeAirlockPolicy } from '@agenfk/core';
import { buildSandboxSpec, type SandboxSession, type SandboxSpec } from '../airlock/spec';
import { SmolvmRuntime, SMOLVM_VERSION, machineNameOf } from '../airlock/smolvm';
import { GATEWAY } from '../airlock/egress';
import type { ProxyDecision } from '../airlock/runtime';
import { realBroker, smolvmTestsEnabled } from './fixtures/smolvm-real';

const IMAGE = process.env.AGENFK_AIRLOCK_TEST_IMAGE;
const SMOLVM = process.env.AGENFK_SMOLVM_PATH ?? 'smolvm';
const enabled = smolvmTestsEnabled() && !!IMAGE
  && spawnSync(SMOLVM, ['--version'], { encoding: 'utf8' }).stdout?.trim() === `smolvm ${SMOLVM_VERSION}`;
const TIMEOUT = 600_000;

let root = '';
let home = '';
let ws = '';
let stateDir = '';
const servers: http.Server[] = [];
let relayPort = 0;
let directPort = 0;
let relaySeen = 0;
let directSeen = 0;
/** What reached the server through the relay: path and headers. */
const relayRequests: Array<{ url: string; headers: http.IncomingHttpHeaders }> = [];
const sandboxHome = process.env.HOME;

function serve(onHit: (q: http.IncomingMessage) => void, body: string): Promise<number> {
  return new Promise((resolve) => {
    const s = http.createServer((q, r) => { onHit(q); r.end(body); });
    servers.push(s);
    s.listen(0, '127.0.0.1', () => resolve((s.address() as { port: number }).port));
  });
}

function session(over: Partial<SandboxSession> = {}): SandboxSession {
  return {
    client: 'pi', home, workspace: ws, tempDirs: [os.tmpdir()], inferenceHosts: [], serverPort: relayPort,
    serverUrl: `http://127.0.0.1:${relayPort}`, directServerPort: directPort, installDirs: [path.join(home, '.agenfk-system')],
    gitDir: path.join(ws, '.git'), piAgentDir: path.join(home, '.pi', 'agent'), ...over,
  };
}

/** Runs `script` in the workspace machine under `spec`; the lines it printed, its exit, and the decisions reported. */
async function inMachine(spec: SandboxSpec, script: string): Promise<{ out: string[]; code: number | null; decisions: ProxyDecision[] }> {
  const rt = new SmolvmRuntime({ image: IMAGE!, smolvmPath: SMOLVM, egress: realBroker(path.join(stateDir, 'airlock')), stateDir, isTTY: false, hostEnv: {} });
  const decisions: ProxyDecision[] = [];
  const outFile = path.join(ws, `out-${Date.now()}.txt`);
  try {
    const launched = await rt.launch(spec, { file: 'sh', args: ['-c', `(${script}) > ${outFile} 2>&1`], cwd: ws }, { onProxyDecision: (d) => decisions.push(d) });
    const exit = await launched.exited;
    return { out: fs.readFileSync(outFile, 'utf8').split('\n').filter(Boolean), code: exit.code, decisions };
  } finally {
    await rt.dispose();
  }
}

/** `curl` that prints `<name> <http status or error>`: 000 and an exit code when nothing answered. */
const curl = (name: string, url: string, extra = '') => `echo "${name} $(curl -s -o /dev/null -w '%{http_code}' --max-time 15 ${extra} ${url}; echo " rc=$?")"`;
/** Raw TCP to 1.1.1.1:80, as bash opens it, printing the first bytes of any answer: `raw-tcp HTTP/1.1` or `raw-tcp `. */
const RAW_TCP = `echo "raw-tcp $(timeout 10 bash -c 'exec 3<>/dev/tcp/1.1.1.1/80 && printf "GET / HTTP/1.0\\r\\nHost: one.one.one.one\\r\\n\\r\\n" >&3 && head -c 8 <&3' 2>/dev/null | tr -dc 'A-Za-z0-9/.' ; echo)"`;
const line = (out: string[], name: string) => out.find((l) => l.startsWith(`${name} `)) ?? `${name} (missing)`;

// CI requires it (AGENFK_REQUIRE_SMOLVM_TESTS=1): a run that would skip it all is a failure there, not a pass.
it.runIf(process.env.AGENFK_REQUIRE_SMOLVM_TESTS === '1' && !enabled)('the conformance suite can run here (smolvm, the built decider, the base image)', () => {
  expect({ smolvmTests: smolvmTestsEnabled(), image: IMAGE ?? null, smolvm: spawnSync(SMOLVM, ['--version'], { encoding: 'utf8' }).stdout?.trim() ?? null })
    .toEqual({ smolvmTests: true, image: expect.any(String), smolvm: `smolvm ${SMOLVM_VERSION}` });
});

describe.skipIf(!enabled)('Airlock conformance on the real smolvm (AGENFK_SMOLVM_TESTS=1, AGENFK_AIRLOCK_TEST_IMAGE)', () => {
  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-conformance-')));
    home = path.join(root, 'home');
    ws = path.join(root, 'work', 'repo');
    stateDir = path.join(root, 'state');
    for (const d of [path.join(ws, '.agenfk'), path.join(ws, '.git', 'hooks'), path.join(home, '.ssh'), path.join(home, '.pi', 'agent')]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(ws, '.git', 'config'), '[core]\n');
    fs.writeFileSync(path.join(home, '.ssh', 'id_fake'), 'fake\n');
    fs.writeFileSync(path.join(home, '.pi', 'agent', 'auth.json'), '{"fake":"not-a-key"}\n');
    relayPort = await serve((q) => { relaySeen++; relayRequests.push({ url: q.url ?? '', headers: q.headers }); }, 'relay-ok');
    directPort = await serve(() => { directSeen++; }, 'server-direct');
    // smolvm keeps its sockets under HOME, and a vitest worker's sandbox HOME is past the 103-byte socket path limit.
    process.env.HOME = os.userInfo().homedir;
  }, TIMEOUT);

  afterAll(async () => {
    spawnSync(SMOLVM, ['machine', 'stop', '--name', machineNameOf(ws)]);
    spawnSync(SMOLVM, ['machine', 'delete', '--name', machineNameOf(ws), '-f']);
    process.env.HOME = sandboxHome;
    for (const s of servers) s.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }, TIMEOUT);

  it('enforce: the allow list is reachable, nothing else is - names, IP literals, the metadata address - and every refusal is reported', async () => {
    const spec = buildSandboxSpec(normalizeAirlockPolicy({ mode: 'enforce', hosts: { allow: ['api.github.com'] } }), session());
    const r = await inMachine(spec, [
      curl('allowed', 'https://api.github.com/zen'),
      curl('unlisted', 'https://nextjs.org/'),
      curl('ip-literal', 'https://1.1.1.1/', '-k'),
      curl('metadata', 'http://169.254.169.254/latest/meta-data/'),
      // Raw TCP, as bash opens it: nothing comes back, whatever the guest's own stack said about the connect.
      RAW_TCP,
    ].join('; '));
    expect(line(r.out, 'allowed')).toMatch(/^allowed 200 rc=0$/);
    for (const name of ['unlisted', 'ip-literal', 'metadata']) expect(line(r.out, name), name).toMatch(new RegExp(`^${name} 000 rc=[1-9]`));
    expect(line(r.out, 'raw-tcp')).toBe('raw-tcp ');
    expect(r.decisions.some((d) => d.decision === 'allow' && d.host === 'api.github.com')).toBe(true);
    expect(r.decisions.some((d) => d.decision === 'deny' && /nextjs\.org/.test(d.host))).toBe(true);
  }, TIMEOUT);

  it('observe: an unlisted host is reached, and reported as what enforce would refuse; the deny list still holds', async () => {
    const spec = buildSandboxSpec(normalizeAirlockPolicy({ mode: 'observe', hosts: { allow: [], deny: ['example.org'] } }), session());
    const r = await inMachine(spec, [curl('unlisted', 'https://nextjs.org/'), curl('denied', 'https://example.org/'), curl('metadata', 'http://169.254.169.254/'), RAW_TCP].join('; '));
    expect(line(r.out, 'unlisted')).toMatch(/^unlisted 200 rc=0$/);
    expect(line(r.out, 'denied')).toMatch(/^denied 000 rc=[1-9]/);
    expect(line(r.out, 'metadata')).toMatch(/^metadata 000 rc=[1-9]/);
    // The raw-TCP probe gets an answer when the flow is let through: its silence in enforce means something.
    expect(line(r.out, 'raw-tcp')).toMatch(/^raw-tcp HTTP\/1\./);
    expect(r.decisions.some((d) => d.decision === 'allow' && /nextjs\.org/.test(d.host) && /^observe:/.test(d.rule))).toBe(true);
  }, TIMEOUT);

  it('the AgEnFK server: reached through the session\'s relay, never on its own port', async () => {
    relaySeen = 0;
    directSeen = 0;
    const spec = buildSandboxSpec(normalizeAirlockPolicy({ mode: 'enforce' }), session());
    const r = await inMachine(spec, [curl('relay', '"$AGENFK_API_URL/"'), curl('direct', `http://${GATEWAY}:${directPort}/`), curl('host-loopback', `http://127.0.0.1:${directPort}/`)].join('; '));
    expect(line(r.out, 'relay')).toMatch(/^relay 200 rc=0$/);
    expect(relaySeen).toBeGreaterThan(0);
    expect(line(r.out, 'direct')).toMatch(/^direct 000 rc=[1-9]/);
    expect(line(r.out, 'host-loopback')).toMatch(/^host-loopback 000 rc=[1-9]/);
    expect(directSeen).toBe(0);
  }, TIMEOUT);

  it('files: the home outside the mounts is not there, the client\'s keys are hidden, AgEnFK\'s and git\'s config are unwritable, the workspace is', async () => {
    const spec = buildSandboxSpec(normalizeAirlockPolicy({ mode: 'enforce' }), session());
    const r = await inMachine(spec, [
      `test -e ${path.join(home, '.ssh', 'id_fake')} && echo ssh-visible`,
      `grep -q not-a-key ${path.join(home, '.pi', 'agent', 'auth.json')} && echo auth-readable`,
      `{ echo x > ${path.join(ws, '.agenfk', 'planted')}; } 2>/dev/null && echo agenfk-writable`,
      `{ echo x > ${path.join(ws, '.git', 'hooks', 'pre-commit')}; } 2>/dev/null && echo hooks-writable`,
      `{ echo x > ${path.join(ws, '.git', 'config')}; } 2>/dev/null && echo git-config-writable`,
      'echo ok > made-in-guest && echo workspace-writable',
    ].join('; '));
    expect(r.out.filter((l) => !l.startsWith('workspace-writable'))).toEqual([]);
    expect(r.out).toContain('workspace-writable');
    expect(fs.readFileSync(path.join(ws, 'made-in-guest'), 'utf8')).toBe('ok\n');
  }, TIMEOUT);

  // CGLAB-696 task 9: the SHIPPED adapter script, run by node in the guest as the session.
  it('the agenfk adapters work inside: confinement proven, ~/.agenfk there and unwritable, the CLI reaches the server through the relay with its token', async () => {
    const g = path.join(home, '.agenfk');
    // The hook scripts come from the running CLI's install (this checkout's bin/), not from here.
    fs.mkdirSync(g, { recursive: true });
    fs.writeFileSync(path.join(g, 'verify-token'), 'tok-task9\n');
    fs.writeFileSync(path.join(g, 'airlock-state.json'), JSON.stringify({ mode: 'enforce' }));
    relayRequests.length = 0;
    const spec = buildSandboxSpec(normalizeAirlockPolicy({ mode: 'enforce' }), session());
    const r = await inMachine(spec, [
      `echo "probe $(echo '{"probe":"confinement"}' | node ${g}/bin/agenfk-airlock.mjs 2>&1)"`,
      `echo "check $(node --input-type=module -e "const m = await import('${g}/bin/agenfk-airlock.mjs'); console.log(JSON.stringify(await m.airlockSandboxCheck()))" 2>&1)"`,
      `echo "state $(cat ${g}/airlock-state.json)"`,
      `{ echo x > ${g}/planted; } 2>/dev/null && echo agenfk-writable`,
      `{ echo x > ${g}/bin/agenfk-airlock.mjs; } 2>/dev/null && echo bin-writable`,
      `echo "verify $(agenfk verify item-task9 --evidence probe 2>&1 | tr '\\n' ' ' | head -c 400)"`,
      'agenfk db vacuum >/dev/null 2>&1; echo cli-done',
    ].join('; '));
    expect(line(r.out, 'probe')).toBe('probe {"confined":true}');
    expect(line(r.out, 'check')).toBe('check {"sandboxed":true}');
    expect(line(r.out, 'state')).toBe('state {"mode":"enforce"}');
    expect(r.out).not.toContain('agenfk-writable');
    expect(r.out).not.toContain('bin-writable');
    expect(r.out).toContain('cli-done');
    const seen = `${line(r.out, 'verify')} | relay saw: ${relayRequests.map((q) => q.url).join(', ')}`;
    // verify resolves the card through the server first (the stub's answer is no list, so it stops there).
    expect(relayRequests.some((q) => q.url.startsWith('/items')), seen).toBe(true);
    expect(relayRequests.some((q) => q.headers['x-agenfk-internal'] === 'tok-task9'), seen).toBe(true);
  }, TIMEOUT);

  it('a command the server runs: no relay to the server, the policy\'s allow list only', async () => {
    relaySeen = 0;
    const spec = buildSandboxSpec(normalizeAirlockPolicy({ mode: 'enforce', hosts: { allow: ['api.github.com'] } }),
      session({ purpose: 'command', serverPort: 0, serverUrl: undefined, piAgentDir: undefined }));
    const r = await inMachine(spec, [curl('allowed', 'https://api.github.com/zen'), curl('relay', `http://${GATEWAY}:${relayPort}/`), 'echo "env ${AGENFK_API_URL:-none}"'].join('; '));
    expect(line(r.out, 'allowed')).toMatch(/^allowed 200 rc=0$/);
    expect(line(r.out, 'relay')).toMatch(/^relay 000 rc=[1-9]/);
    expect(line(r.out, 'env')).toBe('env none');
    expect(relaySeen).toBe(0);
  }, TIMEOUT);
});
