/**
 * Preferences the desktop app owns, and that no HTTP route can reach.
 *
 * Everything in the server's `/settings` is written through an unauthenticated
 * local route. That is the right call for a preference whose worst outcome is a
 * terminal that does or does not survive quitting. It is the wrong call for one
 * that changes the argv of every agent the app spawns afterwards — and the
 * server already draws exactly that line, with `verifyCommand` behind
 * VERIFY_TOKEN because it is a shell string, and `autoWorktree` open because it
 * has no execution semantics.
 *
 * So `autoApprove` lives here. It only affects terminals the desktop spawns,
 * a browser has none, and the preload is the only way in. See prefs.test.ts for
 * the full reasoning.
 *
 * Deliberately plain JSON on disk rather than the database: the database is
 * shared with the CLI and the server, and putting it there would put it back
 * within reach of the thing this move is getting it out of.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface Prefs {
  /**
   * Start agents with their own permission prompts disabled.
   *
   * Off by default, and that default is what protects every install that never
   * opens the settings screen. It can only become true because somebody went
   * and turned it on, in this app.
   */
  autoApprove: boolean;
}

export const DEFAULT_PREFS: Prefs = { autoApprove: false };

/** The closed set. A write outside it is refused, not ignored. */
export const PREF_KEYS = Object.keys(DEFAULT_PREFS) as ReadonlyArray<keyof Prefs>;

const FILE = 'prefs.json';

/**
 * Read the stored preferences, layered over the defaults.
 *
 * Every failure path answers with the DEFAULTS, which for this file means
 * "agents keep asking". Failing towards the permissive state — treating a
 * corrupt file as "everything on" — is the one failure mode here that costs the
 * user something they cannot undo.
 */
export function readPrefs(dir: string): Prefs {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'));
  } catch {
    return { ...DEFAULT_PREFS };
  }
  // Arrays and null are both 'object'. Neither is a preferences file.
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ...DEFAULT_PREFS };

  const prefs = { ...DEFAULT_PREFS };
  for (const key of PREF_KEYS) {
    // hasOwnProperty through Object.prototype, so a '__proto__' entry in the
    // file cannot answer this lookup through the prototype chain.
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const value = (raw as Record<string, unknown>)[key];
    // Type-checked, never coerced: 'false' is a truthy string, and coercing it
    // would take the rails off for someone trying to keep them on.
    if (typeof value === typeof DEFAULT_PREFS[key]) (prefs[key] as unknown) = value;
  }
  return prefs;
}

/**
 * Write one preference.
 *
 * One key at a time, from a closed list, type-checked. The renderer is our own
 * bundle, but it is also the part an XSS would control, so this is a named
 * operation rather than a "save this object" surface.
 */
export function writePref<K extends keyof Prefs>(dir: string, key: K, value: Prefs[K]): Prefs {
  if (!PREF_KEYS.includes(key)) {
    throw new Error(`Unknown preference "${String(key)}". Expected one of: ${PREF_KEYS.join(', ')}`);
  }
  if (typeof value !== typeof DEFAULT_PREFS[key]) {
    throw new Error(`Preference "${String(key)}" must be ${typeof DEFAULT_PREFS[key]}`);
  }
  const next = { ...readPrefs(dir), [key]: value };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, FILE), JSON.stringify(next, null, 2));
  return next;
}
