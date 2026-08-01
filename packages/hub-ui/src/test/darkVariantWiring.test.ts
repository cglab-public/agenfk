/**
 * TASK 85c7a519 — class-based `dark:` variant wiring for hub-ui.
 *
 * These are static-source assertions (same style as favicon.test.ts) rather
 * than render tests, because what we need to guarantee lives in CSS that Vite
 * compiles — jsdom does not run Tailwind, so a render test literally cannot
 * observe whether `dark:` resolves against a class or a media query.
 *
 * Why it matters: hub-ui has ~132 `dark:` utilities. Without the `@variant`
 * override they follow `prefers-color-scheme` and a manual toggle silently
 * does nothing to them, even though the CSS-variable tokens do flip.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const HUB_UI_SRC = path.resolve(__dirname, '..');
const INDEX_CSS = path.join(HUB_UI_SRC, 'index.css');
const UI_INDEX_CSS = path.resolve(HUB_UI_SRC, '../../ui/src/index.css');

const readCss = () => fs.readFileSync(INDEX_CSS, 'utf8');

describe('hub-ui dark variant wiring', () => {
  it('declares an @variant dark override so `dark:` follows the explicit class', () => {
    const css = readCss();
    const variantLine = css
      .split('\n')
      .find((l) => l.trim().startsWith('@variant dark'));
    expect(variantLine, 'expected an `@variant dark (...)` declaration in hub-ui/src/index.css').toBeDefined();
  });

  it('matches both the .dark class and the [data-theme="dark"] attribute', () => {
    const css = readCss();
    const variantLine = css.split('\n').find((l) => l.trim().startsWith('@variant dark')) ?? '';
    expect(variantLine).toContain('.dark');
    expect(variantLine).toContain('[data-theme="dark"]');
    // Descendant forms matter: tokens.css sets vars on `.dark *` too.
    expect(variantLine).toMatch(/\.dark \*/);
  });

  it('uses the identical variant definition as packages/ui so the apps cannot drift', () => {
    const pick = (css: string) =>
      css.split('\n').find((l) => l.trim().startsWith('@variant dark'))?.trim();
    expect(pick(readCss())).toBe(pick(fs.readFileSync(UI_INDEX_CSS, 'utf8')));
  });

  it('keeps all @import statements ahead of @variant, per the CSS spec', () => {
    // packages/ui/src/index.css carries a comment about @import silently
    // breaking when preceded by other at-rules. Same trap applies here.
    const lines = readCss().split('\n').map((l) => l.trim());
    const lastImport = lines.reduce((acc, l, i) => (l.startsWith('@import') ? i : acc), -1);
    const firstVariant = lines.findIndex((l) => l.startsWith('@variant'));
    expect(lastImport).toBeGreaterThanOrEqual(0);
    expect(firstVariant).toBeGreaterThan(lastImport);
  });

  it('no longer hardcodes `color-scheme: light dark` on :root', () => {
    // A static `light dark` leaves native form controls and scrollbars
    // following the OS, contradicting an explicit user choice. The provider
    // now sets documentElement.style.colorScheme instead.
    expect(readCss()).not.toMatch(/color-scheme:\s*light\s+dark/);
  });
});
