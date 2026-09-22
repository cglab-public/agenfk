/**
 * Writing into a herdr pane (96953f6a / CGLAB-266).
 *
 * This is the half that touches somebody else's terminal, so the tests are
 * mostly about what it REFUSES. herdr validates every key and answers
 * `invalid_key` — but a round trip to learn that is worse than a thrown error
 * at the call site, and the refused set is enumerable, so an interface can grey
 * those keys instead of discovering them by failing.
 *
 * The grammar pinned here was enumerated empirically against herdr 0.7.0 and
 * re-verified on 0.7.3 and 0.7.4 (collie's HERDR_API.md, MIT). It is NOT tmux
 * syntax, which is the mistake anyone coming from tmux will make first.
 */
import { describe, it, expect } from 'vitest';
import {
  isSendableKey,
  normalizeKey,
  sendPaneText,
  sendPaneKeys,
  focusPane,
  HERDR_UNSENDABLE_KEYS,
  MAX_SEND_TEXT_BYTES,
  SPECIAL_KEYS_FOR_TEST,
} from '../herdrWrite';

const ok = '{"id":"x","result":{"type":"ack"}}';

/* ── the grammar, refused locally ──────────────────────────────────────── */

describe('which keys herdr will take', () => {
  it('takes the special keys, in any case', () => {
    for (const k of ['Up', 'down', 'LEFT', 'Right', 'Tab', 'Enter', 'Escape', 'Space', 'Backspace', 'BS', 'F1', 'f12']) {
      expect(isSendableKey(k), k).toBe(true);
    }
  });

  it('takes a single literal character, which is how a permission dialog gets answered', () => {
    /*
     * `{keys:["1"]}` answers a permission prompt; `{keys:["2","Enter"]}` picks
     * option 2 of a question. That is the whole reason a person would reach for
     * this from another screen.
     */
    for (const k of ['1', '9', 'a', 'Z', '/', '?']) expect(isSendableKey(k), k).toBe(true);
  });

  it('takes chords, in any modifier order, including three at once', () => {
    for (const k of ['ctrl+c', 'ctrl+u', 'shift+tab', 'alt+Up', 'ctrl+shift+p', 'shift+ctrl+p', 'ctrl+alt+shift+p']) {
      expect(isSendableKey(k), k).toBe(true);
    }
  });

  it('REFUSES the six herdr answers invalid_key to, in any spelling', () => {
    /*
     * There is no forward-delete and no scrollback paging by key — the mirror
     * scrolls instead. Enumerated, so a keypad can grey them rather than let a
     * person press something that will always fail.
     */
    for (const k of HERDR_UNSENDABLE_KEYS) {
      expect(isSendableKey(k), k).toBe(false);
      expect(isSendableKey(k.toLowerCase()), k).toBe(false);
      expect(isSendableKey(`ctrl+${k}`), k).toBe(false);
    }
    expect(HERDR_UNSENDABLE_KEYS).toEqual(['PageUp', 'PageDown', 'Home', 'End', 'Insert', 'Delete']);
  });

  it('REFUSES tmux syntax, which is the first thing anyone will try', () => {
    // `C-c` and `BTab` are what a tmux user reaches for. herdr answers
    // invalid_key to both.
    for (const k of ['C-c', 'C-u', 'BTab', 'M-f']) expect(isSendableKey(k), k).toBe(false);
  });

  it('refuses an unknown name rather than hoping', () => {
    for (const k of ['Fn', 'F13', 'ctrl+', '+c', '']) expect(isSendableKey(k), k).toBe(false);
  });

  it('refuses an INVENTED modifier, even when the key after it is valid', () => {
    /*
     * The gap mutation found: `foo+c` has a one-character base, and a single
     * character is always typable — so without the modifier check it sails
     * through and herdr answers `invalid_key` on the wire instead.
     */
    for (const k of ['foo+c', 'hyper+a', 'fn+Up', 'control+c']) {
      expect(isSendableKey(k), k).toBe(false);
    }
    // `super` IS one of herdr's, so it must still pass — the check is a list,
    // not a blanket refusal of anything unfamiliar.
    expect(isSendableKey('super+p')).toBe(true);
  });

  it('keeps refusing the six even if the special-key list ever grows to include one', () => {
    /*
     * The explicit set looks redundant today: none of the six is in
     * SPECIAL_KEYS, so they already fall through. Its job is to survive a
     * future edit that adds `Home` to that list by analogy with `End` on
     * another multiplexer — and to be EXPORTED, so a keypad greys them instead
     * of discovering them by failing.
     */
    for (const k of HERDR_UNSENDABLE_KEYS) {
      expect(SPECIAL_KEYS_FOR_TEST.includes(k.toLowerCase()), `${k} must not be special`).toBe(false);
    }
  });

  it('spells meta as cmd on the wire, and accepts both on input', () => {
    // The contract has one word; herdr answers to `cmd` and `super`.
    expect(normalizeKey('meta+p')).toBe('cmd+p');
    expect(normalizeKey('cmd+p')).toBe('cmd+p');
  });

  it('keeps the case of a literal character, because that IS the character typed', () => {
    expect(normalizeKey('Z')).toBe('Z');
    expect(normalizeKey('z')).toBe('z');
  });
});

