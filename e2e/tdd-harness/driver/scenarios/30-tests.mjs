/**
 * The 13 test checks, on every runner in runners.mjs: each scenario runs once
 * per runner, and says so in its name ("[pytest] ..."). HARNESS_RUNNERS=a,b
 * runs only those runners.
 *
 * Two flows. Checks that judge the step where tests are written sit on SPECS,
 * alone; checks that judge the code sit on CODE, after a SPECS step whose
 * some-new-test-red produces the red set, the frozen surface and the authored
 * test names. Leaving TODO captures the suite when SPECS reads an entry record,
 * so SPECS starts from the sample's own two green tests.
 *
 * A scenario's expected outcome is what the check SHOULD do. Where a runner
 * cannot express a case the way the others do, it says so beside the runner.
 */
import { walk, setTestReport } from '../cards.mjs';
import { RUNNER_NAMES } from '../runners.mjs';

const steps = ({ specs, code } = {}) => [
  { name: 'TODO', label: 'To Do', order: 0, isAnchor: true },
  { name: 'SPECS', label: 'Specs', order: 1, ...(specs ? { checks: specs } : {}) },
  { name: 'CODE', label: 'Code', order: 2, ...(code ? { checks: code } : {}) },
  { name: 'NEXT', label: 'Next', order: 3 },
  { name: 'DONE', label: 'Done', order: 4, isAnchor: true },
];
const RED_SPECS = [{ id: 'some-new-test-red' }];

// What the card does on a step, in the runner's own idiom.
const addRed = ({ write, kit }) => write(kit.tests('extra', [['multiplies', 'red']]));
const addGreen = ({ write, kit }) => write(kit.tests('extra', [['addsAgain', 'green']]));
const addError = ({ write, kit }) => write(kit.tests('extra', [['explodes', 'error']]));
const addBroken = ({ write, kit }) => write(kit.brokenFile());
const changeCode = ({ write, kit }) => write(kit.codeChange());
const implement = ({ write, kit }) => write(kit.implement());
const all = (...fns) => async ctx => { for (const f of fns) await f(ctx); };
/** A report the server cannot use: the path leaves the tree, so the capture has a parse error. */
const breakReport = ({ project, kit }) => setTestReport(project.id, { ...kit.report, reportPath: '../outside.xml', command: kit.command });

/** On SPECS alone. */
const specs = (check, name, expected, { params, severity, ...opts } = {}) => ({
  check, name, expected,
  opts: { steps: steps({ specs: [{ id: check, ...(params ? { params } : {}), ...(severity ? { severity } : {}) }] }), at: 'SPECS', ...opts },
});
/** On CODE, after SPECS wrote a red test. */
const code = (check, name, expected, { params, work = {}, ...opts } = {}) => ({
  check, name, expected,
  opts: { steps: steps({ specs: RED_SPECS, code: [{ id: check, ...(params ? { params } : {}) }] }), at: 'CODE', work: { SPECS: addRed, ...work }, ...opts },
});
const noReport = { project: { testReport: false }, passEntryHold: true };

// dotnet: a test file that does not compile fails the whole build, so there is
// no report to read at all - the capture is unusable, and a blocking check
// that cannot judge holds the card. That is the honest outcome there.
const BROKEN_DOTNET = { dotnet: 'unavailable' };

