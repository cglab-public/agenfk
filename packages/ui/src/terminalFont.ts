/**
 * Loading every subset of the terminal face, once per page (INFRA-425).
 *
 * @fontsource ships JetBrains Mono as one @font-face per Unicode range. A
 * browser loads a range the first time a character from it is drawn, and the
 * WebGL renderer caches whatever glyph it drew first — the FALLBACK font's,
 * for the moment the range was still loading. So every range is asked for up
 * front, and when they are in, each WebGL terminal's glyph atlas is cleared so
 * nothing drawn with a fallback survives.
 *
 * Separate from measuring the cell: the UI's own --font-mono already loads the
 * latin range, so `fonts.check()` usually says "loaded" before any terminal
 * opens, and gating this on it would mean it never ran.
 */
import { TERMINAL_FONT_FACE } from './terminalOptions';

type FontSet = { [Symbol.iterator]?: () => Iterator<FontFace> };

let started: Promise<void> | null = null;

export function loadAllTerminalFaces(fonts: FontSet | undefined, onLoaded: () => void): Promise<void> {
  if (started) return started;
  const family = TERMINAL_FONT_FACE.replace(/['"]/g, '');
  const listed = fonts && typeof fonts[Symbol.iterator] === 'function'
    ? [...(fonts as Iterable<FontFace>)].filter(f => f.family.replace(/['"]/g, '') === family)
    : [];
  if (listed.length > 0) {
    const pending = listed.filter(f => f.status !== 'loaded');
    started = pending.length === 0
      ? Promise.resolve()
      : Promise.all(pending.map(f => f.load().catch(() => null))).then(() => { onLoaded(); });
    return started;
  }
  /*
   * A FontFaceSet that lists none of them — one that does not expose faces
   * declared in CSS — is asked by text instead: one character from each range
   * the face ships (Latin, Latin Extended, Cyrillic, Greek), which makes the
   * browser fetch each of them.
   */
  const loader = fonts as { load?: (font: string, text?: string) => Promise<unknown> } | undefined;
  started = typeof loader?.load === 'function'
    ? loader.load(`12px ${TERMINAL_FONT_FACE}`, 'AĀЖΩ').then(() => { onLoaded(); }, () => {})
    : Promise.resolve();
  return started;
}

/** Tests only. */
export function __resetTerminalFaces(): void {
  started = null;
}
