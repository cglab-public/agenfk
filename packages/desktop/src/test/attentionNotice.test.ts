/**
 * @vitest-environment node
 *
 * The OS banner that says an agent is waiting for you.
 *
 * The rule the card asks for is "when the app is unfocused", and that rule has
 * to be decided HERE rather than in the renderer. The renderer's
 * `document.hasFocus()` answers whether the document has focus, which is not
 * the same question: a window can be behind another application while its
 * document still reports focus, and a renderer that has just been backgrounded
 * is exactly the case the setting is for. The main process can ask the window.
 *
 * The other reason is trust. A banner is the one part of this feature that
 * renders outside the app's own surface, so what goes in it must not be
 * renderer-authored text — an agent's terminal title is agent output, and an
 * OS notification is a good place to put a convincing sentence in front of
 * somebody.
 */
import { describe, it, expect } from 'vitest';
import { showAttentionNotice } from '../main/attentionNotice';

const deps = (over: Partial<Parameters<typeof showAttentionNotice>[1]> = {}) => {
  const shown: Array<Record<string, unknown>> = [];
  return {
    shown,
    deps: {
      isFocused: () => false,
      supported: () => true,
      show: (options: Record<string, unknown>) => { shown.push(options); },
      ...over,
    },
  };
};

describe('when the banner is shown', () => {
  it('shows one when the app is not focused', () => {
    const { shown, deps: d } = deps();
    expect(showAttentionNotice({ agentLabel: 'Codex', cardTitle: 'Fix the flaky test' }, d)).toBe(true);
    expect(shown).toHaveLength(1);
  });

  it('shows none when the user is already looking at the app', () => {
    // The card says "system banners when the app is unfocused", and that is not
    // a detail: a banner over the window you are typing in steals focus on some
    // desktops and is pure noise on the rest.
    const { shown, deps: d } = deps({ isFocused: () => true });
    expect(showAttentionNotice({ agentLabel: 'Codex', cardTitle: 'x' }, d)).toBe(false);
    expect(shown).toHaveLength(0);
  });

  it('shows none where the OS has no notifications to show', () => {
    // Electron answers false on a Linux desktop with no notification daemon.
    // Constructing one there throws, and a throw on this path would take down
    // the activity handler that also drives the sessions rail.
    const { shown, deps: d } = deps({ supported: () => false });
    expect(showAttentionNotice({ agentLabel: 'Codex', cardTitle: 'x' }, d)).toBe(false);
    expect(shown).toHaveLength(0);
  });

  it('does not let a failure to notify escape', () => {
    // Same reason. This is called from a pty data callback.
    const d = { isFocused: () => false, supported: () => true, show: () => { throw new Error('dbus is gone'); } };
    expect(() => showAttentionNotice({ agentLabel: 'Codex', cardTitle: 'x' }, d)).not.toThrow();
    expect(showAttentionNotice({ agentLabel: 'Codex', cardTitle: 'x' }, d)).toBe(false);
  });
});

describe('what the banner says', () => {
  it('names the agent and the card, because the user has several', () => {
    // "An agent needs you" over four running agents tells the user to go and
    // check all four.
    const { shown, deps: d } = deps();
    showAttentionNotice({ agentLabel: 'Codex', cardTitle: 'Fix the flaky test' }, d);
    expect(String(shown[0].title)).toMatch(/Codex/);
    expect(String(shown[0].body)).toMatch(/Fix the flaky test/);
  });

  it('says what is being asked of the reader', () => {
    // A banner that only states a fact leaves the reader to work out whether it
    // needs them. This one only fires when it does.
    const { shown, deps: d } = deps();
    showAttentionNotice({ agentLabel: 'Codex', cardTitle: 'x' }, d);
    expect(`${shown[0].title} ${shown[0].body}`).toMatch(/waiting|needs you|attention/i);
  });

  it('works when there is no card title to name', () => {
    // A shell session has no card the user would recognise by name.
    const { shown, deps: d } = deps();
    expect(showAttentionNotice({ agentLabel: 'Codex' }, d)).toBe(true);
    expect(String(shown[0].body)).not.toMatch(/undefined|null/);
  });

  it('truncates a title long enough to be a paragraph', () => {
    // Card titles are free text and some are a sentence. An OS banner clips
    // silently, which turns a long title into a banner that says nothing.
    const { shown, deps: d } = deps();
    showAttentionNotice({ agentLabel: 'Codex', cardTitle: 'x'.repeat(500) }, d);
    expect(String(shown[0].body).length).toBeLessThan(200);
  });

  it('strips control characters out of the text it was handed', () => {
    // The title travels from an agent's own terminal title. Newlines and
    // escape sequences in a notification body render as anything from a blank
    // line to a spoofed second message.
    const { shown, deps: d } = deps();
    showAttentionNotice({ agentLabel: 'Codex', cardTitle: 'real\n]0;Sign in to continue' }, d);
    expect(String(shown[0].body)).not.toMatch(new RegExp(String.raw`[\u0000-\u001f]`));
  });

  it('never puts renderer-supplied markup where an OS would render it', () => {
    const { shown, deps: d } = deps();
    showAttentionNotice({ agentLabel: '<b>Codex</b>', cardTitle: 'x' }, d);
    expect(String(shown[0].title)).not.toMatch(/</);
  });
});
