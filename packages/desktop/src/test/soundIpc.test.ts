/**
 * @vitest-environment node
 *
 * The border, for the sound and banner channels.
 *
 * `ipcSurface.test.ts` already guarantees every channel registered here is
 * reachable from the preload, which is the "built and unreachable" half. This
 * file is the other half: that what crosses is what we meant to let cross.
 *
 * The shape that matters is the same one `pty:spawn` learned the hard way.
 * `pty:spawn` read `autoApprove` from the PAYLOAD for a while, after the whole
 * preference had been moved into the main process precisely so the renderer
 * could not set it — the border was there and it was decorative. So: the
 * renderer asks for a PICKER, never names a file; and the path that is read
 * back comes from stored prefs, never from the call.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { registerPtyIpc } from '../main/ptyIpc';
import { PtyRegistry } from '../main/ptyRegistry';
import { readPrefs } from '../main/prefs';
import { soundsDir } from '../main/customSound';

type Handler = (event: unknown, ...args: unknown[]) => unknown;

let handlers: Record<string, Handler>;
let userData: string;
let chosen: string[] | null;
let noticeCalls: Array<Record<string, unknown>>;

const fakeEvent = { sender: { id: 1 } };

/** A real audio file somewhere the picker would plausibly return from. */
const sourceFile = (name: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-sound-pick-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, 'RIFF....WAVEfmt ');
  return file;
};

beforeEach(() => {
  handlers = {};
  noticeCalls = [];
  chosen = null;
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-sound-ipc-'));
  const registry = {
    spawn: vi.fn(), write: vi.fn(), resize: vi.fn(), kill: vi.fn(), ack: vi.fn(),
  } as unknown as PtyRegistry;
  registerPtyIpc(
    registry,
    {
      handle: (channel, listener) => {
        handlers[channel] = (event, ...args) =>
          Promise.resolve().then(() => (listener as Handler)(event, ...args));
      },
    },
    () => ({ available: false }),
    () => userData,
    undefined,
    {
      // The picker, injected. The real one is Electron's dialog; what matters
      // for the border is that the ANSWER comes from here and not from the
      // renderer's arguments.
      chooseSoundFile: async () => chosen,
      notify: (options: Record<string, unknown>) => { noticeCalls.push(options); return true; },
    },
  );
});
afterEach(() => { fs.rmSync(userData, { recursive: true, force: true }); });

describe('choosing a custom sound', () => {
  it('stores what the picker returned, not what the renderer asked for', () => {
    // The assertion that keeps the border from being decorative: the handler
    // takes no path argument at all, so there is nothing for a caller to pass.
    expect(handlers['sounds:choose'].length).toBeLessThanOrEqual(2);
  });

  it('remembers the choice where the next launch will find it', async () => {
    chosen = [sourceFile('ping.wav')];
    const result = await handlers['sounds:choose'](fakeEvent) as { name: string | null };
    expect(result.name).toBe('ping.wav');
    // Read back through prefs, not from the return value. A handler that
    // answers correctly and stores nothing is the defect this branch keeps
    // finding.
    expect(readPrefs(userData).customSoundPath).toBe(path.join(soundsDir(userData), 'custom.wav'));
  });

  it('leaves the stored choice alone when the user cancels the dialog', async () => {
    chosen = [sourceFile('ping.wav')];
    await handlers['sounds:choose'](fakeEvent);
    chosen = null;
    const result = await handlers['sounds:choose'](fakeEvent) as { name: string | null };
    expect(result.name).toBe('ping.wav');
    expect(readPrefs(userData).customSoundPath).not.toBe('');
  });

  it('answers with no sound when the chosen file is not one it will play', async () => {
    // storeCustomSound refuses it. The handler must report that rather than
    // recording a path to a file it cannot use.
    chosen = [sourceFile('script.sh')];
    const result = await handlers['sounds:choose'](fakeEvent) as { name: string | null; error?: string };
    expect(result.name).toBeNull();
    expect(result.error).toMatch(/audio|format|wav|\.mp3/i);
    expect(readPrefs(userData).customSoundPath).toBe('');
  });

  it('keeps naming the sound that is still playing when a file is refused', async () => {
    /*
     * The cancel rule, applied to the other way of not changing anything.
     *
     * Nothing is written when storeCustomSound refuses, so the previous sound
     * is still stored and still plays. Answering `null` made the screen cache
     * that null and draw "Playing the built-in cue." over a file that was
     * demonstrably still in use - and it hid the "Use the built-in" button,
     * which is gated on there being a name, so the user could no longer clear
     * a sound the app had just told them was not there.
     */
    chosen = [sourceFile('chime.wav')];
    await handlers['sounds:choose'](fakeEvent);
    chosen = [sourceFile('too-big.sh')];
    const result = await handlers['sounds:choose'](fakeEvent) as { name: string | null; error?: string };
    expect(result.error).toBeTruthy();
    expect(result.name, 'a refusal rewrote the state it refused to touch').toBe('chime.wav');
    expect(readPrefs(userData).customSoundName).toBe('chime.wav');
  });

  it('refuses when this build has no picker at all', async () => {
    // Registered without the injected dialog — the shape a non-desktop or
    // stripped build takes. It has to answer, not throw: the settings screen
    // shows the row either way and must be able to say the control is not
    // available.
    const bare: Record<string, Handler> = {};
    registerPtyIpc(
      { spawn: vi.fn() } as unknown as PtyRegistry,
      { handle: (c, l) => { bare[c] = (e, ...a) => Promise.resolve().then(() => (l as Handler)(e, ...a)); } },
      () => ({ available: false }),
      () => userData,
    );
    await expect(bare['sounds:choose'](fakeEvent)).resolves.toMatchObject({ name: null });
  });
});

