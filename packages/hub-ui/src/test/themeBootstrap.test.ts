/**
 * TASK 85c7a519 — pre-paint theme application.
 *
 * The provider applies the theme in a useEffect, which runs *after* React's
 * first paint. For a user who forced dark on a light-OS machine, the first
 * frame therefore renders with tokens.css's light `:root` defaults and then
 * snaps to dark — a visible white flash on every full page load.
 *
 * The fix is a tiny synchronous inline script in index.html that sets the
 * marker before the bundle (and before first paint). Asserted statically
 * because vitest never performs a real document parse of index.html.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const INDEX_HTML = path.resolve(__dirname, '../../index.html');
const readHtml = () => fs.readFileSync(INDEX_HTML, 'utf8');

describe('hub-ui pre-paint theme bootstrap', () => {
  it('ships a blocking inline script in <head>', () => {
    const html = readHtml();
    const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
    // Inline (no src) and not deferred/module, so it executes immediately.
    expect(head).toMatch(/<script>[\s\S]*<\/script>/);
  });

  it('runs before the app bundle so the marker exists on the first frame', () => {
    const html = readHtml();
    const inlineAt = html.indexOf('<script>');
    const bundleAt = html.indexOf('src="/src/main.tsx"');
    expect(inlineAt).toBeGreaterThan(-1);
    expect(bundleAt).toBeGreaterThan(-1);
    expect(inlineAt).toBeLessThan(bundleAt);
  });

  it('applies the same markers and storage key as ThemeContext', () => {
    const html = readHtml();
    const inline = html.slice(html.indexOf('<script>'), html.indexOf('</script>'));
    expect(inline).toContain("'theme'");
    expect(inline).toContain('data-theme');
    expect(inline).toContain('classList');
    expect(inline).toContain('prefers-color-scheme: dark');
    expect(inline).toContain('colorScheme');
  });

  it('is resilient to blocked storage so a throwing localStorage cannot white-screen the hub', () => {
    const inline = readHtml();
    expect(inline.slice(inline.indexOf('<script>'), inline.indexOf('</script>'))).toMatch(/try\s*\{/);
  });

  it('reproduces the provider\'s precedence: stored choice wins, else OS', () => {
    // Execute the extracted snippet against a stubbed environment and assert
    // the resulting marker, so the two implementations cannot silently diverge.
    const html = readHtml();
    const inline = html.slice(html.indexOf('<script>') + '<script>'.length, html.indexOf('</script>'));

    const run = (stored: string | null, prefersDark: boolean) => {
      const root = { className: '', attrs: {} as Record<string, string>, style: {} as Record<string, string> };
      const fakeDoc = {
        documentElement: {
          classList: {
            remove: (...cs: string[]) => {
              const kept = root.className.split(' ').filter((c) => c && !cs.includes(c));
              root.className = kept.join(' ');
            },
            add: (c: string) => {
              root.className = `${root.className} ${c}`.trim();
            },
          },
          setAttribute: (k: string, v: string) => { root.attrs[k] = v; },
          style: root.style,
        },
      };
      const fakeWin = {
        localStorage: { getItem: () => stored },
        matchMedia: (q: string) => ({ matches: prefersDark && q === '(prefers-color-scheme: dark)' }),
      };
      // eslint-disable-next-line no-new-func
      new Function('document', 'window', 'localStorage', 'matchMedia', inline)(
        fakeDoc, fakeWin, fakeWin.localStorage, fakeWin.matchMedia,
      );
      return { cls: root.className, attr: root.attrs['data-theme'] };
    };

    expect(run('dark', false)).toEqual({ cls: 'dark', attr: 'dark' });
    expect(run('light', true)).toEqual({ cls: 'light', attr: 'light' });
    expect(run(null, true)).toEqual({ cls: 'dark', attr: 'dark' });
    expect(run(null, false)).toEqual({ cls: 'light', attr: 'light' });
    expect(run('banana', true)).toEqual({ cls: 'dark', attr: 'dark' });
  });
});
