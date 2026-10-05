/**
 * CGLAB-420: the CGLAB-419 story replayed on the shipped TDD flow, the way the
 * field agent drove it - the real CLI for every task verify, a STORY with two
 * TASKs in one tree, a branch the agent made itself (none recorded on the
 * card), a born-green test on the first task, an independent review at the
 * story whose fixes were written after the reviewer read the diff, and a PR
 * opened with plain `gh pr create` then `agenfk pr-register`.
 *
 * The run happens once; each scenario reads one finding off it.
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { newProject, newCard, card, verify, update, write, checkOnWork } from '../cards.mjs';
import { board, transcript, record, firstCommit } from '../gates.mjs';
import { sh, cli, api } from '../lib.mjs';
import { kit } from '../runners.mjs';

const { TDD_FLOW_PRESET } = createRequire(import.meta.url)('/agenfk/packages/core/dist/index.js');
const SESSION = 'field-author';
const AUTHOR = { client: 'claude-code', sessionId: SESSION, agentId: null };

/** A `gh` that records what it was asked to do: the harness has no GitHub. */
function fakeGh() {
  mkdirSync('/work/fakebin', { recursive: true });
  writeFileSync('/work/fakebin/gh', '#!/bin/sh\nprintf "%s\\n" "$*" >> /work/gh-calls.txt\n[ "$1" = "--version" ] && echo "gh version 2.0.0"\nexit 0\n');
  chmodSync('/work/fakebin/gh', 0o755);
  if (!process.env.PATH.startsWith('/work/fakebin')) process.env.PATH = `/work/fakebin:${process.env.PATH}`;
}

/** `agenfk verify` as the field agent ran it: the real CLI, from the tree, as its Claude Code session. */
function agentVerify(id, dir, evidence, extra = []) {
  process.env.CLAUDE_CODE_SESSION_ID = SESSION;
  return cli(['verify', id, '--evidence', evidence, ...extra], { cwd: dir });
}

