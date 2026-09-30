/**
 * docs/adr/0001-desktop-shell-in-a-browser.md is a recipe that has to RUN: it
 * hands people a script to inject before the bundle, and a list of what the
 * browser cannot stand in for. Both drift silently - the preload's bridge
 * changes shape and the script stops switching the shell on, or a bridge is
 * added and the list stops saying what a browser run leaves untested.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDesktop, desktopInfo } from '../desktop';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..', '..');
const adr = readFileSync(join(repo, 'docs', 'adr', '0001-desktop-shell-in-a-browser.md'), 'utf8');
const preload = readFileSync(join(repo, 'packages', 'desktop', 'src', 'preload', 'index.ts'), 'utf8');

/** The fenced block the ADR marks as the init script. */
function initScript(): string {
  const m = /<!-- init-script -->\s*```js\n([\s\S]*?)```/.exec(adr);
  if (!m) throw new Error('the ADR has no <!-- init-script --> block');
  return m[1];
}

/** The bridges the preload exposes beyond identity: what a browser run has no stand-in for. */
function preloadBridges(): string[] {
  const m = /const api: AgenfkDesktopApi = \{([\s\S]*?)\n\};/.exec(preload);
  if (!m) throw new Error('could not find the preload api object');
  // A spread, a quoted or a computed key would add a bridge this parser cannot name - and the test would pass blind.
  if (/^\s{2}(\.\.\.|['"\[])/m.test(m[1])) throw new Error('the preload api object has a spread, quoted or computed key: name its bridges plainly');
  const identity = new Set(['isDesktop', 'platform', 'versions']);
  return [...m[1].matchAll(/^\s{2}(\w+)[,:]/gm)].map(k => k[1]).filter(k => !identity.has(k));
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).agenfkDesktop;
});

describe('the desktop-shell-in-a-browser ADR', () => {
  it('its init script switches the desktop shell on, with the stub identity the ADR describes', () => {
    expect(isDesktop()).toBe(false);
    new Function(initScript())();
    expect(isDesktop()).toBe(true);
    // Read from the script, not defaulted: desktopInfo() fills a missing platform with 'unknown',
    // and 'Electron 0' in the footer is how the ADR tells a simulated shell from the real one.
    expect(desktopInfo()?.platform).toBe('darwin');
    expect(desktopInfo()?.versions.electron).toBe('0');
  });

  it('names every preload bridge a browser run cannot exercise', () => {
    const bridges = preloadBridges();
    expect(bridges.length).toBeGreaterThan(0);
    const section = adr.split(/^## /m).find(s => s.startsWith('What it does not cover')) ?? '';
    for (const bridge of bridges) expect(section, `missing \`${bridge}\``).toContain(`\`${bridge}\``);
  });
});
