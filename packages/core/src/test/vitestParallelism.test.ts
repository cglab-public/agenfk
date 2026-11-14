// The suite's parallelism must be what the config says it is (BUG c03aa92e).
//
// vitest.config.ts splits the suite into a `parallel` project (packages with no
// shared filesystem state) and a `serial` one (server/hub/cli, which shared a
// single per-run HOME sandbox until GH-274). Both projects resolved their own settings
// correctly for months — and ran serially anyway, because the ROOT-LEVEL test
// block set fileParallelism: false and the global wins over a project's value.
// The optimisation was inert and nothing said so.
//
// So these assert the RESOLVED RUNTIME config, including the global, not the
// literal config objects: reading back the values a project declares is exactly
// the check that passed all along while the suite ran serially.
import { describe, it, expect } from 'vitest';
import { createVitest } from 'vitest/node';
import * as os from 'os';
import { resolveMaxWorkers } from '../../../../scripts/vitest-workers.mjs';

/** What the root config should resolve to on THIS machine (#313: win32 has its own rule). */
const expectedWorkers = () => resolveMaxWorkers({ platform: process.platform, cpus: os.availableParallelism() });

/** `fileParallelism` is present on the resolved config at runtime but missing
 *  from vitest's published ResolvedConfig type, so read it through this shape
 *  rather than casting the whole config to any — the other fields stay typed. */
type Parallelism = { fileParallelism?: boolean; maxWorkers?: number; sequence?: { concurrent?: boolean } };
const read = (c: unknown): { fileParallelism?: boolean; concurrent?: boolean; maxWorkers?: number } => {
  const p = c as Parallelism;
  return { fileParallelism: p.fileParallelism, concurrent: p.sequence?.concurrent, maxWorkers: p.maxWorkers };
};

async function resolved(cli: { maxWorkers?: number } = {}) {
  const v = await createVitest('test', { watch: false, ...cli });
  try {
    return {
      global: read(v.config),
      projects: Object.fromEntries(v.projects.map(p => [p.name || '(root)', read(p.config)])),
    };
  } finally {
    await v.close();
  }
}

describe('root vitest parallelism', () => {
  it('leaves the global permissive, so a project can actually run files in parallel', async () => {
    // This is the exact value that was false and silently disabled the whole
    // PARALLEL_INCLUDE design.
    const r = await resolved();
    expect(r.global.fileParallelism).toBe(true);
  });

  // GH-274: server/hub/cli ran one file at a time because every worker shared the
  // run's HOME sandbox; each worker now has its own (scripts/vitest-home-pin.mjs).
  // Their files spawn git and node children by the dozen, so the run takes a capped
  // worker count: a quarter of the CPUs on POSIX, its own rule on win32 (#313).
  it('runs the server/hub/cli files in parallel, on the worker count resolveMaxWorkers gives this platform', async () => {
    const r = await resolved();
    expect(r.projects.serial?.fileParallelism).toBe(true);
    expect(r.global.maxWorkers).toBe(expectedWorkers());
  });

  it('leaves the worker count to --maxWorkers when one is given, for every project', async () => {
    // vitest 5 resolves maxWorkers per project (the board's config file sets its own, see
    // packages/ui/vitest.config.ts), so assert what each project actually runs with: the flag.
    // One more than the default, so the flag is told apart from the cap on any machine.
    const flag = expectedWorkers() + 1;
    const r = await resolved({ maxWorkers: flag });
    expect(r.global.maxWorkers).toBe(flag);
    for (const [name, cfg] of Object.entries(r.projects)) {
      expect(cfg.maxWorkers, `project ${name} ignores --maxWorkers`).toBe(flag);
    }
  });

  it('gives every project the same worker count without a flag, as vitest 5 requires', async () => {
    // Projects of one sequence.groupOrder with different maxWorkers stop the run before any test.
    const r = await resolved();
    for (const [name, cfg] of Object.entries(r.projects)) {
      expect(cfg.maxWorkers, `project ${name} runs on its own worker count`).toBe(expectedWorkers());
    }
  });

  it('collects each test file in exactly one project', async () => {
    // vitest 5 merges the root test block into the inline projects and concatenates arrays:
    // a root `include` made `parallel` and `serial` both collect every file, so the suite ran twice.
    const v = await createVitest('test', { watch: false });
    try {
      const counts = new Map<string, string[]>();
      for (const spec of await v.globTestSpecifications()) {
        counts.set(spec.moduleId, [...(counts.get(spec.moduleId) ?? []), spec.project.name]);
      }
      const twice = [...counts].filter(([, projects]) => projects.length > 1);
      expect(counts.size).toBeGreaterThan(0);
      expect(twice, 'files collected by more than one project').toEqual([]);
    } finally {
      await v.close();
    }
  });

  it('runs files in parallel for the packages that have no shared state', async () => {
    const r = await resolved();
    expect(r.projects.parallel?.fileParallelism).toBe(true);
  });

  it('never runs tests concurrently WITHIN a file, anywhere', async () => {
    // A different thing from file parallelism, and the reason the two could not
    // share one flag: the jsdom packages in the parallel project are component
    // specs sharing one document, and concurrent renders fail 95 of them.
    const r = await resolved();
    expect(r.global.concurrent).toBe(false);
    for (const [name, cfg] of Object.entries(r.projects)) {
      expect(cfg.concurrent, `project ${name} runs tests concurrently within a file`).toBe(false);
    }
  });
});