let once;
function simulate() {
  once ??= (async () => {
    const k = kit('node');
    const project = await newProject({ steps: TDD_FLOW_PRESET.steps, runner: 'node' });
    const { dir } = project;
    const story = await newCard(project, { type: 'STORY', title: 'show what needs a decision' });
    await update(story, { jiraItem: 'ABC-9' });
    const t1 = await newCard(project, { title: 'nav badges', parentId: story });
    const t2 = await newCard(project, { title: 'async ingest', parentId: story });
    const log = [];
    const out = {};

    // The story leaves TODO; a person approves its DISCOVERY on the board, which covers its tasks.
    await verify(story, { actor: AUTHOR, evidence: 'starting the story' });
    const a = await board('POST', `/items/${story}/approvals`, { step: 'DISCOVERY', note: 'go' });
    if (a.status !== 201) throw new Error(`approval refused (${a.status}): ${JSON.stringify(a.body)}`);

    const toTests = t => { for (let i = 0; i < 2; i++) log.push(agentVerify(t, dir, 'harness: next step').out.slice(-300)); };
    let arrived = null;
    /** Walk a task from IN_PROGRESS to its end, as the field agent did; note the reply that brings the story onto REVIEW. */
    const toEnd = async t => {
      for (let i = 0; i < 4 && (await card(t)).status !== 'DONE'; i++) {
        const before = (await card(story)).status;
        if ((await card(t)).status === 'REVIEW') sh('git add -A', dir);
        const r = agentVerify(t, dir, 'harness: step done');
        if (before !== 'REVIEW' && (await card(story)).status === 'REVIEW') arrived = r.out;
        log.push(r.out.slice(-300));
      }
    };

    // Task 1 starts, on the branch the agent makes itself (none is recorded on the card).
    toTests(t1);
    sh('git checkout -q -b feat/ABC-9_what-needs-a-decision', dir);
    // It writes a red test and a test that passes on arrival (the field's test_an_unknown_run_is_a_404).
    write(dir, k.tests('extra', [['multiplies', 'red'], ['addsAgain', 'green']]));
    const unanswered = agentVerify(t1, dir, 'harness: tests written');
    out.unanswered = { code: unanswered.code, out: unanswered.out, status: (await card(t1)).status };
    const answeredRun = agentVerify(t1, dir, 'harness: tests written', ['--check-note', 'new-tests-born-green=addsAgain pins add, which exists already']);
    out.answered = { code: answeredRun.code, out: answeredRun.out, status: (await card(t1)).status };
    write(dir, k.implement());
    await toEnd(t1);

    // Task 2 tests code that does not exist yet, loading it inside the test (the field's lib/activity case).
    toTests(t2);
    write(dir, { 'test/sub.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n\ntest('subtracts', async () => { const { sub } = await import('../src/extra.js'); assert.equal(sub(3, 1), 2); });\n" });
    log.push(agentVerify(t2, dir, 'harness: tests written', ['--check-note', 'red-is-assertion=src/extra.js is not written yet, so the red is a missing module until it is']).out.slice(-300));
    out.t2AfterTests = (await card(t2)).status;
    write(dir, k.codeChange());
    await toEnd(t2);
    out.arrived = arrived;
    out.storyAtReview = (await card(story)).status;

    // The review: a reviewer reads the diff, the agent fixes its findings (30 lines and a new test file), then records it.
    const range = `${firstCommit(dir)}..HEAD`;
    const startedAt = new Date().toISOString(); // the reviewer begins; the fixes come after
    await new Promise(r => setTimeout(r, 50));
    write(dir, {
      'src/fix.js': Array.from({ length: 30 }, (_, i) => `export const fix${i} = ${i};`).join('\n') + '\n',
      [k.paths.extra.replace('extra', 'late')]: k.render([['lateOne', 'green']], 'extra'),
    });
    const rec1 = await record(story, { transcript: transcript({ sessionId: 'the-author-session', agentId: 'reviewer-1', startedAt }), range });
    if (rec1.status !== 201) throw new Error(`review refused (${rec1.status}): ${JSON.stringify(rec1.body)}`);
    sh('git add -A', dir);
    const done = await verify(story, { actor: AUTHOR, evidence: 'harness: reviewed' });
    out.afterFixes = await card(story);
    out.closed = { status: out.afterFixes.status, body: done.body };
    out.warnings = (await api('GET', `/items/${story}/warnings`)).body;

    // The PR, as the field agent opened it: plain gh pr create, then pr-register.
    fakeGh();
    const reg = cli(['pr-register', '--item', story, '--number', '141', '--repo', 'acme/lab', '--epic', '0', '--story', '1', '--task', '2', '--bug', '0',
      '--model', 'claude-opus-5-5', '--harness', 'claude-code', '--no-detect-model'], { cwd: dir });
    out.prRegister = { code: reg.code, out: reg.out, gh: existsSync('/work/gh-calls.txt') ? readFileSync('/work/gh-calls.txt', 'utf8') : '' };
    out.log = log;
    return out;
  })();
  return once;
}

const checks = c => c?.lastChecks?.results ?? [];
const byId = (c, id) => checks(c).find(r => r.id === id);

export const scenarios = [
  {
    check: 'new-tests-born-green',
    name: 'CGLAB-419 replay: a born-green test holds the task on CREATE_UNIT_TESTS until the agent answers it',
    expected: 'held-then-answered',
    run: async () => {
      const s = await simulate();
      const held = s.unanswered.status === 'CREATE_UNIT_TESTS' && s.unanswered.code !== 0 && /--check-note new-tests-born-green=/.test(s.unanswered.out);
      const moved = s.answered.status === 'IN_PROGRESS';
      return { actual: held && moved ? 'held-then-answered' : `held=${held} moved=${moved}`, detail: `${s.unanswered.out.slice(-400)} || ${s.answered.out.slice(-300)}` };
    },
  },
  {
    check: 'tree-warnings',
    name: 'CGLAB-419 replay: the verify that brings the story to REVIEW hands the reviewer the tasks\' warnings, with the answer',
    expected: 'briefed',
    run: async () => {
      const s = await simulate();
      const ok = s.storyAtReview === 'REVIEW' && !!s.arrived && /reviewer/.test(s.arrived) && /addsAgain/.test(s.arrived) && /pins add/.test(s.arrived);
      return { actual: ok ? 'briefed' : 'not-briefed', detail: (s.arrived ?? `story on ${s.storyAtReview}; task 2 after its tests on ${s.t2AfterTests}; no verify brought it to REVIEW. ${s.log.slice(-3).join(' || ')}`).slice(-900) };
    },
  },
  {
    check: 'fixes-reviewed',
    name: 'CGLAB-419 replay: a review recorded after 30 lines of fixes it never saw is flagged, naming them',
    expected: 'warn',
    run: async () => {
      const s = await simulate();
      const r = byId(s.afterFixes, 'fixes-reviewed');
      const flagged = r?.outcome === 'fail' && !r.blocking && /lines changed after the reviewer began/.test(r.detail) && /fix\.js/.test(r.detail);
      return { actual: flagged ? 'warn' : `${r?.outcome}`, detail: r?.detail ?? '' };
    },
  },
  {
    check: 'fixes-reviewed',
    name: 'fixes-reviewed passes when nothing changed after the reviewer began',
    expected: 'pass',
    run: async () => checkOnWork('fixes-reviewed', {
      prepare: async ({ id, dir }) => {
        const r = await record(id, { transcript: transcript({ sessionId: 'a-clean-review', agentId: 'clean' }), range: `${firstCommit(dir)}..HEAD` });
        if (r.status !== 201) throw new Error(`review refused (${r.status}): ${JSON.stringify(r.body)}`);
      },
    }),
  },
  {
    check: 'tests-added-late',
    name: 'CGLAB-419 replay: at the story, tests-added-late reads the tasks\' frozen tests and names the test file the fixes added',
    expected: 'late-named',
    run: async () => {
      const s = await simulate();
      const r = byId(s.afterFixes, 'tests-added-late');
      const named = r?.outcome === 'fail' && /late\.test/.test(r.detail) && !/extra\.test|more\.test/.test(r.detail);
      return { actual: named ? 'late-named' : `${r?.outcome}`, detail: r?.detail ?? '' };
    },
  },
  {
    check: 'review-record',
    name: 'CGLAB-419 replay: the story closes on its independent review, the flag on its record',
    expected: 'closed',
    run: async () => {
      const s = await simulate();
      return { actual: s.closed.status === 'DONE' ? 'closed' : `on ${s.closed.status}`, detail: JSON.stringify(s.closed.body).slice(0, 500) };
    },
  },
  {
    check: 'on-card-branch',
    name: 'CGLAB-419 replay: with no branch recorded, on-card-branch says the tree is on the card\'s own branch',
    expected: 'judged',
    run: async () => {
      const s = await simulate();
      const r = byId(s.afterFixes, 'on-card-branch');
      return { actual: r?.outcome === 'pass' && /carries ABC-9/.test(r.detail) ? 'judged' : `${r?.outcome}`, detail: r?.detail ?? '' };
    },
  },
  {
    check: 'tree-warnings',
    name: 'CGLAB-419 replay: the story\'s review step lists its tasks\' warnings, and lets it go (a warning)',
    expected: 'warn',
    run: async () => {
      const s = await simulate();
      const r = byId(s.afterFixes, 'tree-warnings');
      const actual = r?.outcome === 'fail' && !r.blocking && /addsAgain/.test(r.detail) && /answered/.test(r.detail) ? 'warn' : `${r?.outcome}`;
      return { actual, detail: r?.detail ?? '' };
    },
  },
  {
    check: 'tree-warnings',
    name: 'tree-warnings passes on a card whose tree raised no warning',
    expected: 'pass',
    run: async () => checkOnWork('tree-warnings'),
  },
  {
    check: 'on-card-branch',
    name: 'a card on another card\'s branch is held, when no branch is recorded',
    expected: 'held',
    run: async () => {
      const project = await newProject({ steps: TDD_FLOW_PRESET.steps, runner: 'node' });
      const id = await newCard(project, { title: 'wrong branch' });
      await update(id, { jiraItem: 'ABC-10' });
      sh('git checkout -q -b feat/OTHER-3_theirs', project.dir);
      await verify(id, { actor: AUTHOR, evidence: 'starting' });
      const c = await card(id);
      const r = byId(c, 'on-card-branch');
      return { actual: c.status === 'TODO' && r?.blocking ? 'held' : `on ${c.status}: ${r?.outcome}`, detail: r?.detail ?? '' };
    },
  },
  {
    check: 'tree-warnings',
    name: 'CGLAB-419 replay: pr-register after a plain gh pr create posts the check history on the PR',
    expected: 'posted',
    run: async () => {
      const s = await simulate();
      const posted = s.prRegister.code === 0 && /pr comment 141 --repo acme\/lab/.test(s.prRegister.gh) && /AgEnFK check history/.test(s.prRegister.gh) && /new-tests-born-green/.test(s.prRegister.gh) && /fixes-reviewed/.test(s.prRegister.gh);
      return { actual: posted ? 'posted' : 'not-posted', detail: `${s.prRegister.out.slice(-300)} || gh: ${s.prRegister.gh.slice(0, 400)}` };
    },
  },
];
