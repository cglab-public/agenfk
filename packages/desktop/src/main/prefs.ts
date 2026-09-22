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

  /**
   * The notification sound the user chose, or '' for the built-in one.
   *
   * Here rather than in the server's `/settings` with the other notification
   * preferences, and for the same reason `autoApprove` is here: this one is a
   * PATH, and it reaches the filesystem. Written through an unauthenticated
   * local HTTP route it would be a path any page on the machine could set.
   *
   * Written by exactly one caller — the main-process file dialog — so nothing
   * on the renderer side of the border ever supplies the value. It is still
   * contained-checked when it is read back, because this file is an ordinary
   * file on disk that anything running as the user can edit. See
   * main/customSound.ts.
   */
  customSoundPath: string;

  /**
   * What the user calls that file.
   *
   * Stored separately because the COPY is named from its extension —
   * `custom.wav` — so that a hostile filename has nothing to contribute to a
   * path this process builds. That is the right trade, and it costs the screen
   * the only string a person would recognise: "custom.wav" tells them nothing
   * about which of their three chimes is in use.
   */
  customSoundName: string;
  /** Where a cloned repository lands, remembered between runs. */
  cloneDir: string;
}

export const DEFAULT_PREFS: Prefs = {
  autoApprove: false,
  customSoundPath: '',
  customSoundName: '',
  /*
   * Empty means "nobody has chosen one" — see `cloneDirOrDefault`, which is
   * where the proposal lives. It is NOT stored as the default here on purpose:
   * a value written to disk is a decision the person made, and reading one back
   * that they never made would make "remembered" and "suggested" the same
   * thing on the next screen that consults this file.
   */
  cloneDir: '',
};

/**
 * Where a clone should land: what they chose, or ~/agenfk proposed.
 *
 * PROPOSED, NOT IMPOSED. Answering "" would make choosing a directory a
 * precondition of cloning — a question with an obvious answer that the person
 * has to type anyway. Answering ~/agenfk is only safe because of what the
 * screen does with it: it is written out in the field, changeable by the
 * picker, and the folder is created when a clone actually runs rather than on
 * the chance that one might. An app that invents a directory to write into
 * WITHOUT SHOWING IT is the thing being avoided; the showing is the whole
 * difference.
 *
 * Visible, not hidden: ~/.agenfk-worktrees and ~/.agenfk-system are dotted
 * because they are ours to manage. A person's checkouts are theirs to find.
 */
export function cloneDirOrDefault(prefs: Prefs, home: string): string {
  return prefs.cloneDir || path.join(home, 'agenfk');
}

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
