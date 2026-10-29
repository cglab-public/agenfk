/**
 * BUG 7a9b2032: on Node 22 every `agenfk` command printed "ExperimentalWarning: SQLite is an
 * experimental feature", because the dataset import module required node:sqlite when it was
 * loaded - and the CLI loads it for every command. node:sqlite is loaded only when an import
 * actually opens OpenCode's database.
 *
 * Measured by what is required, not by stderr: Node 23+ no longer warns, so a stderr check
 * would pass on a developer's machine with the bug in place.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import Module from 'module';

const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const original = loader._load;
let requested: string[] = [];

afterEach(() => {
  loader._load = original;
  requested = [];
});

function watchRequires(): void {
  loader._load = function (request: string, ...rest: unknown[]) {
    requested.push(request);
    return original.call(this, request, ...rest);
  };
}

describe('node:sqlite is loaded only when it is used', () => {
  it('loading the dataset import module does not load node:sqlite', async () => {
    vi.resetModules();
    watchRequires();
    await import('../airlock/datasetImport');
    expect(requested.filter(r => r === 'node:sqlite' || r === 'sqlite')).toEqual([]);
  });

  it('reading an OpenCode database still loads it', async () => {
    vi.resetModules();
    watchRequires();
    const mod = await import('../airlock/datasetImport');
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-sqlite-lazy-'));
    try {
      // A database that is not there: the import says so, after trying to open it.
      await mod.runDatasetImport({ piDir: null, openCodeDb: path.join(dir, 'missing.db') }, {
        status: async () => ({ joined: true, enabled: true }),
        post: async () => ({ recorded: 0, skipped: 0 }),
        log: () => {},
      }).catch(() => undefined);
      const db = path.join(dir, 'opencode.db');
      fs.writeFileSync(db, '');
      await mod.runDatasetImport({ piDir: null, openCodeDb: db }, {
        status: async () => ({ joined: true, enabled: true }),
        post: async () => ({ recorded: 0, skipped: 0 }),
        log: () => {},
      }).catch(() => undefined);
      expect(requested).toContain('node:sqlite');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
