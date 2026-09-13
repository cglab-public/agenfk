/**
 * AgEnFK Desktop — Electron main process (CGLAB-167).
 *
 * The shape of the app: this process owns the AgEnFK server's lifetime, and
 * the window is just a browser pointed at it over loopback. Loading an
 * http://127.0.0.1 URL rather than file:// is deliberate — REST, Socket.io and
 * assets then share one origin, so the server's loopback-only CORS allowlist
 * needs no special case for app:// or file://, and nothing about the web flow
 * has to change to support the desktop one.
 */
import { app, BrowserWindow, dialog, shell, utilityProcess, type UtilityProcess } from 'electron';
import * as path from 'path';
import { readServerPort, DEFAULT_API_PORT } from '@agenfk/telemetry';
import { resolveServer, type ResolvedServer } from './serverLifecycle.js';
import { resolveDesktopPaths } from './paths.js';
import { resolveDbPath } from './serverEnv.js';
import { isAgenfkServer, servesUiBundle, httpGet } from './probes.js';
import { PtyRegistry } from './ptyRegistry.js';
import { registerPtyIpc } from './ptyIpc.js';
import { resolveWorktree } from './worktree.js';
import { httpPost } from './httpPost.js';
import { captureLoginPath } from './ptyEnv.js';

let mainWindow: BrowserWindow | null = null;
/**
 * Terminals. Created once the server port is known, because a session's
 * directory is resolved by asking the server which worktree a card owns.
 */
let ptyRegistry: PtyRegistry | null = null;
/**
 * The PATH an interactive login shell would have.
 *
 * Captured ONCE at boot and shared by agent detection and every spawn. Probing
 * with one PATH and launching with another is how a picker that says
 * "Installed" produces ENOENT — which is CGLAB-177's bug one layer down. Null
 * until the capture returns, or if it failed; every consumer treats that as
 * "use the inherited PATH".
 */
let loginPath: string | null = null;
let serverChild: UtilityProcess | null = null;
let server: ResolvedServer | null = null;
// Two distinct facts, deliberately not one flag. `tearingDown` means we are
// shutting down on purpose, so a dying child is expected rather than alarming.
// `quitHandled` means before-quit already ran its graceful stop and must not
// re-enter. Conflating them made the error paths skip the graceful stop.
let tearingDown = false;
let quitHandled = false;
// Tracked separately from `server`, which is only assigned once resolveServer
// RESOLVES. When it throws we have already forked a child, and keying shutdown
// off `server` would skip the graceful stop on exactly the path that needs it.
let weSpawnedTheServer = false;

/** How long to let the server finish its async shutdown before forcing quit. */
const SHUTDOWN_GRACE_MS = 5000;

/**
 * Ports to check for an already-running server when no port file names one.
 *
 * The server probes upward from 3000 for a free port and will try up to
 * MAX_PORT_PROBE_ATTEMPTS of them, so "is AgEnFK already running?" is a range
 * question, not a single-port one. We scan the low end where it realistically
 * lands: far enough to cover a few stale listeners, short enough that the scan
 * does not visibly delay startup.
 */
const ADOPT_PORT_RANGE = Array.from({ length: 16 }, (_, i) => DEFAULT_API_PORT + i);

/** Show a real dialog: a GUI app's console output goes nowhere the user looks. */
function fail(title: string, detail: string): void {
  console.error(`[DESKTOP] ${detail}`);
  dialog.showErrorBox(title, detail);
}

function startServer(): void {
  const { serverEntry, uiDir } = resolveDesktopPaths({
    dirname: __dirname,
    resourcesPath: process.resourcesPath,
    packaged: app.isPackaged,
  });
  const dbPath = resolveDbPath();
  weSpawnedTheServer = true;

  serverChild = utilityProcess.fork(serverEntry, [], {
    // cwd is explicit because the server's own fallback derives the database
    // from it. Launched from Finder that would be "/" — see serverEnv.ts.
    cwd: path.dirname(serverEntry),
    env: {
      ...process.env,
      // One origin for everything (CGLAB-165).
      AGENFK_SERVE_UI: uiDir,
      // Never let the database location depend on how the app was launched.
      AGENFK_DB_PATH: dbPath,
    },
    stdio: 'inherit',
  });
  console.log(`[DESKTOP] Starting AgEnFK server (db: ${dbPath})`);

  serverChild.on('exit', code => {
    serverChild = null;
    if (tearingDown) return;
    // A server that dies under a live window leaves a shell talking to nothing
    // and looks like a frozen app. `agenfk up` in a terminal does exactly this
    // — it kills anything matching packages/server/dist/server.js, ours
    // included — so this is a road the user will actually walk down.
    fail(
      'The AgEnFK server stopped',
      `The server this app started exited (code ${code}).\n\n` +
      `If you just ran \`agenfk up\` in a terminal, it stopped this app's server. ` +
      `Quit and reopen AgEnFK Desktop.`,
    );
  });
}

