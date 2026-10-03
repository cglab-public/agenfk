/**
 * The visual system's colour tokens (CGLAB-434, user direction 2026-09-30).
 *
 * Teal stays the brand mark; indigo becomes the working accent; charts get a
 * fixed six-hue palette and an indigo size ramp; state gets reserved status
 * colours. Backgrounds stay muted and neutral: colour belongs in marks, chips
 * and selection, never in the canvas or cards.
 *
 * jsdom runs no Tailwind, so the values the browser will apply are checked
 * here as numbers read from brand/tokens.css, the one file both apps import.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const TOKENS = fs.readFileSync(path.resolve(__dirname, '../../../brand/tokens.css'), 'utf8');

/** Declarations inside the first block whose selector starts with `selector`. */
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
  // A token declared twice in one block silently takes the later value; that
  // is how a new token can recolour every existing use of an old one.
  // Nested blocks (the :root inside @media) are one scope here, which is right.
  for (const m of TOKENS.slice(open + 1, end).replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    expect(out[m[1]], `${m[1]} declared twice in ${selector}`).toBeUndefined();
    out[m[1]] = m[2].trim();
  }
  return out;
}

const HEX = /^#[0-9a-f]{6}$/i;
const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const lum = (hex: string) => {
  const [r, g, b] = rgb(hex).map(v => lin(v / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
/** An rgba() fill composited over an opaque hex background. */
function over(rgba: string, bg: string): string {
  const [r, g, b, a] = /rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)/.exec(rgba)!.slice(1).map(Number);
  return '#' + [r, g, b].map((c, i) => Math.round(c * a + rgb(bg)[i] * (1 - a)).toString(16).padStart(2, '0')).join('');
}
const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
/** OKLab, for perceptual distance between chart hues. */
function oklab(hex: string): [number, number, number] {
  const [r, g, b] = rgb(hex).map(v => lin(v / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
const deltaE = (a: string, b: string) => { const [p, q] = [oklab(a), oklab(b)]; return 100 * Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };

const SERIES = [1, 2, 3, 4, 5, 6].map(n => `--series-${n}`);
const SIZES = [1, 2, 3, 4, 5].map(n => `--size-${n}`);
const STATUS = ['ok', 'warn', 'danger', 'info'];
const TYPES = ['epic', 'story', 'task', 'bug'].map(t => `--type-${t}`);
const ON_SIZES = [1, 2, 3, 4, 5].map(n => `--on-size-${n}`);
const HEX_TOKENS = ['--accent', '--accent-ink', '--focus-ring', ...SERIES, ...SIZES, ...ON_SIZES, ...STATUS.map(s => `--status-${s}-text`), ...TYPES];
const FILL_TOKENS = ['--accent-fill', ...STATUS.map(s => `--status-${s}-bg`)];

const THEMES = {
  light: ':root {',
  'dark (OS)': '@media (prefers-color-scheme: dark)',
  'dark (forced)': '.dark, .dark *',
  'light (forced)': '.light, .light *',
} as const;
const isDark = (name: string) => name.startsWith('dark');

describe('visual system tokens', () => {
  for (const [name, sel] of Object.entries(THEMES)) {
    describe(name, () => {
      const v = block(sel);

      it('defines every colour token: hex for marks and text, rgba for tinted fills', () => {
        for (const t of HEX_TOKENS) expect(v[t], t).toMatch(HEX);
        for (const t of FILL_TOKENS) expect(v[t], t).toMatch(/^rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0?\.\d+\s*\)$/);
      });

      it('keeps the canvas and cards muted and neutral: colour lives in marks, not surfaces', () => {
        for (const t of ['--canvas', '--surface']) {
          const [r, g, b] = rgb(v[t]);
          // 10 matches darkPalette.test.ts: the brand's dark card (#13161c) is 9.
          expect(Math.max(r, g, b) - Math.min(r, g, b), `${t} ${v[t]} is tinted`).toBeLessThanOrEqual(10);
        }
      });

      it('text tokens pass WCAG AA on the canvas and on cards', () => {
        for (const t of ['--text-tertiary', '--accent-ink', ...STATUS.map(s => `--status-${s}-text`)]) {
          for (const bg of ['--canvas', '--surface']) {
            expect(contrast(v[t], v[bg]), `${t} ${v[t]} on ${bg} ${v[bg]}`).toBeGreaterThanOrEqual(4.5);
          }
        }
      });

      it('chart series stand off the card (>= 3:1) and are told apart by full-colour readers (ΔE >= 15)', () => {
        for (const t of SERIES) expect(contrast(v[t], v['--surface']), `${t} ${v[t]}`).toBeGreaterThanOrEqual(3);
        // Neighbours in the fixed order must clear the normal-vision floor
        // (ΔE 15); any two series must still never be confusable (ΔE 10).
        // Six saturated hues at 3:1 cannot all sit 15 apart - indigo and sky
        // are 13 - but a violet at ΔE 7 from indigo is the mistake this catches.
        for (let i = 1; i < SERIES.length; i++) {
          expect(deltaE(v[SERIES[i - 1]], v[SERIES[i]]), `${SERIES[i - 1]} next to ${SERIES[i]}`).toBeGreaterThanOrEqual(15);
        }
        for (let i = 0; i < SERIES.length; i++) {
          for (let j = i + 1; j < SERIES.length; j++) {
            expect(deltaE(v[SERIES[i]], v[SERIES[j]]), `${SERIES[i]} vs ${SERIES[j]}`).toBeGreaterThanOrEqual(10);
          }
        }
      });

      it('the size ramp steps evenly from faint to strong, and its faint end is still visible', () => {
        const L = SIZES.map(t => oklab(v[t])[0]);
        for (let i = 1; i < L.length; i++) {
          const step = isDark(name) ? L[i] - L[i - 1] : L[i - 1] - L[i];
          expect(step, `${SIZES[i - 1]} → ${SIZES[i]}`).toBeGreaterThanOrEqual(0.06);
        }
        expect(contrast(v['--size-1'], v['--surface']), '--size-1 on the card').toBeGreaterThanOrEqual(2);
      });

      it('item types are four distinct hues', () => {
        // 12, not 15: a type colour always sits beside its EPIC/STORY/TASK/BUG
        // label, so it is never the only cue.
        for (let i = 0; i < TYPES.length; i++) {
          for (let j = i + 1; j < TYPES.length; j++) {
            expect(deltaE(v[TYPES[i]], v[TYPES[j]]), `${TYPES[i]} vs ${TYPES[j]}`).toBeGreaterThanOrEqual(12);
          }
        }
      });

      it('text on a size-ramp fill (the PR size badge) passes AA with its own ink token', () => {
        SIZES.forEach((t, i) => {
          const ink = v[`--on-size-${i + 1}`];
          expect(ink, `--on-size-${i + 1}`).toMatch(HEX);
          expect(contrast(ink, v[t]), `--on-size-${i + 1} on ${t} ${v[t]}`).toBeGreaterThanOrEqual(4.5);
        });
      });

      it('item types never pass for the selection accent (a STORY chip beside an accent chip)', () => {
        for (const t of TYPES) for (const a of ['--accent', '--accent-ink']) {
          expect(deltaE(v[t], v[a]), `${t} ${v[t]} vs ${a} ${v[a]}`).toBeGreaterThanOrEqual(12);
        }
      });

      it('item-type chips are readable: type text passes AA on its own 10% tint', () => {
        for (const t of TYPES) {
          const tint = over(`rgba(${rgb(v[t]).join(', ')}, 0.1)`, v['--surface']);
          expect(contrast(v[t], tint), `${t} ${v[t]} on its tint`).toBeGreaterThanOrEqual(4.5);
        }
      });

      it('status chips are readable: status text passes AA on its own tinted background', () => {
        for (const s of STATUS) {
          for (const bg of ['--canvas', '--surface']) {
            const chip = over(v[`--status-${s}-bg`], v[bg]);
            expect(contrast(v[`--status-${s}-text`], chip), `${s} text on ${s} bg over ${bg}`).toBeGreaterThanOrEqual(4.5);
          }
        }
      });

      it('chart series and the focus ring clear 3:1 on the page background as well as on cards', () => {
        for (const t of [...SERIES, '--focus-ring']) {
          for (const bg of ['--canvas', '--surface']) {
            expect(contrast(v[t], v[bg]), `${t} ${v[t]} on ${bg} ${v[bg]}`).toBeGreaterThanOrEqual(3);
          }
        }
      });
    });
  }

  it('the forced themes match the automatic ones, so the toggle and the OS setting agree', () => {
    const pairs: Array<[string, string]> = [[THEMES['dark (OS)'], THEMES['dark (forced)']], [THEMES.light, THEMES['light (forced)']]];
    for (const [auto, forced] of pairs) {
      const [a, b] = [block(auto), block(forced)];
      for (const t of [...HEX_TOKENS, ...FILL_TOKENS, '--text-tertiary']) {
        expect(a[t], `${t} in ${auto}`).toBeDefined();
        expect(b[t], `${t} in ${forced}`).toBe(a[t]);
      }
    }
  });

  it('adding tokens changes nothing already on screen: --accent-text stays the brand teal it was', () => {
    // 150+ text-accent-text uses (the CG/LAB wordmark among them) read this
    // token. Moving them to indigo is a deliberate per-component change in the
    // recolour stories, not a side effect of defining the palette.
    expect(block(THEMES.light)['--accent-text']).toBe('#056f71');
    expect(block(THEMES['light (forced)'])['--accent-text']).toBe('#056f71');
    expect(block(THEMES['dark (OS)'])['--accent-text']).toBe('#7fe5ca');
    expect(block(THEMES['dark (forced)'])['--accent-text']).toBe('#7fe5ca');
  });

  it('Tailwind utilities exist for every token (bg-accent, text-series-3, bg-status-ok-bg, ...)', () => {
    const theme = block('@theme {');
    for (const t of [...HEX_TOKENS, ...FILL_TOKENS]) {
      expect(theme[`--color-${t.slice(2)}`], `--color-${t.slice(2)}`).toBe(`var(${t})`);
    }
  });

  it('keyboard focus is visible everywhere: a global :focus-visible outline in the brand colour', () => {
    const rule = /:focus-visible\s*\{([^}]*)\}/.exec(TOKENS);
    // Inside @layer base: unlayered CSS beats every Tailwind utility, so a bare
    // rule would override components' own focus:outline-none + ring styles.
    const base = TOKENS.indexOf('@layer base');
    expect(base, 'focus rule must live in @layer base').toBeGreaterThan(-1);
    const open = TOKENS.indexOf('{', base);
    let depth = 0, close = open;
    for (let i = open; i < TOKENS.length; i++) {
      if (TOKENS[i] === '{') depth++;
      if (TOKENS[i] === '}' && --depth === 0) { close = i; break; }
    }
    expect(TOKENS.slice(open, close), 'focus rule is outside @layer base').toMatch(/:focus-visible\s*\{/);
    expect(rule, 'no :focus-visible rule').not.toBeNull();
    expect(rule![1]).toMatch(/outline:\s*2px\s+solid\s+var\(--focus-ring\)/);
    expect(rule![1]).toMatch(/outline-offset:\s*2px/);
  });
});
