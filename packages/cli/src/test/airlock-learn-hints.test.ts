/**
 * `agenfk airlock learn --import-pi-sessions --hints <provider>` (user
 * decisions 2026-11-02): one sentence per learned host, written by a model the
 * person picks - their own agent CLI (claude, codex or pi) or an
 * OpenAI-compatible server (a local llama-server, Ollama, a self-hosted model)
 * - from up to a few example commands, secrets removed, so whoever accepts
 * the host knows what it is. Opt-in only: without --hints no command leaves
 * the machine.
 *
 * Every import, hints or not, also carries the projects whose sessions
 * reached a host and an address's reverse DNS name.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Command } from 'commander';
import {
  parseHintProvider, hintPrompt, parseHints, hintRunner, writeHints, scrubCredentials, runCommand, HINT_BATCH, MAX_HINT_EXAMPLES, MAX_EXAMPLE_CHARS,
  type RunCommand,
} from '../airlock/learnHints';
import { collectPiSessionHosts, importBatches, runLearnImport, reverseNames } from '../airlock/learnImport';
import { registerAirlockCommands } from '../commands/airlock';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-learn-hints-')); });
// Windows can hold a folder a just-killed program ran in for a moment.
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });

const header = (cwd: string) => JSON.stringify({ type: 'session', version: 3, id: 's', timestamp: '2026-10-01T09:00:00.000Z', cwd });
const call = (command: string) => JSON.stringify({
  type: 'message', timestamp: '2026-10-01T09:00:00.000Z',
  message: { role: 'assistant', content: [{ type: 'toolCall', name: 'bash', arguments: { command } }] },
});
const session = (name: string, lines: string[]) => {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, 's.jsonl'), lines.join('\n') + '\n');
};

describe('the provider the person picks', () => {
  it.each([
    ['claude', { kind: 'claude' }],
    ['codex', { kind: 'codex' }],
    ['pi', { kind: 'pi' }],
    ['http://127.0.0.1:8080/v1', { kind: 'url', url: 'http://127.0.0.1:8080/v1' }],
    ['https://llm.corp.vendor.io/v1/', { kind: 'url', url: 'https://llm.corp.vendor.io/v1' }],
  ])('%s', (v, want) => {
    expect(parseHintProvider(v)).toEqual(want);
  });

  it.each(['gpt', 'ftp://x.vendor.io', 'claude; rm -rf ~', ''])('refuses %j, naming what it takes', (v) => {
    expect(() => parseHintProvider(v)).toThrow(/claude, codex, pi or an http\(s\) URL/);
  });
});

describe('the prompt', () => {
  const subjects = [
    { host: '16.170.214.92', hits: 23, uploads: 0, projects: ['horizon'], examples: ['ssh ec2-user@16.170.214.92 cat /data/STATUS'] },
    { host: 'api.vendor.io', hits: 4, uploads: 1, projects: [], examples: ['curl -T r.csv https://api.vendor.io/in'] },
  ];

  it('names every host with its projects, counts and examples, asks for what it is, not for a verdict', () => {
    const p = hintPrompt(subjects);
    for (const s of ['16.170.214.92', 'horizon', 'ssh ec2-user@16.170.214.92 cat /data/STATUS', 'api.vendor.io', 'curl -T r.csv https://api.vendor.io/in']) expect(p).toContain(s);
    expect(p).toMatch(/JSON/);
    expect(p).toMatch(/do not recommend/i);
  });
});

describe('reading the answer', () => {
  const hosts = ['a.vendor.io', 'b.vendor.io'];

  it('a JSON array, fenced or inside prose; only the hosts asked about, one line each', () => {
    const out = 'Sure!\n```json\n[{"host":"a.vendor.io","hint":"A docs site;\\nagents read guides."},{"host":"evil.vendor.io","hint":"x"},{"host":"b.vendor.io","hint":7}]\n```\nDone.';
    expect([...parseHints(out, hosts)]).toEqual([['a.vendor.io', 'A docs site; agents read guides.']]);
  });

  it('a hint is cut to a sentence-sized limit', () => {
    const out = JSON.stringify([{ host: 'a.vendor.io', hint: 'w '.repeat(500) }]);
    expect(parseHints(out, hosts).get('a.vendor.io')!.length).toBeLessThanOrEqual(300);
  });

  it('anything that is not such an array reads as no hints', () => {
    for (const out of ['', 'no idea', '{"host":"a.vendor.io"}', '[not json]']) expect(parseHints(out, hosts).size).toBe(0);
  });
});

describe('running the provider', () => {
  const fake = (stdout = '[]', code = 0) => {
    const runs: Array<{ cmd: string; args: string[]; cwd: string; input: string; cwdExisted: boolean; cwdEntries: string[] }> = [];
    const run: RunCommand = vi.fn(async (cmd, args, opts) => {
      runs.push({ cmd, args, cwd: opts.cwd, input: opts.input, cwdExisted: fs.existsSync(opts.cwd), cwdEntries: fs.readdirSync(opts.cwd) });
      const o = args.indexOf('-o');
      if (o >= 0) fs.writeFileSync(args[o + 1], stdout);
      return { code, stdout: o >= 0 ? 'codex log noise' : stdout, stderr: code ? 'boom: not logged in' : '' };
    });
    return { run, runs };
  };

  it('claude: print mode with no tools and no saved session, the prompt on stdin, from an empty folder removed afterwards', async () => {
    const { run, runs } = fake('[{"host":"a.vendor.io","hint":"h"}]');
    const r = hintRunner({ kind: 'claude' }, { model: 'claude-haiku-5-5', run });
    expect(await r.run('PROMPT')).toBe('[{"host":"a.vendor.io","hint":"h"}]');
    expect(runs[0].cmd).toBe('claude');
    const a = runs[0].args;
    expect(a).toContain('-p');
    expect(a[a.indexOf('--tools') + 1]).toBe('');
    expect(a).toContain('--no-session-persistence');
    expect(a.slice(a.indexOf('--model'), a.indexOf('--model') + 2)).toEqual(['--model', 'claude-haiku-5-5']);
    expect(runs[0].input).toBe('PROMPT');
    expect(runs[0].cwd).not.toBe(process.cwd());
    expect(runs[0].cwdExisted && runs[0].cwdEntries).toEqual([]);
    expect(fs.existsSync(runs[0].cwd)).toBe(false);
    expect(r.name).toBe('claude claude-haiku-5-5');
  });

  it('pi: print mode with no tools, extensions, skills, context files or session', async () => {
    const { run, runs } = fake();
    await hintRunner({ kind: 'pi' }, { run }).run('PROMPT');
    expect(runs[0].cmd).toBe('pi');
    expect(runs[0].args).toEqual(expect.arrayContaining(['-p', '--no-tools', '--no-extensions', '--no-skills', '--no-context-files', '--no-session']));
    expect(runs[0].args.at(-1)).toBe('PROMPT');
    expect(runs[0].args).not.toContain('--model');
  });

  it('codex: read-only and ephemeral, the answer read from its last-message file', async () => {
    const { run, runs } = fake('[{"host":"a.vendor.io","hint":"h"}]');
    const out = await hintRunner({ kind: 'codex' }, { model: 'gpt-6.1-sol', run }).run('PROMPT');
    expect(out).toBe('[{"host":"a.vendor.io","hint":"h"}]');
    expect(runs[0].cmd).toBe('codex');
    const a = runs[0].args;
    expect(a[0]).toBe('exec');
    expect(a).toEqual(expect.arrayContaining(['--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '-m', 'gpt-6.1-sol', '-']));
    expect(path.dirname(a[a.indexOf('-o') + 1])).toBe(runs[0].cwd);
    expect(runs[0].input).toBe('PROMPT');
  });

  it('a provider that fails says why, with the end of what it printed', async () => {
    const { run } = fake('', 1);
    await expect(hintRunner({ kind: 'claude' }, { run }).run('PROMPT')).rejects.toThrow(/claude.*exited 1.*not logged in/s);
  });

  it('a URL: one chat completion, the model and a key from AGENFK_HINTS_API_KEY when set', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ANSWER' } }] }), { status: 200 }));
    const r = hintRunner({ kind: 'url', url: 'http://127.0.0.1:8080/v1' }, { model: 'qwen3-4b', fetch, env: { AGENFK_HINTS_API_KEY: 'k-123' } });
    expect(await r.run('PROMPT')).toBe('ANSWER');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8080/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k-123');
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'qwen3-4b', messages: [{ role: 'user', content: 'PROMPT' }] });
    expect(r.name).toBe('127.0.0.1:8080 qwen3-4b');
  });

  it('a URL that answers an error fails with its status', async () => {
    const fetch = vi.fn(async () => new Response('nope', { status: 503 }));
    await expect(hintRunner({ kind: 'url', url: 'http://127.0.0.1:8080/v1' }, { fetch, env: {} }).run('P')).rejects.toThrow(/503/);
  });
});

describe('writing hints in batches', () => {
  const subject = (i: number) => ({ host: `h${i}.vendor.io`, hits: 1, uploads: 0, projects: [], examples: [`curl https://h${i}.vendor.io/`] });

  it(`asks about at most ${HINT_BATCH} hosts at a time; a batch that fails is reported and the others still count`, async () => {
    const subjects = Array.from({ length: HINT_BATCH * 2 + 1 }, (_, i) => subject(i));
    let n = 0;
    const runner = {
      name: 'fake',
      run: vi.fn(async (prompt: string) => {
        if (++n === 2) throw new Error('rate limited');
        const asked = subjects.filter(s => prompt.includes(`"${s.host}"`));
        return JSON.stringify(asked.map(s => ({ host: s.host, hint: `about ${s.host}` })));
      }),
    };
    const log = vi.fn();
    const hints = await writeHints(subjects, runner, log);
    expect(runner.run).toHaveBeenCalledTimes(3);
    expect(hints.size).toBe(HINT_BATCH + 1);
    expect(hints.get('h0.vendor.io')).toBe('about h0.vendor.io');
    expect(log.mock.calls.flat().join('\n')).toMatch(/rate limited/);
  });
});

describe('what the import collects', () => {
  const ENV = 'HINTS_TEST_SECRET_TOKEN';
  const SECRET = 'Zq9xLm2Pw8Rt5Yv1KcHints';

  it('the project of each host, from the session\'s working folder', async () => {
    session('a', [header('/home/dev/spark'), call('curl https://api.vendor.io/x')]);
    session('b', [header('/home/dev/horizon'), call('curl https://api.vendor.io/y')]);
    const out = await collectPiSessionHosts(dir);
    expect([...out.context.get('api.vendor.io')!.projects].sort()).toEqual(['horizon', 'spark']);
  });

  it(`examples only when asked: at most ${MAX_HINT_EXAMPLES} per host, each cut, secrets removed`, async () => {
    session('a', [header('/home/dev/spark'),
      ...Array.from({ length: 5 }, (_, i) => call(`curl -H "Authorization: Bearer ${SECRET}" https://api.vendor.io/${i}${'x'.repeat(400)}`))]);
    expect((await collectPiSessionHosts(dir)).context.get('api.vendor.io')!.examples).toEqual([]);
    const out = await collectPiSessionHosts(dir, { examples: true, env: { [ENV]: SECRET } });
    const ex = out.context.get('api.vendor.io')!.examples;
    expect(ex).toHaveLength(MAX_HINT_EXAMPLES);
    for (const e of ex) {
      expect(e.length).toBeLessThanOrEqual(MAX_EXAMPLE_CHARS);
      expect(e).not.toContain(SECRET);
    }
  });

  it('each batch entry carries its context, an empty one when there is none (so the server clears a stale one)', async () => {
    session('a', [header('/home/dev/spark'), call('curl https://api.vendor.io/x')]);
    session('b', [call('curl https://bare.vendor.io/x')]);
    const out = await collectPiSessionHosts(dir, { examples: true });
    const entries = [...importBatches(out.hosts, undefined, new Map([['api.vendor.io', { projects: ['spark'], reverseDns: null, hint: 'A docs API.', hintBy: 'pi' }]]))][0].hosts;
    expect(entries.find(e => e.host === 'api.vendor.io')!.context).toEqual({ projects: ['spark'], reverseDns: null, hint: 'A docs API.', hintBy: 'pi' });
    expect(entries.find(e => e.host === 'bare.vendor.io')!.context).toEqual({ projects: [], reverseDns: null, hint: null, hintBy: null });
    // Examples are for the model only: never sent to the server.
    expect(JSON.stringify(entries)).not.toContain('curl');
  });
});

describe('runLearnImport with context and hints', () => {
  const post = () => vi.fn(async (_url: string, body: any) => ({ data: { recorded: body.hosts.length, invalid: 0 } }));

  it('looks up the reverse DNS name of a public address only, and sends it', async () => {
    session('a', [header('/home/dev/horizon'), call('ssh ec2-user@16.170.214.92 uptime && curl http://10.1.1.53:8000/v1/models https://api.vendor.io/')]);
    const reverse = vi.fn(async (ip: string) => (ip === '16.170.214.92' ? ['ec2-16-170-214-92.eu-north-1.compute.amazonaws.com'] : []));
    const p = post();
    await runLearnImport({ dir }, { post: p, apiUrl: 'http://api.test', log: vi.fn(), reverse });
    expect(reverse.mock.calls.map(c => c[0])).toEqual(['16.170.214.92']);
    const sent = p.mock.calls[0][1].hosts;
    expect(sent.find((h: any) => h.host === '16.170.214.92').context).toMatchObject({ reverseDns: 'ec2-16-170-214-92.eu-north-1.compute.amazonaws.com', projects: ['horizon'] });
  });

  it('a lookup that fails or is slow leaves the name out; the import goes on', async () => {
    session('a', [call('ssh 52.1.2.3 uptime')]);
    const reverse = vi.fn(async () => { throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); });
    const p = post();
    const r = await runLearnImport({ dir }, { post: p, apiUrl: 'http://api.test', log: vi.fn(), reverse });
    expect(r.recorded).toBe(1);
    expect(p.mock.calls[0][1].hosts[0].context.reverseDns).toBeNull();
  });

  it('without --hints no model is run and no example is collected', async () => {
    session('a', [header('/home/dev/spark'), call('curl https://api.vendor.io/x')]);
    const hintRunnerFor = vi.fn();
    await runLearnImport({ dir }, { post: post(), apiUrl: 'http://api.test', log: vi.fn(), reverse: async () => [], hintRunnerFor });
    expect(hintRunnerFor).not.toHaveBeenCalled();
  });

  it('with --hints: says what goes where, never asks about a private or reserved host, and sends each hint with who wrote it', async () => {
    session('a', [header('/home/dev/spark'), call('curl https://api.vendor.io/x && curl http://10.1.1.53:8000/ && curl https://docs.example.com/')]);
    const prompts: string[] = [];
    const runner = { name: 'pi spark/glm', run: vi.fn(async (prompt: string) => { prompts.push(prompt); return '[{"host":"api.vendor.io","hint":"A vendor API."}]'; }) };
    const hintRunnerFor = vi.fn(() => runner);
    const log = vi.fn();
    const p = post();
    const r = await runLearnImport({ dir, hints: { kind: 'pi' }, hintsModel: 'spark/glm' }, { post: p, apiUrl: 'http://api.test', log, reverse: async () => [], hintRunnerFor });
    expect(hintRunnerFor).toHaveBeenCalledWith({ kind: 'pi' }, 'spark/glm');
    // Asked about: never the private address or the reserved name (they may still appear inside another host's example).
    expect(prompts.join('\n')).not.toMatch(/"host": "(10\.1\.1\.53|docs\.example\.com)"/);
    expect(prompts.join('\n')).toMatch(/"host": "api\.vendor\.io"/);
    expect(log.mock.calls.flat().join('\n')).toMatch(/1 host.*pi spark\/glm/);
    const sent = p.mock.calls[0][1].hosts.find((h: any) => h.host === 'api.vendor.io');
    expect(sent.context).toMatchObject({ hint: 'A vendor API.', hintBy: 'pi spark/glm', projects: ['spark'] });
    expect(r.hints).toEqual({ asked: 1, written: 1 });
  });
});

describe('the command', () => {
  it('takes --hints <provider> and --hints-model <id>', () => {
    const program = new Command();
    registerAirlockCommands(program, { launch: async () => 0, exit: () => {} });
    const learn = program.commands.find(c => c.name() === 'airlock')!.commands.find(c => c.name() === 'learn')!;
    expect(learn.options.map(o => o.long)).toEqual(expect.arrayContaining(['--hints', '--hints-model']));
  });

  it('an unknown provider stops it before anything is read or sent', async () => {
    const exit = vi.fn();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const program = new Command();
    program.exitOverride();
    registerAirlockCommands(program, { launch: async () => 0, exit });
    await program.parseAsync(['node', 'agenfk', 'airlock', 'learn', '--import-pi-sessions', '--dir', dir, '--hints', 'gpt']);
    expect(exit).toHaveBeenCalledWith(1);
    expect(err.mock.calls.flat().join('\n')).toMatch(/claude, codex, pi or an http\(s\) URL/);
    err.mockRestore();
  });
});

describe('review (Codex, 2026-11-02)', () => {
  it.each([
    ['curl -u alice:ordinary-pass https://api.vendor.io/', 'ordinary-pass'],
    ['curl --user=alice:hunter22 https://api.vendor.io/', 'hunter22'],
    ['curl -H "Authorization: Basic YWxpY2U6aHVudGVy" https://api.vendor.io/', 'YWxpY2U6aHVudGVy'],
    ["curl -H 'Cookie: session=s3cr3tcookie' https://api.vendor.io/", 's3cr3tcookie'],
    ['curl -H "X-Api-Key: plainkey123" https://api.vendor.io/', 'plainkey123'],
    ['git clone https://bob:pw-in-url@git.vendor.io/r.git', 'pw-in-url'],
    ['sshpass -p sshpw123 ssh 52.1.2.3', 'sshpw123'],
    ['mysql -h db.vendor.io -pdbpw123 app', 'dbpw123'],
    ['DB_PASSWORD=envpw123 node app.js && curl https://api.vendor.io', 'envpw123'],
    ['wget --password=wgetpw123 https://files.vendor.io/a', 'wgetpw123'],
    ['curl -ualice:gluedpw123 https://api.vendor.io/', 'gluedpw123'],
    ['curl -s -Uproxy:proxpw123 https://api.vendor.io/', 'proxpw123'],
    ['sshpass -pgluedssh123 ssh 52.1.2.3', 'gluedssh123'],
    ['curl -u alice:originpw -U proxy:secondpw https://api.vendor.io/', 'secondpw'],
    ['curl -Uproxy:firstpw -ualice:secondpw2 https://api.vendor.io/', 'secondpw2'],
    ['sort -u a.txt && curl -u bob:afterpw https://api.vendor.io/', 'afterpw'],
  ])('credentials a command spells out are scrubbed: %s', (command, secret) => {
    const out = scrubCredentials(command);
    expect(out).not.toContain(secret);
    expect(out).toContain('[REDACTED]');
  });

  it('a command with no credential is left as it was', () => {
    for (const c of ['curl -s https://api.vendor.io/v1?page=2', 'ssh ec2-user@16.170.214.92 uptime', 'ls -p /tmp', 'sort -u hosts.txt', 'git push -u origin main']) {
      expect(scrubCredentials(c)).toBe(c);
    }
  });

  it.each([
    ['curl -u alice:ordinary-pass https://api.vendor.io/x', 'ordinary-pass'],
    ['curl -ualice:gluedpw123 https://api.vendor.io/x', 'gluedpw123'],
  ])('an example carrying a credential reaches the prompt scrubbed: %s', async (command, secret) => {
    session('a', [header('/home/dev/spark'), call(command)]);
    const ex = (await collectPiSessionHosts(dir, { examples: true })).context.get('api.vendor.io')!.examples;
    expect(ex.join('\n')).not.toContain(secret);
  });

  it('a project name longer than a context keeps is never collected, so never prompted', async () => {
    session('a', [header(`/home/dev/${'x'.repeat(5000)}`), call('curl https://api.vendor.io/x')]);
    expect((await collectPiSessionHosts(dir, { examples: true })).context.get('api.vendor.io')!.projects).toEqual([]);
  });

  it('a hint carrying a secret is dropped by the screen, judged before it is cut', () => {
    const screen = (s: string) => /ghp_[A-Za-z0-9]{36}/.test(s);
    const out = JSON.stringify([{ host: 'a.vendor.io', hint: `${'w '.repeat(140)}ghp_${'a'.repeat(36)}` }, { host: 'b.vendor.io', hint: 'fine' }]);
    expect([...parseHints(out, ['a.vendor.io', 'b.vendor.io'], screen)]).toEqual([['b.vendor.io', 'fine']]);
  });

  it('a program that ignores SIGTERM is killed after the grace and the call fails, not hangs', async () => {
    const started = Date.now();
    await expect(runCommand(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],
      { cwd: dir, input: '', timeoutMs: 200, graceMs: 200, env: process.env })).rejects.toThrow(/longer than/);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('on a timeout, a descendant that ignores SIGTERM is killed even after the provider itself exits', async () => {
    const pidFile = path.join(dir, 'child.pid');
    const script = `const { spawn } = require('child_process');
      const c = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], { stdio: 'ignore' });
      require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
      setInterval(()=>{},1000);`;
    await expect(runCommand(process.execPath, ['-e', script], { cwd: dir, input: '', timeoutMs: 300, graceMs: 300, env: process.env })).rejects.toThrow(/longer than/);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    await new Promise(r => setTimeout(r, 900));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('reverse DNS stops starting lookups past its budget, and counts what it skipped or could not name', async () => {
    let t = 0;
    const reverse = vi.fn(async (ip: string) => { t += 1000; return ip.endsWith('.1') ? ['one.vendor.io'] : []; });
    const ips = Array.from({ length: 50 }, (_, i) => `52.0.0.${i + 1}`);
    const r = await reverseNames(ips, reverse, { budgetMs: 5000, now: () => t });
    expect(reverse.mock.calls.length).toBeLessThan(50);
    expect(r.skipped).toBe(50 - reverse.mock.calls.length);
    expect(r.names.get('52.0.0.1')).toBe('one.vendor.io');
    expect(r.unnamed).toBe(reverse.mock.calls.length - r.names.size);
  });

  it('the import says how reverse DNS went', async () => {
    session('a', [call('ssh 52.1.2.3 uptime && ssh 52.1.2.4 uptime')]);
    const log = vi.fn();
    await runLearnImport({ dir }, { post: vi.fn(async (_u: string, b: any) => ({ data: { recorded: b.hosts.length } })), apiUrl: 'http://api.test', log, reverse: async (ip: string) => (ip === '52.1.2.3' ? ['a.vendor.io'] : []) });
    expect(log.mock.calls.flat().join('\n')).toMatch(/Reverse DNS: named 1 of 2 addresses; 1 had no name/);
  });
});
