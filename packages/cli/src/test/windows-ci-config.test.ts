/**
 * Issue #201 — a lightweight Windows job in the CI.
 *
 * These pin the shape of the Windows CI contract so it cannot silently rot:
 * the job must stay parallel to the Linux one (no extra wall-clock time),
 * build only what is platform-sensitive, and run the curated cross-platform
 * subset. They read config files as text, so they run identically on any OS.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

type Job = {
  'runs-on'?: string;
  needs?: unknown;
  'continue-on-error'?: boolean;
  steps?: Array<{ name?: string; run?: string; uses?: string; env?: Record<string, string>; with?: Record<string, unknown>; shell?: string }>;
  defaults?: { run?: { shell?: string } };
};
const workflow = () => yaml.load(read('.github/workflows/ci.yml')) as { jobs: Record<string, Job>; concurrency?: unknown };

describe('ci.yml windows-compat job', () => {
  it('exists and runs on windows-latest', () => {
    expect(workflow().jobs['windows-compat']?.['runs-on']).toBe('windows-latest');
  });

  it('is independent of the Linux job (no `needs`) so wall-clock time does not grow', () => {
    expect(workflow().jobs['windows-compat'].needs).toBeUndefined();
  });

  it('starts advisory (continue-on-error) until it is proven stable', () => {
    expect(workflow().jobs['windows-compat']['continue-on-error']).toBe(true);
  });

  it('uses Git Bash for run steps, like Claude Code does on Windows', () => {
    const job = workflow().jobs['windows-compat'];
    expect(job.defaults?.run?.shell).toBe('bash');
  });

  it('builds only the platform-sensitive packages, never the vite UIs', () => {
    const runs = (workflow().jobs['windows-compat'].steps ?? []).map(s => s.run ?? '').join('\n');
    for (const pkg of ['core', 'storage-sqlite', 'telemetry', 'cli', 'server']) {
      expect(runs).toContain(`-w packages/${pkg}`);
    }
    for (const pkg of ['ui', 'hub-ui', 'hub']) {
      expect(runs).not.toMatch(new RegExp(`-w packages/${pkg}(\\s|$)`));
    }
    expect(runs).not.toMatch(/npm run build\s*($|\n)/);
  });

  it('runs the curated subset via `npm run test:windows` with the unicode HOME sandbox', () => {
    const steps = workflow().jobs['windows-compat'].steps ?? [];
    const testStep = steps.find(s => (s.run ?? '').includes('npm run test:windows'));
    expect(testStep).toBeDefined();
    expect(testStep!.env?.AGENFK_TEST_UNICODE_HOME).toBe('1');
  });

  it('keeps the Linux job intact', () => {
    const linux = workflow().jobs['build-and-test'];
    expect(linux['runs-on']).toBe('ubuntu-latest');
    expect((linux.steps ?? []).some(s => s.run === 'npm test')).toBe(true);
  });

  it('cancels superseded runs so Windows minutes do not pile up', () => {
    expect(workflow().concurrency).toBeDefined();
  });
});

describe('vitest.windows.config.ts + test:windows script', () => {
  it('package.json exposes test:windows', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts['test:windows']).toMatch(/vitest run .*vitest\.windows\.config\.ts/);
  });

  it('includes xplat and windows-* specs, and no jsdom UI packages', async () => {
    expect(existsSync(path.join(ROOT, 'vitest.windows.config.ts'))).toBe(true);
    const mod = await import(path.join(ROOT, 'vitest.windows.config.ts').replace(/\\/g, '/'));
    const include: string[] = mod.default.test.include;
    expect(include.some(g => g.includes('.xplat.test'))).toBe(true);
    expect(include.some(g => g.includes('windows-'))).toBe(true);
    expect(include.join(' ')).not.toMatch(/packages\/(ui|hub-ui|flow-editor)\//);
  });
});

describe('.gitattributes', () => {
  it('forces LF for shell wrappers and scripts so a Windows checkout does not break them', () => {
    expect(existsSync(path.join(ROOT, '.gitattributes'))).toBe(true);
    const attrs = read('.gitattributes');
    expect(attrs).toMatch(/\*\.sh\s+text\s+eol=lf/);
    expect(attrs).toMatch(/\*\.mjs\s+text\s+eol=lf/);
    expect(attrs).toMatch(/^bin\/\*\s+text\s+eol=lf/m);
  });
});