const cases = [
  // only-test-files-changed
  specs('only-test-files-changed', 'passes when only a test file was added', 'pass', { work: { SPECS: addRed } }),
  specs('only-test-files-changed', 'blocks a change to code in the step that writes tests', 'fail', { work: { SPECS: all(addRed, changeCode) } }),
  specs('only-test-files-changed', 'blocks a step where nothing changed', 'fail'),
  // Its soft unavailable (no entry commit) cannot be staged here: every advance
  // records the exit commit, checks or not, so only a card advanced by an older
  // server lacks one.
  specs('only-test-files-changed', 'blocks when git cannot read the tree', 'unavailable', { work: { SPECS: ({ sh }) => sh('rm -rf .git') } }),

  // no-broken-test-files
  specs('no-broken-test-files', 'passes when every test file loads', 'pass', { work: { SPECS: addRed } }),
  specs('no-broken-test-files', 'blocks a test file that fails to load', { default: 'fail', ...BROKEN_DOTNET }, { work: { SPECS: addBroken } }),
  specs('no-broken-test-files', 'blocks when there is no test report', 'unavailable', { ...noReport, work: { SPECS: addRed } }),

  // entry-baseline (5a8d22e6): the server's hold on the way INTO a step whose blocking checks need a per-test baseline
  { check: 'entry-baseline', name: 'holds the card on the way into a step whose blocking checks need per-test results the project cannot record', expected: 'unavailable',
    opts: { steps: steps({ specs: [{ id: 'new-tests-exist' }] }), at: 'TODO', project: { testReport: false } } },
  { check: 'entry-baseline', name: 'does not hold it when those checks would only warn there', expected: 'absent',
    opts: { steps: steps({ specs: [{ id: 'new-tests-born-green' }] }), at: 'TODO', project: { testReport: false } } },

  // new-tests-exist
  specs('new-tests-exist', 'passes when a test was added', 'pass', { work: { SPECS: addRed } }),
  specs('new-tests-exist', 'blocks when no test was added', 'fail', { work: { SPECS: changeCode } }),
  specs('new-tests-exist', 'blocks when there is no test report', 'unavailable', { ...noReport, work: { SPECS: addRed } }),
  specs('new-tests-exist', 'warns for a card that predates checks (no entry record)', 'unavailable-soft', { predates: true, work: { SPECS: addRed } }),

  // some-new-test-red
  specs('some-new-test-red', 'passes when a new test fails', 'pass', { work: { SPECS: addRed } }),
  specs('some-new-test-red', 'blocks when every new test already passes', 'fail', { work: { SPECS: addGreen } }),
  specs('some-new-test-red', 'does not count a test file that fails to load as a red test', { default: 'fail', ...BROKEN_DOTNET }, { work: { SPECS: addBroken } }),
  specs('some-new-test-red', 'blocks when there is no test report', 'unavailable', { ...noReport, work: { SPECS: addRed } }),
  specs('some-new-test-red', 'warns for a card that predates checks (no entry record)', 'unavailable-soft', { predates: true, work: { SPECS: addRed } }),

  // new-tests-born-green (warn by default)
  specs('new-tests-born-green', 'passes when the new tests are red', 'pass', { work: { SPECS: addRed } }),
  specs('new-tests-born-green', 'warns about a new test that already passes, and lets the card move', 'warn', { work: { SPECS: addGreen } }),
  specs('new-tests-born-green', 'blocks the same when the flow makes it blocking', 'fail', { severity: 'block', work: { SPECS: addGreen } }),
  specs('new-tests-born-green', 'cannot judge without a test report, and does not hold the card', 'unavailable-soft', { ...noReport, work: { SPECS: addGreen } }),

  // red-is-assertion (warn by default)
  specs('red-is-assertion', 'passes when the new test fails on an assertion', 'pass', { work: { SPECS: addRed } }),
  specs('red-is-assertion', 'warns when the new test fails with an error, not an assertion', 'warn', { work: { SPECS: addError } }),
  specs('red-is-assertion', 'cannot judge without a test report, and does not hold the card', 'unavailable-soft', { ...noReport, work: { SPECS: addError } }),

  // existing-tests-still-green
  specs('existing-tests-still-green', 'passes when the old tests still pass', 'pass', { work: { SPECS: addRed } }),
  specs('existing-tests-still-green', 'blocks when a test that passed now fails', 'fail', { work: { SPECS: ({ write, kit }) => write(kit.mathRed()) } }),
  specs('existing-tests-still-green', 'blocks when a test that passed is gone', 'fail', { work: { SPECS: ({ write, kit }) => write(kit.mathWithout()) } }),
  specs('existing-tests-still-green', 'blocks when there is no test report', 'unavailable', { ...noReport, work: { SPECS: addRed } }),
  specs('existing-tests-still-green', 'warns for a card that predates checks (no entry record)', 'unavailable-soft', { predates: true, work: { SPECS: addRed } }),

  // suite-green
  specs('suite-green', 'passes a green suite', 'pass'),
  specs('suite-green', 'blocks a red suite', 'fail', { work: { SPECS: addRed } }),
  specs('suite-green', 'blocks a suite with a test file that fails to load', { default: 'fail', ...BROKEN_DOTNET }, { work: { SPECS: addBroken } }),
  specs('suite-green', 'passes on the exit code when there is no test report', 'pass', noReport),
  specs('suite-green', 'blocks on the exit code when there is no test report', 'fail', { ...noReport, work: { SPECS: addRed } }),
  specs('suite-green', 'blocks when there is nothing to run', 'unavailable', { project: { testReport: false, verifyCommand: null } }),
  specs('suite-green', 'blocks when the report cannot be used', 'unavailable', { work: { SPECS: breakReport } }),

  // red-set-passes-by-name
  code('red-set-passes-by-name', 'passes when the red test now passes', 'pass', { work: { CODE: implement } }),
  code('red-set-passes-by-name', 'blocks while the red test still fails', 'fail'),
  code('red-set-passes-by-name', 'blocks when the red test was renamed, even though the suite is green', 'fail', {
    work: { CODE: all(implement, ({ write, kit }) => write(kit.tests('extra', [['multipliesRenamed', 'red']]))) },
  }),
  code('red-set-passes-by-name', 'warns for a card that predates checks (no red set)', 'unavailable-soft', { predates: true, work: { SPECS: addRed, CODE: implement } }),
  code('red-set-passes-by-name', 'blocks when the report cannot be used', 'unavailable', { work: { CODE: all(implement, breakReport) } }),

  // test-surface-frozen (append, since test-authoring) - added to the code step explicitly: no role brings it there since 1049ce52
  code('test-surface-frozen', 'passes when only code changed', 'pass', { work: { CODE: implement } }),
  code('test-surface-frozen', 'passes a new test file in append mode', 'pass', { work: { CODE: all(implement, ({ write, kit }) => write(kit.tests('more', [['addsMore', 'green']]))) } }),
  code('test-surface-frozen', 'blocks an edit to a test file written earlier', 'fail', { work: { CODE: all(implement, ({ write, kit }) => write(kit.touchMath())) } }),
  code('test-surface-frozen', 'blocks a deleted test file', 'fail', { work: { CODE: all(implement, ({ sh, kit }) => sh(`rm ${kit.paths.extra}`)) } }),
  code('test-surface-frozen', 'blocks a new test file in strict mode, since step entry', 'fail', {
    params: { mode: 'strict', since: 'step-entry' },
    work: { CODE: all(implement, ({ write, kit }) => write(kit.tests('more', [['addsMore', 'green']]))) },
  }),
  // node:test and xUnit reports name no file: without declared test paths the check cannot see the tests.
  code('test-surface-frozen', 'cannot see the tests when the report names no file and no test paths are declared', { default: 'pass', node: 'unavailable', dotnet: 'unavailable' }, {
    project: { declare: false }, work: { CODE: implement },
  }),
  code('test-surface-frozen', 'warns for a card that predates checks (no frozen surface)', 'unavailable-soft', { predates: true, work: { SPECS: addRed, CODE: implement } }),
  code('test-surface-frozen', 'blocks when the report cannot be used', 'unavailable', { work: { CODE: all(implement, breakReport) } }),

  // test-count-not-lower
  code('test-count-not-lower', 'passes when no test is gone', 'pass', { work: { CODE: implement } }),
  code('test-count-not-lower', 'blocks when a test is gone since the step began', 'fail', { work: { CODE: all(implement, ({ write, kit }) => write(kit.mathWithout())) } }),
  code('test-count-not-lower', 'blocks when a test is gone since the tests were written', 'fail', {
    params: { since: 'test-authoring' },
    work: { CODE: all(implement, ({ write, kit }) => write(kit.mathWithout())) },
  }),
  code('test-count-not-lower', 'warns for a card that predates checks (no entry record)', 'unavailable-soft', { predates: true, work: { SPECS: addRed, CODE: implement } }),

  // test-set-identical
  code('test-set-identical', 'passes when the tests are the same by name', 'pass', { work: { CODE: implement } }),
  code('test-set-identical', 'blocks an added test', 'fail', { work: { CODE: all(implement, ({ write, kit }) => write(kit.tests('more', [['addsMore', 'green']]))) } }),
  code('test-set-identical', 'blocks a renamed test, though the count is the same', 'fail', { work: { CODE: all(implement, ({ write, kit }) => write(kit.mathRenamed())) } }),
  code('test-set-identical', 'warns for a card that predates checks (no entry record)', 'unavailable-soft', { predates: true, work: { SPECS: addRed, CODE: implement } }),
  code('test-set-identical', 'blocks when the report cannot be used', 'unavailable', { work: { CODE: all(implement, breakReport) } }),
];

