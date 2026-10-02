/**
 * The flag mark on its own (44fb546f).
 *
 * What a unit test can and cannot settle here is worth being explicit about.
 * Whether the drawing *looks* like the brand book's flag is a judgement no
 * assertion makes; that was checked by eye against the book's own rendered
 * output. What a test can settle is that nobody redrew it. The brand book
 * builds its mark in JavaScript rather than shipping literal markup, so the
 * only defensible source is the exact path string that builder emits, and the
 * digest pinned below is that string's. If someone traces the shape by hand,
 * simplifies the curves, or swaps in a lookalike glyph, the digest moves and
 * this file fails - which is the whole point, because a near-miss is the
 * failure mode this card was opened to fix.
 */
import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import { AgenfkFlag } from '../components/AgenfkFlag';
import { FLAG_MARK_PATH, FLAG_MARK_VIEWBOX } from '../components/agenfkFlagPath';

afterEach(cleanup);

/**
 * FNV-1a, 64-bit, written out rather than imported.
 *
 * node:crypto would be the obvious way to digest the path, and it is the wrong
 * one here: this package typechecks under tsconfig.app.json, whose `types` is
 * `["vite/client"]` with no @types/node, so importing node:crypto passes
 * vitest and then breaks `tsc -b` - which means it breaks `npm run build` and
 * every CI job that calls it, while looking green locally.
 *
 * FNV-1a is not a cryptographic hash and does not need to be. It is guarding
 * against a path that got hand-edited or redrawn, not against someone forging
 * a collision, and it separates every single-character change tried against
 * it.
 */
const fnv1a64 = (input: string): string => {
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
};

/**
 * Fingerprint of markSVG's `d` for VARIANTS[0] in
 * agenfk-final-brand-bnadeira.html, taken from the file itself and confirmed
 * byte-for-byte against the page's live DOM. The length is pinned alongside it
 * because a truncation is the one edit a rolling hash makes least obvious.
 */
const BRAND_BOOK_MARK_FNV1A64 = '2cddf9153a78d99c';
const BRAND_BOOK_MARK_LENGTH = 14003;

describe('AgenfkFlag geometry', () => {
  it('carries the brand book mark path unmodified', () => {
    expect(FLAG_MARK_PATH).toHaveLength(BRAND_BOOK_MARK_LENGTH);
    expect(fnv1a64(FLAG_MARK_PATH)).toBe(BRAND_BOOK_MARK_FNV1A64);
  });

  it('uses the mark viewBox from the brand book, not the lockup one', () => {
    expect(FLAG_MARK_VIEWBOX).toBe('0 -32.64 377.06 233.2');
  });

  it('draws the mark as the single path of the rendered svg', () => {
    const { container } = render(<AgenfkFlag />);
    const paths = container.querySelectorAll('path');
    expect(paths).toHaveLength(1);
    expect(paths[0].getAttribute('d')).toBe(FLAG_MARK_PATH);
  });

  it('keeps the viewBox on the svg so the mark is not cropped', () => {
    const { container } = render(<AgenfkFlag />);
    expect(container.querySelector('svg')?.getAttribute('viewBox')).toBe(FLAG_MARK_VIEWBOX);
  });
});

describe('AgenfkFlag is the mark alone', () => {
  it('renders no wordmark and no CG/lab byline', () => {
    const { container } = render(<AgenfkFlag />);
    // <title> supplies the accessible name and is not painted, so it is the
    // one piece of text allowed to exist here.
    container.querySelectorAll('title').forEach((t) => t.remove());
    expect(container.textContent?.trim()).toBe('');
    expect(container.querySelector('[data-testid="logo-wordmark"]')).toBeNull();
  });

  it('draws no lettering - the flag is the only shape', () => {
    const { container } = render(<AgenfkFlag />);
    expect(container.querySelectorAll('text')).toHaveLength(0);
    expect(container.querySelectorAll('svg')).toHaveLength(1);
  });
});

describe('AgenfkFlag presentation', () => {
  it('has an accessible name', () => {
    render(<AgenfkFlag />);
    expect(screen.getByRole('img', { name: 'AgEnFK' })).toBeTruthy();
  });

  it('names itself twice, by aria-label and by title', () => {
    // Deliberate redundancy, and asserted so it cannot be tidied away by
    // accident. The name-computation test above passes on either one alone,
    // so it would not notice one of them going missing. aria-label is the
    // reading VoiceOver is most consistent about on an inline svg; <title> is
    // what gives the mark a hover tooltip and what the brand book's own
    // builder emits.
    const { container } = render(<AgenfkFlag />);
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toBe('AgEnFK');
    expect(container.querySelector('title')?.textContent).toBe('AgEnFK');
  });

  it('lets the caller rename it for context', () => {
    render(<AgenfkFlag label="AgEnFK home" />);
    expect(screen.getByRole('img', { name: 'AgEnFK home' })).toBeTruthy();
  });

  it('sizes to the requested height', () => {
    const { container } = render(<AgenfkFlag size={20} />);
    expect(container.querySelector('svg')?.getAttribute('height')).toBe('20');
  });

  // Including the sizes a bar actually asks for, not just a round 100: the
  // ratio has to survive the awkward ones too.
  it.each([3, 16, 22, 24, 48, 100])('widens exactly in proportion at size %i', (size) => {
    const { container } = render(<AgenfkFlag size={size} />);
    const svg = container.querySelector('svg');
    const width = Number(svg?.getAttribute('width'));
    const height = Number(svg?.getAttribute('height'));
    // 377.06 / 233.2 from the brand book's mark viewBox. Tight tolerance on
    // purpose: the box should match the artwork, not merely resemble it, or
    // the mark letterboxes inside its own frame.
    expect(width / height).toBeCloseTo(377.06 / 233.2, 10);
  });

  it('scales rather than keeping one fixed size', () => {
    const { container: small } = render(<AgenfkFlag size={16} />);
    const { container: large } = render(<AgenfkFlag size={48} />);
    const w = (c: HTMLElement) => Number(c.querySelector('svg')?.getAttribute('width'));
    expect(w(large)).toBeGreaterThan(w(small));
  });

  it('inherits its colour so it reads on both the light and the dark ground', () => {
    const { container } = render(<AgenfkFlag />);
    expect(container.querySelector('path')?.getAttribute('fill')).toBe('currentColor');
    // text-ink is the theme token that flips with the theme; hardcoding a hex
    // here would leave the mark invisible on one of the two grounds.
    expect(container.querySelector('svg')?.getAttribute('class')).toContain('text-ink');
  });

  it('appends a caller className without dropping the theme colour', () => {
    // Deliberately not called a colour override. Tailwind resolves two
    // competing utilities by stylesheet order, not attribute order, so this
    // asserts what actually holds: the caller's class arrives and text-ink
    // survives alongside it.
    const { container } = render(<AgenfkFlag className="opacity-70" />);
    const cls = container.querySelector('svg')?.getAttribute('class');
    expect(cls).toContain('opacity-70');
    expect(cls).toContain('text-ink');
  });
});
