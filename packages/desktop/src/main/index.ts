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
import { app, BrowserWindow, dialog, ipcMain, Notification, shell, utilityProcess, type UtilityProcess } from 'electron';
import * as path from 'path';
import * as os from 'os';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { execFile, execFileSync } from 'node:child_process';
import { readServerPort, DEFAULT_API_PORT } from '@agenfk/telemetry';
import { resolveServer, type ResolvedServer } from './serverLifecycle.js';
import { resolveDesktopPaths } from './paths.js';
import { printCommandFor, listAgents, reopenNotice } from './agents.js';
import { resolveDbPath } from './serverEnv.js';
import { isAgenfkServer, servesUiBundle, httpGet } from './probes.js';
import { agentRunSourcePath } from './agentRunSource.js';
import { PtyRegistry } from './ptyRegistry.js';
import { proposeDecomposition } from './propose.js';
import { addProjectFromDirectory, folderDoor, type AddProjectDeps } from './addProject.js';
import { cloneRepository } from './cloneRepository.js';
import { createRepository, listOwners } from './createRepository.js';
import { cloneDirOrDefault, readPrefs, writePref } from './prefs.js';
import { registerPtyIpc } from './ptyIpc.js';
import { resolveWorktree } from './worktree.js';
import { cardPrompt } from './cardPrompt.js';
import { httpPost } from './httpPost.js';
import { captureLoginPath } from './ptyEnv.js';
import { adoptFailureChoice, resolveBrowserUi } from './adoptFailure.js';
import { EDITORS } from './editors.js';
import { detectTmux, type TmuxStatus } from './tmux.js';
import { whichOnPath, setAgentDetectionDeps } from './detectAgents.js';
import { makeEmit } from './windowEmit.js';
import { makeLoginPathCache } from './loginPathCache.js';
import { SOUND_EXTENSIONS } from './customSound.js';
import { showAttentionNotice } from './attentionNotice.js';

/**
 * What the sound picker offers.
 *
 * The filter list is derived from the same allowlist `storeCustomSound`
 * enforces, so the dialog cannot offer a format the copy would then refuse —
 * which would read to the user as the app losing their file.
 */
const SOUND_DIALOG: Electron.OpenDialogOptions = {
  title: 'Choose a notification sound',
  properties: ['openFile'],
  filters: [{ name: 'Audio', extensions: SOUND_EXTENSIONS.map(e => e.slice(1)) }],
};

let mainWindow: BrowserWindow | null = null;
/**
 * Terminals. Created once the server port is known, because a session's
 * directory is resolved by asking the server which worktree a card owns.
 */
let ptyRegistry: PtyRegistry | null = null;
/**
 * The PATH an interactive login shell would have, most recently captured.
 *
 * Shared by agent detection and every spawn. Probing with one PATH and
 * launching with another is how a picker that says "Installed" produces
 * ENOENT — which is CGLAB-177's bug one layer down.
 *
 * Kept for logging and for anything that wants the value without waiting;
 * both real consumers go through the accessor below, which can wait for a
 * capture still in flight. Null means no successful capture yet.
 */
let loginPath: string | null = null;
/**
 * Whether sessions can survive the app closing.
 *
 * Detected once. On Windows this is a fact about the platform rather than a
 * missing install — there is no tmux port — so it carries a named warning the
 * UI can explain instead of an install command that would be a lie.
 */
