/**
 * What a repository declares about its own project.
 *
 * `.agenfk/project.json` has always carried one thing — the project id — which
 * answers "which project is this folder". Everything else a project is
 * configured with lived in the database, so it never travelled: clone the
 * repo and you got the link to the project and none of its settings, and two
 * people on the same repository could be running different flows without
 * either of them noticing.
 *
 * THE FILE IS CHECKED IN, which is the point and also the whole risk. Three
 * refusals below came from reading the real database rather than from theory,
 * and each one is a value that would be wrong the moment somebody else cloned:
 *
 *   - `projectRoot` is `/Users/<someone>/GitHub/horizon-lab`. Writing it inside
 *     that very checkout is circular — the file is found BECAUSE you are in the
 *     folder — and it names a path nobody else has.
 *   - a flow given by ID points at a row in one machine's database. Three flows
 *     there are called "TDD Flow" with different ids; the name is the only
 *     thing that means the same thing on both sides.
 *   - a command with an absolute home path in it — the real one begins
 *     `cd /Users/<someone>/... && PATH=/Users/<someone>/.nvm/...` — breaks for
 *     everyone else the moment it is committed.
 *
 * Reading this file NEVER throws and never returns half an answer: it returns
 * what it could use and a list of problems in plain words, because the file is
 * hand-edited and a parse error must not take an app down.
 */

/** The settings a repository may declare about itself. */
export interface ProjectFileSettings {
  name?: string;
  description?: string;
  /**
   * Which flow this project runs, in one of two spellings:
   *
   *   "TDD Flow"                 — by NAME, for a flow authored on a machine
   *   "hub:47719f30-62d2-…"      — by HUB id, for one installed from the hub
   *
   * A bare local id is refused. Flows carry `source: 'hub'` and a `hubFlowId`
   * when they came from the hub, and THAT id means the same thing everywhere;
   * the local `id` column does not — three flows on one machine here are all
   * called "TDD Flow" with three different local ids.
   */
  flow?: string;
  autoWorktree?: boolean;
  /** Ask before the close commit instead of making it (CGLAB-373). */
  askBeforeCommit?: boolean;
  verifyCommand?: string;
  setupCommand?: string;
}

export interface ProjectFile {
  /** Null when the file could not be read at all. */
  projectId: string | null;
  settings: ProjectFileSettings;
}

export interface ProjectFileRead {
  readonly value: ProjectFile;
  /** What was ignored, and why. Never thrown: this file is hand-edited. */
  readonly problems: string[];
}

const BOOLEANS = ['autoWorktree', 'askBeforeCommit'] as const;
const STRINGS = ['name', 'description', 'flow', 'verifyCommand', 'setupCommand'] as const;
const KNOWN = new Set<string>(['projectId', ...BOOLEANS, ...STRINGS]);

/**
 * Values that belong to a MACHINE, and the sentence explaining each.
 *
 * Listed rather than silently dropped: somebody who wrote one is trying to
 * configure something real, and "ignored" without a reason is how a person
 * spends an afternoon on a key that never did anything.
 */
const MACHINE_ONLY: Record<string, string> = {
  projectRoot: 'projectRoot is where this checkout lives on THIS machine, so it cannot travel with the repository.',
  worktreeRoot: 'worktreeRoot points outside the repository and differs per machine.',
  flowId: 'flowId names a row in one machine\'s database — declare the flow by name instead.',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `hub:<id>` — the one id that means the same thing on every machine. */
const HUB_REF = /^hub:[0-9a-f-]{36}$/i;

/** How a flow reference should be resolved, once the file has been read. */
export function flowReference(flow: string | undefined):
  { kind: 'hub'; hubFlowId: string } | { kind: 'name'; name: string } | null {
  if (!flow) return null;
  return HUB_REF.test(flow)
    ? { kind: 'hub', hubFlowId: flow.slice('hub:'.length) }
    : { kind: 'name', name: flow };
}
/** `/Users/...`, `/home/...`, `~/...` — a path that only exists for one person. */
const HOME_PATH = /(^|\s|=)(~\/|\/Users\/|\/home\/)/;

export function readProjectFile(raw: string): ProjectFileRead {
  const problems: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      value: { projectId: null, settings: {} },
      problems: ['The project file could not be read: it is not valid JSON.'],
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      value: { projectId: null, settings: {} },
      problems: ['The project file could not be read: it does not describe an object.'],
    };
  }

  const input = parsed as Record<string, unknown>;
  const settings: ProjectFileSettings = {};

  for (const [key, why] of Object.entries(MACHINE_ONLY)) {
    if (key in input) problems.push(why);
  }
  for (const key of Object.keys(input)) {
    if (!KNOWN.has(key) && !(key in MACHINE_ONLY)) {
      problems.push(`"${key}" is not a setting this version knows, so it was ignored.`);
    }
  }

  for (const key of BOOLEANS) {
    if (!(key in input)) continue;
    const given = input[key];
    if (typeof given === 'boolean') settings[key] = given;
    else problems.push(`"${key}" must be true or false, so it was ignored.`);
  }

  for (const key of STRINGS) {
    if (!(key in input)) continue;
    const given = input[key];
    if (typeof given !== 'string' || !given.trim()) {
      problems.push(`"${key}" must be a non-empty string, so it was ignored.`);
      continue;
    }
    const text = given.trim();
    if (key === 'flow' && UUID.test(text)) {
      problems.push(
        '"flow" was given a bare id, which names a row in one machine\'s database. '
        + 'Use the flow\'s name, or "hub:<id>" for a flow installed from the hub.',
      );
      continue;
    }
    if ((key === 'verifyCommand' || key === 'setupCommand') && HOME_PATH.test(text)) {
      problems.push(
        `"${key}" contains an absolute path under a home directory, which only works on the machine that wrote it. `
        + 'Write it relative to the repository instead.',
      );
      continue;
    }
    settings[key] = text;
  }

  const projectId = typeof input.projectId === 'string' && input.projectId.trim()
    ? input.projectId.trim()
    : null;
  if (!projectId) problems.push('The project file has no projectId, so it names no project.');

  return { value: { projectId, settings }, problems };
}

export interface MergedSettings<T> {
  readonly value: T;
  /** Keys the FILE decided, so a screen can show where they came from. */
  readonly fromFile: string[];
}

/**
 * The file wins for the keys it names; the database keeps the rest.
 *
 * Chosen deliberately over the other way round: what is written in the
 * repository is the project's own declaration — identical for everyone who
 * clones it and reviewable in a pull request — while the database is one
 * machine's memory. A setting the file does not mention is not an empty value;
 * it is no opinion, and the stored one stands.
 */
export function mergeProjectSettings<T extends Record<string, unknown>>(
  fromFile: Partial<T> | null | undefined,
  stored: T,
): MergedSettings<T> {
  if (!fromFile) return { value: stored, fromFile: [] };
  const keys = Object.keys(fromFile).filter(k => fromFile[k as keyof T] !== undefined);
  return {
    value: { ...stored, ...fromFile } as T,
    fromFile: keys,
  };
}
