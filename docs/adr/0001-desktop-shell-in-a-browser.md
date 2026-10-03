# ADR 0001 — Verify the desktop shell in a browser

- **Status:** Accepted
- **Date:** 2026-09-30
- **Card:** 66a4d9e8 (CGLAB-164)

## Context

The desktop-only UI — the sidebar, the Settings screen, the project page, the
terminal region — renders only when `isDesktop()` sees
`window.agenfkDesktop.isDesktop === true`. The Electron preload injects that
object through `contextBridge` (`packages/desktop/src/preload/index.ts`); the
UI checks it by shape in `packages/ui/src/desktop.ts`.

Everything else about that UI is an ordinary web page. The API server serves
the built bundle on its own origin (`AGENFK_SERVE_UI`, CGLAB-165), and the
packaged app adopts a server already listening on ports 3000–3015 and loads
the UI from it (it starts its own only when it finds none).

So the long way to check a UI change is: build, package
(`npm run pack -w packages/desktop`), quit the app — which kills the terminals
it holds — and reopen it. The short way has a trap of its own: a desktop window
left open keeps the bundle it loaded in memory while its API calls reach
whatever server is running now. On 2026-09-30 that is exactly how the project
Settings switch still looked broken after it had been fixed: the window was
five days old.

## Decision

Verify desktop-only UI in a browser, with the preload's identity injected
before the bundle runs, against **a sandboxed second server** — its own
`HOME`, its own database, its own port. Use the installation's real server
only when the data you need is there, and with the precautions below. Package
the app only for changes to the main process or the preload, or when someone
wants to use the app itself.

## How to run it

1. **Build.** The UI alone when only the UI changed; the whole monorepo on a
   fresh clone or when the change touches the server or core, because the
   sandbox runs this checkout's `packages/server/dist`.

   ```sh
   npm run build -w packages/ui   # or: npm run build
   ```

2. **Start a sandboxed server** from the repository root. Each variable closes
   a hazard: `HOME` keeps it from rewriting `~/.agenfk/server-port` (and from
   deleting it on exit, which would leave the CLI and the hooks with no port
   file) and from joining the hub; `AGENFK_DB_PATH` keeps every write off the
   installation's database; `AGENFK_SERVE_UI` names the bundle you just built,
   whichever checkout the `agenfk` binary happens to point at.

   ```sh
   SANDBOX=$(mktemp -d)
   # Telemetry off: otherwise every sandbox reports itself as a new installation.
   mkdir -p "$SANDBOX/.agenfk" && echo '{"telemetry":false}' > "$SANDBOX/.agenfk/config.json"
   HOME=$SANDBOX AGENFK_DB_PATH=$SANDBOX/scratch.sqlite AGENFK_PORT=3190 \
     AGENFK_SERVE_UI=$PWD/packages/ui/dist node packages/server/dist/server.js
   # afterwards, Ctrl+C and: rm -rf "$SANDBOX"
   ```

   It logs `Using Database: …/scratch.sqlite` and
   `API Server running on 127.0.0.1:3190` — or a higher port if 3190 is taken,
   so open the one the log names. A `verify-token not found … ephemeral token`
   warning is expected: the sandbox HOME has none. It starts empty: create
   what the screen needs (a project, a card) through its own UI or API.

3. **Open `http://127.0.0.1:3190`** — the address, not `localhost`: the server
   binds 127.0.0.1 only, and on a machine where another dev server holds the
   same port on IPv6, `localhost` resolves to that one instead. Use an
   isolated browser context, and inject this script before any page script
   runs:

   <!-- init-script -->
   ```js
   window.agenfkDesktop = { isDesktop: true, platform: 'darwin', versions: { electron: '0', chrome: '0', node: '0' } };
   ```

   - **chrome-devtools MCP:** `new_page` on `about:blank` with an
     `isolatedContext`, then `navigate_page` to the server with the script as
     `initScript`. It applies to that navigation only: to reload, navigate
     again with the script rather than reloading.
   - **Playwright:** `page.addInitScript(...)` with the script before
     `page.goto(...)`; it persists across reloads.
   - Setting it from the DevTools console does not work: the shell has already
     been laid out as a browser page by then, and a reload drops the global.

   The footer then reads `Electron 0` — the stub's version, which is how to
   tell a simulated shell from the real one at a glance. `platform: 'darwin'`
   lays the shell out for macOS (traffic-light padding, drag regions); set it
   to `'win32'` or `'linux'` to check the other layouts.

