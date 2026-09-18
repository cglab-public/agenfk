/**
 * Where `agenfk ui` opens (cb05216e).
 *
 * THE TEST THAT MATTERS IS THE ONE THAT PROMPTED THIS: the desktop app is open,
 * on screen, and the command puts a browser tab next to it. That is not a
 * preference gone wrong - the browser surface does not have the projects tree,
 * the terminals or the preload bridge, so it opens the version WITHOUT the
 * things the person went there to use.
 */
import { describe, it, expect } from 'vitest';
import { chooseOpenTarget } from '../openTarget';

const MAC = 'darwin' as NodeJS.Platform;
const APP = '/Applications/AgEnFK.app';

describe('when the desktop app is there', () => {
  it('goes to the app when it is already running', () => {
    /*
     * THE case. `open -a` on a running app FOCUSES it - and the main process
     * holds a single-instance lock, so a second launch would exit silently and
     * look like the command did nothing.
     */
    const t = chooseOpenTarget({ platform: MAC, appIsRunning: true, installedApps: [APP] });
    expect(t.kind).toBe('desktop');
    expect(t.why).toMatch(/already running/i);
  });

  it('goes to the app when it is merely installed', () => {
    const t = chooseOpenTarget({ platform: MAC, installedApps: [APP] });
    expect(t.kind).toBe('desktop');
  });

  it('takes the FIRST candidate, so the caller\'s order is the preference', () => {
    // The caller looks in /Applications, then ~/Applications, then the local
    // build. Re-sorting here would make two places decide one order.
    const t = chooseOpenTarget({
      platform: MAC,
      installedApps: [APP, '/Users/x/GitHub/agenfk/packages/desktop/release/mac-arm64/AgEnFK.app'],
    });
    expect(t.kind === 'desktop' && t.appPath).toBe(APP);
  });
});

describe('when it should still be the browser', () => {
  it('honours an explicit --web, even with the app running', () => {
    /*
     * A fix that removes somebody's ability to choose the browser has traded
     * one imposition for another. The explicit ask wins over everything.
     */
    const t = chooseOpenTarget({
      platform: MAC, forceWeb: true, appIsRunning: true, installedApps: [APP],
    });
    expect(t.kind).toBe('browser');
    expect(t.why).toMatch(/--web/);
  });

  it('falls back when no app was found', () => {
    const t = chooseOpenTarget({ platform: MAC, installedApps: [] });
    expect(t.kind).toBe('browser');
    expect(t.why).toMatch(/no desktop app/i);
  });

  it('stays on the browser off macOS, even if an app path was handed in', () => {
    /*
     * Linux and Windows have no stable way to focus or launch a named bundle
     * without knowing how it was installed, and guessing wrong there means a
     * confusing error instead of a working browser.
     */
    for (const platform of ['linux', 'win32'] as NodeJS.Platform[]) {
      const t = chooseOpenTarget({ platform, appIsRunning: true, installedApps: [APP] });
      expect(t.kind, platform).toBe('browser');
    }
  });
});

describe('the reason it gives', () => {
  it('always says why, on every branch', () => {
    /*
     * The command prints a line before it opens something, and "Opening UI..."
     * followed by the wrong surface is how the original behaviour went
     * unnoticed. Naming WHICH one and on what grounds makes a wrong answer
     * visible the first time instead of the tenth.
     */
    const cases: Parameters<typeof chooseOpenTarget>[0][] = [
      { platform: MAC, appIsRunning: true, installedApps: [APP] },
      { platform: MAC, installedApps: [APP] },
      { platform: MAC, installedApps: [] },
      { platform: 'linux' as NodeJS.Platform, installedApps: [APP] },
      { platform: MAC, forceWeb: true, installedApps: [APP] },
    ];
    for (const input of cases) {
      expect(chooseOpenTarget(input).why.length, JSON.stringify(input)).toBeGreaterThan(0);
    }
  });
});
