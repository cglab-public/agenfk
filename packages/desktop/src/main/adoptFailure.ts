/**
 * What the app offers when it cannot use the server it found.
 *
 * Separated from index.ts so the wording and the choices can be tested without
 * an Electron app object — the decision here is the whole feature, and it used
 * to be a string literal inside a startup branch nothing could reach.
 */

/**
 * Where `agenfk up` serves the board.
 *
 * The CLI's own teardown kills this port (packages/cli/src/index.ts), which is
 * what makes it the right thing to point at: if a browser flow is running, this
 * is where it is.
 */
export const BROWSER_UI_URL = 'http://localhost:5173';

export interface AdoptFailureChoice {
  readonly title: string;
  readonly detail: string;
  readonly buttons: string[];
  /** Index into `buttons`. What a hurried user gets by pressing Return. */
  readonly defaultId: number;
}

export function adoptFailureChoice(server: { adopted: boolean; url: string }): AdoptFailureChoice {
  if (!server.adopted) {
    // We started it ourselves and it is not serving the bundle: a broken build,
    // not a conflict. There is no browser session to offer — sending the user
    // to a blank page would blame them for our missing files.
    return {
      title: 'AgEnFK Desktop cannot show the board',
      detail: 'The server started but is not serving the UI bundle. Run `npm run build` at the repo root.',
      buttons: ['Quit'],
      defaultId: 0,
    };
  }

  return {
    title: 'AgEnFK is already running in the browser',
    detail:
      `An AgEnFK server is already running at ${server.url}, and it serves the board to a browser ` +
      `rather than to this app. The two cannot share the port.\n\n` +
      `Your work is open at ${BROWSER_UI_URL}.\n\n` +
      `To use the desktop app instead, stop the other one with \`agenfk down\` and reopen AgEnFK.`,
    // Opening the browser first, and as the default: it is the option that
    // leaves the user with their board. Recovering from a graphical app should
    // not require a terminal, and someone who installed only the desktop may
    // not have the CLI on their PATH at all.
    buttons: ['Open in browser', 'Quit'],
    defaultId: 0,
  };
}
