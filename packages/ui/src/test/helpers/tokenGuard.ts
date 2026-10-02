/**
 * Visual-system guard for the dashboard's panels and modals (CGLAB-434 S5.2).
 *
 * `guardTokens()` registers an afterEach that sweeps whatever the test left on
 * screen, so every existing test of a component also proves it renders on the
 * tokens: no raw Tailwind palette colours (slate stays - tokens.css remaps it
 * to the neutral ramp), no gradients, glow or old teal chrome, teal only on the
 * brand mark and primary buttons (navy text on them), no inline hex/rgba colours
 * except on elements marked data-user-colour (a colour the user chose) (neutral black
 * shadows aside). Call it at the top level of a test file, AFTER the file's own
 * afterEach(cleanup) if it has one: after-hooks run last-registered-first, so
 * the sweep sees the DOM before cleanup empties it. One cleanup per guard
 * scope: a nested describe with its own afterEach(cleanup) needs its own
 * guardTokens() after it. Never call it from beforeAll - hooks registered
 * there never attach, and nothing can detect it.
 */
import { afterAll, afterEach, expect } from 'vitest';

const RAW_PALETTE = /\b(?:bg|text|border(?:-[trblxy])?|ring|ring-offset|from|to|via|fill|stroke|outline|divide|shadow|caret|accent|decoration|placeholder)-(?:(?:red|rose|amber|yellow|orange|emerald|green|teal|cyan|sky|blue|indigo|violet|purple|pink|fuchsia|lime|gray|zinc|neutral|stone)-\d{2,3}|white)\b|\b(?:bg|text|border|ring)-black\b(?!\/\d)|\b(?:text|border|ring)-black\/\d+/;
const OLD_ACCENT = /(?:^|\s|:)(?:(?:bg|from|to|via)-chip(?:\/\d+)?|(?:border|outline|ring)-border-brand(?:\/\d+)?|bg-mint(?:\/\d+)?|bg-brand\/\d+|text-brand(?:-dark|-light)?|shadow-glow|bg-gradient-[\w-]+|bg-\[image:var\(--gradient-accent\)\]|(?:border|ring|outline)-brand(?:\/\d+)?|ring-brand|story-blue(?:\/\d+)?|[\w-]*danger-muted(?:\/\d+)?)(?=\s|$)/;

export function expectOnTokens(root: HTMLElement = document.body): void {
  const marks = Array.from(root.querySelectorAll('[data-brand-mark]'));
  const els = [root, ...Array.from(root.querySelectorAll('*'))].filter(el => !marks.some(m => m.contains(el)));
  for (const el of els) {
    const c = el.getAttribute('class') ?? '';
    const where = `<${el.tagName.toLowerCase()}> ${el.outerHTML.slice(0, 140)}`;
    expect(c.match(RAW_PALETTE)?.[0] ?? null, `raw palette colour on ${where}`).toBeNull();
    expect(c.match(OLD_ACCENT)?.[0]?.trim() ?? null, `old teal accent on ${where}`).toBeNull();
    expect(c.match(/(?:^|\s|:)text-accent-text(?:\s|$)/)?.[0] ?? null, `teal text on ${where}`).toBeNull();
    if (/(?:^|\s)bg-brand(?:\s|$)/.test(c)) {
      expect(el.tagName, `bg-brand off a button: ${where}`).toBe('BUTTON');
      // Only navy reads on the teal (white or canvas text is about 2:1).
      expect(/(?:^|\s)text-navy(?:\s|$)/.test(c), `text on bg-brand is not text-navy: ${where}`).toBe(true);
    }
    // A colour the user chose (a flow step's) is data, marked data-user-colour.
    const style = el.hasAttribute('data-user-colour') ? '' : (el.getAttribute('style') ?? '').replace(/rgba?\(\s*0[\s,]+0[\s,]+0\b[^)]*\)/g, '');
    expect(style.match(/#[0-9a-f]{3,8}\b|rgba?\(/i)?.[0] ?? null, `inline colour on ${where}`).toBeNull();
  }
}

export function guardTokens(): void {
  // Registered from inside a hook or a test, the afterEach never fires and the
  // guard passes vacuously; refuse rather than guard nothing.
  if (expect.getState().currentTestName !== undefined) {
    throw new Error('guardTokens() must be called at file or describe level, not inside a hook or test');
  }
  let sawContent = false;
  afterEach(() => {
    if (document.body.innerHTML.trim() !== '') sawContent = true;
    expectOnTokens(document.body);
  });
  // Registered before a cleanup that runs first, every sweep sees an empty body.
  afterAll(() => {
    expect(sawContent, 'guardTokens() never saw a rendered DOM - is it registered before this suite\'s cleanup?').toBe(true);
  });
}
