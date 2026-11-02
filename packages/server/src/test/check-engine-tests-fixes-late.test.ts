/**
 * @file The check-engine end-to-end tests (check-engine-tests.test.ts), CGLAB-420, fixes-reviewed: the second half.
 * Split out so the parts run side by side (GH-274); the harness is helpers/engineTests.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { storage } from '../server';
import { posixShell } from './helpers/posixShell';

vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  mockAxios.create = vi.fn(() => mockAxios);
  return { default: mockAxios };
});

import {
  AUTHOR,
  agent,
  atLook,
  engineHome,
  internal,
  leave,
  lines,
  reviewed,
  reviewerBegins,
  useEngineServer,
  validate,
  write,
} from './helpers/engineTests';

useEngineServer('check-engine-tests-fixes-late-test-db.sqlite');

describe('CGLAB-420: field findings from CGLAB-419', () => {
  describe('fixes-reviewed: the fixes to a review\'s findings are flagged, not certified', () => {
    it('rolling back to fix and coming back to review does not clear it', async () => {
      const { dir, id } = await atLook();
      const startedAt = await reviewerBegins();
      await storage.updateItem(id, { status: 'TIDY' } as any);
      write(dir, 'src/fix.js', lines(60));
      expect((await validate(id, AUTHOR)).status).toBe(200); // back on LOOK
      await reviewed(id, dir, { startedAt, agent: 'first' });
      expect((await leave(id)).outcome).toBe('fail');
    });

    it('clears once a reviewer that began after the fixes records its review', async () => {
      const { dir, id } = await atLook();
      const startedAt = await reviewerBegins();
      write(dir, 'src/fix.js', lines(30));
      await reviewed(id, dir, { startedAt, agent: 'first' });
      await reviewed(id, dir, { startedAt: await reviewerBegins(), agent: 'second' });
      expect((await leave(id)).outcome).toBe('pass');
    });

    it('a reviewer given a new message after the fixes has read them; a note the harness injects is no such message', async () => {
      const { dir, id } = await atLook();
      const startedAt = await reviewerBegins();
      write(dir, 'src/fix.js', lines(30));
      const tdir = path.join(engineHome(), '.claude', 'projects', '-repo', 'sess', 'subagents');
      await reviewed(id, dir, { startedAt, agent: 'first', promptedAt: await reviewerBegins() });
      expect((await leave(id)).outcome).toBe('pass');
      // The same shape, but the late "prompt" is a hand-back reminder the harness injected.
      const { dir: d2, id: id2 } = await atLook();
      const s2 = await reviewerBegins();
      write(d2, 'src/fix.js', lines(30));
      await reviewed(id2, d2, { startedAt: s2, agent: 'third' });
      const t = path.join(tdir, 'agent-third.jsonl');
      const later = await reviewerBegins();
      const recs = fs.readFileSync(t, 'utf8').trim().split('\n');
      recs.splice(1, 0, JSON.stringify({ isSidechain: true, agentId: 'third', sessionId: 'sess', timestamp: later, type: 'user', isMeta: true, message: { content: '[handback-send-enforce] Your report has not been delivered' } }));
      fs.writeFileSync(t, recs.join('\n') + '\n');
      const rr = await agent().post(`/items/${id2}/review-records`).set(internal()).send({ transcript: t, range: `${execSync('git rev-list --max-parents=0 HEAD', { cwd: d2, encoding: 'utf8' }).trim()}..HEAD`, findings: [] });
      expect(rr.status, JSON.stringify(rr.body)).toBe(201);
      expect((await leave(id2)).outcome).toBe('fail');
    });

    it('main merged in during the review is not the card\'s work', async () => {
      const { dir, id } = await atLook();
      const startedAt = await reviewerBegins();
      execSync('git checkout -q -b upstream', { cwd: dir });
      write(dir, 'src/theirs.js', lines(50, 'theirs'));
      execSync('git add src/theirs.js && git commit -qm "main moved on" && git update-ref refs/remotes/origin/main HEAD && git checkout -q main && git merge -q --no-edit upstream', { cwd: dir, shell: posixShell() });
      await reviewed(id, dir, { startedAt });
      expect((await leave(id)).outcome).toBe('pass');
    });
  });
});
