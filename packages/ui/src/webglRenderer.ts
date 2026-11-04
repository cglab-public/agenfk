/**
 * Whether a terminal may draw through WebGL, and who holds the few contexts
 * there are (INFRA-425).
 *
 * Three rules came out of reading xterm's WebGL addon rather than trusting it:
 *
 * 1. NEVER CONSTRUCT IT WHERE WEBGL2 CANNOT START. The addon's renderer
 *    subscribes to the terminal's option and theme changes, and adds a canvas
 *    to the screen, BEFORE it asks for a context — and then throws. The half
 *    built renderer is never registered, so nothing can dispose it: every
 *    terminal opened on such a machine stayed in memory after it closed. So the
 *    question is asked once, of a throwaway canvas, and the answer is kept.
 *
 *    `failIfMajorPerformanceCaveat` also answers no for a GPU emulated on the
 *    CPU (WSLg, most VMs), where WebGL draws text slower than the DOM does. On
 *    those machines every terminal stays on the DOM renderer.
 *
 * 2. FEW CONTEXTS, KEPT. Chromium keeps at most 16 live WebGL contexts and
 *    drops the oldest past that, blanking that pane for three seconds; a window
 *    may hold thirty terminals. So at most LIVE_LIMIT panes hold one. A pane
 *    KEEPS its context while hidden — handing it back on every tab switch made
 *    a new context per switch, and a disposed one keeps counting until garbage
 *    collection. A context is taken from a hidden pane only when a shown one
 *    needs it: the one hidden longest gives it up.
 *
 * 3. GIVE IT BACK FOR REAL. A holder that releases calls `loseContext()` on
 *    the canvases its renderer created, so the slot is free now and not at the
 *    next collection.
 */

/** Panes that may hold a WebGL context at once, well under Chromium's 16. */
export const LIVE_LIMIT = 8;

/** A pane's side of the bargain. */
export interface WebglHolder {
  /** Whether the pane is on screen now. Hidden holders are the ones evicted. */
  shown: boolean;
  /** When it was last on screen; the oldest hidden holder is evicted first. */
  lastShown: number;
  /** Give the context up: called when evicted. */
  release(): void;
  /** A slot freed up while this pane, shown, was waiting for one. */
  retry(): void;
  /** Drop glyphs drawn with a fallback font; see terminalFont.ts. */
  clearAtlas?(): void;
}

let usable: boolean | null = null;
const holders = new Set<WebglHolder>();
const waiting = new Set<WebglHolder>();

/** Whether WebGL2 starts here at full speed. Asked once per page. */
export function webglUsable(): boolean {
  if (usable !== null) return usable;
  usable = false;
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: true }) as WebGL2RenderingContext | null;
    if (gl) {
      usable = true;
      // Given back now: a probe must not count against the 16.
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch {
    // jsdom answers "not implemented"; a sandbox may throw. Either way: no.
  }
  return usable;
}

/**
 * Take a slot for a SHOWN pane, evicting the longest-hidden holder if the
 * budget is spent. False when every holder is on screen; the pane is then
 * remembered and retried when a slot frees.
 */
export function acquireWebglSlot(holder: WebglHolder): boolean {
  if (holders.has(holder)) return true;
  if (holders.size >= LIVE_LIMIT) {
    const hidden = [...holders].filter(h => !h.shown).sort((a, b) => a.lastShown - b.lastShown);
    const victim = hidden[0];
    if (!victim) {
      waiting.add(holder);
      return false;
    }
    holders.delete(victim);
    victim.release();
  }
  waiting.delete(holder);
  holders.add(holder);
  return true;
}

/**
 * Whether this pane still holds its slot. Asked after every await: a pane can
 * be evicted while its addon is still loading, and attaching anyway would put
 * a context outside the budget that nothing could ever take back.
 */
export function holdsWebglSlot(holder: WebglHolder): boolean {
  return holders.has(holder);
}

/**
 * A holder just went off screen: a shown pane waiting for a slot can now take
 * this one's, since the budget evicts hidden holders.
 */
export function offerHiddenSlot(): void {
  const next = [...waiting].find(h => h.shown);
  if (next) {
    waiting.delete(next);
    next.retry();
  }
}

/** Give a slot back, and let one waiting pane try again. */
export function releaseWebglSlot(holder: WebglHolder): void {
  waiting.delete(holder);
  if (!holders.delete(holder)) return;
  const next = [...waiting].find(h => h.shown);
  if (next) {
    waiting.delete(next);
    next.retry();
  }
}

/** Forget a pane entirely: it closed. */
export function forgetWebglHolder(holder: WebglHolder): void {
  waiting.delete(holder);
  releaseWebglSlot(holder);
}

/** Every holder now: the font loader clears their glyph atlases. */
export function webglHolders(): readonly WebglHolder[] {
  return [...holders];
}

/**
 * Lose the contexts of canvases a renderer created, after it was disposed.
 *
 * Only canvases that already have a WebGL2 context: `getContext('webgl2')` on
 * a canvas that has a 2D context answers null, and these were collected as
 * the ones the renderer added, so none is a fresh canvas that would be given a
 * context by asking.
 */
export function loseContexts(canvases: readonly HTMLCanvasElement[]): void {
  for (const canvas of canvases) {
    try {
      const gl = canvas.getContext('webgl2') as WebGL2RenderingContext | null;
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      // Already gone with its context.
    }
  }
}

/** Tests only. */
export function __resetWebgl(state: { usable?: boolean | null } = {}): void {
  usable = state.usable ?? null;
  holders.clear();
  waiting.clear();
}
