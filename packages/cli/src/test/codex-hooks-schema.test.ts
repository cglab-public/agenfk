/**
 * Tests for CGLAB-12 — the installer wrote ~/.codex/hooks.json with an invalid
 * schema (a Claude-Code-style top-level `PostToolUse` key), which makes Codex
 * refuse to start with:
 *   failed to parse hooks config …/.codex/hooks.json: unknown field `PostToolUse`,
 *   expected `description` or `hooks` at line 2 column 15
 *
 * Codex requires hook events nested under a top-level `hooks` object, and it
 * matches the shell tool as `Bash` (not `shell`). This suite pins:
 *   - the pure config builder produces a valid Codex schema,
 *   - upgrades migrate away the legacy top-level key (self-heal),
 *   - the bundled template (codexrules/hooks.json) matches the valid schema.
 *
 * These reflect future functionality and are expected to fail until
 * scripts/install-helpers.mjs and codexrules/hooks.json are fixed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { buildCodexHooksConfig } from '../../../../scripts/install-helpers.mjs';

const ROOT = path.resolve(__dirname, '../../../..');
const CMD = '/h/agenfk-pr-hook --client codex';

const jsonHas = (v: unknown, needle: string) => JSON.stringify(v).includes(needle);

describe('CGLAB-12 — buildCodexHooksConfig', () => {
  it('produces a valid Codex schema: events nested under top-level `hooks`, no top-level PostToolUse', () => {
    const cfg = buildCodexHooksConfig({}, CMD);
    // The crash cause: a top-level PostToolUse key. It must NOT be present.
    expect(cfg).not.toHaveProperty('PostToolUse');
    expect(cfg.hooks).toBeTypeOf('object');
    expect(Array.isArray(cfg.hooks.PostToolUse)).toBe(true);
  });

  it('registers the pr-hook with the `Bash` matcher (Codex matches shell as Bash, not `shell`)', () => {
    const cfg = buildCodexHooksConfig({}, CMD);
    const entry = cfg.hooks.PostToolUse.find((e: any) => jsonHas(e, 'agenfk-pr-hook'));
    expect(entry).toBeDefined();
    expect(entry.matcher).toBe('Bash');
    expect(entry.hooks).toEqual([{ type: 'command', command: CMD }]);
  });

  it('migrates a legacy top-level PostToolUse away on upgrade (self-heals the crash)', () => {
    const legacy = {
      PostToolUse: [
        { matcher: 'shell', hooks: [{ type: 'command', command: '/old/agenfk-pr-hook --client codex' }] },
      ],
    };
    const cfg = buildCodexHooksConfig(legacy, CMD);
    expect(cfg).not.toHaveProperty('PostToolUse');
    // exactly one agenfk entry, now nested and using the Bash matcher
    const agenfkEntries = cfg.hooks.PostToolUse.filter((e: any) => jsonHas(e, 'agenfk-pr-hook'));
    expect(agenfkEntries).toHaveLength(1);
    expect(agenfkEntries[0].matcher).toBe('Bash');
  });

  it('preserves an existing description and other hook events', () => {
    const existing = {
      description: 'my hooks',
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/bin/user-pre' }] }],
      },
    };
    const cfg = buildCodexHooksConfig(existing, CMD);
    expect(cfg.description).toBe('my hooks');
    expect(jsonHas(cfg.hooks.PreToolUse, 'user-pre')).toBe(true);
    expect(jsonHas(cfg.hooks.PostToolUse, 'agenfk-pr-hook')).toBe(true);
  });

  it('preserves unrelated nested PostToolUse entries and is idempotent', () => {
    const existing = {
      hooks: {
        PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/bin/user-post' }] }],
      },
    };
    const once = buildCodexHooksConfig(existing, CMD);
    const twice = buildCodexHooksConfig(once, CMD);
    // unrelated entry survives both passes
    expect(jsonHas(twice.hooks.PostToolUse, 'user-post')).toBe(true);
    // exactly one agenfk entry after applying twice (no duplication)
    expect(twice.hooks.PostToolUse.filter((e: any) => jsonHas(e, 'agenfk-pr-hook'))).toHaveLength(1);
  });

  it('does not drop unrelated legacy top-level entries — migrates them into the nested location', () => {
    const legacy = {
      PostToolUse: [
        { matcher: 'shell', hooks: [{ type: 'command', command: '/usr/bin/user-legacy' }] },
        { matcher: 'shell', hooks: [{ type: 'command', command: '/old/agenfk-pr-hook --client codex' }] },
      ],
    };
    const cfg = buildCodexHooksConfig(legacy, CMD);
    expect(cfg).not.toHaveProperty('PostToolUse');
    expect(jsonHas(cfg.hooks.PostToolUse, 'user-legacy')).toBe(true);
  });
});

describe('CGLAB-12 — codexrules/hooks.json template', () => {
  it('is valid Codex schema (nested hooks, Bash matcher, no top-level PostToolUse)', () => {
    const tpl = JSON.parse(readFileSync(path.join(ROOT, 'codexrules', 'hooks.json'), 'utf8'));
    expect(tpl).not.toHaveProperty('PostToolUse');
    expect(Array.isArray(tpl.hooks?.PostToolUse)).toBe(true);
    const entry = tpl.hooks.PostToolUse.find((e: any) => jsonHas(e, 'agenfk-pr-hook'));
    expect(entry).toBeDefined();
    expect(entry.matcher).toBe('Bash');
  });
});

// GH-356: Codex's Airlock hook. Codex takes hooks only from hooks.json (with the user's trust), so
// the installer registers it there; it judges calls only inside the Airlock sandbox and does
// nothing outside it. Its path is the same in the machine (~/.agenfk/bin is given to the session).
describe('GH-356 — the Airlock PreToolUse hook for Codex', () => {
  const AIRLOCK = 'node "/h/.agenfk/bin/agenfk-airlock-hook.mjs"';
  const airlockEntries = (cfg: any) => (cfg.hooks.PreToolUse ?? []).filter((e: any) => jsonHas(e, 'agenfk-airlock-hook'));

  it('registers it under hooks.PreToolUse, beside the pr-hook', () => {
    const cfg = buildCodexHooksConfig({}, CMD, AIRLOCK);
    expect(airlockEntries(cfg)).toHaveLength(1);
    expect(airlockEntries(cfg)[0].hooks).toEqual([{ type: 'command', command: AIRLOCK }]);
    expect(cfg.hooks.PostToolUse.some((e: any) => jsonHas(e, 'agenfk-pr-hook'))).toBe(true);
    expect(cfg).not.toHaveProperty('PreToolUse');
  });

  it('is idempotent and keeps the user\'s own PreToolUse entries', () => {
    const mine = { matcher: 'Bash', hooks: [{ type: 'command', command: 'my-guard' }] };
    const once = buildCodexHooksConfig({ hooks: { PreToolUse: [mine] } }, CMD, AIRLOCK);
    const twice = buildCodexHooksConfig(once, CMD, AIRLOCK);
    expect(airlockEntries(twice)).toHaveLength(1);
    expect(twice.hooks.PreToolUse).toContainEqual(mine);
  });

  it('without an Airlock command, leaves PreToolUse as it was (older callers)', () => {
    const cfg = buildCodexHooksConfig({ hooks: { PreToolUse: [] } }, CMD);
    expect(cfg.hooks.PreToolUse).toEqual([]);
  });
});
