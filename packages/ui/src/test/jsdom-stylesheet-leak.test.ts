/**
 * Stylesheets do not outlive their test (the AppShell slowdown).
 *
 * jsdom 28.1 RE-CREATES a <style>'s sheet when the element leaves the document
 * because an ANCESTOR was removed - which is how every React unmount removes
 * it (the descendant's cached root is still the Document during _detach). xterm
 * injects two <style> elements of ~790 rules per terminal, so every terminal
 * test left ~1,580 rules registered, and getComputedStyle - which every byRole
 * query runs per element per poll - walks all of them. A test that takes 0.8s
 * alone took 4s late in AppShell.test.tsx, and 20s on a CI runner: the timeout.
 *
 * The shared test setup unregisters sheets whose owner is no longer in the
 * document after each test (scripts/vitest-jsdom-stylesheets.mjs).
 */
import { describe, it, expect } from 'vitest';
import { Terminal } from '@xterm/xterm';
// @ts-expect-error — plain .mjs helper
import { purgeOrphanedStyleSheets } from '../../../../scripts/vitest-jsdom-stylesheets.mjs';

/** An element's sheet left registered after its container was removed. */
const orphanOne = (css: string) => {
  const host = document.createElement('div');
  const style = document.createElement('style');
  style.textContent = css;
  host.appendChild(style);
  document.body.appendChild(host);
  host.remove();
};

describe('the jsdom leak itself', () => {
  it('still exists - if this fails, jsdom fixed it: delete the helper, its setup hook and this file', () => {
    const before = document.styleSheets.length;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const term = new Terminal();
    term.open(host);
    host.remove();
    term.dispose();
    expect(document.styleSheets.length - before).toBeGreaterThan(0);
  });
});

describe('purgeOrphanedStyleSheets', () => {
  it('drops a sheet whose element left the document, and keeps one still in it', () => {
    orphanOne('.gone { color: red }');
    const kept = document.createElement('style');
    kept.textContent = '.kept { color: blue }';
    document.head.appendChild(kept);
    const before = document.styleSheets.length;

    const removed = purgeOrphanedStyleSheets();

    expect(removed).toBeGreaterThan(0);
    expect(document.styleSheets.length).toBe(before - removed);
    const owners = Array.from(document.styleSheets).map(s => s.ownerNode);
    expect(owners.every(o => (o as Node | null)?.isConnected)).toBe(true);
    expect(owners.length).toBe(1);
    kept.remove();
  });

  it('runs after every test: a sheet orphaned in one test is gone by the next', async () => {
    // Two phases in ONE test, so the claim holds under a filter or a shuffle:
    // orphan a sheet, run the hook the setup installs, and look.
    orphanOne('.between-tests { color: green }');
    expect(document.styleSheets.length).toBeGreaterThan(0);
    purgeOrphanedStyleSheets();
    expect(document.styleSheets.length).toBe(0);
  });
});

describe('the setup hook', () => {
  // Proves the hook is INSTALLED, which the direct calls above cannot. Order
  // matters within this block, so the second test skips - rather than passing
  // on nothing - when run without the first (a filter, or a shuffle).
  let orphanedByPrevious = 0;
  it('orphans a sheet and leaves it for the hook', () => {
    orphanOne('.left-for-the-hook { color: purple }');
    orphanedByPrevious = document.styleSheets.length;
    expect(orphanedByPrevious).toBeGreaterThan(0);
  });
  it('finds it gone at the start of the next test', (ctx) => {
    if (orphanedByPrevious === 0) ctx.skip();
    expect(document.styleSheets.length).toBe(0);
  });
});

