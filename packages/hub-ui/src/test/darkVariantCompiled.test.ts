/**
 * @vitest-environment node
 *
 * What the two apps' stylesheets COMPILE to, for the theme.
 *
 * darkVariantWiring.test.ts and darkPalette.test.ts used to read index.css as
 * text and look for lines (`@variant dark`, `@plugin "@tailwindcss/typography"`,
 * the tokens import). A line can be present and still not do what it is for,
 * so this compiles each app's real index.css with Tailwind - jsdom cannot run
 * it - and asserts on the rules that come out.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { compile } from '@tailwindcss/node';

const PACKAGES = path.resolve(__dirname, '../../..');
const APPS = ['hub-ui', 'ui'] as const;

async function build(app: (typeof APPS)[number]): Promise<string> {
  const file = path.join(PACKAGES, app, 'src/index.css');
  const compiler = await compile(fs.readFileSync(file, 'utf8'), { base: path.dirname(file), onDependency: () => {} });
  return compiler.build(['dark:bg-black', 'prose']);
}

/** The selector `dark:bg-black` compiles to. */
const darkSelector = (css: string): string | null => css.match(/\.dark\\:bg-black([^{]*)\{/)?.[1].trim() ?? null;

/** Whether the character at `at` sits inside an `@layer … { }` block. */
function insideLayer(css: string, at: number): boolean {
  const stack: boolean[] = [];
  const re = /@layer[^{;]*\{|\{|\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) && m.index < at) {
    if (m[0] === '}') stack.pop();
    else stack.push(m[0].startsWith('@layer'));
  }
  return stack.includes(true);
}

describe('the theme, as compiled', () => {
  for (const app of APPS) {
    describe(app, () => {
      it('routes `dark:` through the explicit theme marker, class and attribute, not the OS setting', async () => {
        const css = await build(app);
        const selector = darkSelector(css);
        expect(selector, '`dark:bg-black` did not compile').not.toBeNull();
        for (const marker of ['.dark', '.dark *', '[data-theme="dark"]', '[data-theme="dark"] *']) {
          expect(selector).toContain(marker);
        }
        const rule = css.slice(css.indexOf('.dark\\:bg-black'));
        expect(rule.slice(0, rule.indexOf('}'))).not.toMatch(/prefers-color-scheme/);
      });

      it('compiles the typography plugin, which rendered markdown needs', async () => {
        expect(await build(app)).toMatch(/\.prose \{/);
      });

      it('lets native controls follow the chosen theme rather than pinning them to the OS', async () => {
        expect(await build(app)).not.toMatch(/color-scheme:\s*light\s+dark/);
      });

      it("puts the brand's dark slate ramp outside every layer, so it beats Tailwind's layered theme", async () => {
        const css = await build(app);
        const overrides = [...css.matchAll(/--color-slate-400:\s*#[0-9a-f]+/gi)];
        expect(overrides.length, 'the brand never redefines slate-400').toBeGreaterThan(0);
        for (const m of overrides) expect(insideLayer(css, m.index!), m[0]).toBe(false);
      });
    });
  }

  it('compiles `dark:` identically in both apps, so they cannot drift', async () => {
    const [hub, board] = await Promise.all(APPS.map(build));
    expect(darkSelector(board)).toBe(darkSelector(hub));
  });
});