function createWindow(url: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#14181b',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      // The renderer runs the same bundle a browser would. It gets no Node
      // and no direct access to this process — everything it may do arrives
      // through the preload's explicit surface.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Paint only once there is something to show, instead of a white flash.
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  // Before 'closed': webContents.id is still readable here, and a shell left
  // attached to a worktree with no window in front of it is a process the user
  // cannot find or stop.
  win.on('close', () => ptyRegistry?.killAllForWindow(win.webContents.id));

  const appOrigin = new URL(url).origin;

  // External links belong in the user's browser, not in a chrome-less window
  // they cannot navigate back out of. Only ever hand the OS an http(s) URL:
  // openExternal launches whatever handler the scheme is registered to, so a
  // file:// or custom-protocol link would start an application.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    openExternally(target);
    return { action: 'deny' };
  });

  // Keep the window on our own origin. Item descriptions and comments render
  // markdown, so a link in agent-authored content is a top-level navigation
  // waiting to happen — and this window has no address bar or back button to
  // escape with, while the preload would be injected into whatever loaded.
  win.webContents.on('will-navigate', (event, target) => {
    if (safeOrigin(target) !== appOrigin) {
      event.preventDefault();
      openExternally(target);
    }
  });

  void win.loadURL(url);
  return win;
}

function safeOrigin(raw: string): string | null {
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

function openExternally(raw: string): void {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    console.warn(`[DESKTOP] Refused to open non-web URL: ${parsed.protocol}`);
    return;
  }
  void shell.openExternal(parsed.href);
}

async function boot(): Promise<void> {
  try {
    server = await resolveServer({
      readPort: readServerPort,
      fallbackPorts: ADOPT_PORT_RANGE,
      // Identity, not just liveness: anything could be listening on 3000, and
      // adopting it would open a window on somebody else's application.
      probe: isAgenfkServer,
      spawn: startServer,
    });
    console.log(
      `[DESKTOP] ${server.adopted ? 'Adopted running' : 'Started'} AgEnFK server at ${server.url}`,
    );

    if (!await servesUiBundle(server.port)) {
      // Adopting was still the right call — forking a second server onto the
      // same database would be worse than this message. Say exactly what is
      // wrong and exactly how to fix it.
      fail('AgEnFK Desktop cannot show the board', server.adopted
        ? `An AgEnFK server is already running at ${server.url}, but it is not serving the app ` +
          `(it was started for the browser flow, which serves the UI separately).\n\n` +
          `Stop it with \`agenfk down\` and reopen AgEnFK Desktop, which will run its own server.`
        : `The server started but is not serving the UI bundle. Run \`npm run build\` at the repo root.`);
      tearingDown = true;
      app.quit();
      return;
    }

    // Terminals need the resolved port: a card's directory comes from the
    // server, never from a guess. node-pty is required lazily so a failure to
    // load the native module degrades to "no terminals" rather than "the app
    // does not start".
    try {
      // Started before the window so the first terminal does not wait on it,
      // and awaited here because the registry is built with it. A broken rc
      // file resolves to null rather than blocking the app.
      loginPath = await captureLoginPath();

      const { spawn: spawnPty } = await import('@lydell/node-pty');
      const port = new URL(server.url).port ? Number(new URL(server.url).port) : DEFAULT_API_PORT;
      ptyRegistry = new PtyRegistry({
        spawn: spawnPty as never,
        resolveCwd: itemId => resolveWorktree(itemId, { port, get: httpGet, post: httpPost }),
        loginPath: () => loginPath,
        emit: (windowId, channel, payload) => {
          // To that window only. Broadcasting would put one card's shell
          // output into every open window.
          BrowserWindow.getAllWindows()
            .find(w => w.webContents.id === windowId)
            ?.webContents.send(channel, payload);
        },
      });
      registerPtyIpc(ptyRegistry);
    } catch (e) {
      console.warn('[DESKTOP] Terminals unavailable:', (e as Error).message);
    }

    mainWindow = createWindow(server.url);
  } catch (e) {
    fail('AgEnFK Desktop could not start', (e as Error).message);
    // Before quit(): otherwise the child's own exit fires a second, confusing
    // dialog on top of this one while we are already tearing down.
    tearingDown = true;
    app.quit();
  }
}

// One app, one server. A second launch raises the existing window instead of
// forking another server onto the same SQLite file.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else if (server) {
      // All windows closed but the app is still alive (macOS). Relaunching
      // from Finder must show something rather than appear to do nothing.
      mainWindow = createWindow(server.url);
    }
  });

  void app.whenReady().then(boot);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && server) {
      mainWindow = createWindow(server.url);
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', event => {
    // Only ever stop a server we started; an adopted one belongs to the
    // terminal session that launched it and must outlive this window.
    // Unconditional, and before the early return: an adopted server outlives
    // this app, but the shells THIS app spawned never should.
    ptyRegistry?.killAll();

    if (quitHandled || !serverChild || !weSpawnedTheServer) return;

    // Hold the quit open until the child is gone. Its SIGTERM handler is async
    // — it drains the hub outbox and writes a shutdown backup — and tearing
    // the main process down first would skip all of it and strand the port
    // file, which the next launch would then read as a live server.
    event.preventDefault();
    quitHandled = true;
    tearingDown = true;
    const child = serverChild;
    const done = (): void => app.quit();
    const timer = setTimeout(() => {
      console.warn('[DESKTOP] Server did not exit in time; quitting anyway.');
      done();
    }, SHUTDOWN_GRACE_MS);
    child.once('exit', () => { clearTimeout(timer); done(); });
    child.kill();
  });
}