4. **Assert on state, not on pixels.** The shared switch is shadcn's (Radix),
   so it carries `role="switch"`, `aria-checked` and `data-state`, and its
   thumb's computed `translate` says whether it actually moved. A switch can
   also be legitimately disabled — `Sound` is while "Notify when an agent
   needs you" is off — so read `disabled` before blaming the switch:

   ```js
   async () => {
     const sw = () => document.querySelector('button[role=switch][aria-label="Notify when an agent needs you"]');
     const read = () => ({ checked: sw().getAttribute('aria-checked'), disabled: sw().disabled, thumb: getComputedStyle(sw().firstElementChild).translate });
     const wait = ms => new Promise(r => setTimeout(r, ms));
     const before = read(); sw().click(); await wait(1500);
     const flipped = read(); sw().click(); await wait(1500);
     const back = read();
     return { before, flipped, back, moved: flipped.checked !== before.checked, restored: back.checked === before.checked };
   }
   ```

### Against the installation's real server

When the screen needs real data, point the browser at the running server
instead (`agenfk restart -q` after the build — the server reads `index.html`
once and keeps it in memory, so without a restart the page points at assets
the build deleted and renders black, 2c8e4b64). Then:

- **Every press is a real write.** Read the state first and put it back, as the
  snippet does.
- **Do not close restored terminal tabs.** The stub turns on terminal restore
  (`AppShell` gates it on `desktopInfo()`), so the shell puts back every tab
  the desktop app remembers. Closing one deletes that row from the database,
  and the desktop app loses the terminal on its next launch. Leave them open
  and close the browser page instead.
- **Check which bundle it serves.** `agenfk restart` serves the checkout the
  `agenfk` binary resolves to; `.agenfk/api.log` says which, in
  `[UI] Serving UI bundle from …`.
- `agenfk restart` also stops whatever holds :3000 — including a server the
  desktop app started for itself.

## What it does not cover

The stub carries identity only. Every bridge below is absent in the browser,
so the features behind it fail or stay inert there; check them in the
Electron app:

- `terminal` — spawning and driving agent terminals (pty), listing agents, the
  decomposition proposer, the project-folder picker, cloning and creating a
  repository.
- `prefs` — auto-approve, which lives in the desktop's own preferences rather
  than in `/settings`.
- `editors` — opening a card's worktree in an editor.
- `sounds` — the custom notification sound.
- `notifications` — operating-system notifications.
- `fullScreen` — whether the window is full screen. Absent, the shell reads
  the window as windowed, so on a `darwin` stub the macOS title bar always
  draws; full screen dropping it is checked in the Electron app.

Nor does it cover the main process (server adoption, window chrome, menus),
packaging or code signing. A sandboxed server has no hub, so screens that
depend on one show it disconnected.

`packages/ui/src/test/desktopInBrowserAdr.test.ts` keeps this document honest:
it runs the init script above and requires the shell to switch on with the
stub's own identity, and it fails when the preload grows a bridge this list
does not name.

## Consequences

- Most verification needs no packaged app and touches no real data: the
  sandbox is disposable, and the installation's server and port file are left
  alone.
- **Isolated context, always.** Otherwise the test page shares localStorage
  with the person's own session on the same origin.
- **An open desktop window still needs a reload.** Verifying in the browser
  proves the bundle on the server; the app window shows it only after it
  reloads or reopens.
