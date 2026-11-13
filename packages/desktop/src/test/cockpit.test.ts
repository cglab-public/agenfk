/**
 * @vitest-environment node
 *
 * INFRA-425: the cockpit under the terminal tabs.
 *
 * Ported from the pi cockpit extension: git, AWS, Kubernetes and Terraform
 * where the terminal is, and the agent's context and cost. The decision (user,
 * 2026-10-08): the AWS profile is the one THAT terminal runs with. An
 * `export AWS_PROFILE=...` at a prompt changes only the shell's memory, so the
 * shell reports it (envReport.ts); without that, the foreground process's
 * environment is the next best source, and an idle shell's export is not seen.
 *
 * Prices and context windows come from platform.claude.com (pricing.md and
 * models/overview.md, fetched 2026-10-08). Tests pin the cases a wrong table
 * would get wrong, not every row.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { claudeMessageCost, claudeContextWindow } from '../main/cockpit/pricing';
import { UsageAccumulator, piContextWindow } from '../main/cockpit/transcript';
import { COCKPIT_PROBE_SCRIPT, parseCockpitProbe } from '../main/cockpit/probe';
import { CockpitService, type CockpitContext } from '../main/cockpit/service';
import { EnvReportReader, ENV_REPORT_SNIPPET } from '../main/cockpit/envReport';
import { ENV_REPORT_SNIPPET as UI_SNIPPET } from '../../../ui/src/cockpit';

describe('what a Claude message costs', () => {
  it('prices each kind of token at its own rate', () => {
    // Opus 5.5: $4 in, $5 5m write, $8 1h write, $0.20 read, $20 out (per MTok).
    const cost = claudeMessageCost('claude-opus-5-5', {
      input_tokens: 1_000_000,
      cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 },
      cache_read_input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(4 + 5 + 8 + 0.2 + 20, 6);
  });

  it('treats an unsplit cache write as the 5-minute kind', () => {
    // Older transcripts carry only cache_creation_input_tokens.
    expect(claudeMessageCost('claude-sonnet-4-6', { cache_creation_input_tokens: 1_000_000 })).toBeCloseTo(3.75, 6);
  });

  it('uses the cheaper cache reads of the newest models', () => {
    expect(claudeMessageCost('claude-fable-5-1', { cache_read_input_tokens: 1_000_000 })).toBeCloseTo(0.25, 6);
    expect(claudeMessageCost('claude-sonnet-5-5', { cache_read_input_tokens: 1_000_000 })).toBeCloseTo(0.1, 6);
  });

  it('switches Haiku 5.5 to its long-prompt rates above 100,000 prompt tokens', () => {
    expect(claudeMessageCost('claude-haiku-5-5', { input_tokens: 50_000 })).toBeCloseTo(0.005, 9);
    expect(claudeMessageCost('claude-haiku-5-5', { input_tokens: 200_000 })).toBeCloseTo(0.1, 9);
  });

  it('accepts dated and suffixed ids of a known model', () => {
    expect(claudeMessageCost('claude-haiku-4-5-20251001', { output_tokens: 1_000_000 })).toBeCloseTo(5, 6);
    expect(claudeMessageCost('claude-opus-5-5[1m]', { output_tokens: 1_000_000 })).toBeCloseTo(20, 6);
  });

  it('says it does not know rather than guessing for a model it has no price for', () => {
    expect(claudeMessageCost('claude-unknown-9', { output_tokens: 10 })).toBeNull();
  });

  it('knows the context windows', () => {
    expect(claudeContextWindow('claude-opus-5-5')).toBe(1_000_000);
    expect(claudeContextWindow('claude-haiku-4-5-20251001')).toBe(200_000);
    expect(claudeContextWindow('claude-unknown-9')).toBeNull();
  });
});

const claudeLine = (id: string, usage: Record<string, unknown>, model = 'claude-opus-5-5') =>
  JSON.stringify({ type: 'assistant', message: { id, model, usage, content: [{ type: 'text', text: 'x' }] } });

describe('reading a Claude transcript as it grows', () => {
  it('counts a message once although Claude Code writes one line per content block', () => {
    const acc = new UsageAccumulator('claude');
    const u = { input_tokens: 10, cache_read_input_tokens: 1_000_000, output_tokens: 0 };
    acc.feed(`${claudeLine('m1', u)}\n${claudeLine('m1', u)}\n`);
    expect(acc.snapshot().cost).toBeCloseTo(0.2 + 10 * 4 / 1e6, 9);
  });

  it('reports the context of the LAST message, and its window', () => {
    const acc = new UsageAccumulator('claude');
    acc.feed(`${claudeLine('m1', { input_tokens: 5, cache_read_input_tokens: 100 })}\n`);
    acc.feed(`${claudeLine('m2', { input_tokens: 7, cache_creation_input_tokens: 3, cache_read_input_tokens: 400_000 })}\n`);
    expect(acc.snapshot()).toMatchObject({ model: 'claude-opus-5-5', contextTokens: 400_010, contextWindow: 1_000_000 });
  });

  it('keeps a line split across two reads', () => {
    const acc = new UsageAccumulator('claude');
    const line = claudeLine('m1', { output_tokens: 1_000_000 });
    acc.feed(line.slice(0, 20));
    expect(acc.snapshot().cost).toBe(0);
    acc.feed(`${line.slice(20)}\n`);
    expect(acc.snapshot().cost).toBeCloseTo(20, 6);
  });

  it('skips lines that are not usage, and lines that are not JSON', () => {
    const acc = new UsageAccumulator('claude');
    acc.feed('{"type":"user","message":{"content":"hi"}}\nnot json\n');
    expect(acc.snapshot()).toMatchObject({ cost: 0, contextTokens: null });
  });

  it('ignores the messages Claude Code writes itself, which cost nothing', () => {
    const acc = new UsageAccumulator('claude');
    acc.feed(`${claudeLine('m1', { output_tokens: 10 })}\n${claudeLine('m2', { output_tokens: 0 }, '<synthetic>')}\n`);
    expect(acc.snapshot()).toMatchObject({ model: 'claude-opus-5-5', costComplete: true });
  });

  it('marks the cost incomplete when a message used a model it cannot price', () => {
    const acc = new UsageAccumulator('claude');
    acc.feed(`${claudeLine('m1', { output_tokens: 5 }, 'claude-unknown-9')}\n`);
    expect(acc.snapshot().costComplete).toBe(false);
  });
});

describe('reading a pi transcript', () => {
  const piLine = (total: number, cost: number) => JSON.stringify({
    type: 'message',
    message: { role: 'assistant', provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash', usage: { totalTokens: total, cost: { total: cost } } },
  });

  it('sums the cost pi already computed, and takes the context from the last message', () => {
    const acc = new UsageAccumulator('pi');
    acc.feed(`${piLine(1000, 0.001)}\n${piLine(163_351, 0.002475034)}\n`);
    expect(acc.snapshot()).toMatchObject({ contextTokens: 163_351, model: 'deepseek/deepseek-v4.1-flash', provider: 'openrouter' });
    expect(acc.snapshot().cost).toBeCloseTo(0.003475034, 9);
  });

  it('finds the window of a pi model in its models.json', () => {
    const models = JSON.stringify({ providers: { 'dgx-spark-qwen38': { models: [{ id: 'qwen38-flashnext', contextWindow: 262144 }] } } });
    expect(piContextWindow(models, 'dgx-spark-qwen38', 'qwen38-flashnext')).toBe(262144);
    expect(piContextWindow(models, 'other', 'qwen38-flashnext')).toBeNull();
    expect(piContextWindow('not json', 'p', 'm')).toBeNull();
  });
});

describe('the probe, run for real under sh', () => {
  let dir: string;
  let marked: ChildProcess | null = null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-cockpit-'));
  });
  afterEach(() => {
    marked?.kill();
    marked = null;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const run = (args: string[], env: NodeJS.ProcessEnv = {}) =>
    execFileSync('/bin/sh', ['-c', COCKPIT_PROBE_SCRIPT, 'cockpit', ...args], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, HOME: dir, ...env },
    });
  const probe = (session: string, mode = 'scan', prof = '-', kube = '-') => parseCockpitProbe(run([session, mode, prof, kube]));

  it.skipIf(process.platform === 'win32')('reads the branch and a dirty tree', () => {
    execFileSync('git', ['init', '-q', '-b', 'feat/x'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'a'), '1');
    execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'add', 'a'], { cwd: dir });
    execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'a'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'a'), '2');
    expect(probe('none').git).toMatchObject({ branch: 'feat/x', dirty: true });
  });

  it.skipIf(process.platform === 'win32')('reads the Terraform workspace', () => {
    fs.mkdirSync(path.join(dir, '.terraform'));
    fs.writeFileSync(path.join(dir, '.terraform', 'environment'), 'stg\n');
    expect(probe('none').tf).toBe('stg');
  });

  it.skipIf(process.platform !== 'linux')('takes AWS_PROFILE from the terminal\'s own process found by its marker, and only that', async () => {
    marked = spawn('/bin/sh', ['-c', 'sleep 30'], {
      env: { ...process.env, AGENFK_SESSION: 'sess-42', AWS_PROFILE: 'cglab-prod-ro', AWS_SECRET_ACCESS_KEY: 'never-read' },
    });
    await new Promise(r => setTimeout(r, 200));
    fs.mkdirSync(path.join(dir, '.aws'));
    fs.writeFileSync(path.join(dir, '.aws', 'credentials'),
      '[cglab-prod-ro]\r\naws_secret_access_key = never-read\r\nx_security_token_expires = 2099-01-01T00:00:00Z\r\n');
    const out = run(['sess-42', 'scan', '-', '-']);
    expect(out).not.toContain('never-read');
    // CRLF credentials (a file shared with Windows) still give the expiry.
    expect(parseCockpitProbe(out).aws).toEqual({ profile: 'cglab-prod-ro', expires: '2099-01-01T00:00:00Z', source: 'shell' });
  });

  it.skipIf(process.platform === 'win32')('uses what the shell reported, which sees an export the environ cannot', () => {
    fs.mkdirSync(path.join(dir, 'kube'));
    fs.writeFileSync(path.join(dir, 'kube', 'a'), 'apiVersion: v1\n');
    fs.writeFileSync(path.join(dir, 'kube', 'b'), 'current-context: "prd-main"\n');
    const got = probe('nobody-has-this', 'reported', 'cglab-stg', `${path.join(dir, 'kube', 'a')}:${path.join(dir, 'kube', 'b')}`);
    expect(got.aws).toEqual({ profile: 'cglab-stg', expires: null, source: 'reported' });
    // kubectl's rule: the first file in the list that names a context.
    expect(got.k8s).toBe('prd-main');
  });

  it.skipIf(process.platform === 'win32')('refuses a reported profile that is not a word', () => {
    expect(probe('x', 'reported', 'a b;rm -rf ~', '').aws).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('reads no AWS profile and no kube context under tmux, rather than another pane\'s', () => {
    fs.mkdirSync(path.join(dir, '.kube'));
    fs.writeFileSync(path.join(dir, '.kube', 'config'), 'current-context: default-ctx\n');
    const got = probe('x', 'none', '-', '-');
    expect(got.aws).toBeNull();
    expect(got.k8s).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('reads "-" as empty, since wsl.exe may drop an empty argument', () => {
    expect(probe('x', 'reported', '-', '-').aws).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('reports the physical working directory, as agents name their project directories', () => {
    expect(probe('x').cwd).toBe(fs.realpathSync(dir));
  });

  it.skipIf(process.platform === 'win32')('says nothing about AWS when no process carries the marker', () => {
    expect(probe('nobody-has-this').aws).toBeNull();
  });
});

describe('a terminal\'s cockpit, joined', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-cockpit-svc-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const realFs = {
    readdir: (p: string) => fs.promises.readdir(p),
    stat: async (p: string) => { const st = await fs.promises.stat(p); return { size: st.size, mtimeMs: st.mtimeMs }; },
    read: async (p: string, offset: number, length: number) => {
      const h = await fs.promises.open(p, 'r');
      try { const b = Buffer.alloc(length); const { bytesRead } = await h.read(b, 0, length, offset); return b.subarray(0, bytesRead); } finally { await h.close(); }
    },
    readText: (p: string) => fs.promises.readFile(p, 'utf8').catch(() => null),
  };
  let clock = 0;
  const service = (probe: (ctx: CockpitContext, args: readonly string[]) => Promise<string>) => new CockpitService({
    probe, home: async () => root, hostPath: async (_c, p) => p, fs: realFs, now: () => clock,
  });
  const ctx = (over: Partial<CockpitContext> = {}): CockpitContext => ({
    cwd: '/home/x/repo', agentId: 'claude-code', agentSessionId: 'conv-1', wsl: null, tmux: false, spawnedAt: 0, resumed: false, reported: null, ...over,
  });
  const projectDir = () => path.join(root, '.claude', 'projects', '-home-x-repo');

  beforeEach(() => { clock = 0; });

  it('finds the transcript in the directory the agent derives from the cwd, and reads only what was appended', async () => {
    fs.mkdirSync(projectDir(), { recursive: true });
    const file = path.join(projectDir(), 'conv-1.jsonl');
    fs.writeFileSync(file, `${claudeLine('m1', { output_tokens: 1_000_000 })}\n`);
    const svc = service(async () => 'git=main\t0\t0\t0\n');
    const first = await svc.snapshot('sess-1', ctx());
    expect(first.git?.branch).toBe('main');
    expect(first.usage?.cost).toBeCloseTo(20, 6);
    fs.appendFileSync(file, `${claudeLine('m2', { output_tokens: 500_000 })}\n`);
    clock += 11_000;
    expect((await svc.snapshot('sess-1', ctx())).usage?.cost).toBeCloseTo(30, 6);
  });

  it('follows a --continue that resumed under another id: the newest file since the terminal opened', async () => {
    fs.mkdirSync(projectDir(), { recursive: true });
    const old = path.join(projectDir(), 'other-old.jsonl');
    fs.writeFileSync(old, `${claudeLine('o1', { output_tokens: 1_000_000 })}\n`);
    fs.utimesSync(old, new Date(1000), new Date(1000));
    fs.writeFileSync(path.join(projectDir(), 'picked.jsonl'), `${claudeLine('p1', { output_tokens: 500_000 })}\n`);
    const snap = await service(async () => '').snapshot('sess-c', ctx({ agentSessionId: 'never-written', spawnedAt: 5000, resumed: true }));
    expect(snap.usage?.cost).toBeCloseTo(10, 6);
  });

  it('never guesses for a FRESH session, whose own file simply has not been written yet', async () => {
    fs.mkdirSync(projectDir(), { recursive: true });
    fs.writeFileSync(path.join(projectDir(), 'neighbour.jsonl'), `${claudeLine('n1', { output_tokens: 500_000 })}\n`);
    const snap = await service(async () => '').snapshot('sess-f', ctx({ agentSessionId: 'not-yet', spawnedAt: 0 }));
    expect(snap.usage).toBeNull();
  });

  it('switches from a guessed file to the conversation\'s own as soon as it appears', async () => {
    fs.mkdirSync(projectDir(), { recursive: true });
    fs.writeFileSync(path.join(projectDir(), 'guess.jsonl'), `${claudeLine('g1', { output_tokens: 500_000 })}\n`);
    const svc = service(async () => '');
    const c = ctx({ agentSessionId: 'mine', resumed: true });
    expect((await svc.snapshot('sess-p', c)).usage?.cost).toBeCloseTo(10, 6);
    fs.writeFileSync(path.join(projectDir(), 'mine.jsonl'), `${claudeLine('m1', { output_tokens: 1_000_000 })}\n`);
    // Re-checked every few polls, not on every one.
    let last = 0;
    for (let i = 0; i < 4; i += 1) {
      clock += 11_000;
      last = (await svc.snapshot('sess-p', c)).usage?.cost ?? 0;
    }
    expect(last).toBeCloseTo(20, 6);
  });

  it('never moves a guessed pin to ANOTHER guess, only to the conversation\'s own file', async () => {
    fs.mkdirSync(projectDir(), { recursive: true });
    fs.writeFileSync(path.join(projectDir(), 'guess.jsonl'), `${claudeLine('g1', { output_tokens: 500_000 })}\n`);
    const svc = service(async () => '');
    const c = ctx({ agentSessionId: 'mine', resumed: true });
    await svc.snapshot('sess-q', c);
    fs.writeFileSync(path.join(projectDir(), 'later-neighbour.jsonl'), `${claudeLine('n1', { output_tokens: 1_000_000 })}\n`);
    let last = 0;
    for (let i = 0; i < 4; i += 1) {
      clock += 11_000;
      last = (await svc.snapshot('sess-q', c)).usage?.cost ?? 0;
    }
    expect(last).toBeCloseTo(10, 6);
  });

  it('runs one transcript read at a time, so a slow read is never counted twice', async () => {
    fs.mkdirSync(projectDir(), { recursive: true });
    fs.writeFileSync(path.join(projectDir(), 'conv-1.jsonl'), `${claudeLine('m1', { output_tokens: 1_000_000 })}\n`);
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    let reads = 0;
    const svc = new CockpitService({
      probe: async () => '', home: async () => root, hostPath: async (_c, p) => p, now: () => clock, usageTimeoutMs: 20,
      fs: { ...realFs, read: async (p, o, l) => { reads += 1; await gate; return realFs.read(p, o, l); } },
    });
    expect((await svc.snapshot('slow', ctx())).usage).toBeNull();
    clock += 11_000;
    await svc.snapshot('slow', ctx());
    expect(reads).toBe(1);
    release();
    await new Promise(r => setTimeout(r, 30));
    clock += 11_000;
    expect((await svc.snapshot('slow', ctx())).usage?.cost).toBeCloseTo(20, 6);
  });

  it('calls an agent terminal\'s own environment what it is: the foreground, not a shell\'s stale start', async () => {
    const snap = await service(async () => 'aws=cglab-stg\t\tshell\n').snapshot('ag', ctx({ agentId: 'claude-code' }));
    expect(snap.aws?.source).toBe('foreground');
    const codex = await service(async () => 'aws=cglab-stg\t\tshell\n').snapshot('cx', ctx({ agentId: 'codex' }));
    expect(codex.aws?.source).toBe('foreground');
    const shell = await service(async () => 'aws=cglab-stg\t\tshell\n').snapshot('sh', ctx({ agentId: 'shell' }));
    expect(shell.aws?.source).toBe('shell');
  });

  it('finds the transcript under the physical cwd the probe reported (a Windows path is /mnt/c/... in WSL)', async () => {
    const dir2 = path.join(root, '.claude', 'projects', '-mnt-c-Users-e-repo');
    fs.mkdirSync(dir2, { recursive: true });
    fs.writeFileSync(path.join(dir2, 'conv-1.jsonl'), `${claudeLine('m1', { output_tokens: 1_000_000 })}\n`);
    const svc = service(async () => 'cwd=/mnt/c/Users/e/repo\n');
    const c = ctx({ cwd: 'C:\\Users\\e\\repo' });
    await svc.snapshot('sess-w', c);
    clock += 11_000;
    expect((await svc.snapshot('sess-w', c)).usage?.cost).toBeCloseTo(20, 6);
  });

  it('adds what the session\'s subagents cost, but not their context', async () => {
    fs.mkdirSync(path.join(projectDir(), 'conv-2', 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(projectDir(), 'conv-2.jsonl'), `${claudeLine('m1', { output_tokens: 1_000_000 })}\n`);
    fs.writeFileSync(path.join(projectDir(), 'conv-2', 'subagents', 'agent-a.jsonl'), `${claudeLine('s1', { output_tokens: 500_000 })}\n`);
    const snap = await service(async () => '').snapshot('sess-9', ctx({ agentSessionId: 'conv-2' }));
    expect(snap.usage?.cost).toBeCloseTo(30, 6);
    expect(snap.usage?.contextTokens).toBe(0);
  });

  it('keeps cost and context when the probe fails', async () => {
    fs.mkdirSync(projectDir(), { recursive: true });
    fs.writeFileSync(path.join(projectDir(), 'conv-1.jsonl'), `${claudeLine('m1', { output_tokens: 1_000_000 })}\n`);
    const snap = await service(async () => { throw new Error('timeout'); }).snapshot('sess-3', ctx());
    expect(snap).toMatchObject({ git: null, usage: { cost: 20 } });
  });

  it('runs one probe for overlapping asks and none more within the interval', async () => {
    let probes = 0;
    const svc = service(async () => { probes += 1; return ''; });
    await Promise.all([svc.snapshot('s', ctx({ agentId: 'shell' })), svc.snapshot('s', ctx({ agentId: 'shell' }))]);
    clock += 5_000;
    await svc.snapshot('s', ctx({ agentId: 'shell' }));
    expect(probes).toBe(1);
    clock += 6_000;
    await svc.snapshot('s', ctx({ agentId: 'shell' }));
    expect(probes).toBe(2);
  });

  it('asks the probe for the shell\'s report when there is one, for nothing under tmux, and to scan otherwise', async () => {
    const seen: Array<readonly string[]> = [];
    const svc = service(async (_c, args) => { seen.push(args); return ''; });
    await svc.snapshot('a', ctx({ agentId: 'shell', reported: { awsProfile: 'cglab-stg', kubeconfig: '/k' } }));
    await svc.snapshot('b', ctx({ agentId: 'shell', tmux: true }));
    await svc.snapshot('c', ctx({ agentId: 'shell' }));
    expect(seen).toEqual([['a', 'reported', 'cglab-stg', '/k'], ['b', 'none', '-', '-'], ['c', 'scan', '-', '-']]);
  });

  it('marks the cost a lower bound when only the tail of a huge transcript was read', async () => {
    fs.mkdirSync(projectDir(), { recursive: true });
    const file = path.join(projectDir(), 'conv-1.jsonl');
    const filler = `${'x'.repeat(1024 * 1024)}\n`;
    fs.writeFileSync(file, filler.repeat(17) + `${claudeLine('m1', { output_tokens: 1 })}\n`);
    const snap = await service(async () => '').snapshot('big', ctx());
    expect(snap.usage?.costComplete).toBe(false);
  });

  it('keeps nothing for a session that ended while it was looking', async () => {
    let release: () => void = () => {};
    const svc = new CockpitService({
      probe: async () => '', hostPath: async (_c, p) => p, fs: realFs, now: () => clock,
      home: () => new Promise(resolve => { release = () => resolve(root); }),
    });
    const pending = svc.snapshot('gone', ctx());
    svc.forget('gone');
    release();
    await pending;
    expect((svc as unknown as { trackers: Map<string, unknown> }).trackers.size).toBe(0);
  });
});

describe('the shell reporting its own environment', () => {
  const report = (prof: string, kube: string, end = '\x07', session = 'sess-1') =>
    `\x1b]1337;AgenfkEnv=SESSION=${session}\x1fAWS_PROFILE=${prof}\x1fKUBECONFIG=${kube}${end}`;

  it('keeps the latest report found in the output', () => {
    const r = new EnvReportReader('sess-1');
    r.feed(`prompt$ ${report('cglab-stg', '/a')} ls\r\n${report('cglab-prod-ro', '/b')}`);
    expect(r.current()).toEqual({ awsProfile: 'cglab-prod-ro', kubeconfig: '/b' });
  });

  it('reads a report split across two chunks, at any point', () => {
    const whole = report('cglab-stg', '/k');
    for (let cut = 1; cut < whole.length; cut += 1) {
      const r = new EnvReportReader('sess-1');
      r.feed(`x${whole.slice(0, cut)}`);
      r.feed(`${whole.slice(cut)}y`);
      expect(r.current(), `cut at ${cut}`).toEqual({ awsProfile: 'cglab-stg', kubeconfig: '/k' });
    }
  });

  it('accepts the ST terminator too, and an unset profile', () => {
    const r = new EnvReportReader('sess-1');
    r.feed(report('', '', '\x1b\\'));
    expect(r.current()).toEqual({ awsProfile: '', kubeconfig: '' });
  });

  it('refuses a profile that is not a word, keeping the last good one', () => {
    const r = new EnvReportReader('sess-1');
    r.feed(report('cglab-stg', ''));
    r.feed(report('a b', ''));
    expect(r.current()?.awsProfile).toBe('cglab-stg');
  });

  it('drops a report that never ends instead of buffering it forever', () => {
    const r = new EnvReportReader('sess-1');
    r.feed(`\x1b]1337;AgenfkEnv=${'x'.repeat(10_000)}`);
    r.feed(report('cglab-stg', ''));
    expect(r.current()?.awsProfile).toBe('cglab-stg');
  });

  it.skipIf(process.platform === 'win32')('keeps the exit status the prompt shows, and runs after the prompt\'s own hooks', () => {
    // A prompt like starship reads $? in its own PROMPT_COMMAND hook; the
    // report must neither go first nor reset it.
    const out = execFileSync('/bin/bash', ['-c',
      `PROMPT_COMMAND='echo "status=$?"'\n${ENV_REPORT_SNIPPET}\n(exit 3); eval "$PROMPT_COMMAND"; echo "after=$?"`], {
      encoding: 'utf8', env: { ...process.env, TERM_PROGRAM: 'agenfk' },
    });
    expect(out).toContain('status=3');
    expect(out.indexOf('status=3')).toBeLessThan(out.indexOf('\x1b]1337'));
  });

  it('ignores a report naming another terminal: printed text cannot forge the profile', () => {
    const r = new EnvReportReader('sess-1');
    r.feed(report('cglab-prod-ro', ''));
    r.feed(report('cglab-stg', '', '\x07', 'forged'));
    r.feed(`\x1b]1337;AgenfkEnv=AWS_PROFILE=cglab-stg\x1fKUBECONFIG=\x07`);
    expect(r.current()?.awsProfile).toBe('cglab-prod-ro');
  });

  it.skipIf(process.platform === 'win32')('joins any existing PROMPT_COMMAND without breaking it, trailing ; or newline included', () => {
    for (const existing of ['history -a;', 'echo existing\n', 'echo existing', '']) {
      const out = execFileSync('/bin/bash', ['-c', `${ENV_REPORT_SNIPPET}\neval "$PROMPT_COMMAND"`], {
        encoding: 'utf8',
        // HISTFILE so `history -a` has somewhere to write outside an interactive shell.
        env: { ...process.env, TERM_PROGRAM: 'agenfk', AGENFK_SESSION: 'sess-1', PROMPT_COMMAND: existing, HISTFILE: path.join(os.tmpdir(), 'agenfk-histfile-test') },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      expect(out, JSON.stringify(existing)).toContain('\x1b]1337;AgenfkEnv=SESSION=sess-1');
      if (existing.startsWith('echo')) expect(out).toContain('existing');
    }
  });

  it('is the same snippet Settings shows', () => {
    expect(UI_SNIPPET).toBe(ENV_REPORT_SNIPPET);
  });

  it.skipIf(process.platform === 'win32')('is what the snippet prints, run by a real bash', () => {
    const out = execFileSync('/bin/bash', ['-c', `${ENV_REPORT_SNIPPET}\n__agenfk_env`], {
      encoding: 'utf8', env: { ...process.env, TERM_PROGRAM: 'agenfk', AGENFK_SESSION: 'sess-1', AWS_PROFILE: 'cglab-prod-ro', KUBECONFIG: '/k' },
    });
    const r = new EnvReportReader('sess-1');
    r.feed(out);
    expect(r.current()).toEqual({ awsProfile: 'cglab-prod-ro', kubeconfig: '/k' });
  });
});

describe('prices beyond the token rates', () => {
  it('doubles for fast mode where it exists, and refuses to guess where it does not', () => {
    expect(claudeMessageCost('claude-opus-5-5', { output_tokens: 1_000_000, speed: 'fast' })).toBeCloseTo(40, 6);
    expect(claudeMessageCost('claude-sonnet-5-5', { output_tokens: 1, speed: 'fast' })).toBeNull();
  });

  it('adds 10% for US-only inference on the models that charge it', () => {
    expect(claudeMessageCost('claude-opus-5-5', { output_tokens: 1_000_000, inference_geo: 'us' })).toBeCloseTo(22, 6);
    expect(claudeMessageCost('claude-opus-4-5', { output_tokens: 1_000_000, inference_geo: 'us' })).toBeCloseTo(25, 6);
  });

  it('charges web searches on top', () => {
    expect(claudeMessageCost('claude-opus-5-5', { server_tool_use: { web_search_requests: 3 } })).toBeCloseTo(0.03, 9);
  });
});
