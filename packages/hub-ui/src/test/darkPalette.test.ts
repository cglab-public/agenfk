/**
 * Dark mode is neutral gray and readable (user request 2026-09-24).
 *
 * The Kanban UI and the shared flow editor are written in Tailwind's slate
 * palette, which is blue-tinted; the brand tokens were already neutral, so
 * the editor showed as a bluish panel on a neutral hub page, and its dark
 * secondary text (slate-500 at 3.8:1, slate-600 at 2.4:1) was below WCAG AA.
 * brand/tokens.css redefines the slate variables in dark mode, which every
 * Tailwind v4 utility reads. jsdom runs no Tailwind, so the values the
 * browser will apply are checked here as numbers: hue and contrast.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const TOKENS = fs.readFileSync(path.resolve(__dirname, '../../../brand/tokens.css'), 'utf8');
const THEME = fs.readFileSync(require.resolve('tailwindcss/theme.css'), 'utf8');
const SHADES = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950'];

/** The declarations inside the first block whose selector starts with `selector`. */
function block(selector: string): Record<string, string> {
  const at = TOKENS.indexOf(selector);
  expect(at, `no block for ${selector}`).toBeGreaterThan(-1);
  const open = TOKENS.indexOf('{', at);
  let depth = 0, end = open;
  for (let i = open; i < TOKENS.length; i++) {
    if (TOKENS[i] === '{') depth++;
    if (TOKENS[i] === '}' && --depth === 0) { end = i; break; }
  }
  const out: Record<string, string> = {};
  for (const m of TOKENS.slice(open + 1, end).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}
const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const lum = (hex: string) => {
  const [r, g, b] = rgb(hex).map(v => v / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const DARK_BLOCKS = ['.dark, .dark *', '@media (prefers-color-scheme: dark)'];

describe('dark mode palette', () => {
  for (const sel of DARK_BLOCKS) {
    describe(sel, () => {
      const vars = block(sel);
      const slate = (s: string) => vars[`--color-slate-${s}`];

      it('redefines every slate shade as a hex colour', () => {
        for (const s of SHADES) expect(slate(s), `--color-slate-${s}`).toMatch(/^#[0-9a-f]{6}$/i);
      });

      it('is neutral gray: no shade leans blue', () => {
        for (const s of SHADES) {
          const [r, g, b] = rgb(slate(s));
          // 10: the brand surface itself (#13161c) is 9. Tailwind's slate-900 is 27.
          expect(b - r, `slate-${s} ${slate(s)} is blue-tinted`).toBeLessThanOrEqual(10);
          expect(Math.abs(g - r), `slate-${s} ${slate(s)} is not gray`).toBeLessThanOrEqual(6);
        }
      });

      it('secondary text (slate-400/500) meets WCAG AA on every dark surface', () => {
        for (const text of ['400', '500']) {
          for (const bg of ['800', '900', '950']) {
            expect(contrast(slate(text), slate(bg)), `slate-${text} on slate-${bg}`).toBeGreaterThanOrEqual(4.5);
          }
        }
      });

      it('keeps borders and hovers visible: slate-700/800 stand off the surface', () => {
        expect(contrast(slate('700'), slate('900')), 'slate-700 border on slate-900').toBeGreaterThanOrEqual(1.5);
        expect(contrast(slate('800'), slate('900')), 'slate-800 hover on slate-900').toBeGreaterThanOrEqual(1.2);
      });

      it("the brand's own text and border tokens are neutral and readable too (the hub's text uses them)", () => {
        for (const t of ['--text-primary', '--text-secondary', '--text-tertiary']) {
          const [r, , b] = rgb(vars[t]);
          expect(b - r, `${t} ${vars[t]} is blue-tinted`).toBeLessThanOrEqual(10);
          for (const bg of [vars['--surface'], slate('800')]) expect(contrast(vars[t], bg), `${t} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        }
        const [r, , b] = /rgba\((\d+),\s*(\d+),\s*(\d+)/.exec(vars['--border-soft'])!.slice(1).map(Number);
        expect(b - r, '--border-soft is blue-tinted').toBeLessThanOrEqual(10);
      });

      it('matches the brand surfaces, so the editor sits flush on the hub page', () => {
        expect(slate('950')).toBe(vars['--canvas']);
        expect(slate('900')).toBe(vars['--surface']);
      });
    });
  }

  it('both dark blocks agree', () => {
    const [a, b] = DARK_BLOCKS.map(block);
    for (const s of SHADES) expect(a[`--color-slate-${s}`]).toBe(b[`--color-slate-${s}`]);
  });

  it("a forced light theme restores Tailwind's own slate, so light mode is unchanged", () => {
    const light = block('.light, .light *');
    for (const s of SHADES) {
      const stock = new RegExp(`--color-slate-${s}:\\s*([^;]+);`).exec(THEME)![1].trim();
      expect(light[`--color-slate-${s}`], `--color-slate-${s}`).toBe(stock);
    }
  });

  it('markdown follows the neutral ramp: the typography plugin writes slate values in directly', () => {
    const dark = block('.dark, .dark *');
    for (const v of ['--tw-prose-invert-body', '--tw-prose-invert-counters', '--tw-prose-invert-captions', '--tw-prose-invert-hr', '--tw-prose-invert-quote-borders', '--tw-prose-invert-td-borders', '--tw-prose-invert-th-borders', '--tw-prose-invert-bullets', '--tw-prose-invert-lead', '--tw-prose-invert-pre-code']) {
      expect(dark[v], v).toMatch(/^var\(--color-slate-\d+\)$/);
    }
  });

  it('both apps import the tokens unlayered, so they win over Tailwind\'s layered theme', () => {
    for (const app of ['../index.css', '../../../ui/src/index.css']) {
      const css = fs.readFileSync(path.resolve(__dirname, app), 'utf8');
      const line = css.split('\n').find(l => l.startsWith('@import') && l.includes('brand/tokens.css'))!;
      expect(line, app).toMatch(/^@import "[^"]*brand\/tokens\.css";\s*$/);
    }
  });
});

