/**
 * The notification sound a user chose, on its way to and from the disk.
 *
 * This is the only place in the whole notifications feature where a PATH
 * reaches the filesystem, so it is the only part with a real security question.
 * The answer has two halves, and they are easy to mistake for one:
 *
 * **The renderer never names a file.** It asks for a picker; the main process
 * opens it and the OS hands back what the user selected. There is no request in
 * which a hostile renderer supplies a path at all — which is the strongest
 * guarantee available here, and the reason the chooser lives in main rather
 * than behind an `<input type=file>`.
 *
 * **The stored path is checked anyway, at the sink.** Not redundant: the value
 * comes back out of prefs.json on the next launch, and prefs.json is an
 * ordinary file that anything running as the user can edit. `containedPath`
 * from @agenfk/core rather than a boolean, because a boolean leaves the caller
 * holding the unchecked variable and nothing stops the next `fs` call being
 * added below the guard.
 *
 * The COPY is what makes the containment mean anything. Playing the file where
 * the user chose it would keep every path on the machine in scope forever;
 * copying once reduces the trusted region to one directory this app made. It
 * also fixes the ordinary failure: a path in ~/Downloads is a path the user
 * will move, and a notification sound that silently stops working is
 * indistinguishable from notifications being broken.
 */
import * as fs from 'fs';
import * as path from 'path';
import { containedPath } from '@agenfk/core';

/**
 * What the picker offers and what this module will copy.
 *
 * Not a security boundary on its own — the renderer cannot execute what it is
 * handed — but a `.command` or `.app` copied into the app's own directory under
 * a name the app then passes around is a bad shape to leave lying about. The
 * media types below are also what Chromium will actually decode.
 */
export const SOUND_EXTENSIONS = ['.wav', '.mp3', '.ogg', '.m4a', '.aac', '.flac'] as const;

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
};

/**
 * How large a file may be before it stops being a notification sound.
 *
 * It crosses IPC as a data URL: base64 in a string, copied through the
 * structured clone. An album-length file freezes the app, and the freeze looks
 * like the notification feature hanging rather than like a file being too big.
 */
const MAX_BYTES = 5 * 1024 * 1024;

/** The one directory a custom sound may live in. */
export function soundsDir(userData: string): string {
  return path.join(userData, 'sounds');
}

/** The allowlisted extension of this filename, lowercased, or null. */
function soundExtension(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  return (SOUND_EXTENSIONS as readonly string[]).includes(ext) ? ext : null;
}

/**
 * Copy the chosen file in, and answer where it went and what it was called.
 *
 * The destination name is built from the EXTENSION, never from the source
 * filename, so a name like `../../../.ssh/authorized_keys` has nothing to
 * contribute to it. The original name travels back separately because the
 * screen has to be able to say which file is in use.
 *
 * Null, not a throw and not a fallback: the caller turns it into a sentence for
 * the user, and every reason to refuse is one the user can act on.
 */
export function storeCustomSound(
  { userData, sourcePath }: { userData: string; sourcePath: string },
): { path: string; name: string } | null {
  const ext = soundExtension(sourcePath);
  if (!ext) return null;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(sourcePath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > MAX_BYTES) return null;

  const dir = soundsDir(userData);
  fs.mkdirSync(dir, { recursive: true });
  // One custom sound. Choosing a different file ten times must not leave ten
  // files behind with no way to tell which one is live.
  for (const existing of fs.readdirSync(dir)) {
    if (existing.startsWith('custom.')) {
      try { fs.unlinkSync(path.join(dir, existing)); } catch { /* best effort */ }
    }
  }

  const dest = path.join(dir, `custom${ext}`);
  try {
    fs.copyFileSync(sourcePath, dest);
  } catch {
    return null;
  }
  return { path: dest, name: path.basename(sourcePath) };
}

/**
 * Read the stored sound back as something the renderer can play.
 *
 * The renderer is sandboxed and has no filesystem, so a path would be a string
 * it can do nothing with — the only useful answer is the audio itself.
 *
 * `containedPath` returns the VALUE, and that value is what `readFileSync`
 * gets. The check and the use are one expression rather than two mentions of a
 * name, so no edit can land between them.
 */
export function readCustomSound(
  { userData, storedPath }: { userData: string; storedPath: string },
): { dataUrl: string; name: string } | null {
  const safe = containedPath(soundsDir(userData), storedPath);
  if (!safe) return null;
  const ext = soundExtension(safe);
  if (!ext) return null;
  try {
    const bytes = fs.readFileSync(safe);
    return {
      dataUrl: `data:${MEDIA_TYPES[ext]};base64,${bytes.toString('base64')}`,
      name: path.basename(safe),
    };
  } catch {
    // The user deleted it, or it was never written. The caller falls back to
    // the built-in tone, which it can only do if this returns rather than
    // throws.
    return null;
  }
}

/** Put it back to the built-in sound, on disk as well as in the preference. */
export function clearCustomSound({ userData }: { userData: string }): void {
  const dir = soundsDir(userData);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const existing of entries) {
    if (existing.startsWith('custom.')) {
      try { fs.unlinkSync(path.join(dir, existing)); } catch { /* best effort */ }
    }
  }
}
