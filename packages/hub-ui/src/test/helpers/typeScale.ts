/**
 * Type-scale and width guard for rendered hub pages (story 7073be87). Swept by
 * the page-by-page token tests, so every page also proves it uses:
 * - only the five text sizes from @theme (caption, small, body, title, display),
 *   never an arbitrary text-[Npx] or a Tailwind default size;
 * - the one eyebrow style for uppercase labels, never its own letter-spacing;
 * - the two content widths (max-w-form, max-w-data), never a named max-w-*
 *   size or the old max-w-[1200px] page column;
 * - and the same five sizes in an inline style (svg text sets its own).
 * Form fields are exempt from the eyebrow rule: an uppercase, letter-spaced
 * input (a device code) is not a label.
 */
import { expect } from 'vitest';

const SCALE_PX = new Set(['11px', '12px', '14px', '18px', '24px']);
const STRAY_SIZE = /(?:^|\s|:)text-(?:\[\d+(?:\.\d+)?(?:px|rem|em)\]|xs|sm|base|lg|xl|[2-9]xl)(?=\s|$)/;
// xs–md size small cards (the sign-in card); the drift was the lg–3xl tab widths.
const STRAY_WIDTH = /(?:^|\s|:)max-w-(?:lg|xl|[2-7]xl|\[1200px\])(?=\s|$)/;

export function expectOnTypeScale(root: HTMLElement): void {
  for (const el of [root, ...Array.from(root.querySelectorAll('[class]'))]) {
    const c = el.getAttribute('class') ?? '';
    const where = `<${el.tagName.toLowerCase()}> "${(el.textContent ?? '').trim().slice(0, 30)}"`;
    expect(c.match(STRAY_SIZE)?.[0]?.trim() ?? null, `text size outside the scale on ${where}`).toBeNull();
    expect(c.match(STRAY_WIDTH)?.[0]?.trim() ?? null, `content width outside form/data on ${where}`).toBeNull();
    const field = ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
    const own = !field && /(?:^|\s)uppercase(?:\s|$)/.test(c) && /(?:^|\s|:)tracking-/.test(c);
    expect(own ? c : null, `uppercase label with its own letter-spacing (use eyebrow) on ${where}`).toBeNull();
    expect(field && /(?:^|\s)eyebrow(?:\s|$)/.test(c) ? c : null, `form field styled as an eyebrow on ${where}`).toBeNull();
  }
  for (const el of Array.from(root.querySelectorAll<HTMLElement | SVGElement>('[style]'))) {
    const size = (el as HTMLElement).style.fontSize;
    if (!size) continue;
    expect(SCALE_PX.has(size) ? null : size, `inline font-size outside the scale on <${el.tagName.toLowerCase()}>`).toBeNull();
  }
}

/**
 * Every scroller contains its absolutely positioned children (sr-only text, a
 * toggle's knob): unpositioned, they take an outer box as their containing
 * block and widen the page or the pane past the screen (epic review, 390px).
 */
export function expectScrollersContain(root: HTMLElement): void {
  const scrollers = Array.from(root.querySelectorAll('[class*="overflow-"]')).filter(el =>
    /(?:^|\s)overflow-(?:x-)?auto(?:\s|$)/.test(el.getAttribute('class') ?? ''));
  for (const el of scrollers) {
    const c = el.getAttribute('class') ?? '';
    const positioned = /(?:^|\s)(?:relative|absolute|fixed|sticky)(?:\s|$)/.test(c);
    expect(positioned ? null : c, `scroller without a positioned box on <${el.tagName.toLowerCase()}>`).toBeNull();
  }
}
