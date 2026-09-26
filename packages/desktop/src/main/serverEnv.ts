/**
 * Which database does the desktop app open?
 *
 * The server's own last resort is `findProjectRoot(process.cwd())`, which is
 * fine for a CLI launched inside a project and wrong for a GUI app: launched
 * from Finder the cwd is "/", so the server would try to create
 * /.agenfk/db.sqlite and die on EPERM before serving anything. On Windows the
 * cwd is the executable's directory — a different wrong answer.
 *
 * So the desktop process decides, using the same chain
 * `scripts/start-services.mjs` uses. That is not merely a safe default: it is
 * what makes the app and the terminal show the same board.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface FsReader {
  exists(p: string): boolean;
  read(p: string): string;
}

export interface ResolveDbPathOptions {
  env?: Record<string, string | undefined>;
  homedir?: string;
  fs?: FsReader;
}

const realFs: FsReader = {
  exists: (p) => fs.existsSync(p),
  read: (p) => fs.readFileSync(p, 'utf8'),
};

/**
 * Resolve the SQLite path: AGENFK_DB_PATH, then `dbPath` from
 * ~/.agenfk/config.json (what the installer writes), then a default under the
 * home directory. Never cwd-relative, and never below the filesystem root.
 */
export function resolveDbPath(opts: ResolveDbPathOptions = {}): string {
  const {
    env = process.env,
    homedir = os.homedir(),
    fs: reader = realFs,
  } = opts;

  const explicit = env.AGENFK_DB_PATH?.trim();
  if (explicit) return explicit;

  const configPath = path.join(homedir, '.agenfk', 'config.json');
  if (reader.exists(configPath)) {
    try {
      const cfg = JSON.parse(reader.read(configPath));
      if (typeof cfg?.dbPath === 'string' && cfg.dbPath.trim()) return cfg.dbPath;
    } catch {
      // A malformed config must not push us onto the cwd fallback — that is
      // the very failure this function exists to prevent.
    }
  }

  return path.join(homedir, '.agenfk-system', '.agenfk', 'db.sqlite');
}
