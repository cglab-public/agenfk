/**
 * @vitest-environment node
 *
 * What to offer when the desktop cannot use the server it found.
 *
 * The situation is ordinary, not exotic: anyone who runs AgEnFK in the browser
 * (`agenfk up`) and then opens the desktop app hits it. The desktop adopts the
 * server on port 3000 — adopting is correct, forking a second one onto the same
 * database would be worse — discovers it is not serving the app bundle, and
 * stops.
 *
 * The message was already a real dialog, not console output; that part was
 * checked before being blamed. The problem is what the dialog ASKS FOR: it
 * tells the user to run `agenfk down` in a terminal. So recovering from a
 * graphical app requires a command line, and someone who installed only the
 * desktop may not have the CLI on their PATH at all.
 *
 * The way out that needs no terminal: the browser UI that `agenfk up` started
 * is already running. Offering to open it is one click, and it is honest —
 * their work is right there.
 */
import { describe, it, expect } from 'vitest';
import { adoptFailureChoice, resolveBrowserUi, DEFAULT_BROWSER_UI_URL } from '../main/adoptFailure';

describe('when the adopted server does not serve the app', () => {
  it('offers to open the session that IS running, not just an instruction', () => {
    const choice = adoptFailureChoice({ adopted: true, url: 'http://127.0.0.1:3000', browserUi: 'http://localhost:5173' });
    expect(choice.buttons).toContain('Open in browser');
    // The terminal command stays available for anyone who wants the desktop
    // app rather than the browser — it is no longer the only way out.
    expect(choice.detail).toMatch(/agenfk down/);
  });

  it('names the port the browser session actually bound, not the usual one', async () => {
    // vite does not set strictPort, so it moves to 5174 when 5173 is taken,
    // and VITE_PORT overrides it outright. The running UI records the URL it
    // bound in .agenfk/ui.log, which is the same source `agenfk ui` reads.
    const url = await resolveBrowserUi({
      readUiLog: () => '  ➜  Local:   http://localhost:5174/',
      reachable: async () => true,
    });
    expect(url).toBe('http://localhost:5174');
  });

  it('falls back to the usual port when there is no log to read', async () => {
    expect(await resolveBrowserUi({ readUiLog: () => null, reachable: async () => true }))
      .toBe(DEFAULT_BROWSER_UI_URL);
  });

  it('offers nothing when the port does not answer', async () => {
    // The failure that made this worse than the message it replaced: an API
    // server can be adopted while no browser session exists at all, and the
    // user would have clicked the DEFAULT button into a connection error.
    expect(await resolveBrowserUi({ readUiLog: () => null, reachable: async () => false }))
      .toBeNull();
  });

  it('defaults to opening the browser rather than to quitting', () => {
    // The default is what a hurried user takes. Quitting leaves them with
    // nothing; the browser leaves them with their board.
    const choice = adoptFailureChoice({ adopted: true, url: 'http://127.0.0.1:3000', browserUi: 'http://localhost:5173' });
    expect(choice.actions[choice.defaultId]).toBe('open-browser');
  });

  it('says what each button MEANS, so rewording one cannot turn it into a quit', () => {
    // The caller compared the chosen label against the literal 'Open in
    // browser'. Renaming the button here would have silently made it quit:
    // the user clicks open, the app closes.
    const choice = adoptFailureChoice({ adopted: true, url: 'http://127.0.0.1:3000', browserUi: 'http://localhost:5173' });
    expect(choice.actions).toHaveLength(choice.buttons.length);
  });

  it('does not offer a browser session that is not answering', () => {
    const choice = adoptFailureChoice({ adopted: true, url: 'http://127.0.0.1:3000', browserUi: null });
    expect(choice.actions).not.toContain('open-browser');
    expect(choice.detail).toMatch(/agenfk down/);
  });

  it('says plainly that the two cannot share the port', () => {
    const choice = adoptFailureChoice({ adopted: true, url: 'http://127.0.0.1:3000', browserUi: 'http://localhost:5173' });
    expect(choice.detail).toMatch(/already running/i);
  });
});

describe('when our own server started but serves nothing', () => {
  it('does not offer a browser session that is not there', () => {
    // A different failure with the same symptom: we started the server
    // ourselves and the UI bundle is missing from the build. Offering to open
    // a browser would send the user to a blank page and blame them for it.
    const choice = adoptFailureChoice({ adopted: false, url: 'http://127.0.0.1:3000' });
    expect(choice.buttons).not.toContain('Open in browser');
    expect(choice.detail).toMatch(/npm run build/);
  });
});
