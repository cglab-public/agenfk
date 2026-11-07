/**
 * The gatekeeper hook's block message is read by an agent that has just been
 * refused an edit, and it runs the suggested commands verbatim. It used to:
 *   - name the tool "unknown tool" for every Claude Code edit, because it read
 *     `tool` while Claude Code sends `tool_name`;
 *   - suggest `agenfk create item --type TASK --title`, which the CLI rejects
 *     ("unknown option '--type'"), and `agenfk verify <id>` without the
 *     --evidence the CLI requires.
 *
 * The contract test below pulls every `agenfk …` command out of the messages the
 * hook actually prints — no active task, and a project this machine has not
 * linked — and checks each against the built CLI's own --help, so a renamed
 * command or option breaks this test instead of the agent.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'child_process';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const HOOK = path.resolve(__dirname, '../../../../bin/agenfk-gatekeeper.mjs');
// The bin shim users run — it reports itself as `agenfk`; dist/index.js run
// directly would call itself `index`. It needs dist built.
const CLI = path.resolve(__dirname, '../../../cli/bin/agenfk.js');
const CLI_DIST = path.resolve(__dirname, '../../../cli/dist/index.js');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-gk-message-'));
const projectDir = path.join(home, 'repo');
const editedFile = path.join(projectDir, 'src', 'app.ts');
// A fresh clone: the shared project.json only, no local.json naming its id.
const unlinkedFile = path.join(home, 'clone', 'src', 'app.ts');
let server: http.Server;

beforeAll(async () => {
  fs.mkdirSync(path.join(projectDir, '.agenfk'), { recursive: true });
  fs.mkdirSync(path.dirname(editedFile), { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.agenfk', 'project.json'), JSON.stringify({ projectId: 'proj' }));
  fs.mkdirSync(path.join(home, 'clone', '.agenfk'), { recursive: true });
  fs.mkdirSync(path.dirname(unlinkedFile), { recursive: true });
  fs.writeFileSync(path.join(home, 'clone', '.agenfk', 'project.json'), JSON.stringify({ verifyCommand: 'npm test' }));
  // No items at all, so every edit is blocked and the message is printed.
  server = http.createServer((req, res) => {
    res.writeHead(req.url?.startsWith('/items') ? 200 : 404, { 'content-type': 'application/json' });
    res.end('[]');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  fs.mkdirSync(path.join(home, '.agenfk'), { recursive: true });
  fs.writeFileSync(path.join(home, '.agenfk', 'server-port'), String((server.address() as import('net').AddressInfo).port));
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

function blockReason(payload: object): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      env: { ...process.env, HOME: home, USERPROFILE: home, AGENFK_API_URL: '' },
    });
    let stdout = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.on('close', () => resolve(stdout ? JSON.parse(stdout).reason : ''));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

const claudeCodeEdit = { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: editedFile } };
const unlinkedEdit = { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: unlinkedFile } };

describe('gatekeeper block message', () => {
  it('names the tool from the payload Claude Code sends', async () => {
    const reason = await blockReason(claudeCodeEdit);
    expect(reason).toContain('while attempting to use Write.');
    expect(reason).not.toContain('unknown tool');
  });

  it('still names the tool for the pi/OpenCode adapters, which send `tool`', async () => {
    const reason = await blockReason({ tool: 'edit', tool_input: { file_path: editedFile } });
    expect(reason).toContain('while attempting to use edit.');
  });

  it('keeps the prefix the OpenCode adapter matches on', async () => {
    expect(await blockReason(claudeCodeEdit)).toMatch(/^AgenFK WORKFLOW VIOLATION:/);
    expect(await blockReason(unlinkedEdit)).toMatch(/^AgenFK WORKFLOW VIOLATION:/);
  });

  it('names the tool in the not-linked message too', async () => {
    expect(await blockReason(unlinkedEdit)).toContain('No task can authorize Write here:');
  });
});

describe('every command in the block message is real CLI syntax', () => {
  /** `agenfk <sub> <rest>` lines as the hook prints them, up to any "(…)" note. */
  const commandsIn = (reason: string) =>
    [...reason.matchAll(/agenfk ([a-z][a-z-]*)([^\n(]*)/g)].map(([line, sub, rest]) => ({
      line: line.trim(),
      sub,
      flags: rest.match(/--[a-z][a-z-]*/g) ?? [],
      args: rest.replace(/--[a-z][a-z-]*\s+("[^"]*"|\S+)/g, '').trim().split(/\s+/).filter(Boolean),
    }));

  const help = (sub: string) =>
    spawnSync(process.execPath, [CLI, sub, '--help'], {
      encoding: 'utf8',
      timeout: 30_000,
      // The CLI's main block is skipped under NODE_ENV=test; without this every
      // "help" would come back empty and the assertions would prove nothing.
      env: { ...process.env, HOME: home, USERPROFILE: home, NODE_ENV: 'production', VITEST: '' },
    });

  /** Every command in `reason` is a CLI command, and every option it passes is one the command defines. */
  const expectRealCommands = (reason: string, subs: string[]) => {
    expect(fs.existsSync(CLI_DIST), 'packages/cli/dist/index.js missing — run `npm run build` before `npm test`').toBe(true);
    const commands = commandsIn(reason);
    // Guard: an extraction that finds nothing would make the loop below vacuous.
    expect(commands.map((c) => c.sub)).toEqual(subs);

    for (const { line, sub, flags } of commands) {
      const res = help(sub);
      expect(res.status, `${line}: --help exited ${res.status}: ${res.stderr}`).toBe(0);
      // An unknown subcommand prints the top-level usage instead of its own.
      expect(res.stdout, `${line}: "${sub}" is not a CLI command`).toMatch(new RegExp(`^Usage: agenfk ${sub}\\b`));
      for (const flag of flags) {
        expect(res.stdout, `${line}: the CLI has no ${flag} option`).toContain(flag);
      }
    }
  };

  it('suggests commands the CLI accepts, with options it defines', async () => {
    expectRealCommands(await blockReason(claudeCodeEdit), ['create', 'verify']);
  });

  it('suggests real commands to link a project this machine has not linked', async () => {
    expectRealCommands(await blockReason(unlinkedEdit), ['list-projects', 'init', 'init']);
  });

  it('passes the --evidence that verify requires', async () => {
    const verify = commandsIn(await blockReason(claudeCodeEdit)).find((c) => c.sub === 'verify');
    expect(help('verify').stdout).toMatch(/--evidence <text>\s+REQUIRED/);
    expect(verify?.flags).toContain('--evidence');
  });

  it('creates an item of a type the CLI knows', async () => {
    const create = commandsIn(await blockReason(claudeCodeEdit)).find((c) => c.sub === 'create');
    const types = help('create').stdout.match(/\(([a-z, ]+)\)/)?.[1].split(/,\s*/) ?? [];
    expect(types).toContain('task');
    expect(types).toContain(create?.args[0]);
  });
});
