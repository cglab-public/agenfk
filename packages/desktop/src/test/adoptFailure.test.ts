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
import { adoptFailureChoice, BROWSER_UI_URL } from '../main/adoptFailure';

describe('when the adopted server does not serve the app', () => {
  it('offers to open the session that IS running, not just an instruction', () => {
    const choice = adoptFailureChoice({ adopted: true, url: 'http://127.0.0.1:3000' });
    expect(choice.buttons).toContain('Open in browser');
    // The terminal command stays available for anyone who wants the desktop
    // app rather than the browser — it is no longer the only way out.
    expect(choice.detail).toMatch(/agenfk down/);
  });

  it('points at the UI that the browser flow actually starts', () => {
    expect(BROWSER_UI_URL).toMatch(/5173/);
  });

  it('defaults to opening the browser rather than to quitting', () => {
    // The default is what a hurried user takes. Quitting leaves them with
    // nothing; the browser leaves them with their board.
    const choice = adoptFailureChoice({ adopted: true, url: 'http://127.0.0.1:3000' });
    expect(choice.buttons[choice.defaultId]).toBe('Open in browser');
  });

  it('says plainly that the two cannot share the port', () => {
    const choice = adoptFailureChoice({ adopted: true, url: 'http://127.0.0.1:3000' });
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
