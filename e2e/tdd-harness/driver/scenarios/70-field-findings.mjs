/**
 * BUG d26832d6 (CGLAB-415): what a real card met on the shipped TDD flow, one
 * scenario per finding. The field case was marketing-lab: a monorepo whose
 * suites run in subdirectories, a report command that writes several files
 * into a report directory nobody had ignored yet, and a no-op REFACTOR.
 *
 * Every project's report command is wrapped to count its runs (the counter
 * lives outside the tree, so counting never changes what a run sees): a
 * scenario about wasted runs reads how many suites a verify started.
 *
 * `expected` is what the check SHOULD do; the findings are the gaps.
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { newProject, newCard, card, verify, update, write, setTestReport, outcomeOf, verdictOf } from '../cards.mjs';
import { board, AUTHOR, transcript, record, firstCommit } from '../gates.mjs';
import { sh, cli } from '../lib.mjs';
import { RUNNERS, kit } from '../runners.mjs';

const { TDD_FLOW_PRESET } = createRequire(import.meta.url)('/agenfk/packages/core/dist/index.js');
const BRANCH = 'feat/ABC-7_findings';

let seq = 0;
/** A report command that counts its runs in a file outside the tree. */
function counted(command) {
  mkdirSync('/work/runs', { recursive: true });
  const file = `/work/runs/c${++seq}`;
  return { file, command: `echo run >> ${file} && ${command}` };
}
const runsOf = file => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0);

/**
 * A project on the shipped TDD flow whose report command is counted. `report`
 * overrides the runner's report setting; `files` the sample.
 */
async function tddProject({ runner = 'node', files, report = {} } = {}) {
  const k = kit(runner);
  const project = await newProject({ steps: TDD_FLOW_PRESET.steps, runner, files: files ?? k.sample(), testReport: false });
  const c = counted(report.command ?? RUNNERS[runner].command);
  const { command: _ignored, ...rest } = report;
  const setting = { ...RUNNERS[runner].report, ...(RUNNERS[runner].surface ? { surface: RUNNERS[runner].surface } : {}), ...rest, command: c.command };
  const r = await setTestReport(project.id, setting);
  if (r.status >= 300) throw new Error(`test report refused (${r.status}): ${JSON.stringify(r.body)}`);
  const id = await newCard(project, { title: 'field finding' });
  return { project, id, dir: project.dir, k, counter: c.file, setting, runs: () => runsOf(c.file) };
}

/** What an honest agent does on each step before verifying off it (the shipped flow's own order). */
const HONEST = {
  TODO: async ({ id, dir }) => { await update(id, { jiraItem: 'ABC-7', branchName: BRANCH }); sh(`git checkout -q -b ${BRANCH}`, dir); },
  DISCOVERY: async ({ id }) => {
    const a = await board('POST', `/items/${id}/approvals`, { step: 'DISCOVERY', note: 'scope agreed' });
    if (a.status !== 201) throw new Error(`approval refused (${a.status}): ${JSON.stringify(a.body)}`);
  },
  CREATE_UNIT_TESTS: ({ dir, k }) => write(dir, k.tests('extra', [['multiplies', 'red']])),
  IN_PROGRESS: ({ dir, k }) => write(dir, k.implement()),
  // REFACTOR: "no refactoring needed" - the step changes nothing.
  REVIEW: async ({ id, dir, k }) => {
    const r = await record(id, { transcript: transcript(), range: `${firstCommit(dir)}..HEAD` });
    if (r.status !== 201) throw new Error(`review refused (${r.status}): ${JSON.stringify(r.body)}`);
    sh(`git add ${k.src} ${k.paths.extra}`, dir);
  },
};

/** Writes into the tree on its FIRST run only - as a report directory nobody had ignored appears once. */
const FIRST_RUN_WRITES = `[ -f gen/stamp.txt ] || { mkdir -p gen && date +%s%N > gen/stamp.txt; }; ${RUNNERS.node.command}`;

const blockers = c => (c.lastChecks?.results ?? []).filter(x => x.blocking).map(x => `${x.id}: ${x.detail}`).join(' | ');

