/**
 * Type-scale guard for the flow editor (story 12f3921a), the same size rule as
 * hub-ui's test/helpers/typeScale.ts: only the five sizes from the shared
 * packages/brand/type-scale.css (caption, small, body, title, display), never
 * an arbitrary text-[Npx] or a Tailwind default size, in a class or an inline
 * style. The editor opens inside both apps, so it is guarded here rather than
 * by either app's page sweep.
 */
import { expect } from 'vitest';

const SCALE_PX = new Set(['11px', '12px', '14px', '18px', '24px']);
const STRAY_SIZE = /(?:^|\s|:)text-(?:\[\d+(?:\.\d+)?(?:px|rem|em)\]|xs|sm|base|lg|xl|[2-9]xl)(?=\s|$)/;

export function expectOnTypeScale(root: HTMLElement): void {
  for (const el of [root, ...Array.from(root.querySelectorAll('[class]'))]) {
    const c = el.getAttribute('class') ?? '';
    const where = `<${el.tagName.toLowerCase()}> "${(el.textContent ?? '').trim().slice(0, 30)}"`;
    expect(c.match(STRAY_SIZE)?.[0]?.trim() ?? null, `text size outside the scale on ${where}`).toBeNull();
  }
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[style]'))) {
    const size = el.style.fontSize;
    if (!size) continue;
    expect(SCALE_PX.has(size) ? null : size, `inline font-size outside the scale on <${el.tagName.toLowerCase()}>`).toBeNull();
  }
}
