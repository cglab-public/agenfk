/**
 * @file The check-engine end-to-end tests (check-engine-tests.test.ts), CGLAB-420, fixes-reviewed: the first half.
 * Split out so the parts run side by side (GH-274); the harness is helpers/engineTests.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { posixShell } from './helpers/posixShell';

vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  mockAxios.create = vi.fn(() => mockAxios);
  return { default: mockAxios };
});

import {
  atLook,
  leave,
  lines,
  reviewed,
  reviewerBegins,
  useEngineServer,
  write,
} from './helpers/engineTests';

useEngineServer('check-engine-tests-fixes-test-db.sqlite');

describe('CGLAB-420: field findings from CGLAB-419', () => {
  describe('fixes-reviewed: the fixes to a review\'s findings are flagged, not certified', () => {
    it('flags a fix of more than a few lines written after the reviewer began, naming it, and lets the card go', async () => {
      const { dir, id } = await atLook();
      const startedAt = await reviewerBegins();
      write(dir, 'src/fix.js', lines(30));
      await reviewed(id, dir, { startedAt });
      const c = await leave(id);
      expect(c).toMatchObject({ outcome: 'fail', blocking: false });
      expect(c.detail).toMatch(/30 lines changed after the reviewer began/);
      expect(c.detail).toMatch(/src\/fix\.js/);
    });

    it('does not count the card\'s own reviewed work, however large and uncommitted', async () => {
      const { dir, id } = await atLook(40);
      await reviewed(id, dir, { startedAt: await reviewerBegins() });
      expect(await leave(id)).toMatchObject({ outcome: 'pass' });
    });

    it('a small fix to a file the card already changed a lot counts small, once that work is committed', async () => {
      const { dir, id } = await atLook(40);
      execSync('git add -A && git commit -qm "the card\'s work"', { cwd: dir, shell: posixShell() });
      const startedAt = await reviewerBegins();
      fs.appendFileSync(path.join(dir, 'src/feature.js'), 'const oneMore = 1;\n');
      await reviewed(id, dir, { startedAt });
      const c = await leave(id);
      expect(c.outcome).toBe('pass');
      expect(c.detail).toMatch(/1 line\(s\) of follow-up/);
    });

    it('counts a test file removed after the reviewer began', async () => {
      const { dir, id } = await atLook();
      write(dir, 'tests/extra.test.js', lines(30, 't'));
      execSync('git add -A && git commit -qm "more tests"', { cwd: dir, shell: posixShell() });
      const startedAt = await reviewerBegins();
      fs.rmSync(path.join(dir, 'tests/extra.test.js'));
      await reviewed(id, dir, { startedAt });
      const c = await leave(id);
      expect(c.outcome).toBe('fail');
      expect(c.detail).toMatch(/tests\/extra\.test\.js/);
    });

    it('lets a small fix pass as follow-up', async () => {
      const { dir, id } = await atLook();
      const startedAt = await reviewerBegins();
      write(dir, 'src/fix.js', lines(3));
      await reviewed(id, dir, { startedAt });
      expect((await leave(id)).outcome).toBe('pass');
    });

    it('small fixes re-recorded one by one add up: the allowance is not per record', async () => {
      const { dir, id } = await atLook();
      const startedAt = await reviewerBegins();
      for (let i = 0; i < 4; i++) {
        write(dir, `src/fix${i}.js`, lines(18, `f${i}`));
        await reviewed(id, dir, { startedAt, agent: 'first' });
      }
      expect((await leave(id)).detail).toMatch(/72 lines changed after the reviewer began/);
    });
  });
});
