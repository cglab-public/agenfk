/**
 * @vitest-environment node
 *
 * Preferences that must not be reachable over HTTP.
 *
 * This module exists because of one adversarial-review finding. `autoApprove`
 * — start agents with their own permission prompts disabled — was briefly an
 * ordinary setting on the server's `PUT /settings`, which is unauthenticated
 * and accepts requests with no Origin header at all.
 *
 * That is fine for a preference whose worst outcome is a terminal that does or
 * does not survive quitting. It is not fine for one that changes the argv of
 * every agent the app spawns afterwards. The server already draws that line:
 * `verifyCommand` sits behind VERIFY_TOKEN precisely because it is "a shell
 * string", and `autoWorktree` is open precisely because it is "a boolean
 * preference with no execution semantics". auto-approve was put on the wrong
 * side of it.
 *
 * The escalation that matters for this product: an agent running WITH prompts
 * on, granted approval for a single localhost HTTP call, could permanently
 * remove the prompts for every future session. That is the exact boundary the
 * gatekeeper architecture exists to hold.
 *
 * A token would have matched the existing posture. Moving it is stronger and
 * simpler: the setting only ever affects terminals the DESKTOP spawns — a
 * browser has no terminals — so it lives here, reachable only through the
 * preload IPC. No HTTP route can set it, with or without a token.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readPrefs, writePref, cloneDirOrDefault, DEFAULT_PREFS, PREF_KEYS } from '../main/prefs';

let dir: string;
const file = (): string => path.join(dir, 'prefs.json');

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-prefs-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('defaults', () => {
  it('starts with agents asking for permission', () => {
    // The only default here that can cost something irreversible, and the one
    // that protects every install that never opens the settings screen.
    expect(DEFAULT_PREFS.autoApprove).toBe(false);
  });

  it('answers with defaults when nothing has been written', () => {
    expect(readPrefs(dir)).toEqual(DEFAULT_PREFS);
  });

  it('answers with defaults when the file is unreadable garbage', () => {
    // A corrupt file must not crash the app at startup, and must not be read
    // as "everything on" — failing towards the permissive state is the one
    // failure mode that actually costs the user something.
    fs.writeFileSync(file(), '{ not json');
    expect(readPrefs(dir)).toEqual(DEFAULT_PREFS);
  });

  it('answers with defaults when the file holds something that is not an object', () => {
    for (const junk of ['null', '[]', '"true"', '42']) {
      fs.writeFileSync(file(), junk);
      expect(readPrefs(dir)).toEqual(DEFAULT_PREFS);
    }
  });
});

describe('writing', () => {
  it('keeps what it is given', () => {
    writePref(dir, 'autoApprove', true);
    expect(readPrefs(dir).autoApprove).toBe(true);
  });

  it('can be turned back off', () => {
    writePref(dir, 'autoApprove', true);
    writePref(dir, 'autoApprove', false);
    expect(readPrefs(dir).autoApprove).toBe(false);
  });

  it('survives a restart, because a preference that forgets is not one', () => {
    writePref(dir, 'autoApprove', true);
    expect(readPrefs(dir).autoApprove).toBe(true);
    expect(JSON.parse(fs.readFileSync(file(), 'utf8')).autoApprove).toBe(true);
  });

  it('refuses a key it does not know', () => {
    // The renderer is our own bundle, but it is also the part an XSS would
    // control. A write surface that accepts arbitrary keys is a write surface
    // into whatever this file is later used for.
    expect(() => writePref(dir, 'somethingElse' as never, true)).toThrow(/unknown/i);
  });

  it('refuses a non-boolean', () => {
    for (const bad of ['true', 1, null, {}]) {
      expect(() => writePref(dir, 'autoApprove', bad as never)).toThrow();
    }
    expect(readPrefs(dir).autoApprove).toBe(false);
  });
});

describe('reading what is stored', () => {
  it('ignores a key it does not know rather than passing it on', () => {
    fs.writeFileSync(file(), JSON.stringify({ autoApprove: true, injected: 'x' }));
    // Every key the defaults define and nothing else. Spelled as the defaults
    // plus the override rather than as a literal, so adding a preference does
    // not quietly turn this into a test about the shape it used to have.
    expect(readPrefs(dir)).toEqual({ ...DEFAULT_PREFS, autoApprove: true });
    expect(readPrefs(dir)).not.toHaveProperty('injected');
  });

  it('ignores a stored value of the wrong type', () => {
    // A file edited by hand, or written by a different version. 'false' is a
    // truthy string, and reading it as true would turn the rails off for
    // someone who was trying to keep them on.
    fs.writeFileSync(file(), JSON.stringify({ autoApprove: 'false' }));
    expect(readPrefs(dir).autoApprove).toBe(false);
  });

  it('is not fooled by a __proto__ row', () => {
    fs.writeFileSync(file(), '{"__proto__":{"autoApprove":true}}');
    expect(readPrefs(dir).autoApprove).toBe(false);
  });
});

describe('the key list is closed', () => {
  it('lists exactly the keys the defaults define', () => {
    expect([...PREF_KEYS].sort()).toEqual(Object.keys(DEFAULT_PREFS).sort());
  });
});

/**
 * The custom notification sound, which is here and not in the server's settings.
 *
 * Every other notification preference is installation-wide and lives on the
 * server. This one is a PATH, and it reaches the filesystem. The server's
 * settings route is unauthenticated on loopback, so a path stored through it
 * would be a path any page on the machine can set — which is the same line this
 * file already draws for autoApprove, arrived at from a different direction.
 *
 * It is written by exactly one caller: the main-process file dialog. Nothing on
 * the renderer side of the border ever supplies the value.
 */
