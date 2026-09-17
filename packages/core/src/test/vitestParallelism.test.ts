// The suite's parallelism must be what the config says it is (BUG c03aa92e).
//
// vitest.config.ts splits the suite into a `parallel` project (packages with no
// shared filesystem state) and a `serial` one (server/hub/cli, which share a
// single per-run HOME sandbox). Both projects resolved their own settings
// correctly for months — and ran serially anyway, because the ROOT-LEVEL test
// block set fileParallelism: false and the global wins over a project's value.
// The optimisation was inert and nothing said so.
//
// So these assert the RESOLVED RUNTIME config, including the global, not the
// literal config objects: reading back the values a project declares is exactly
// the check that passed all along while the suite ran serially.
import { describe, it, expect } from 'vitest';
import { createVitest } from 'vitest/node';

/** `fileParallelism` is present on the resolved config at runtime but missing
 *  from vitest's published ResolvedConfig type, so read it through this shape
 *  rather than casting the whole config to any — the other fields stay typed. */
type Parallelism = { fileParallelism?: boolean; sequence?: { concurrent?: boolean } };
const read = (c: unknown): { fileParallelism?: boolean; concurrent?: boolean } => {
  const p = c as Parallelism;
  return { fileParallelism: p.fileParallelism, concurrent: p.sequence?.concurrent };
};

async function resolved() {
  const v = await createVitest('test', { watch: false });
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

  it('keeps the serial project one-file-at-a-time', async () => {
    // server/hub/cli share one HOME sandbox per run (scripts/vitest-home-pin.mjs),
    // which exists because a test once wrote into the real ~/.agenfk. Running
    // their files concurrently would put that back.
    const r = await resolved();
    expect(r.projects.serial?.fileParallelism).toBe(false);
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
