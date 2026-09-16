/**
 * @vitest-environment node
 *
 * A sound file the user chose, on its way to and from the disk.
 *
 * This is the only place in the notifications feature where a PATH reaches the
 * filesystem, so it is the only place with a real security question, and the
 * answer has two halves that are easy to confuse:
 *
 * **The renderer never names a file.** It asks for a picker; the main process
 * opens it, and the OS hands back a path the user selected. So there is no
 * request in which a hostile renderer supplies a path at all — which is the
 * strongest guarantee available and the reason the chooser lives here rather
 * than behind an `<input type=file>`.
 *
 * **The stored path is still checked at the sink.** That sounds redundant given
 * the above, and it is not: the stored value comes back out of prefs.json on the
 * next launch, and prefs.json is an ordinary file on disk that anything running
 * as the user can edit. `containedPath` from @agenfk/core is used rather than a
 * boolean check, because a boolean leaves the caller holding the unchecked
 * variable and nothing stops the next `fs` call being added below the guard.
 *
 * The copy into the app's own directory is what makes the containment mean
 * something. Playing the file where the user chose it would put every path on
 * the machine in scope forever; copying once reduces the trusted region to one
 * directory this app made.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  SOUND_EXTENSIONS,
  soundsDir,
  storeCustomSound,
  readCustomSound,
  clearCustomSound,
} from '../main/customSound';

let userData: string;

/** A real file with real bytes; the copy path is what is under test. */
const sourceFile = (name: string, bytes = 'RIFF....WAVEfmt '): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-sound-src-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return file;
};

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-userdata-'));
});
afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

describe('choosing a sound', () => {
  it('copies it into the app directory rather than remembering where it was', () => {
    // A path in ~/Downloads is a path the user will move or delete, and a
    // notification sound that silently stops working is indistinguishable from
    // notifications being broken.
    const src = sourceFile('ping.wav');
    const stored = storeCustomSound({ userData, sourcePath: src });
    expect(stored).not.toBeNull();
    expect(path.dirname(stored!.path)).toBe(soundsDir(userData));
    expect(fs.readFileSync(stored!.path, 'utf8')).toBe(fs.readFileSync(src, 'utf8'));
  });

  it('keeps the name the user recognises, for the screen to show', () => {
    // The screen has to say WHICH file, and the stored filename is derived from
    // the extension rather than from the name, so the name has to travel
    // separately.
    const stored = storeCustomSound({ userData, sourcePath: sourceFile('Gentle Chime.wav') });
    expect(stored!.name).toBe('Gentle Chime.wav');
  });

  it('names the copy from the extension, never from the user filename', () => {
    /*
     * The destination is built from an allowlisted extension, so a filename
     * like `../../../.ssh/authorized_keys` has nothing to contribute to it.
     *
     * THE TRAVERSAL IS IN THE PATH HANDED IN, NOT IN WHERE THE FIXTURE WRITES.
     * It used to be `sourceFile('../../evil.wav')`, which made the helper write
     * two levels above the temp directory - on macOS that is deep inside
     * /var/folders and lands somewhere writable, on Linux os.tmpdir() is /tmp
     * and two levels up is `/`. So the fixture failed to create the file on CI
     * and the test failed for a reason that had nothing to do with the rule it
     * is about.
     *
     * The file is real now and the path given to the subject still contains
     * `..`, which is what the subject is actually being asked about.
     */
    const real = sourceFile('evil.wav');
    const traversing = path.join(path.dirname(real), 'nested', '..', 'evil.wav');
    const stored = storeCustomSound({ userData, sourcePath: traversing });
    expect(path.basename(stored!.path)).toBe('custom.wav');
    expect(path.dirname(stored!.path)).toBe(soundsDir(userData));
  });

  it('refuses a file that is not an audio format it will play', () => {
    // Not a security boundary on its own — the renderer cannot execute what it
    // is handed — but a `.command` or `.app` copied into the app's own
    // directory under a name the app then hands around is a bad shape to have.
    for (const bad of ['script.sh', 'payload.app', 'notes.txt', 'noextension']) {
      expect(storeCustomSound({ userData, sourcePath: sourceFile(bad) }), bad).toBeNull();
    }
  });

  it('accepts every extension it claims to', () => {
    // The allowlist and the behaviour read from the same list, so one cannot
    // grow without the other.
    for (const ext of SOUND_EXTENSIONS) {
      expect(storeCustomSound({ userData, sourcePath: sourceFile(`s${ext}`) }), ext).not.toBeNull();
    }
  });

  it('matches the extension regardless of case', () => {
    expect(storeCustomSound({ userData, sourcePath: sourceFile('PING.WAV') })).not.toBeNull();
  });

  it('replaces the previous choice instead of accumulating files', () => {
    // One custom sound, so "Choose a different file" ten times must not leave
    // ten files in the app's directory and no way to tell which is live.
    storeCustomSound({ userData, sourcePath: sourceFile('one.wav') });
    storeCustomSound({ userData, sourcePath: sourceFile('two.mp3') });
    expect(fs.readdirSync(soundsDir(userData))).toEqual(['custom.mp3']);
  });

  it('refuses a source that does not exist rather than storing a broken choice', () => {
    expect(storeCustomSound({ userData, sourcePath: path.join(userData, 'nope.wav') })).toBeNull();
  });

  it('refuses a file too large to hand to the renderer', () => {
    // It crosses IPC as a data URL. An album-length file would be base64'd into
    // a string and copied through the structured clone — the app freezes, and
    // it looks like the notification feature hung.
    const big = sourceFile('huge.wav', 'x'.repeat(6 * 1024 * 1024));
    expect(storeCustomSound({ userData, sourcePath: big })).toBeNull();
  });
});