describe('the custom sound path', () => {
  it('starts empty, because no sound is the normal state', () => {
    expect(DEFAULT_PREFS.customSoundPath).toBe('');
  });

  it('keeps a path it is given', () => {
    const stored = writePref(dir, 'customSoundPath', '/Users/x/Library/AgEnFK/sounds/custom.wav');
    expect(stored.customSoundPath).toBe('/Users/x/Library/AgEnFK/sounds/custom.wav');
    expect(readPrefs(dir).customSoundPath).toBe('/Users/x/Library/AgEnFK/sounds/custom.wav');
  });

  it('does not disturb autoApprove when it is written', () => {
    // The failure a read-modify-write gets wrong: setting a sound must not
    // silently take an agent's permission prompts away, or put them back.
    writePref(dir, 'autoApprove', true);
    writePref(dir, 'customSoundPath', '/tmp/custom.wav');
    expect(readPrefs(dir).autoApprove).toBe(true);
  });

  it('refuses a non-string instead of coercing it', () => {
    // Coercion here would store "true" or "[object Object]" as a path, and the
    // read side would then try to open it.
    expect(() => writePref(dir, 'customSoundPath', 42 as unknown as string)).toThrow();
  });

  it('falls back to the default when the file holds the wrong type', () => {
    fs.writeFileSync(file(), JSON.stringify({ autoApprove: false, customSoundPath: 42 }));
    expect(readPrefs(dir).customSoundPath).toBe('');
  });
});

/*
 * The proposal for where clones land. The interesting half is what it does
 * NOT do: it never writes, so a machine that opens the dialog and closes it
 * again has no new folder and no new preference.
 */
describe('cloneDirOrDefault', () => {
  it('proposes ~/agenfk when nobody has chosen', () => {
    expect(cloneDirOrDefault(DEFAULT_PREFS, '/Users/me')).toBe('/Users/me/agenfk');
  });

  it('yields to a choice that was actually made', () => {
    expect(cloneDirOrDefault({ ...DEFAULT_PREFS, cloneDir: '/work/checkouts' }, '/Users/me'))
      .toBe('/work/checkouts');
  });

  it('does not store the proposal, so "remembered" keeps meaning remembered', () => {
    // Reading is not choosing. Asserted on the FILE, and against a prefs.json
    // that exists — `dir` is the suite's own sandbox, removed by afterEach;
    // a second one declared here would leak and, worse, would let this pass
    // while the real file was being written.
    writePref(dir, 'autoApprove', true);
    cloneDirOrDefault(readPrefs(dir), '/Users/me');
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'prefs.json'), 'utf8'));
    expect(onDisk.cloneDir ?? '').toBe('');
    expect(readPrefs(dir).cloneDir).toBe('');
  });
});

/**
 * The default agent, and whether opening a terminal asks first.
 *
 * Here for exactly the reason `autoApprove` is, and the argument is one line
 * long: the default agent decides WHICH BINARY every terminal the desktop
 * spawns runs. That is argv. The server's `/settings` is unauthenticated on
 * loopback, so a value stored there would let any page open on this machine
 * choose the program this app starts next — one step short of the shell string
 * that already sits behind VERIFY_TOKEN.
 *
 * What is deliberately NOT here: `herdr`. It is in `agentLabels.ts` only because
 * it is rendered beside agents; it is an attach, not a CLI this app starts, and
 * it brings its own tabs. It cannot be a default the open-dialog honours.
 */
describe('the default agent', () => {
  it('starts empty, meaning nobody has chosen one', () => {
    /*
     * '' is deliberately NOT 'claude-code'. A written value is a decision the
     * person made, and inventing one here would make "remembered" and
     * "suggested" the same thing — the cloneDir rule, arrived at again.
     */
    expect(DEFAULT_PREFS.defaultAgentId).toBe('');
  });

  it('keeps the agent it is given, across a restart', () => {
    writePref(dir, 'defaultAgentId', 'pi');
    expect(readPrefs(dir).defaultAgentId).toBe('pi');
  });

  it('refuses a non-string', () => {
    expect(() => writePref(dir, 'defaultAgentId', 7 as never)).toThrow(/must be string/i);
  });

  it('ignores a stored value of the wrong type', () => {
    // A hand-edited or half-written file: the answer is "nobody chose", not a
    // crash and not a guess at which agent the object meant.
    fs.writeFileSync(file(), JSON.stringify({ defaultAgentId: { id: 'pi' } }));
    expect(readPrefs(dir).defaultAgentId).toBe('');
  });

  it('does not disturb autoApprove when it is written', () => {
    // The failure a read-modify-write gets wrong, and the one that costs the
    // most here: choosing an agent must not take an agent's prompts away.
    writePref(dir, 'autoApprove', true);
    writePref(dir, 'defaultAgentId', 'codex');
    expect(readPrefs(dir).autoApprove).toBe(true);
  });
});

describe('whether opening a terminal asks first', () => {
  it('starts ON, so an upgrade opens terminals the way it always did', () => {
    // The same promise tmuxByDefault makes: an install that predates this must
    // not start skipping a screen because of a default we chose for it.
    expect(DEFAULT_PREFS.askBeforeOpening).toBe(true);
  });

  it('can be turned off, and stays off', () => {
    writePref(dir, 'askBeforeOpening', false);
    expect(readPrefs(dir).askBeforeOpening).toBe(false);
  });

  it('refuses a non-boolean', () => {
    expect(() => writePref(dir, 'askBeforeOpening', 'no' as never)).toThrow(/must be boolean/i);
  });
});
