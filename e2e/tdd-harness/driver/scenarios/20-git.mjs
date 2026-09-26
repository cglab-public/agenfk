/** The git and meta checks: tree-clean, on-card-branch, tree-in-sync, jira-key-valid, has-children. */
import { checkOnWork, newCard, verify, update, write } from '../cards.mjs';
import { sh } from '../lib.mjs';

const dirty = ({ dir }) => write(dir, { 'src/math.js': 'export const add = (a, b) => a + b + 0;\n' });
const s = (check, name, expected, opts) => ({ check, name, expected, run: () => checkOnWork(check, opts) });
/** Record a branch on the card and put the tree on it, before the card leaves TODO (the entry guard checks it). */
const onBranch = branch => async ({ id, dir }) => { await update(id, { branchName: branch }); sh(`git checkout -q -b ${branch}`, dir); };

/**
 * Give the sample a bare remote it tracks. `pushAhead` has a colleague push a
 * commit the card's clone has not fetched; `unreachable` points the remote at
 * nothing after the push, so the fetch fails.
 */
const withRemote = ({ pushAhead = false, unreachable = false } = {}) => ({ dir }) => {
  const origin = `${dir}.origin.git`;
  sh(`git init -q --bare -b main ${origin} && git remote add origin ${origin} && git push -q -u origin HEAD:main && git branch -q --set-upstream-to=origin/main`, dir);
  if (pushAhead) sh(`git clone -q ${origin} ${dir}.other && cd ${dir}.other && git config user.email o@o && git config user.name o && echo x > colleague.txt && git add . && git commit -qm colleague && git push -q`, dir);
  if (unreachable) sh('git remote set-url origin /nonexistent/agenfk-e2e-remote.git', dir);
};

export const scenarios = [
  // tree-clean
  s('tree-clean', 'passes on a clean tree', 'pass'),
  s('tree-clean', 'blocks an uncommitted change to a tracked file', 'fail', { prepare: dirty }),
  s('tree-clean', "does not count another active card's claimed files", 'pass', {
    before: async ({ project }) => {
      const other = await newCard(project, { title: 'other card' });
      await update(other, { claims: ['src/'] });
      await verify(other); // TODO -> WORK: an active card holding src/
    },
    prepare: dirty,
  }),
  // No tree: the TODO entry guard already reads it, so the card never reaches WORK.
  s('tree-clean', 'is unavailable when the card has no tree (read on leaving TODO)', 'unavailable', { project: { root: false }, at: 'TODO' }),

  // on-card-branch
  s('on-card-branch', 'passes when no branch is recorded for the card', 'pass'),
  s('on-card-branch', "passes when the tree is on the card's branch", 'pass', { before: onBranch('feat/ABC-12_widget') }),
  s('on-card-branch', 'blocks when the tree has moved to another branch', 'fail', {
    before: onBranch('feat/ABC-12_widget'),
    prepare: ({ dir }) => sh('git checkout -q main', dir),
  }),
  s('on-card-branch', 'is unavailable when the card has a branch but no tree (read on leaving TODO)', 'unavailable', {
    project: { root: false },
    before: ({ id }) => update(id, { branchName: 'feat/ABC-12_widget' }),
    at: 'TODO',
  }),

  // jira-key-valid
  s('jira-key-valid', 'passes with a linked key', 'pass', { before: ({ id }) => update(id, { jiraItem: 'ABC-12' }) }),
  s('jira-key-valid', "passes when the card's branch carries its key", 'pass', {
    before: async ctx => { await update(ctx.id, { jiraItem: 'ABC-12' }); await onBranch('feat/ABC-12_widget')(ctx); },
  }),
  s('jira-key-valid', 'blocks a card with no key', 'fail'),
  s('jira-key-valid', "blocks when the card's branch carries none of its keys", 'fail', {
    before: async ctx => { await update(ctx.id, { jiraItem: 'ABC-12' }); await onBranch('feat/XYZ-9_other')(ctx); },
  }),

  // tree-in-sync (1049ce52): a bare remote next to the sample, the card's clone tracking it.
  s('tree-in-sync', 'passes a tree in sync with its remote', 'pass', { before: withRemote() }),
  s('tree-in-sync', 'blocks a tree behind its remote (it fetches by itself)', 'fail', { before: withRemote({ pushAhead: true }) }),
  s('tree-in-sync', 'only warns when the remote cannot be reached', 'unavailable-soft', { before: withRemote({ unreachable: true }) }),

  // has-children
  s('has-children', 'passes an EPIC that has a child card', 'pass', {
    card: { type: 'EPIC' },
    before: async ({ project, id }) => { await newCard(project, { type: 'STORY', parentId: id }); },
  }),
  s('has-children', 'passes a card type it does not apply to', 'pass'),
  s('has-children', 'blocks an EPIC with no child cards', 'fail', { card: { type: 'EPIC' } }),
  s('has-children', 'blocks a bare STORY when types includes STORY', 'fail', { card: { type: 'STORY' }, params: { types: 'EPIC,STORY' } }),
];