/**
 * server-owned-verify is not judged by the engine: it is `deferred` to the
 * project's verify command, which the server runs on the transition that ends
 * the flow. Its verdict is what that transition did.
 */
const CLOSE_STEPS = [
  { name: 'TODO', label: 'To Do', order: 0, isAnchor: true },
  { name: 'WORK', label: 'Work', order: 1, checks: [{ id: 'server-owned-verify' }] },
  { name: 'DONE', label: 'Done', order: 2, isAnchor: true },
];
const closing = (name, expected, opts = {}) => ({
  check: 'server-owned-verify', name, expected,
  opts: { steps: CLOSE_STEPS, at: 'WORK', ...opts },
  read: ({ card, response, detail }) => ({
    actual: card.status === 'DONE' ? 'pass'
      : response.body?.error === 'NO_VERIFY_COMMAND' ? 'unavailable'
      : card.status === 'WORK' && response.status >= 400 ? 'fail' : `unexpected (${response.status}, card on ${card.status})`,
    detail: `${response.body?.error ?? response.body?.message?.slice(0, 200) ?? ''} ${detail}`,
  }),
});
const closes = [
  closing('lands the card when the project verify command passes', 'pass'),
  closing('holds the card when the project verify command fails', 'fail', { work: { WORK: ({ write, kit }) => write(kit.mathRed()) } }),
  closing("holds the card when a caller passes a command that succeeds: the project's own runs", 'fail', { command: 'true', work: { WORK: ({ write, kit }) => write(kit.mathRed()) } }),
  closing('holds the card when the project has no verify command', 'unavailable', { project: { testReport: false, verifyCommand: null } }),
];

const only = process.env.HARNESS_RUNNERS ? process.env.HARNESS_RUNNERS.split(',') : RUNNER_NAMES;
export const scenarios = only.flatMap(runner => [...cases, ...closes].map(c => ({
  check: c.check,
  name: `[${runner}] ${c.name}`,
  expected: typeof c.expected === 'string' ? c.expected : (c.expected[runner] ?? c.expected.default),
  run: async () => {
    const out = await walk(c.check, { runner, ...c.opts });
    return c.read ? c.read(out) : out;
  },
})));
