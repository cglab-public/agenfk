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
the UI from it.

So the long way to check a UI change is: build, package
(`npm run pack -w packages/desktop`), quit the app — which kills the terminals
it holds — and reopen it. The short way has a trap of its own: a desktop window
left open keeps the bundle it loaded in memory while its API calls reach
whatever server is running now. On 2026-09-30 that is exactly how the project
Settings switch still looked broken after it had been fixed: the window was
five days old.

## Decision

Verify desktop-only UI in a browser, against the real server, with the
preload's identity injected before the bundle runs. Package the app only for
changes to the main process or the preload, or when someone wants to use the
app itself.

## How to run it

1. Build the UI and restart the server. The restart is not optional: the
   server reads `index.html` once and keeps it in memory, so without it the
   page points at hashed assets the build just deleted and renders black
   (2c8e4b64).

   ```sh
   npm run build -w packages/ui && agenfk restart
   ```

2. Open `http://localhost:3000` in an isolated browser context, with this
   script injected before any page script runs:

   <!-- init-script -->
   ```js
   window.agenfkDesktop = { isDesktop: true, platform: 'darwin', versions: { electron: '0', chrome: '0', node: '0' } };
   ```

   - **chrome-devtools MCP:** `new_page` with an `isolatedContext`, then
     `navigate_page` with the script as `initScript`.
   - **Playwright:** `page.addInitScript(...)` with the script, before
     `page.goto(...)`.
   - Setting it from the DevTools console does not work: the bundle has
     already decided it is not on the desktop by then, and a reload drops the
     global.

   The footer then reads `Electron 0` — the stub's version, which is how to
   tell a simulated shell from the real one at a glance.

3. Assert on state, not on pixels. The shared switch is shadcn's (Radix), so
   it carries `role="switch"`, `aria-checked` and `data-state`, and its thumb's
   computed `translate` says whether it actually moved. For example, to press
   a switch twice and leave it as it was:

   ```js
   async () => {
     const sw = () => document.querySelector('button[role=switch][aria-label="Sound"]');
     const read = () => ({ checked: sw().getAttribute('aria-checked'), thumb: getComputedStyle(sw().firstElementChild).translate });
     const wait = ms => new Promise(r => setTimeout(r, ms));
     const before = read(); sw().click(); await wait(1500);
     const flipped = read(); sw().click(); await wait(1500);
     return { before, flipped, back: read() };
   }
   ```

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

Nor does it cover the main process (server adoption, window chrome, menus),
packaging or code signing.

`packages/ui/src/test/desktopInBrowserAdr.test.ts` keeps this document honest:
it runs the init script above and requires `isDesktop()` to turn on, and it
fails when the preload grows a bridge this list does not name.

## Consequences

- **It writes to the real database.** The server on `:3000` uses the
  installation's database, so pressing a switch changes that setting for real.
  Read the state first and put it back afterwards, as the snippet above does.
  Starting a second server on a scratch database is not a shortcut: it
  rewrites `~/.agenfk/server-port`, and the CLI and the hooks follow it until
  the main server is restarted.
- **Isolated context, always.** Otherwise the test page shares localStorage
  with the person's own session on the same origin.
- **An open desktop window still needs a reload.** Verifying in the browser
  proves the bundle on the server; the app window shows it only after it
  reloads or reopens.
