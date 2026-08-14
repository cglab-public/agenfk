/**
 * CSS wiring for hub-ui class-based dark mode.
 *
 * hub-ui previously relied on Tailwind v4's default (media-query) `dark:`
 * variant, so `dark:` utilities followed the OS. These tests lock in the
 * switch to a class/attribute-driven variant (mirroring packages/ui) so a
 * manual theme toggle can drive it. Run under the default node environment.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');

const hubIndexCss = read('../index.css');
const tokensCss = read('../../../brand/tokens.css');
const uiIndexCss = read('../../../ui/src/index.css');

/** Extract the selector list of `@variant dark (…)`, normalised. */
function darkVariantSelector(css: string): string | null {
  const m = css.match(/@variant\s+dark\s*\(([^)]*)\)/);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

describe('hub-ui class-based dark mode CSS wiring', () => {
  it('defines a class-based @variant dark matching .dark and [data-theme="dark"]', () => {
    const sel = darkVariantSelector(hubIndexCss);
    expect(sel, 'hub-ui/src/index.css must declare `@variant dark (…)`').not.toBeNull();
    expect(sel).toContain('.dark');
    expect(sel).toContain('[data-theme="dark"]');
  });

  it('uses the same dark-variant selectors as packages/ui (one mechanism across both apps)', () => {
    const uiSel = darkVariantSelector(uiIndexCss);
    expect(uiSel, 'packages/ui/src/index.css is the reference for the variant').not.toBeNull();
    expect(darkVariantSelector(hubIndexCss)).toBe(uiSel);
  });

  it('pins color-scheme per explicit theme so native widgets follow the choice', () => {
    expect(hubIndexCss).toMatch(/\.light\s*\{[^}]*color-scheme:\s*light[^}]*\}/);
    expect(hubIndexCss).toMatch(/\.dark\s*\{[^}]*color-scheme:\s*dark[^}]*\}/);
  });

  it('keeps the .dark/.light token override blocks in the shared brand tokens (drift guard)', () => {
    // The manual toggle only works if tokens.css still overrides the theme
    // tokens for the explicit class/attribute selectors.
    expect(tokensCss).toMatch(/\.dark\s*,\s*\.dark \*/);
    expect(tokensCss).toMatch(/\[data-theme="dark"\]/);
    expect(tokensCss).toMatch(/\.light\s*,\s*\.light \*/);
    expect(tokensCss).toMatch(/\[data-theme="light"\]/);
  });
});
