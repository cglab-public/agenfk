/**
 * Where `agenfk ui` should open: the desktop app, or a browser (cb05216e).
 *
 * It always opened a browser. That is not merely a preference gone wrong: the
 * desktop app SERVES THE SAME BUNDLE - with AGENFK_SERVE_UI the server returns
 * the UI on its own origin - so the two surfaces show the same screen and only
 * one of them has the projects tree, the terminals and the preload bridge.
 * Opening the browser when the app exists opens the version WITHOUT the things
 * the person went there to use.
 *
 * The most irritating case is the one that prompted this: the app is open, on
 * screen, and the command puts a browser tab next to it.
 *
 * A DECISION, NOT AN ACTION. This returns where to go and the caller does the
 * opening, so the order of preference can be tested without launching anything.
 */

export type OpenTarget =
  | { readonly kind: 'desktop'; readonly appPath: string; readonly why: string }
  | { readonly kind: 'browser'; readonly why: string };

export interface OpenTargetInputs {
  /** True when the user explicitly asked for the browser. Always wins. */
  readonly forceWeb?: boolean;
  /** True when a process matching the AgEnFK desktop app is already running. */
  readonly appIsRunning?: boolean;
  /**
   * Candidate app bundles, most preferred first, already filtered to ones that
   * exist. The caller owns the filesystem; this owns the order.
   */
  readonly installedApps?: readonly string[];
  /** Not every platform has an app bundle to open. */
  readonly platform?: NodeJS.Platform;
}

/**
 * Where to open, and why.
 *
 * The `why` is not decoration. This command prints a line before it opens
 * something, and "Opening UI..." followed by the wrong surface is how the
 * original behaviour stayed unnoticed - saying WHICH one, and on what grounds,
 * makes a wrong answer visible the first time instead of the tenth.
 */
export function chooseOpenTarget({
  forceWeb = false,
  appIsRunning = false,
  installedApps = [],
  platform = process.platform,
}: OpenTargetInputs): OpenTarget {
  if (forceWeb) {
    // An explicit ask always wins. A fix that removes somebody's ability to
    // choose the browser has traded one imposition for another.
    return { kind: 'browser', why: 'you asked for the browser with --web' };
  }

  /*
   * Only macOS gets `open -a`. Linux and Windows have no stable way to focus or
   * launch a named bundle without knowing how it was installed, and guessing
   * wrong there means a confusing error instead of a working browser.
   */
  const canOpenAnApp = platform === 'darwin';
  if (!canOpenAnApp) {
    return { kind: 'browser', why: 'the desktop app can only be launched by name on macOS' };
  }

  const app = installedApps[0];
  if (!app) {
    return { kind: 'browser', why: 'no desktop app was found' };
  }

  /*
   * Running beats installed, and it is the case worth naming: `open -a` on a
   * running app FOCUSES it rather than starting a second one - and the main
   * process holds a single-instance lock anyway, so a second launch would exit
   * silently and look like the command did nothing.
   */
  return {
    kind: 'desktop',
    appPath: app,
    why: appIsRunning ? 'the desktop app is already running' : 'the desktop app is installed',
  };
}