/** Verify the card off each step, doing `work[step]` (or the honest default) first, until it is on `until`. */
async function drive(ctx, until, work = {}) {
  for (let guard = 0; guard < 12; guard++) {
    const on = (await card(ctx.id)).status;
    if (on === until) return;
    const w = on in work ? work[on] : HONEST[on];
    if (w) await w(ctx);
    const r = await verify(ctx.id, { actor: AUTHOR, evidence: `harness: ${on} done` });
    const c = await card(ctx.id);
    if (c.status === on) throw new Error(`${on} -> next refused (${r.status}): ${blockers(c) || JSON.stringify(r.body).slice(0, 300)}`);
  }
  throw new Error(`the card never reached ${until}`);
}

/** Verify once and report how many suites it ran and where the card went. */
async function verifyCounting(ctx) {
  const before = ctx.runs();
  const from = (await card(ctx.id)).status;
  await verify(ctx.id, { actor: AUTHOR, evidence: 'harness' });
  const c = await card(ctx.id);
  return { ran: ctx.runs() - before, moved: c.status !== from, card: c, from };
}
const noRun = ({ ran, moved, card: c, from }) => ({
  actual: ran === 0 && moved ? 'no-run' : moved ? `ran ${ran}` : `held on ${from}`,
  detail: `${ran} suite run(s); card on ${c.status}${moved ? '' : `: ${blockers(c)}`}`,
});

/** Every check verify recorded, as a scenario reads it. */
const hollowOf = c => (c.lastChecks?.results ?? []).filter(x => x.outcome === 'n/a' || x.outcome === 'unavailable');