describe('playing it back', () => {
  it('hands the renderer the bytes, not the path', () => {
    // The renderer is sandboxed and has no filesystem. A path would be a string
    // it can do nothing with, so the only useful answer is the audio itself.
    const stored = storeCustomSound({ userData, sourcePath: sourceFile('ping.wav') })!;
    const read = readCustomSound({ userData, storedPath: stored.path });
    expect(read!.dataUrl.startsWith('data:audio/wav;base64,')).toBe(true);
    expect(Buffer.from(read!.dataUrl.split(',')[1], 'base64').toString('utf8'))
      .toBe('RIFF....WAVEfmt ');
  });

  it('refuses a stored path outside the sounds directory', () => {
    // THE test. prefs.json is an ordinary file; a stored path is not a path
    // this process chose, it is a path this process read back.
    const outside = sourceFile('secrets.wav');
    expect(readCustomSound({ userData, storedPath: outside })).toBeNull();
  });

  it('refuses a traversal that lands outside after resolution', () => {
    const escape = path.join(soundsDir(userData), '..', '..', 'etc', 'passwd');
    expect(readCustomSound({ userData, storedPath: escape })).toBeNull();
  });

  it('refuses a sibling directory whose name merely starts the same way', () => {
    // `<userData>/sounds-backup/x.wav` is not inside `<userData>/sounds`, and a
    // prefix comparison without the separator says it is.
    fs.mkdirSync(`${soundsDir(userData)}-backup`, { recursive: true });
    const sibling = path.join(`${soundsDir(userData)}-backup`, 'x.wav');
    fs.writeFileSync(sibling, 'nope');
    expect(readCustomSound({ userData, storedPath: sibling })).toBeNull();
  });

  it('answers null for an empty or absent choice instead of throwing', () => {
    // No custom sound is the normal state. The caller falls back to the built-in
    // tone, which it can only do if this returns rather than throws.
    expect(readCustomSound({ userData, storedPath: '' })).toBeNull();
    expect(readCustomSound({ userData, storedPath: path.join(soundsDir(userData), 'custom.wav') })).toBeNull();
  });

  it('answers null for a contained path the user deleted, rather than throwing', () => {
    const stored = storeCustomSound({ userData, sourcePath: sourceFile('ping.wav') })!;
    fs.unlinkSync(stored.path);
    expect(readCustomSound({ userData, storedPath: stored.path })).toBeNull();
  });
});

describe('clearing it', () => {
  it('removes the copy, so "no custom sound" is true on disk too', () => {
    const stored = storeCustomSound({ userData, sourcePath: sourceFile('ping.wav') })!;
    clearCustomSound({ userData });
    expect(fs.existsSync(stored.path)).toBe(false);
  });

  it('is safe to call when there is nothing to clear', () => {
    expect(() => clearCustomSound({ userData })).not.toThrow();
  });
});
