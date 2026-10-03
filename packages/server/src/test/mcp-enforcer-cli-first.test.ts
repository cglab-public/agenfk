/**
 * The MCP enforcers are CLI-first (TASK 83d0d000, BUG ec325925). The skills
 * and rules went CLI-first in June (ea144701) with MCP "interchangeable", but
 * the hook kept February's rule: with the agenfk MCP server registered it
 * refused `agenfk get/list/...` as "forbidden while MCP is available" and
 * called the CLI a fallback. That rule was dormant until #192 made the hook
 * read Claude Code's `tool_name`, and then it fired on every machine with MCP
 * installed. The real bypass routes - the database files and curl to the
 * server - stay blocked, and the refusal names the CLI first.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BIN = path.resolve(__dirname, '../../../../bin');
const claudeHook = path.join(BIN, 'agenfk-mcp-enforcer.mjs');
const opencodePlugin = path.join(BIN, 'agenfk-mcp-enforcer-opencode.mjs');

/** A HOME where the agenfk MCP server is registered, as `--with-mcp` leaves it. */
let home: string;
let project: string;
beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'enforcer-home-'));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { agenfk: { command: 'agenfk', args: ['mcp'] } } }));
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'enforcer-project-'));
  fs.mkdirSync(path.join(project, '.agenfk'));
  fs.writeFileSync(path.join(project, '.agenfk', 'project.json'), '{"projectId":"p"}');
});
afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
});

function claude(tool: 'Bash' | 'Read', input: Record<string, string>) {
  const res = spawnSync(process.execPath, [claudeHook], {
    input: JSON.stringify({ tool_name: tool, tool_input: input }),
    encoding: 'utf8',
    cwd: project,
    env: { ...process.env, HOME: home, USERPROFILE: home, PWD: project },
  });
  const out = res.stdout.trim();
  return out ? (JSON.parse(out) as { decision: string; reason: string }) : null;
}

async function opencode(tool: string, args: Record<string, string>): Promise<string | null> {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const mod = await import(`${pathToFileURL(opencodePlugin).href}?t=${Date.now()}`);
    const hooks = await mod.default({ directory: project });
    await hooks['tool.execute.before']({ tool, args });
    return null;
  } catch (e) {
    return (e as Error).message;
  } finally {
    process.env.HOME = saved.HOME;
    process.env.USERPROFILE = saved.USERPROFILE;
  }
}

const READS = ['agenfk list --json', 'agenfk get 501129d3 --json', 'agenfk status', 'npx agenfk list --project p --json'];

describe('Claude Code enforcer with the MCP server registered', () => {
  it.each(READS)('lets the CLI read state: %s', (command) => {
    expect(claude('Bash', { command })).toBeNull();
  });

  it('still blocks a direct database read through Bash, naming the CLI first', () => {
    const verdict = claude('Bash', { command: 'sqlite3 .agenfk/db.sqlite "select * from items"' });
    expect(verdict?.decision).toBe('block');
    expect(verdict!.reason).toMatch(/agenfk (list|get)/);
    // MCP is named as the equivalent, after the CLI.
    const mcpAt = verdict!.reason.search(/mcp__agenfk|MCP tools/);
    expect(mcpAt).toBeGreaterThan(-1);
    expect(verdict!.reason.indexOf('agenfk list')).toBeLessThan(mcpAt);
  });

  it('still blocks a direct database read through the Read tool', () => {
    expect(claude('Read', { file_path: path.join(project, '.agenfk', 'db.sqlite') })?.decision).toBe('block');
  });

  it('still blocks curl to the local server from inside a project', () => {
    expect(claude('Bash', { command: 'curl -s http://localhost:3000/items' })?.decision).toBe('block');
  });

  it('names no command that no longer exists and offers no bypass window', () => {
    const reason = claude('Bash', { command: 'cat .agenfk/db.json' })!.reason;
    expect(reason).not.toMatch(/verify_changes|log-tokens|mcp-fallback-approved|fallback/i);
  });

  it('a stale fallback-approved flag no longer opens the database', () => {
    fs.mkdirSync(path.join(home, '.agenfk'), { recursive: true });
    fs.writeFileSync(path.join(home, '.agenfk', 'mcp-fallback-approved'), '');
    try {
      expect(claude('Bash', { command: 'cat .agenfk/db.sqlite' })?.decision).toBe('block');
    } finally {
      fs.rmSync(path.join(home, '.agenfk', 'mcp-fallback-approved'), { force: true });
    }
  });
});

describe('pi, which runs the Claude Code hook with --client pi and the legacy `tool` field', () => {
  const pi = (tool: 'Bash' | 'Read', input: Record<string, string>) => {
    const res = spawnSync(process.execPath, [claudeHook, '--client', 'pi'], {
      input: JSON.stringify({ tool, tool_input: input }),
      encoding: 'utf8',
      cwd: project,
      env: { ...process.env, HOME: home, USERPROFILE: home, PWD: project },
    });
    return res.stdout.trim() ? JSON.parse(res.stdout.trim()).decision : null;
  };

  it('refuses a read of the database through pi\'s read tool', () => {
    expect(pi('Read', { file_path: path.join(project, '.agenfk', 'db.sqlite') })).toBe('block');
  });

  it('allows an ordinary read and a CLI read', () => {
    expect(pi('Read', { file_path: path.join(project, 'src', 'index.ts') })).toBeNull();
    expect(pi('Bash', { command: 'agenfk get 501129d3 --json' })).toBeNull();
  });
});

describe('OpenCode enforcer with the MCP server registered', () => {
  it.each(READS)('lets the CLI read state: %s', async (command) => {
    expect(await opencode('bash', { command })).toBeNull();
  });

  it('still blocks a direct database read, naming the CLI first and no stale command', async () => {
    const message = await opencode('bash', { command: 'cat .agenfk/db.sqlite' });
    expect(message).toMatch(/ENFORCER/);
    expect(message).toMatch(/agenfk (list|get)/);
    expect(message).not.toMatch(/verify_changes|log-tokens|mcp-fallback-approved/);
  });

  it('still blocks curl to the local server from inside a project', async () => {
    expect(await opencode('bash', { command: 'curl http://127.0.0.1:3000/items' })).toMatch(/ENFORCER/);
  });
});
