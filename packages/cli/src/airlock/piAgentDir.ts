/**
 * The agent dir pi runs on inside the Airlock sandbox (BUG ff9969f5).
 *
 * The sandbox denies pi's auth.json (its logins and keys), and pi reads an auth.json it
 * cannot open as "no key at all" - even for a provider whose key is in models.json - while it
 * reads a missing one as empty. So pi is pointed (PI_CODING_AGENT_DIR) at a staged dir: every
 * entry of the real agent dir as a link to it, and an empty auth.json of its own. What pi
 * writes through a link (sessions, settings) lands in the real dir, under the sandbox's own
 * write rules; the staged auth.json holds nothing and goes when the session does.
 *
 * The sessions dir is made in the real dir first, so a first session's history goes through
 * its link and is kept (review C4). Nothing is ever carried back from the staged dir: it is
 * the sandbox's to write, so an unsandboxed copy out of it could be pointed anywhere (second
 * review: a staged root swapped for a link to ~/.ssh). A file pi creates there for the first
 * time - a settings.json the user never had - goes with the session.
 */
import fs from 'fs';
import path from 'path';

export interface StagedAgentDir {
  dir: string;
  /** Removes the staged dir - a link where it was, never what a link points at. Safe twice. */
  cleanup(): void;
}

export function stagePiAgentDir(realDir: string, tmpDir: string): StagedAgentDir {
  fs.mkdirSync(path.join(realDir, 'sessions'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(tmpDir, 'agenfk-airlock-pi-'));
  try {
    for (const name of fs.readdirSync(realDir)) {
      if (name === 'auth.json') continue;
      fs.symlinkSync(path.join(realDir, name), path.join(dir, name));
    }
    fs.writeFileSync(path.join(dir, 'auth.json'), '{}\n', { mode: 0o600 });
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  // rmSync takes a link it finds - at the root too - as itself: it is unlinked, never followed.
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