export const scenarios = [
  // ── #0: the suite runs only where code or tests changed ──────────────────
  {
    check: 'run-economy',
    name: 'a no-op REFACTOR runs no suite: its exit reuses the green its entry recorded',
    expected: 'no-run',
    run: async () => { const ctx = await tddProject(); await drive(ctx, 'REFACTOR'); return noRun(await verifyCounting(ctx)); },
  },
  {
    check: 'run-economy',
    name: 'rolling back and re-entering on an unchanged tree runs no suite (the rollback keeps the greens it can reuse)',
    expected: 'no-run',
    run: async () => {
      const ctx = await tddProject();
      await drive(ctx, 'REFACTOR');
      const back = await update(ctx.id, { status: 'IN_PROGRESS' });
      if (back.status >= 300) throw new Error(`rollback refused (${back.status}): ${JSON.stringify(back.body)}`);
      const before = ctx.runs();
      const first = await verifyCounting(ctx);
      if (!first.moved) return { actual: `held on ${first.from}`, detail: blockers(first.card) };
      const second = await verifyCounting(ctx);
      return noRun({ ...second, ran: ctx.runs() - before });
    },
  },
  {
    check: 'run-economy',
    // A suite can read .gitignore (d26832d6 review): a green from before it changed is not one of the content after.
    name: 'a .gitignore change is content: the suite runs again',
    expected: 'ran 1',
    run: async () => {
      const ctx = await tddProject();
      await drive(ctx, 'REFACTOR');
      write(ctx.dir, { '.gitignore': `${readFileSync(`${ctx.dir}/.gitignore`, 'utf8')}# tidied\n` });
      return noRun(await verifyCounting(ctx));
    },
  },
  {
    check: 'run-economy',
    name: 'declaring a test path that adds no test file re-reads the last report instead of running the suite',
    expected: 'no-run',
    run: async () => {
      const ctx = await tddProject();
      await drive(ctx, 'REFACTOR');
      // The field case: test paths declared with the tree untouched (a directory that is already there).
      const r = await setTestReport(ctx.project.id, { ...ctx.setting, surface: [...(ctx.setting.surface ?? []), 'src'] });
      if (r.status >= 300) throw new Error(`surface refused (${r.status}): ${JSON.stringify(r.body)}`);
      // Only whether a suite ran: what the checks then conclude about the new surface is theirs.
      const { ran, card: c } = await verifyCounting(ctx);
      return { actual: ran === 0 ? 'no-run' : `ran ${ran}`, detail: `card on ${c.status}` };
    },
  },
  {
    check: 'run-economy',
    name: 'the next card leaves DISCOVERY on the green the last card closed on, without running the suite',
    expected: 'no-run',
    run: async () => {
      const ctx = await tddProject();
      await drive(ctx, 'DONE');
      const next = await newCard(ctx.project, { title: 'the next card' });
      const nctx = { ...ctx, id: next };
      await drive(nctx, 'DISCOVERY', { TODO: async ({ id, dir }) => { await update(id, { jiraItem: 'ABC-8', branchName: 'feat/ABC-8_next' }); sh('git checkout -q -b feat/ABC-8_next', dir); } });
      await HONEST.DISCOVERY(nctx);
      return noRun(await verifyCounting(nctx));
    },
  },

  // ── #1 / #2: a capture that failed never passes for one that measured ────
  {
    check: 'entry-baseline',
    name: 'a baseline the run could not tie to its tree (the command wrote into it) holds the card on DISCOVERY',
    expected: 'unavailable',
    run: async () => {
      // The run writes a file outside the report: the tree changes under it.
      const ctx = await tddProject({ report: { command: FIRST_RUN_WRITES } });
      await drive(ctx, 'DISCOVERY');
      await HONEST.DISCOVERY(ctx);
      const r = await verify(ctx.id, { actor: AUTHOR });
      const c = await card(ctx.id);
      const o = outcomeOf(c, 'entry-baseline', 'DISCOVERY');
      return { actual: verdictOf(o, c.status !== 'DISCOVERY'), detail: `${o.detail ?? ''} [verify ${r.status}, card on ${c.status}]` };
    },
  },
  {
    check: 'some-new-test-red',
    name: 'with no usable entry baseline, the red-test check never passes soft: the card is held, or it judges a real baseline',
    expected: 'not-soft',
    run: async () => {
      const ctx = await tddProject({ report: { command: FIRST_RUN_WRITES } });
      await drive(ctx, 'DISCOVERY');
      await HONEST.DISCOVERY(ctx);
      await verify(ctx.id, { actor: AUTHOR });
      // Whether or not the entry hold let it go, the step's own checks must not pass on nothing.
      if ((await card(ctx.id)).status === 'DISCOVERY') {
        const o = await (await import('../lib.mjs')).api('POST', `/items/${ctx.id}/overrides`, { checkId: 'entry-baseline', reason: 'harness: see the step verdict' }, { board: true });
        if (o.status !== 201) return { actual: 'not-soft', detail: 'held on DISCOVERY by entry-baseline' };
        await verify(ctx.id, { actor: AUTHOR });
      }
      write(ctx.dir, ctx.k.tests('extra', [['multiplies', 'red']]));
      const r = await verify(ctx.id, { actor: AUTHOR });
      const c = await card(ctx.id);
      const o = outcomeOf(c, 'some-new-test-red', 'CREATE_UNIT_TESTS');
      const v = verdictOf(o, c.status !== 'CREATE_UNIT_TESTS');
      return { actual: v === 'unavailable-soft' || v === 'absent' ? v : 'not-soft', detail: `${v}: ${o.detail ?? ''} [verify ${r.status}, card on ${c.status}]` };
    },
  },

  // ── #3 / #4 / #5: agenfk's own report directory is not the card's work ───
  {
    check: 'report-dir',
    name: 'an unignored report directory the command writes several files into: the whole cycle judges every check',
    expected: 'done',
    run: async () => {
      const k = kit('node');
      const files = { ...k.sample(), '.gitignore': 'node_modules/\n' };
      const ctx = await tddProject({ files, report: { command: `${RUNNERS.node.command} && echo '<x/>' > .reports/side.xml` } });
      const trail = [];
      for (let guard = 0; guard < 10; guard++) {
        const on = (await card(ctx.id)).status;
        if (on === 'DONE') return { actual: 'done', detail: trail.join(', ') };
        if (HONEST[on]) await HONEST[on](ctx);
        const v = await verify(ctx.id, { actor: AUTHOR, evidence: `harness: ${on}` });
        const c = await card(ctx.id);
        const results = c.lastChecks?.step === on ? c.lastChecks.results ?? [] : [];
        trail.push(`${on}->${c.status}`);
        // agenfk's own report is never offered to the agent as unstaged work of the card.
        if (c.status === 'DONE' && /`\.reports\//.test(String(v.body?.message ?? ''))) return { actual: 'report-offered-to-stage', detail: String(v.body.message).slice(0, 400) };
        if (c.status === on) return { actual: `stuck on ${on}`, detail: `${blockers(c)} [${trail.join(', ')}]` };
        const hollow = results.filter(x => x.outcome === 'n/a' || x.outcome === 'unavailable');
        if (hollow.length) return { actual: `hollow on ${on}`, detail: `${hollow.map(x => `${x.id}: ${x.detail}`).join(' | ')} [${trail.join(', ')}]` };
      }
      return { actual: 'never finished', detail: trail.join(', ') };
    },
  },

  // ── #20: a rollback cannot launder a change to the tests ─────────────────
  {
    check: 'test-set-identical',
    name: 'a test renamed on REFACTOR, then a rollback and re-entry: the swap is still caught',
    expected: 'fail',
    run: async () => {
      const ctx = await tddProject();
      await drive(ctx, 'REFACTOR');
      write(ctx.dir, ctx.k.mathRenamed());
      await update(ctx.id, { status: 'IN_PROGRESS' });
      await verify(ctx.id, { actor: AUTHOR });
      if ((await card(ctx.id)).status !== 'REFACTOR') {
        const c = await card(ctx.id);
        return { actual: 'fail', detail: `held on ${c.status} before REFACTOR: ${blockers(c)}` };
      }
      await verify(ctx.id, { actor: AUTHOR });
      const c = await card(ctx.id);
      const o = outcomeOf(c, 'test-set-identical', 'REFACTOR');
      const all = (c.lastChecks?.results ?? []).map(x => `${x.id}:${x.outcome}${x.blocking ? '!' : ''}`).join(' ');
      return { actual: verdictOf(o, c.status !== 'REFACTOR'), detail: `${o.detail ?? ''} [card on ${c.status}; ${all}]` };
    },
  },

  // ── #16: a suite that runs in a subdirectory names its files from there ──
  {
    check: 'test-surface-frozen',
    name: 'vitest run inside app/ names its files relative to app/: the surface still resolves, no path declared',
    expected: 'pass',
    run: async () => {
      const k = kit('vitest');
      const sample = k.sample();
      const files = { '.gitignore': '.reports/\nnode_modules/\n', 'package.json': sample['package.json'] };
      for (const [f, t] of Object.entries(sample)) if (f !== '.gitignore' && f !== 'package.json') files[`app/${f}`] = t;
      files['app/package.json'] = sample['package.json'];
      const command = 'cd app && node ../node_modules/vitest/vitest.mjs run --reporter=junit --outputFile=../.reports/junit.xml';
      const ctx = await tddProject({ runner: 'vitest', files, report: { format: 'junit-xml', reportPath: '.reports/junit.xml', command } });
      const appKit = { ...ctx.k, src: `app/${ctx.k.src}`, paths: Object.fromEntries(Object.entries(ctx.k.paths).map(([n, p]) => [n, `app/${p}`])),
        tests: (f, t) => Object.fromEntries(Object.entries(ctx.k.tests(f, t)).map(([p, s]) => [`app/${p}`, s])),
        implement: () => Object.fromEntries(Object.entries(ctx.k.implement()).map(([p, s]) => [`app/${p}`, s])) };
      const actx = { ...ctx, k: appKit };
      await drive(actx, 'REFACTOR');
      await verify(ctx.id, { actor: AUTHOR });
      const c = await card(ctx.id);
      const o = outcomeOf(c, 'test-surface-frozen', 'REFACTOR');
      return { actual: verdictOf(o, c.status !== 'REFACTOR'), detail: `${o.detail ?? ''} [card on ${c.status}]` };
    },
  },

  // ── #6: two suites, two reports, one project ─────────────────────────────
  {
    check: 'multi-report',
    name: 'node and pytest suites writing two JUnit reports: the card goes through with every per-test check judged',
    expected: 'done',
    run: async () => {
      const node = kit('node'), py = kit('pytest');
      const files = { ...node.sample(), ...py.sample(), '.gitignore': '.reports/\n__pycache__/\n' };
      const command = `mkdir -p .reports && ${RUNNERS.node.command.replace('.reports/junit.xml', '.reports/node.xml')}; a=$?; ${RUNNERS.pytest.command.replace('.reports/junit.xml', '.reports/py.xml')}; b=$?; exit $((a|b))`;
      const ctx = await tddProject({ files, report: { format: 'junit-xml', reportPath: ['.reports/node.xml', '.reports/py.xml'], surface: ['test', 'tests'], command } });
      for (let guard = 0; guard < 10; guard++) {
        const on = (await card(ctx.id)).status;
        if (on === 'DONE') return { actual: 'done', detail: 'ok' };
        if (HONEST[on]) await HONEST[on](ctx);
        await verify(ctx.id, { actor: AUTHOR, evidence: `harness: ${on}` });
        const c = await card(ctx.id);
        if (c.status === on) return { actual: `stuck on ${on}`, detail: blockers(c) };
        const hollow = hollowOf(c);
        if (hollow.length) return { actual: `hollow on ${on}`, detail: hollow.map(x => `${x.id}: ${x.detail}`).join(' | ') };
      }
      return { actual: 'never finished', detail: '' };
    },
  },

  // ── #8 / #9 / #15: what the CLI says (a refusal's non-zero exit is a guard: it already holds) ────────────────────────────────
  {
    check: 'cli-verify',
    name: 'a refused agenfk verify exits non-zero',
    expected: 'nonzero',
    run: async () => {
      const ctx = await tddProject();
      await drive(ctx, 'CREATE_UNIT_TESTS');
      // No new test: some-new-test-red refuses.
      const r = cli(['verify', ctx.id, '--evidence', 'harness: nothing written'], { cwd: ctx.dir });
      const c = await card(ctx.id);
      return { actual: c.status !== 'CREATE_UNIT_TESTS' ? 'moved' : r.code === 0 ? 'zero' : 'nonzero', detail: `exit ${r.code}; ${r.out.slice(-300)}` };
    },
  },
  {
    check: 'cli-verify',
    name: 'agenfk verify prints every check it judged - soft, warn and pass included - on a pass',
    expected: 'all-listed',
    run: async () => {
      const ctx = await tddProject();
      await drive(ctx, 'IN_PROGRESS');
      write(ctx.dir, ctx.k.implement());
      const r = cli(['verify', ctx.id, '--evidence', 'harness: implemented'], { cwd: ctx.dir });
      const c = await (await import('../lib.mjs')).api('GET', `/items/${ctx.id}`);
      const judged = (c.body?.stepRecords ?? []).filter(x => x?.kind === 'checks').pop()?.results ?? [];
      const ids = judged.length ? judged.map(x => x.id) : ['suite-green', 'red-set-passes-by-name', 'test-count-not-lower', 'on-card-branch'];
      const missing = ids.filter(id => !r.out.includes(id));
      return { actual: r.code === 0 && !missing.length ? 'all-listed' : `missing ${missing.join(',') || '(exit ' + r.code + ')'}`, detail: r.out.slice(-500) };
    },
  },
  {
    check: 'cli-verify',
    name: 'the verdict is the last thing agenfk verify prints, after the suite output and every check',
    expected: 'verdict-last',
    run: async () => {
      const ctx = await tddProject();
      await drive(ctx, 'CREATE_UNIT_TESTS');
      const r = cli(['verify', ctx.id, '--evidence', 'harness: nothing written'], { cwd: ctx.dir });
      const lines = r.out.split('\n').map(l => l.trim()).filter(Boolean);
      const last = lines[lines.length - 1] ?? '';
      const blockAt = lines.findIndex(l => l.includes('some-new-test-red'));
      const ok = /refused|cannot leave|stays on/i.test(last) && blockAt >= lines.length - 6;
      return { actual: ok ? 'verdict-last' : 'buried', detail: `last: ${last} | block line at ${blockAt}/${lines.length}` };
    },
  },

  // ── #11: the gatekeeper names the step's role ────────────────────────────
  {
    check: 'gatekeeper',
    name: 'the gatekeeper names the role of the step the card is on, not CODING everywhere',
    expected: 'role-named',
    run: async () => {
      const ctx = await tddProject();
      await drive(ctx, 'CREATE_UNIT_TESTS');
      const r = cli(['gatekeeper', '--intent', 'write tests', '--item-id', ctx.id], { cwd: ctx.dir });
      const first = r.out.split('\n')[0] ?? '';
      return { actual: /test-authoring|TEST.AUTHORING/i.test(first) && !/\(CODING\)/.test(first) ? 'role-named' : 'wrong-role', detail: first };
    },
  },
];