let tmuxStatus: TmuxStatus = { available: false };
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

  /*
   * A reload is a teardown too, and it was not treated as one.
   *
   * `webContents.id` is STABLE across a reload, so the old sessions stayed in
   * the registry owned by a renderer that had just lost every session id —
   * unaddressable and unkillable until the window closed. Meanwhile the
   * restore path spawned fresh PTYs for the same cards. Two agents running in
   * one worktree, both editing the same files, plus two orphans still writing
   * into it.
   *
   * Reachable without dev tooling: no application menu is set, so Electron's
   * default one ships View > Reload (Cmd+R).
   *
   * Reaped BEFORE the new document starts, so the incoming renderer sees an
   * empty registry rather than sessions it cannot name.
   */
  win.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (!isMainFrame || isInPlace) return;
    ptyRegistry?.killAllForWindow(win.webContents.id);
  });

  // A crashed renderer leaves the same orphans behind, with no navigation to
  // hang the cleanup on.
  win.webContents.on('render-process-gone', () => {
    ptyRegistry?.killAllForWindow(win.webContents.id);
  });

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
  /*
   * http(s), plus the editor schemes from the closed list — and nothing else.
   *
   * The guard is narrow because `shell.openExternal` hands the string to
   * whatever handler the OS registered for the scheme, so every scheme allowed
   * here is a local program this app can be made to launch. The editor list is
   * fixed at compile time (main/editors.ts) precisely so that set cannot grow
   * at runtime, and the path inside the URL is encoded there before it gets
   * this far.
   */
  const allowed = new Set(['http:', 'https:', ...EDITORS.map(e => `${e.scheme}:`)]);
  if (!allowed.has(parsed.protocol)) {
    console.warn(`[DESKTOP] Refused to open URL with scheme: ${parsed.protocol}`);
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
      // same database would be worse than this. What changed is what we OFFER:
      // telling a graphical app's user to run a terminal command was the only
      // way out, and someone who installed just the desktop may not have the
      // CLI on their PATH at all. Their board is already open in a browser, so
      // that is one click away instead. See main/adoptFailure.ts.
      // Resolved and PROBED, not assumed: the UI port moves, and an adopted
      // API server does not imply a browser session exists at all.
      const browserUi = await resolveBrowserUi({
        readUiLog: () => {
          try {
            return readFileSync(path.join(os.homedir(), '.agenfk-system', '.agenfk', 'ui.log'), 'utf8');
          } catch { return null; }
        },
        reachable: async url => {
          // httpGet takes a PORT, not a URL: the probe answers "is something
          // serving there", which is the question — an adopted API server does
          // not imply a browser session exists at all.
          const port = Number(new URL(url).port);
          if (!Number.isInteger(port) || port <= 0) return false;
          try { return Boolean(await httpGet(port, '/')); } catch { return false; }
        },
      });
      const choice = adoptFailureChoice({ ...server, browserUi });
      console.error(`[DESKTOP] ${choice.detail}`);
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        title: choice.title,
        message: choice.title,
        detail: choice.detail,
        buttons: choice.buttons,
        defaultId: choice.defaultId,
        cancelId: choice.buttons.length - 1,
      });
      // By ACTION, not by label. Comparing the chosen button's text meant a
      // reworded button would silently become a quit.
      if (choice.actions[response] === 'open-browser' && browserUi) {
        await openExternally(browserUi);
      }
      tearingDown = true;
      app.quit();
      return;
    }

    // Terminals need the resolved port: a card's directory comes from the
    // server, never from a guess. node-pty is required lazily so a failure to
    // load the native module degrades to "no terminals" rather than "the app
    // does not start".
    try {
      /*
       * ONE capture, shared, and the window does not wait for it.
       *
       * Both halves were wrong before. The comment here claimed detection and
       * spawning shared one capture — spawning did, detection did not: it fell
       * through to its own default and ran `$SHELL -lic env` a second time, a
       * whole extra rc chain per boot. And this was `await`ed, so despite the
       * comment saying the window did not wait on it, the window waited on
       * every launch; execFile does not close the child's stdin, so an rc file
       * that reads input held the app at a blank screen until the 5s timeout.
       *
       * Not awaiting is only safe because both consumers can wait for the
       * promise themselves: the registry's loginPath callback may return one,
       * and detection is handed the same one. Otherwise a terminal opened in
       * the first second would get a degraded PATH.
       */
      // Comfortably past captureLoginPath's own 5s timeout; this is a backstop
      // for the spawn path, not a second policy.
      const LOGIN_PATH_DEADLINE_MS = 8_000;
      /*
       * The captured PATH, re-captured when the memo is no longer trustworthy.
       *
       * Both halves of that sentence are scar tissue. A single memoised promise
       * turned a boot optimisation into a session-long pin, so a PATH that
       * changed while the app was open was never seen again — hence the expiry.
       * And the expiry without a single flight meant N concurrent spawns each
       * forked their own login shell — hence loginPathCache.
       */
      const currentLoginPath = makeLoginPathCache({
        capture: () => captureLoginPath().then(p => { loginPath = p; return p; }),
      });
      // Kick it off now, so the value is usually ready before anything asks.
      void currentLoginPath();

      setAgentDetectionDeps({ which: whichOnPath, loginPath: currentLoginPath });
      /*
       * Probed against the LOGIN PATH, like agent detection one line above.
       *
       * This used the raw `whichOnPath`, and the consequence was quiet and
       * total: launchd hands an app opened from the Finder a minimal PATH with
       * no /opt/homebrew/bin in it, so tmux reported ABSENT on machines that
       * have it. `useTmux` was then false whatever the user chose, nothing
       * persisted, and every restore fell through to the weaker path.
       *
       * I fixed half of this PATH problem for agent detection and left the
       * other half sitting one line below it.
       */
      tmuxStatus = await detectTmux({
        platform: process.platform,
        which: async file => whichOnPath(file, (await currentLoginPath()) ?? undefined),
      });
      if (!tmuxStatus.available) {
        /*
         * Two facts, said separately, because the old line said one and got it
         * wrong: "Terminal sessions will NOT survive quitting".
         *
         * The PROCESS does not survive - an agent mid-task is not still
         * mid-task afterwards, and that is what tmux buys. The CONVERSATION
         * does: terminals are recorded server-side and reopened, and the agent
         * itself resumes through --session-id or --resume (a subcommand for
         * codex). That path is weaker than tmux, not absent.
         *
         * Read as one sentence, the old wording said "you will lose what was
         * in there". Which pushes somebody into installing tmux over a fear
         * that does not apply, or - worse - into distrusting a restore that
         * works and copying scrollback out by hand before quitting.
         */
        console.log('[DESKTOP] Without tmux, a running agent is stopped when you quit.');
        /*
         * WHICH agents, not "the conversation" flatly. The unconditional
         * sentence was true for two of five: claude-code and pi can be handed a
         * session id, so the restore resumes them; codex cannot dictate one, so
         * no agentSessionId is minted and restore sets resume:false; gemini and
         * shell have no session descriptor at all.
         *
         * Wrong in the REASSURING direction for codex and gemini users - told
         * their conversation comes back when it does not - which is the failure
         * mode this whole card was filed about, reintroduced by its own fix.
         *
         * Derived from `canDictateSessionId` rather than listed here, because a
         * hand-written list beside the real one is the thing that drifts.
         */
        console.log(`[DESKTOP] ${reopenNotice(listAgents())}`);
        /*
         * On Windows `tmuxStatus.warning` is the raw enum
         * 'tmux_unsupported_on_windows', and printing it as the fix presented
         * an internal token as the action to take - on the one platform where
         * there is no action. SettingsPanel already refuses to send a Windows
         * user after an install that cannot exist; this now refuses the same.
         */
        if (tmuxStatus.hint) {
          console.log(`[DESKTOP] To keep the process alive too: ${tmuxStatus.hint}`);
        }
      }

      const { spawn: spawnPty } = await import('@lydell/node-pty');
      /*
       * To ONE window, never broadcast, and never to a destroyed one — see
       * windowEmit.ts for why the guard matters more than it looks. Declared
       * once because both the terminals and the one-shot agent question report
       * through it.
       */
      const emitToWindow = makeEmit(() => BrowserWindow.getAllWindows());

      /*
       * Git's own answer, not ours. `rev-parse --git-dir` resolves upwards, so
       * it is true for a subdirectory of a checkout and for a bare repository,
       * both of which `git worktree add` accepts and a `.git` lookup refuses.
       */
      const isGitCheckout = (dir: string): boolean => {
        try {
          execFileSync('git', ['rev-parse', '--git-dir'], {
            cwd: dir, stdio: 'ignore', env: process.env,
          });
          return true;
        } catch {
          return false;
        }
      };

      const port = new URL(server.url).port ? Number(new URL(server.url).port) : DEFAULT_API_PORT;
      ptyRegistry = new PtyRegistry({
        spawn: spawnPty as never,
        /*
         * The card, in its own words, as the first thing the agent is told.
         * Read from the server here so the text is the CARD's — the renderer
         * never supplies what gets typed into a terminal.
         */
        promptFor: async itemId => {
          const res = await httpGet(port, `/items/${encodeURIComponent(itemId)}`);
          if (!res || res.status >= 300) return null;
          try {
            return cardPrompt(JSON.parse(res.body || '{}'));
          } catch {
            return null;
          }
        },
        resolveCwd: itemId => resolveWorktree(itemId, {
          port, get: httpGet, post: httpPost,
          /*
           * THE SAME QUESTION THE SERVER ASKS. Looking for a `.git` entry is a
           * different, stricter predicate: a project root nested inside a
           * repository — `packages/ui` in this repo — has none and is still a
           * checkout, and answering "not a repository" there would open the
           * card's terminal on the user's current branch with no worktree.
           */
          isRepo: isGitCheckout,
          exists: dir => existsSync(dir),
          projectRoot: async id => {
            const res = await httpGet(port, `/items/${encodeURIComponent(id)}`);
            if (!res || res.status >= 300) return null;
            const projectId = JSON.parse(res.body || '{}')?.projectId;
            if (!projectId) return null;
            const proj = await httpGet(port, `/projects/${encodeURIComponent(String(projectId))}`);
            if (!proj || proj.status >= 300) return null;
            const root = JSON.parse(proj.body || '{}')?.projectRoot;
            return typeof root === 'string' && root ? root : null;
          },
        }),
        /*
         * Where a session with no card runs: the project's own checkout.
         *
         * Not a worktree — cutting one would mean creating the card that Ask
         * AgEnFK exists to propose rather than assume. An id in, a path out,
         * resolved here in the main process like every other path in this app.
         */
        resolveProjectCwd: async projectId => {
          // `.body`, not the response. httpGet resolves to
          // { status, contentType, body }, so String()-ing it produced the
          // literal "[object Object]" and JSON.parse said so on screen.
          const res = await httpGet(port, `/projects/${encodeURIComponent(projectId)}`);
          if (!res || res.status >= 300) {
            throw new Error(`The server did not return this project (${res?.status ?? 'no answer'}).`);
          }
          const root = JSON.parse(res.body || '{}')?.projectRoot;
          if (typeof root !== 'string' || !root) {
            throw new Error('This project has no projectRoot, so there is nowhere to run an agent.');
          }
          return { cwd: root };
        },
        /*
         * A RUN IS REGISTERED WHEN AN AGENT STARTS (BUG 53ed7163).
         *
         * This is the link that was missing. Fire-and-forget on purpose: a
         * terminal must open even when the server is slow or down, and the
         * failure belongs in the log rather than thrown into the spawn. The
         * step comes from the CARD, which is the only honest value; the model
         * is 'unknown' because the desktop does not choose it.
         */
        registerRun: ({ itemId, agentId, agentSessionId }) => {
          void (async () => {
            try {
              const res = await httpGet(port, `/items/${encodeURIComponent(itemId)}`);
              const item = res?.body ? JSON.parse(res.body) : null;
              const posted = await httpPost(port, '/agent-runs', {}, JSON.stringify({
                itemId,
                projectId: item?.projectId,
                step: item?.status ?? 'IN_PROGRESS',
                actor: 'worker',
                harness: agentId,
                model: 'unknown',
                sessionId: agentSessionId,
                sourcePath: agentRunSourcePath(agentId, agentSessionId),
              }));
              /*
               * CHECKED, not assumed. `httpPost` RESOLVES null on a failure
               * rather than rejecting, so an unexamined await made a refused
               * registration invisible: no run, no error, nothing to look at.
               */
              if (!posted || posted.status >= 300) {
                console.warn('[DESKTOP] could not register the run:',
                  posted ? `${posted.status} ${posted.body}` : 'no response from the server');
              } else {
                // Logged on SUCCESS too, and that is not noise: with only the
                // failure line, "the terminal opened and nothing was recorded"
                // is indistinguishable from "this hook was never called",
                // which is a different bug with a different fix.
                console.log('[DESKTOP] registered run', JSON.parse(posted.body)?.id,
                  `(${agentId} on ${itemId})`);
              }
            } catch (e) {
              console.warn('[DESKTOP] could not register the run:', (e as Error)?.message);
            }
          })();
        },
        /*
         * Waits for the capture rather than proceeding without it, which is
         * what lets the window paint first. Raced against a deadline so the
         * failure mode stays what it always was: a terminal with a degraded
         * PATH, never a terminal that refuses to open. `captureLoginPath` has
         * its own 5s timeout, so this only matters if that one is ever
         * survived — but "the spawn hangs forever" is a different category of
         * failure from "the spawn has the wrong PATH", and not one to inherit
         * silently.
         */
        loginPath: () => Promise.race([
          currentLoginPath(),
          new Promise<null>(resolve => setTimeout(() => resolve(null), LOGIN_PATH_DEADLINE_MS)),
        ]),
        tmux: { available: tmuxStatus.available },
        // To that window only, and never to a destroyed one. See windowEmit.ts
        // for why the guard matters more than it looks: this runs inside a
        // pty's data callback.
        emit: emitToWindow,
      });
      // userData, not the AgEnFK database: the database is shared with the
      // CLI and the server, and these preferences exist precisely to be out of
      // reach of anything that talks to the server. See main/prefs.ts.
      /*
       * `git clone`, as the two doors that need it both run it.
       *
       * execFile, never a shell: the URL is text somebody typed, and it
       * reaches argv as one argument rather than as something a shell gets to
       * interpret. `protocol.ext.allow=never` on the command line because a
       * transport that RUNS COMMANDS must not be re-enabled by the config this
       * process inherits — -c comes before the subcommand.
       */
      const gitClone = (repo: string, target: string, into: string, onLine: (l: string) => void) =>
        new Promise<void>((resolve, reject) => {
          /*
           * Created HERE, after every refusal has had its say: a mistyped URL
           * must not leave a directory behind, and ~/agenfk is a proposal
           * until a clone actually runs.
           */
          mkdirSync(into, { recursive: true });
          const child = execFile('git', ['-c', 'protocol.ext.allow=never', 'clone', '--progress', repo, target], {
            env: process.env,
            maxBuffer: 16 * 1024 * 1024,
          }, (err, _stdout, stderr) => {
            if (err) reject(new Error(String(stderr ?? '').trim() || err.message));
            else resolve();
          });
          // git writes progress to stderr, and a big repository takes minutes.
          // It goes to the app log, NOT to the screen: showing it there needs
          // an event channel of its own, and until that exists this is what
          // turns "stuck?" into an answerable question.
          child.stderr?.on('data', chunk => {
            for (const line of String(chunk).split(/[\r\n]+/)) {
              if (line.trim()) onLine(line.trim());
            }
          });
        });

      /*
       * The project row, and the internal-token write that points it at the
       * checkout. Shared by clone and create so the two cannot drift into
       * telling the user different things about the same failure.
       */
      const addProjectAt = async (root: string, projectName: string) => {
        const created = await httpPost(port, '/projects',
          { 'Content-Type': 'application/json' }, JSON.stringify({ name: projectName }));
        if (!created || created.status >= 300) {
          throw new Error(`The checkout is on disk, but the server refused to create the project (${created?.status ?? 'no answer'}).`);
        }
        const project = JSON.parse(created.body);
        const token = readFileSync(path.join(os.homedir(), '.agenfk', 'verify-token'), 'utf8').trim();
        const pointed = await httpPost(port, `/projects/${encodeURIComponent(project.id)}/project-root`,
          { 'Content-Type': 'application/json', 'x-agenfk-internal': token },
          JSON.stringify({ projectRoot: root }), 'PUT');
        if (!pointed || pointed.status >= 300) {
          throw new Error(`The checkout is on disk, but the project could not be pointed at it (${pointed?.status ?? 'no answer'}).`);
        }
        return project as { id: string; name: string };
      };

      /*
       * `gh`, with an ARGUMENT ARRAY. The one credential this machine has —
       * see createRepository.ts for why there is no second one.
       */
      const runGh = (args: readonly string[]) => new Promise<string>((resolve, reject) => {
        execFile('gh', [...args], { env: process.env, maxBuffer: 8 * 1024 * 1024 },
          (err, stdout, stderr) => {
            // gh explains itself on stderr — a taken name, a missing scope, a
            // logged-out state. Its words travel; ours would only paraphrase.
            if (err) reject(new Error(String(stderr ?? '').trim() || err.message));
            else resolve(String(stdout ?? ''));
          });
      });

      /*
       * The three calls only this process may make: the native picker, the
       * create, and the internal-token route that points a project at a
       * folder. Shared by both doors below so they cannot drift apart.
       */
      const folderDeps: AddProjectDeps = {
        chooseDirectory: async () => {
          const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
          const options: Electron.OpenDialogOptions = {
            title: 'Choose the project folder',
            // `createDirectory` so a new project can start from a folder that
            // does not exist yet, without leaving the dialog.
            properties: ['openDirectory', 'createDirectory'],
          };
          const result = owner
            ? await dialog.showOpenDialog(owner, options)
            : await dialog.showOpenDialog(options);
          return result.canceled ? null : (result.filePaths[0] ?? null);
        },
        createProject: async name => {
          const res = await httpPost(port, '/projects',
            { 'Content-Type': 'application/json' }, JSON.stringify({ name }));
          if (!res || res.status >= 300) {
            throw new Error(`The server refused to create the project (${res?.status ?? 'no answer'}).`);
          }
          return JSON.parse(res.body);
        },
        /*
         * The internal-token route. `projectRoot` is a CWD — where the close
         * commit runs and where worktrees are cut — so the server refuses it
         * from anyone without this header, and the token is a file only a
         * trusted process should read.
         */
        setProjectRoot: async (projectId, root) => {
          const token = readFileSync(path.join(os.homedir(), '.agenfk', 'verify-token'), 'utf8').trim();
          const res = await httpPost(port, `/projects/${encodeURIComponent(projectId)}/project-root`,
            { 'Content-Type': 'application/json', 'x-agenfk-internal': token },
            JSON.stringify({ projectRoot: root }), 'PUT');
          if (!res || res.status >= 300) {
            throw new Error(`The server refused to point the project at that folder (${res?.status ?? 'no answer'}).`);
          }
        },
      };

      registerPtyIpc(ptyRegistry, ipcMain, () => tmuxStatus, () => app.getPath('userData'), {
        // whichOnPath answers with the resolved path or null; the editor
        // probe only asks whether it is there.
        which: async command => Boolean(await whichOnPath(command)),
        // Routed through the same guard as every other external URL, which
        // now permits the editor schemes from the closed list and nothing
        // else — see openExternally.
        openExternal: async url => { openExternally(url); },
        resolveCwd: itemId => resolveWorktree(itemId, {
          port, get: httpGet, post: httpPost,
          /*
           * THE SAME QUESTION THE SERVER ASKS. Looking for a `.git` entry is a
           * different, stricter predicate: a project root nested inside a
           * repository — `packages/ui` in this repo — has none and is still a
           * checkout, and answering "not a repository" there would open the
           * card's terminal on the user's current branch with no worktree.
           */
          isRepo: isGitCheckout,
          exists: dir => existsSync(dir),
          projectRoot: async id => {
            const res = await httpGet(port, `/items/${encodeURIComponent(id)}`);
            if (!res || res.status >= 300) return null;
            const projectId = JSON.parse(res.body || '{}')?.projectId;
            if (!projectId) return null;
            const proj = await httpGet(port, `/projects/${encodeURIComponent(String(projectId))}`);
            if (!proj || proj.status >= 300) return null;
            const root = JSON.parse(proj.body || '{}')?.projectRoot;
            return typeof root === 'string' && root ? root : null;
          },
        }),
      }, {
        /*
         * The native picker, and the only way a sound file's path enters this
         * app. The renderer names no file — it asks for this dialog, and the
         * OS answers with what the user actually clicked.
         *
         * Modal to the window when there is one: a file dialog that can end up
         * behind the app looks like a frozen click.
         */
        chooseSoundFile: async () => {
          const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
          const result = owner
            ? await dialog.showOpenDialog(owner, SOUND_DIALOG)
            : await dialog.showOpenDialog(SOUND_DIALOG);
          return result.canceled ? null : result.filePaths;
        },
        /*
         * The OS banner. `Notification.isSupported()` is asked rather than
         * assumed: a Linux desktop with no notification daemon answers false,
         * and constructing one there throws — inside a path reached from a pty
         * callback, which would cost the user the agent-state display over a
         * banner.
         */
        notify: notice => showAttentionNotice(notice, {
          // The WINDOW, not the document. A window behind another application
          // can still contain a document that reports focus, and that is
          // precisely the case this setting exists for.
          isFocused: () => Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()),
          supported: () => Notification.isSupported(),
          show: options => { new Notification(options).show(); },
        }),
      },
      /*
       * One question to one agent, and back with what it printed.
       *
       * The three pieces it needs are resolved HERE, in the main process: the
       * project's checkout, the contract (which lives in core and is served by
       * the API), and the agent's own binary. The renderer sends ids and a
       * sentence.
       */
      req => proposeDecomposition(req, {
        resolveProjectCwd: async projectId => {
          // `.body`, not the response. httpGet resolves to
          // { status, contentType, body }, so String()-ing it produced the
          // literal "[object Object]" and JSON.parse said so on screen.
          const res = await httpGet(port, `/projects/${encodeURIComponent(projectId)}`);
          if (!res || res.status >= 300) {
            throw new Error(`The server did not return this project (${res?.status ?? 'no answer'}).`);
          }
          const root = JSON.parse(res.body || '{}')?.projectRoot;
          if (typeof root !== 'string' || !root) {
            throw new Error('This project has no projectRoot, so there is nowhere to run an agent.');
          }
          return { cwd: root };
        },
        fetchContract: async objective => {
          const res = await httpGet(port, `/decompositions/contract?objective=${encodeURIComponent(objective)}`);
          if (!res || res.status >= 300 || !res.body.trim()) {
            throw new Error(`The server did not return a contract (${res?.status ?? 'no answer'}).`);
          }
          return res.body;
        },
        printCommand: printCommandFor,
        run: (file, args, opts) => new Promise((resolve, reject) => {
          // execFile, never a shell: the objective is a sentence a person
          // typed, and it reaches argv as one argument rather than as
          // something a shell gets to interpret.
          const child = execFile(file, [...args], {
            cwd: opts.cwd,
            timeout: opts.timeoutMs,
            maxBuffer: 16 * 1024 * 1024,
            env: process.env,
          }, (err: Error | null, stdout: string, stderr: string) => {
            // A non-zero exit still carries output worth reading: the answer
            // may be on stdout and the reason on stderr.
            if (err && !String(stdout ?? '').trim()) {
              reject(new Error(String(stderr ?? '').trim() || err.message));
              return;
            }
            resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
          });

          /*
           * EOF ON STDIN, IMMEDIATELY. execFile opens a pipe and leaves it
           * open, so a CLI that reads stdin before answering waits on input
           * that is never coming — the run looks identical to a slow model
           * until the timeout fires minutes later. A one-shot question has
           * nothing to type; saying so is what lets the agent get on with it.
           */
          child.stdin?.end();

          /*
           * What it is saying WHILE it says it. The screen used to show a
           * spinner and the word "working", which cannot distinguish thinking
           * from stuck from a login prompt nobody can see.
           */
          const forward = (stream: 'stdout' | 'stderr') => (chunk: unknown) => {
            for (const line of String(chunk).split(/[\r\n]+/)) {
              if (!line.trim()) continue;
              /*
               * To the window that asked. There is exactly one for this
               * question — the panel that started it — and if it has gone,
               * nobody is waiting for these lines.
               */
              const target = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.id : null;
              if (target !== null) {
                emitToWindow(target, 'agents:proposeOutput', { stream, line: line.trim() });
              }
            }
          };
          child.stdout?.on('data', forward('stdout'));
          child.stderr?.on('data', forward('stderr'));
        }),
      }),
      // The folder picker, and the two calls only this process may make.
      () => addProjectFromDirectory(folderDeps),
      /*
       * The same three capabilities as the TWO-STEP door: the screen shows
       * the folder and offers the name between choosing and creating, so
       * those cannot be one call. Same deps, because it is the same door.
       */
      folderDoor(folderDeps),
      /*
       * Cloning. The destination lives in prefs so it survives a restart, and
       * the picker is the only thing that writes it — a directory this app
       * invented to write into is a directory you stop letting it write to.
       */
      {
        /*
         * A DEFAULT THAT IS PROPOSED, NOT IMPOSED. Empty prefs answer with
         * ~/agenfk rather than with nothing: the screen shows it, the picker
         * changes it, and the choice is remembered. Visible, because this is
         * where a person's checkouts live — ~/.agenfk-worktrees and
         * ~/.agenfk-system are hidden precisely because they are ours.
         */
        where: () => cloneDirOrDefault(readPrefs(app.getPath('userData')), os.homedir()),
        choose: async () => {
          const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
          const options: Electron.OpenDialogOptions = {
            title: 'Choose where clones land',
            properties: ['openDirectory', 'createDirectory'],
          };
          const result = owner
            ? await dialog.showOpenDialog(owner, options)
            : await dialog.showOpenDialog(options);
          if (result.canceled || !result.filePaths[0]) return null;
          writePref(app.getPath('userData'), 'cloneDir', result.filePaths[0]);
          return result.filePaths[0];
        },
        clone: async (url, name) => {
          const into = cloneDirOrDefault(readPrefs(app.getPath('userData')), os.homedir());
          return cloneRepository({ url, into, name }, {
            exists: target => existsSync(target),
            clone: (repo, target, onLine) => gitClone(repo, target, into, onLine),
            addProject: addProjectAt,
          }, line => console.log(`[CLONE] ${line}`));
        },
      }, {
        /*
         * GitHub, through `gh` — the one credential this machine already has.
         * A second OAuth token would give it two identities that can disagree,
         * and `agenfk github setup` and this dialog would then tell the user
         * opposite things about the same account (githubAccount.ts).
         */
        owners: () => listOwners(runGh),
        create: req => createRepository(req, {
          gh: runGh,
          into: cloneDirOrDefault(readPrefs(app.getPath('userData')), os.homedir()),
          exists: target => existsSync(target),
          clone: (repo, target, onLine) => gitClone(repo, target,
            cloneDirOrDefault(readPrefs(app.getPath('userData')), os.homedir()), onLine),
          addProject: addProjectAt,
        }, line => console.log(`[CREATE] ${line}`)),
      });
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

  /*
   * The Dock icon in DEVELOPMENT. Packaged, electron-builder stamps the app
   * bundle and this does nothing; run straight from `electron dist/main`, the
   * Dock shows the Electron binary's own atom, so the brand mark is invisible
   * exactly where it is being worked on. Best effort: a missing file here must
   * not stop the app from starting.
   */
  /*
   * The name macOS shows in the menu bar and the about panel. Packaged, it
   * comes from electron-builder's productName; run from `electron dist/main`
   * it falls back to the binary's own name, so the menu bar reads "Electron"
   * while every other surface says AgEnFK. Set before `whenReady` because the
   * default menu is built from it.
   */
  app.setName('AgEnFK');

  void app.whenReady().then(() => {
    if (process.platform !== 'darwin' || app.isPackaged) return;
    try {
      app.dock?.setIcon(path.join(__dirname, '../../build/icon.png'));
    } catch { /* an icon is not worth a failed launch */ }
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