/* ── sending ───────────────────────────────────────────────────────────── */

describe('sending text', () => {
  it('sends it as pane.send_text, verbatim', async () => {
    let sent = '';
    await sendPaneText('/s.sock', 'w1:p1', 'npm test', async (_p, line) => { sent = line; return ok; });
    expect(JSON.parse(sent)).toMatchObject({
      method: 'pane.send_text', params: { pane_id: 'w1:p1', text: 'npm test' },
    });
  });

  it('does NOT append an Enter, because the caller decides when to run it', async () => {
    /*
     * `agent.send` writes literal text with no Enter, and this keeps that
     * property: typing a command into somebody's terminal is one act, running
     * it is another, and merging them takes the decision away from whoever is
     * watching.
     */
    let sent = '';
    await sendPaneText('/s.sock', 'p', 'rm -rf build', async (_p, line) => { sent = line; return ok; });
    expect(JSON.parse(sent).params.text).toBe('rm -rf build');
    expect(JSON.parse(sent).params.text).not.toMatch(/\n$/);
  });

  it('refuses text over the ceiling before it can hang', async () => {
    // The 1 MiB request cap is the protocol's, and over it the server does not
    // answer at all.
    await expect(sendPaneText('/s.sock', 'p', 'x'.repeat(MAX_SEND_TEXT_BYTES + 1), async () => ok))
      .rejects.toThrow(/too (large|long)|ceiling/i);
  });

  it('refuses an empty pane id rather than letting the server guess', async () => {
    await expect(sendPaneText('/s.sock', '', 'hi', async () => ok)).rejects.toThrow(/pane/i);
  });

  it('surfaces pane_not_found instead of reporting success', async () => {
    const gone = '{"id":"","error":{"code":"pane_not_found","message":"no such pane"}}';
    const r = await sendPaneText('/s.sock', 'nope', 'hi', async () => gone);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe('pane_not_found');
  });
});

describe('sending keys', () => {
  it('sends them as an array, normalised', async () => {
    let sent = '';
    await sendPaneKeys('/s.sock', 'p', ['2', 'Enter'], async (_p, line) => { sent = line; return ok; });
    expect(JSON.parse(sent)).toMatchObject({
      method: 'pane.send_keys', params: { pane_id: 'p', keys: ['2', 'Enter'] },
    });
  });

  it('refuses the whole batch when ONE key is unsendable', async () => {
    /*
     * Partial sends are worse than none: half a chord arriving in somebody's
     * terminal is input they did not ask for and cannot undo.
     */
    let called = false;
    await expect(
      sendPaneKeys('/s.sock', 'p', ['ctrl+c', 'PageUp'], async () => { called = true; return ok; }),
    ).rejects.toThrow(/PageUp/);
    expect(called, 'nothing may reach the socket').toBe(false);
  });

  it('refuses an empty batch, which would be a request that means nothing', async () => {
    await expect(sendPaneKeys('/s.sock', 'p', [], async () => ok)).rejects.toThrow(/empty|at least one/i);
  });
});

/* ── the one that moves somebody's screen ──────────────────────────────── */

describe('focus', () => {
  it('is a separate call, never folded into sending', async () => {
    /*
     * `pane.focus` moves the pane, the tab AND the workspace in one go — it
     * moves the OPERATOR'S REAL SCREEN, on their machine, while they are
     * working. collie calls it from exactly one place: the "Show in terminal"
     * row. It must never be a side effect of typing.
     */
    let sent = '';
    await focusPane('/s.sock', 'w2:p3', async (_p, line) => { sent = line; return '{"id":"x","result":{"type":"pane_info"}}'; });
    expect(JSON.parse(sent).method).toBe('pane.focus');
  });

  it('is not reachable by sending text or keys', async () => {
    const lines: string[] = [];
    const t = async (_p: string, line: string): Promise<string> => { lines.push(line); return ok; };
    await sendPaneText('/s.sock', 'p', 'hi', t);
    await sendPaneKeys('/s.sock', 'p', ['Enter'], t);
    expect(lines.some(l => l.includes('pane.focus'))).toBe(false);
  });
});
