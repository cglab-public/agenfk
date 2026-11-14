/**
 * What the app offers when it cannot use the server it found.
 *
 * Separated from index.ts so the wording and the choices can be tested without
 * an Electron app object — the decision here is the whole feature, and it used
 * to be a string literal inside a startup branch nothing could reach.
 */

/**
 * Where `agenfk up` serves the board, when nothing says otherwise.
 *
 * A FALLBACK, not an answer. The port is not fixed: vite does not set
 * `strictPort`, so it moves to 5174 when something already holds 5173, and
 * `VITE_PORT` overrides it outright. The running server records the URL it
 * actually bound in `.agenfk/ui.log`, which is what `resolveBrowserUi` reads —
 * the same source `agenfk ui` has always used.
 */
export const DEFAULT_BROWSER_UI_URL = 'http://localhost:5173';

/**
 * The board a browser session is actually serving, or null.
 *
 * Null when nothing answers, and that case is the point. `servesUiBundle`
 * returning false proves only that the ADOPTED server is not serving HTML; it
 * says nothing about vite. An API server someone started on its own, or an
 * `agenfk up` whose UI process has since died — both leave a server to adopt
 * and nothing on the UI port. Offering to open it there would hand the user a
 * connection error as the DEFAULT button, which is worse than the instruction
 * it replaced: that at least named a command that works.
 */
export async function resolveBrowserUi(deps: {
  readUiLog: () => string | null;
  reachable: (url: string) => Promise<boolean>;
}): Promise<string | null> {
  const log = deps.readUiLog();
  const match = log?.match(/http:\/\/localhost:\d+/);
  const url = match ? match[0] : DEFAULT_BROWSER_UI_URL;
  return (await deps.reachable(url)) ? url : null;
}

export interface AdoptFailureChoice {
  readonly title: string;
  readonly detail: string;
  readonly buttons: string[];
  /** Index into `buttons`. What a hurried user gets by pressing Return. */
  readonly defaultId: number;
  /**
   * What each button MEANS, positionally.
   *
   * The caller used to compare the chosen label against the string
   * 'Open in browser', so rewording a button here would have silently turned
   * it into a quit — the user clicks "open" and the app closes. The decision
   * is this module's job; the label is presentation.
   */
  readonly actions: AdoptFailureAction[];
}

export type AdoptFailureAction = 'open-browser' | 'quit';

export function adoptFailureChoice(server: {
  adopted: boolean;
  url: string;
  /** The browser board, if one is actually answering. See resolveBrowserUi. */
  browserUi?: string | null;
}): AdoptFailureChoice {
  if (!server.adopted) {
    // We started it ourselves and it is not serving the bundle: a broken build,
    // not a conflict. There is no browser session to offer — sending the user
    // to a blank page would blame them for our missing files.
    return {
      title: 'AgEnFK Desktop cannot show the board',
      detail: 'The server started but is not serving the UI bundle. Run `npm run build` at the repo root.',
      buttons: ['Quit'],
      defaultId: 0,
      actions: ['quit'],
    };
  }

  if (!server.browserUi) {
    // Adopted a server that is not serving the app, and no browser board is
    // answering either. There is nothing to offer but the command.
    return {
      title: 'AgEnFK is already running elsewhere',
      detail:
        `An AgEnFK server is already running at ${server.url}, but it is not serving this app ` +
        `and no browser session is answering either.\n\n` +
        `Stop it with \`agenfk down\` and reopen AgEnFK.`,
      buttons: ['Quit'],
      defaultId: 0,
      actions: ['quit'],
    };
  }

  return {
    title: 'AgEnFK is already running in the browser',
    detail:
      `An AgEnFK server is already running at ${server.url}, and it serves the board to a browser ` +
      `rather than to this app. The two cannot share the port.\n\n` +
      `Your work is open at ${server.browserUi}.\n\n` +
      `To use the desktop app instead, stop the other one with \`agenfk down\` and reopen AgEnFK.`,
    // Opening the browser first, and as the default: it is the option that
    // leaves the user with their board. Recovering from a graphical app should
    // not require a terminal, and someone who installed only the desktop may
    // not have the CLI on their PATH at all.
    buttons: ['Open in browser', 'Quit'],
    defaultId: 0,
    actions: ['open-browser', 'quit'],
  };
}
