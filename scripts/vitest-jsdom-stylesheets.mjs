import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * Unregister stylesheets whose <style>/<link> is no longer in the document.
 *
 * jsdom 28.1 (a regression fixed in 30.1) RE-CREATES a <style>'s sheet when
 * the element leaves the document because an ANCESTOR was removed - which is
 * how a React unmount removes it: during the descendant's _detach its cached
 * root is still the Document, so it re-parses its CSS and registers a fresh
 * sheet that nothing will ever remove. xterm's DOM renderer injects two <style> elements of ~790 rules
 * per terminal, so every terminal test left ~1,580 rules registered, and
 * getComputedStyle (which every byRole query runs per element per poll) walks
 * all of them - and the orphaned rules keep applying to later tests' computed
 * styles. The AppShell specs slowed test by test until one hit the 20s timeout
 * on CI. A browser drops the sheet; this does what jsdom should. Once jsdom is
 * >= 30.1 this finds nothing to do (see jsdom-stylesheet-leak.test.ts).
 *
 * Goes through jsdom's own StyleSheetList._remove. If jsdom's internals move,
 * it says so once instead of quietly letting the slowdown come back.
 */
let warned = false;
const warnOnce = (why) => {
  if (warned) return;
  warned = true;
  console.warn(`[vitest-jsdom-stylesheets] cannot purge orphaned stylesheets (${why}); jsdom specs will slow down as they run`);
};

export function purgeOrphanedStyleSheets(doc = globalThis.document) {
  if (!doc || !doc.styleSheets) return 0;
  const orphaned = Array.from(doc.styleSheets).filter((s) => s && s.ownerNode && !s.ownerNode.isConnected);
  if (!orphaned.length) return 0;
  let list;
  try {
    const { implForWrapper } = require('jsdom/lib/generated/idl/utils.js');
    list = implForWrapper(doc.styleSheets);
  } catch (e) { warnOnce(e?.message ?? String(e)); return 0; }
  if (!list || typeof list._remove !== 'function') { warnOnce('StyleSheetList has no _remove'); return 0; }
  for (const sheet of orphaned) list._remove(sheet);
  return orphaned.length;
}
