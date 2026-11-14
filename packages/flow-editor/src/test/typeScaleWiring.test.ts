/**
 * @vitest-environment node
 *
 * The type scale is defined once, in packages/brand, and both apps compile it
 * (story 12f3921a). The flow editor uses text-caption … text-display in both
 * the hub and the local board, so a board whose CSS lacks the scale renders
 * every one of those labels at the browser default. jsdom does not run
 * Tailwind, so this compiles each app's real index.css instead.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { compile } from '@tailwindcss/node';

const PACKAGES = path.resolve(__dirname, '../../..');
const SCALE = { caption: '11px', small: '12px', body: '14px', title: '18px', display: '24px' };
const UTILITIES = [...Object.keys(SCALE).map(k => `text-${k}`), 'eyebrow', 'max-w-form', 'max-w-data'];

async function build(app: 'hub-ui' | 'ui'): Promise<string> {
  const file = path.join(PACKAGES, app, 'src/index.css');
  const compiler = await compile(fs.readFileSync(file, 'utf8'), { base: path.dirname(file), onDependency: () => {} });
  return compiler.build(UTILITIES);
}

/** The rule a utility compiles to, whitespace-normalised. */
const rule = (css: string, cls: string) => css.match(new RegExp(`\\.${cls} \\{[^}]*\\}`))?.[0].replace(/\s+/g, ' ') ?? null;

describe('shared type scale', () => {
  for (const app of ['hub-ui', 'ui'] as const) {
    it(`${app} compiles the five sizes, the eyebrow and the two content widths`, async () => {
      const css = await build(app);
      for (const [name, px] of Object.entries(SCALE)) {
        expect(css, `--text-${name} in ${app}`).toMatch(new RegExp(`--text-${name}: ${px};`));
        expect(rule(css, `text-${name}`), `.text-${name} in ${app}`).not.toBeNull();
      }
      expect(rule(css, 'eyebrow'), `.eyebrow in ${app}`).not.toBeNull();
      expect(rule(css, 'max-w-form'), `.max-w-form in ${app}`).not.toBeNull();
      expect(rule(css, 'max-w-data'), `.max-w-data in ${app}`).not.toBeNull();
    });
  }

  it('both apps compile the scale identically, so they cannot drift', async () => {
    const [hub, board] = await Promise.all([build('hub-ui'), build('ui')]);
    for (const cls of UTILITIES) expect(rule(board, cls), cls).toBe(rule(hub, cls));
    for (const name of Object.keys(SCALE)) {
      const decl = (css: string) => css.match(new RegExp(`--text-${name}(?:--line-height)?: [^;]+;`, 'g'));
      expect(decl(board), `--text-${name}`).toEqual(decl(hub));
    }
  });
});
