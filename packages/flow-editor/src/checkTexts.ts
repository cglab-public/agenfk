/**
 * CGLAB-384 — the words the flow editor uses, keyed by check id, role and
 * record. A flow author should never need to know a check id: each check says
 * what it stops and what an agent must do to satisfy it. A test pins these to
 * core's catalogue so a new check cannot ship without its words.
 */

export interface CheckText {
  /** Short name. */
  title: string;
  /** What it stops, finishing "Stops: …". */
  stops: string;
  /** What an agent must do to leave the step; empty for a warning-only check. */
  must: string;
}

export const CHECK_TEXTS: Record<string, CheckText> = {
  'tree-clean': { title: 'Clean working tree', stops: 'starting on top of someone else\'s half-finished edits', must: 'Start with no uncommitted changes' },
  'on-card-branch': { title: 'On the card\'s branch', stops: 'working on the wrong branch', must: 'Be on the card\'s own branch' },
  'jira-key-valid': { title: 'Linked to a JIRA item', stops: 'work nobody can trace back to an issue', must: 'Link the card to a valid JIRA key that its branch carries' },
  'has-children': { title: 'Broken down into child cards', stops: 'building an epic or story as one lump', must: 'Break the card down into child cards' },
  'only-test-files-changed': { title: 'Only test files changed', stops: 'writing the code before the tests', must: 'Change test files only' },
  'no-broken-test-files': { title: 'Every test file loads', stops: 'a "failing" test that is really a file that will not import', must: 'Make every test file load' },
  'new-tests-exist': { title: 'New tests were added', stops: 'leaving the step without writing a test', must: 'Add at least one test' },
  'some-new-test-red': { title: 'New tests fail first', stops: 'tests that never proved anything', must: 'Add at least one test that fails before the code exists' },
  'new-tests-born-green': { title: 'New tests already passing', stops: 'nothing on its own: it flags tests that passed before any code', must: '' },
  'red-is-assertion': { title: 'Fails on an assertion', stops: 'nothing on its own: it flags red caused by a crash, not a check', must: '' },
  'existing-tests-still-green': { title: 'Existing tests still pass', stops: 'breaking old behaviour while writing new tests', must: 'Keep every existing test passing' },
  'suite-green': { title: 'Whole test suite passes', stops: 'handing over broken code', must: 'Get the whole suite passing' },
  'red-set-passes-by-name': { title: 'The failing tests now pass', stops: 'deleting, skipping or excluding the test that was failing', must: 'Make each test that failed pass, under the same name' },
  'test-surface-frozen': { title: 'Tests can\'t be weakened', stops: 'editing an assertion to match the bug', must: 'Leave the earlier test files and runner config untouched' },
  'test-count-not-lower': { title: 'No tests removed', stops: 'quietly dropping tests', must: 'Keep the number of tests from going down' },
  'test-set-identical': { title: 'Same tests before and after', stops: 'a "refactor" that deletes or adds tests', must: 'Keep exactly the same tests' },
  'review-record': { title: 'Independent review', stops: 'authors reviewing their own work, and shipping with open findings', must: 'Record a review by someone else, with every finding fixed or rejected with a reason' },
  'human-approval': { title: 'A person approves', stops: 'agents moving on without a person\'s say-so', must: 'Wait for a person to approve on the board' },
  'server-owned-verify': { title: 'Project verify command passes', stops: 'passing "true" as the verify command', must: 'Pass the project\'s own verify command' },
  'command-check': { title: 'A command the flow defines passes', stops: 'moving on while the team\'s own check (lint, types, a script) fails', must: 'Pass the flow\'s command, run by the server in the card\'s tree' },
  'agent-check': { title: 'The agent carried out an instruction', stops: 'moving on without doing what the step asks', must: 'Carry out the step\'s instruction and report it (agent-reported)' },
};

/** A check's words; one the editor does not know yet falls back to the server's description. */
export function checkText(id: string, description?: string): CheckText {
  return CHECK_TEXTS[id] ?? { title: id, stops: description ?? '', must: description ?? '' };
}

export interface RoleText { name: string; desc: string; color: string }

export const ROLE_TEXTS: Record<string, RoleText> = {
  planning: { name: 'Planning', desc: 'Decide what to build. Cards are broken down, and a person can give the go-ahead.', color: '#a3c46b' },
  'test-authoring': { name: 'Writing tests', desc: 'Tests come first and must fail. They are frozen when the step ends, so they can\'t be weakened later.', color: '#498373' },
  coding: { name: 'Implementing', desc: 'Make the failing tests pass without touching them. Its test checks need a Writing-tests step before it.', color: '#3b82f6' },
  refactoring: { name: 'Refactoring', desc: 'Tidy the code. The list of tests must stay exactly the same.', color: '#8b5cf6' },
  review: { name: 'Review', desc: 'Someone other than the author reviews the work, and every finding is fixed or rejected with a reason.', color: '#d97706' },
  testing: { name: 'Testing', desc: 'The whole test suite must pass.', color: '#0ea5e9' },
  closing: { name: 'Closing', desc: 'The server runs the project\'s own verify command. Only the last step can have this role.', color: '#10b981' },
};

/** What a step hands to later ones, in words. */
export const RECORD_TEXTS: Record<string, string> = {
  stepEntryTests: 'Tests at the start of the step',
  redSet: 'Failing-test list',
  testSurface: 'Frozen tests',
  authoredTests: 'Tests as written',
};

export const GROUP_TEXTS: Record<string, string> = {
  git: 'Git hygiene',
  tests: 'Tests',
  review: 'Review',
  approvals: 'Approvals',
};
