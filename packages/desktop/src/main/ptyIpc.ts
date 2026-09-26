/**
 * The IPC surface for terminals (CGLAB-169).
 *
 * This is the border. Everything on the renderer side of it is untrusted —
 * the renderer runs the same bundle a browser would, so an XSS in it speaks
 * through these channels with the user's credentials.
 *
 * Three rules shape every handler here:
 *
 *  - The renderer names an ITEM and an AGENT, never a path and never a command.
 *    The worktree comes from the server, the executable from the closed set in
 *    agents.ts.
 *  - Every call is attributed to the window that made it, taken from the
 *    event's own sender — never from the payload, which the renderer controls.
 *    Ownership is worthless if the caller can claim to be another window.
 *  - Arguments are validated before use. `ipcMain.handle` hands over whatever
 *    was serialised, including objects, `undefined`, and numbers where strings
 *    were expected.
 *
 * Registration is a separate function from the registry itself so the rules
 * above are unit-testable without Electron.
 */
/*
 * TYPE-ONLY, deliberately. This module's own docblock below says the IpcLike
 * shape exists "so tests need no Electron" - and a VALUE import of `ipcMain`
 * silently undid that: importing it loads node_modules/electron/index.js,
 * which reads the downloaded binary's path and throws when there is none.
 *
 * Locally the binary is there because the app runs, so ptyIpc.test.ts passed
 * on every machine and failed in CI, where the download is skipped. The seam
 * was already designed; it was defeated by one line. The caller passes the real
 * ipcMain now.
 */
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { PtyRegistry } from './ptyRegistry.js';
import { readPrefs, writePref, PREF_KEYS, DEFAULT_PREFS } from './prefs';
import {
  SOUND_EXTENSIONS, storeCustomSound, readCustomSound, clearCustomSound,
} from './customSound';
import { detectEditors, editorUrlFor } from './editors';
import { detectAgents, __resetAgentDetectionCache } from './detectAgents.js';
import { HIGH_WATERMARK } from './flowControl.js';

/** Minimal shape of `ipcMain` so tests need no Electron. */
export interface IpcLike {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void;
}

const asString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value;
};

const asSize = (value: unknown, field: string): number => {
  // Bounded, not merely numeric: node-pty passes these to ioctl, and a
  // negative or absurd value is at best a broken terminal.
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 5000) {
    throw new Error(`${field} must be an integer between 1 and 5000.`);
  }
  return value;
};

/**
 * The window that actually sent the message.
 *
 * Deliberately derived from the event rather than accepted as a parameter: a
 * renderer that could state its own window id could address another window's
 * sessions, which is the entire thing ownership exists to stop.
 */
export const senderWindowId = (event: { sender: Pick<WebContents, 'id'> }): number => event.sender.id;

