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
import * as http from 'http';
import * as path from 'path';
import { readServerPort, DEFAULT_API_PORT } from '@agenfk/telemetry';
import { resolveServer, type ResolvedServer } from './serverLifecycle.js';
import { resolveDesktopPaths } from './paths.js';

let mainWindow: BrowserWindow | null = null;
let serverChild: UtilityProcess | null = null;
let server: ResolvedServer | null = null;

function request(
  port: number,
  reqPath: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; contentType: string } | null> {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: reqPath, headers, timeout: 1500 }, res => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, contentType: String(res.headers['content-type'] ?? '') });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/** A real health request — "is the port open" is not the same as "can it serve". */
async function probe(port: number): Promise<boolean> {
  return (await request(port, '/version'))?.status === 200;
}

/**
 * Does this server also serve the UI bundle? An adopted server started by
 * `agenfk up` does not (it leaves that to `vite preview`), and a window
 * pointed at it would render the API's JSON banner instead of the board.
 */
async function servesUi(port: number): Promise<boolean> {
  const res = await request(port, '/', { Accept: 'text/html' });
  return !!res && res.status === 200 && res.contentType.includes('text/html');
}

function startServer(): void {
  const { serverEntry, uiDir } = resolveDesktopPaths({
    dirname: __dirname,
    resourcesPath: process.resourcesPath,
    packaged: app.isPackaged,
  });

  serverChild = utilityProcess.fork(serverEntry, [], {
    env: {
      ...process.env,
      // One origin for everything (CGLAB-165).
      AGENFK_SERVE_UI: uiDir,
      // We are the window; the server must not also open a browser tab.
      AGENFK_NO_OPEN_BROWSER: '1',
    },
    stdio: 'inherit',
  });

  serverChild.on('exit', code => {
    serverChild = null;
    // A server that dies while the window is open leaves a shell talking to
    // nothing, which looks like a frozen app. Surface it instead.
    if (code !== 0 && mainWindow) {
      console.error(`[DESKTOP] AgEnFK server exited unexpectedly with code ${code}`);
    }
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

  // External links belong in the user's browser, not in a chrome-less window
  // they cannot navigate back out of.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: 'deny' };
  });

  void win.loadURL(url);
  return win;
}

async function boot(): Promise<void> {
  try {
    server = await resolveServer({
      readPort: readServerPort,
      fallbackPorts: [DEFAULT_API_PORT],
      probe,
      spawn: startServer,
    });
    console.log(
      `[DESKTOP] ${server.adopted ? 'Adopted running' : 'Started'} AgEnFK server at ${server.url}`,
    );

    if (!await servesUi(server.port)) {
      // Adopting was still the right call — forking a second server onto the
      // same database would be worse than this message. Say exactly what is
      // wrong and exactly how to fix it.
      const detail = server.adopted
        ? `An AgEnFK server is already running at ${server.url}, but it is not serving the app ` +
          `(it was started for the browser flow, which serves the UI separately).\n\n` +
          `Stop it with \`agenfk down\` and reopen AgEnFK Desktop, which will run its own server.`
        : `The server started but is not serving the UI bundle. Run \`npm run build\` at the repo root.`;
      dialog.showErrorBox('AgEnFK Desktop cannot show the board', detail);
      console.error(`[DESKTOP] ${detail}`);
      app.quit();
      return;
    }

    mainWindow = createWindow(server.url);
    mainWindow.on('closed', () => { mainWindow = null; });
  } catch (e) {
    console.error('[DESKTOP] Could not start AgEnFK:', (e as Error).message);
    app.quit();
  }
}

// One app, one server. A second launch raises the existing window instead of
// forking another server onto the same SQLite file.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
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

  app.on('before-quit', () => {
    // Only ever stop a server we started; an adopted one belongs to the
    // terminal session that launched it and must outlive this window.
    server?.stop(() => serverChild?.kill());
  });
}