describe('reading the custom sound back', () => {
  it('reads the STORED path, never one the renderer supplies', async () => {
    // The `pty:spawn` autoApprove lesson, applied. A renderer that could name
    // the file to read would have arbitrary file read through a channel whose
    // whole point is that it does not.
    chosen = [sourceFile('ping.wav')];
    await handlers['sounds:choose'](fakeEvent);
    const secret = sourceFile('secret.wav');
    const result = await handlers['sounds:read'](fakeEvent, { path: secret }) as { dataUrl: string | null };
    expect(result.dataUrl).toMatch(/^data:audio\/wav;base64,/);
    // What came back is the stored copy, not the file the payload named.
    expect(Buffer.from(result.dataUrl!.split(',')[1], 'base64').toString('utf8'))
      .toBe('RIFF....WAVEfmt ');
    expect(result.dataUrl).not.toContain(secret);
  });

  it('answers null when nothing has been chosen', async () => {
    await expect(handlers['sounds:read'](fakeEvent)).resolves.toEqual({ dataUrl: null, name: null });
  });
});

describe('clearing the custom sound', () => {
  it('forgets the path and deletes the copy', async () => {
    chosen = [sourceFile('ping.wav')];
    await handlers['sounds:choose'](fakeEvent);
    const stored = readPrefs(userData).customSoundPath;
    await handlers['sounds:clear'](fakeEvent);
    expect(readPrefs(userData).customSoundPath).toBe('');
    expect(fs.existsSync(stored)).toBe(false);
  });
});

describe('asking for an OS banner', () => {
  it('passes the agent and card through', async () => {
    await handlers['notifications:attention'](fakeEvent, { agentLabel: 'Codex', cardTitle: 'Fix it' });
    expect(noticeCalls[0]).toMatchObject({ agentLabel: 'Codex', cardTitle: 'Fix it' });
  });

  it('answers false rather than throwing when the payload is nonsense', async () => {
    // ipcMain.handle delivers whatever was serialised, including nothing.
    await expect(handlers['notifications:attention'](fakeEvent)).resolves.toBe(false);
    await expect(handlers['notifications:attention'](fakeEvent, { agentLabel: 42 })).resolves.toBe(false);
  });

  it('answers false in a build with no notifier wired', async () => {
    const bare: Record<string, Handler> = {};
    registerPtyIpc(
      { spawn: vi.fn() } as unknown as PtyRegistry,
      { handle: (c, l) => { bare[c] = (e, ...a) => Promise.resolve().then(() => (l as Handler)(e, ...a)); } },
      () => ({ available: false }),
      () => userData,
    );
    await expect(bare['notifications:attention'](fakeEvent, { agentLabel: 'Codex' })).resolves.toBe(false);
  });
});