export function registerPtyIpc(
  registry: PtyRegistry,
  /*
   * REQUIRED, not defaulted to ipcMain. A default would have to import it as a
   * value, which is exactly what made this module untestable without an
   * Electron binary installed.
   */
  ipc: IpcLike,
  tmuxStatus: () => unknown = () => ({ available: false }),
  /**
   * Where desktop-owned preferences live.
   *
   * Passed in rather than reached for, so the tests do not need an Electron
   * app object and so the storage location is one decision made in one place.
   */
  prefsDir: () => string = () => '.',
  /**
   * Everything the editor handlers need, injected.
   *
   * Absent in a build that cannot open one — the handlers then answer "no
   * editors" and refuse to open, which is a real answer rather than a crash.
   */
  editors?: {
    which: (command: string) => Promise<boolean>;
    openExternal: (url: string) => Promise<void>;
    resolveCwd: (itemId: string) => Promise<{ cwd: string }>;
  },
  /**
   * The two things only a main process can do: open a file picker and raise an
   * OS banner.
   *
   * Injected, and optional. A build without them answers "not available"
   * instead of throwing — the settings screen renders the rows either way and
   * must be able to say the control cannot be used here, which it can only do
   * if the call returns.
   */
  alerts?: {
    /** Opens the native picker. Returns the chosen paths, or null on cancel. */
    chooseSoundFile: () => Promise<string[] | null>;
    notify: (notice: { agentLabel: string; cardTitle?: string }) => boolean;
  },
): void {
  ipc.handle('pty:spawn', async (event, raw) => {
    const req = (raw ?? {}) as Record<string, unknown>;
    return registry.spawn({
      itemId: asString(req.itemId, 'itemId'),
      agentId: asString(req.agentId, 'agentId'),
      windowId: senderWindowId(event),
      cols: asSize(req.cols, 'cols'),
      rows: asSize(req.rows, 'rows'),
      /*
       * Read from the STORED preference, never from the payload.
       *
       * This value appends --dangerously-skip-permissions (and for codex
       * sandbox_mode=danger-full-access), so it decides what the next process
       * is allowed to do. The preference was moved into the main process
       * precisely so that nothing on the other side of this border could set
       * it — and then the handler went on taking it from the renderer anyway,
       * which made the border decorative. Whatever `req.autoApprove` says is
       * ignored, in both directions: a renderer that could turn it OFF could
       * also hide that it is on.
       */
      autoApprove: readPrefs(prefsDir()).autoApprove === true,
      // Optional, and only meaningful when resuming. The registry mints one for
      // a fresh spawn; it is validated as a UUID before it reaches argv.
      agentSessionId: req.agentSessionId === undefined ? undefined : asString(req.agentSessionId, 'agentSessionId'),
      resume: req.resume === true,
      // Strict, like autoApprove above. Anything truthy-but-not-true arriving
      // from the renderer must not silently opt a session into tmux.
      persist: req.persist === true,
    });
  });

  ipc.handle('pty:write', (event, raw) => {
    const req = (raw ?? {}) as Record<string, unknown>;
    registry.write(asString(req.sessionId, 'sessionId'), senderWindowId(event), asString(req.data, 'data'));
    return true;
  });

  ipc.handle('pty:resize', (event, raw) => {
    const req = (raw ?? {}) as Record<string, unknown>;
    registry.resize(
      asString(req.sessionId, 'sessionId'),
      senderWindowId(event),
      asSize(req.cols, 'cols'),
      asSize(req.rows, 'rows'),
    );
    return true;
  });

  /*
   * The renderer reporting what it has drawn, which is the return path of the
   * flow control in flowControl.ts.
   *
   * `bytes` is renderer input like any other, so it is bounded rather than
   * trusted: a huge or negative number would drive the in-flight count to zero
   * or below and switch backpressure off — silently, which is the failure mode
   * this whole card exists to remove.
   */
  ipc.handle('pty:ack', (event, raw) => {
    const req = (raw ?? {}) as Record<string, unknown>;
    // Clamped at BOTH ends. Negative was handled and huge was not, while the
    // comment above claimed otherwise: a single `{bytes: 1e15}` zeroes the
    // in-flight count on every call and switches backpressure off for the life
    // of the session — silently, which is the documented failure this guard
    // exists to prevent. The ceiling is the largest ack that can ever be
    // legitimate, since main stops reading past the high mark.
    const bytes = typeof req.bytes === 'number' && Number.isFinite(req.bytes)
      ? Math.min(HIGH_WATERMARK * 2, Math.max(0, Math.floor(req.bytes)))
      : 0;
    registry.ack(asString(req.sessionId, 'sessionId'), senderWindowId(event), bytes);
    return true;
  });

  ipc.handle('pty:kill', (event, raw) => {
    const req = (raw ?? {}) as Record<string, unknown>;
    registry.kill(asString(req.sessionId, 'sessionId'), senderWindowId(event));
    return true;
  });

  // Read-only: the list of agents and whether each is installed. Nothing here
  // takes renderer input, because the set of things to probe is closed.
  ipc.handle('agents:list', async () => detectAgents());

  // Whether sessions survive quitting, and why not when they do not. Surfaced
  // rather than silently assumed: a persistence feature that quietly does
  // nothing is the defect review caught in the auto-approve chain.
  ipc.handle('sessions:persistence', async () => tmuxStatus());

  /*
   * Preferences the desktop owns. Deliberately NOT on the server's /settings:
   * that route is unauthenticated, and `autoApprove` changes the argv of every
   * agent spawned afterwards. See main/prefs.ts.
   */
  ipc.handle('prefs:get', async () => readPrefs(prefsDir()));

  /*
   * Editors. The renderer names a CARD and an editor ID — never a path and
   * never a URL — so the set of programs the OS can be asked to launch stays
   * fixed at compile time and the directory comes from the server's record of
   * which worktree the card owns.
   */
  ipc.handle('editors:list', async () => (editors ? detectEditors(editors) : []));

  ipc.handle('editors:open', async (_event, raw) => {
    if (!editors) throw new Error('Opening an editor is not available in this build.');
    const req = (raw ?? {}) as Record<string, unknown>;
    const itemId = asString(req.itemId, 'itemId');
    const editorId = asString(req.editorId, 'editorId');
    // The DIRECTORY comes from the server's record of which worktree this card
    // owns — never from the renderer, which names only a card and an editor.
    const { cwd } = await editors.resolveCwd(itemId);
    // Throws for an unknown editor or a path that is not absolute, before
    // anything reaches the OS.
    await editors.openExternal(editorUrlFor(editorId as never, cwd));
    return { opened: true, path: cwd };
  });

  ipc.handle('prefs:set', async (_event, raw) => {
    const req = (raw ?? {}) as Record<string, unknown>;
    const key = asString(req.key, 'key');
    if (!(PREF_KEYS as readonly string[]).includes(key)) {
      throw new Error(`Unknown preference "${key}". Expected one of: ${PREF_KEYS.join(', ')}`);
    }
    /*
     * BOOLEAN preferences only, and this channel is the reason the restriction
     * has to be written down. `customSoundPath` is in PREF_KEYS, so it passes
     * the allowlist above — and the line below coerces every value to a
     * boolean, which writePref then rejects with a message about types rather
     * than about permission. Refusing here says what is actually true: that
     * preference is set by the file picker, in this process, and there is no
     * route to it from the renderer at all.
     */
    if (typeof DEFAULT_PREFS[key as keyof typeof DEFAULT_PREFS] !== 'boolean') {
      throw new Error(`Preference "${key}" cannot be set from the renderer.`);
    }
    // Strict === true, like pty:spawn's autoApprove and for the same reason:
    // this is the switch that takes an agent's safety prompts away, so a
    // truthy string must not be enough to flip it.
    return writePref(prefsDir(), key as 'autoApprove', req.value === true);
  });

  /*
   * The notification sound.
   *
   * `sounds:choose` takes NO arguments, and that is the design rather than an
   * omission: there is nothing for a caller to pass, so no renderer can name a
   * file. The path comes from the OS picker; the copy and the extension
   * allowlist are in customSound.ts.
   *
   * `sounds:read` takes no arguments either, for the reason `pty:spawn`
   * learned the hard way. That handler read `autoApprove` from the payload for
   * a while, after the whole preference had been moved into this process
   * precisely so the renderer could not set it — the border was there and it
   * was decorative. A renderer that could name the file to read here would
   * have arbitrary file read through a channel whose entire point is that it
   * does not.
   */
  /**
   * Which file is in use, named the way the user named it.
   *
   * The copy on disk is `custom.wav` whatever it was called, so the friendly
   * name is read from prefs — but only after the copy is confirmed present.
   * Answering with a name for a file that is no longer there would have the
   * screen state a sound it cannot play.
   */
  const currentSoundName = (): string | null => {
    const prefs = readPrefs(prefsDir());
    if (!prefs.customSoundPath) return null;
    const sound = readCustomSound({ userData: prefsDir(), storedPath: prefs.customSoundPath });
    if (!sound) return null;
    return prefs.customSoundName || sound.name;
  };

  ipc.handle('sounds:current', async () => ({ name: currentSoundName() }));

  ipc.handle('sounds:choose', async () => {
    if (!alerts) return { name: null, error: 'Choosing a file is not available in this build.' };
    const picked = await alerts.chooseSoundFile();
    // Cancel is not a change. Clearing the stored choice here would make
    // "think better of it" indistinguishable from "remove my sound".
    if (!picked || picked.length === 0) return { name: currentSoundName() };

    const stored = storeCustomSound({ userData: prefsDir(), sourcePath: picked[0] });
    if (!stored) {
      /*
       * Nothing was written, so answer with what is STILL in use — the same
       * rule the cancel branch above follows, for the same reason.
       *
       * Returning `name: null` here was a real bug: nothing had changed on
       * disk, the previous sound still played, and the screen wrote that null
       * into its cache and drew "Playing the built-in cue." It also hid the
       * "Use the built-in" button, which is gated on there being a name — so
       * the user could no longer clear a sound that was demonstrably still
       * playing. A refusal must not rewrite the state it refused to touch.
       */
      return {
        name: currentSoundName(),
        error: `Choose a ${SOUND_EXTENSIONS.join(', ')} file under 5 MB.`,
      };
    }
    writePref(prefsDir(), 'customSoundPath', stored.path);
    writePref(prefsDir(), 'customSoundName', stored.name);
    return { name: stored.name };
  });

  ipc.handle('sounds:read', async () => {
    const stored = readPrefs(prefsDir()).customSoundPath;
    if (!stored) return { dataUrl: null, name: null };
    const sound = readCustomSound({ userData: prefsDir(), storedPath: stored });
    // Null rather than an error: the caller falls back to the built-in tone,
    // which it can only do if this answers.
    return sound ? { dataUrl: sound.dataUrl, name: sound.name } : { dataUrl: null, name: null };
  });

  ipc.handle('sounds:clear', async () => {
    clearCustomSound({ userData: prefsDir() });
    writePref(prefsDir(), 'customSoundPath', '');
    writePref(prefsDir(), 'customSoundName', '');
    return { name: null };
  });

  /*
   * The OS banner.
   *
   * The renderer asks; this process decides. Whether the window is in front is
   * a fact only this side can see — `document.hasFocus()` answers a different
   * question — so the "only when unfocused" rule lives in attentionNotice.ts
   * rather than being trusted from the caller.
   */
  ipc.handle('notifications:attention', async (_event, raw) => {
    if (!alerts) return false;
    const req = (raw ?? {}) as Record<string, unknown>;
    // ipcMain.handle delivers whatever was serialised, including nothing.
    if (typeof req.agentLabel !== 'string' || req.agentLabel === '') return false;
    return alerts.notify({
      agentLabel: req.agentLabel,
      cardTitle: typeof req.cardTitle === 'string' ? req.cardTitle : undefined,
    });
  });

  // After the user installs a CLI, so the picker updates without an app
  // restart. Also takes no input.
  ipc.handle('agents:refresh', async () => {
    __resetAgentDetectionCache();
    return detectAgents();
  });
}
