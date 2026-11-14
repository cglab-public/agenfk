/**
 * Narrowing the tree to one kind of agent (96953f6a / CGLAB-266).
 *
 * The sidebar could be sorted and not narrowed, which stops helping at the
 * size this tree reaches - one project here holds twenty-nine cards and four
 * agents. The question a person arrives with is "where is pi running", and
 * sorting cannot answer it.
 */
import { describe, it, expect } from 'vitest';
import {
  projectChildCount,
  settleIds,
  collectFilterableRows,
  agentTags,
  cardMatchesAgentFilter,
  HERDR_SOURCE_TAG,
  availableAgentFilters,
  canonicalAgent,
  matchesAgentFilter,
  projectMatchesAgentFilter,
  pruneAgentFilter,
} from '../agentFilter';

/* ── the ids do not agree, and that is the whole problem ───────────────── */

describe('one name per agent, whoever reported it', () => {
  it('folds herdr\'s `claude` and our `claude-code` into one', () => {
    /*
     * MEASURED on this machine: herdr reports `claude` for panes this app
     * would call `claude-code`. Filtering on raw ids would put two entries
     * called Claude in the menu, each hiding half the answer.
     */
    expect(canonicalAgent('claude')).toBe(canonicalAgent('claude-code'));
  });

  it('is case and whitespace insensitive', () => {
    expect(canonicalAgent('  Claude-Code ')).toBe('claude-code');
    expect(canonicalAgent('  CLAUDE ')).toBe('claude-code');
  });

  it('leaves an agent it does not know under its own name', () => {
    /*
     * A closed map, not prefix matching. A new agent under its own name is a
     * cosmetic gap; one folded into the wrong bucket is a wrong answer.
     */
    expect(canonicalAgent('claude-next-thing')).toBe('claude-next-thing');
    expect(canonicalAgent('brand-new')).toBe('brand-new');
  });
});

/* ── what the menu offers ──────────────────────────────────────────────── */

describe('the options', () => {
  it('counts the folded ids together', () => {
    const [claude] = availableAgentFilters([{agentId:'claude'},{agentId:'claude-code'},{agentId:'claude'}]);
    // Folded INTO our id, so the name comes from agentLabels rather than from
    // a second map beside it.
    expect(claude.agentId).toBe('claude-code');
    expect(claude.label).toBe('Claude Code');
    expect(claude.count).toBe(3);
  });

  it('offers only agents that are actually there', () => {
    /*
     * Listing everything this app supports would put a control in the menu
     * that can only ever empty the list: five are installed and a machine
     * rarely runs two at once.
     */
    const ids = availableAgentFilters([{agentId:'pi'},{agentId:'herdr'}]).map(o => o.agentId);
    expect(ids.sort()).toEqual(['herdr', 'pi']);
    expect(ids).not.toContain('gemini');
  });

  it('sorts by name, so the rows do not move as work starts and stops', () => {
    // A menu you have to re-read each time it opens is worse than an unsorted
    // one, because it looks stable.
    const labels = availableAgentFilters([{agentId:'pi'},{agentId:'claude'},{agentId:'codex'}]).map(o => o.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
  });

  it('ignores blanks rather than inventing an unnamed agent', () => {
    expect(availableAgentFilters([{agentId:''},{agentId:'   '},{agentId:'pi'}])).toHaveLength(1);
  });

  it('writes herdr the way herdr writes it', () => {
    const [herdr] = availableAgentFilters([{agentId:'herdr'}]);
    expect(herdr.label).toBe('herdr');
  });
});

/* ── empty means everything ────────────────────────────────────────────── */

describe('no selection', () => {
  it('shows everything, rather than nothing', () => {
    /*
     * "No filter" and "a filter excluding all" are the same state in the data
     * and opposite states to a person. Unticking the last box must land on the
     * sane one.
     */
    expect(matchesAgentFilter({agentId:'pi'}, [])).toBe(true);
    expect(projectMatchesAgentFilter([], [])).toBe(true);
  });
});

describe('a selection', () => {
  it('matches across the differing ids', () => {
    // Picking Claude must find herdr's panes too, or the fold was pointless.
    expect(matchesAgentFilter({agentId:'claude'}, ['claude-code'])).toBe(true);
    expect(matchesAgentFilter({agentId:'claude-code'}, ['claude-code'])).toBe(true);
  });

  it('excludes what was not picked', () => {
    expect(matchesAgentFilter({agentId:'pi'}, ['claude-code'])).toBe(false);
  });
});

/* ── which projects survive ────────────────────────────────────────────── */

describe('a project', () => {
  it('survives when it has one agent of the chosen kind', () => {
    expect(projectMatchesAgentFilter([{agentId:'pi'},{agentId:'claude-code'}], ['pi'])).toBe(true);
  });

  it('is hidden when it has none', () => {
    /*
     * The point of the filter: "where is pi running" is answered by a SHORTER
     * LIST OF PROJECTS, not the same list with emptier branches.
     */
    expect(projectMatchesAgentFilter([{agentId:'claude-code'}], ['pi'])).toBe(false);
  });

  it('is hidden when it has no agents at all and a filter is on', () => {
    // It cannot answer the question being asked.
    expect(projectMatchesAgentFilter([], ['pi'])).toBe(false);
  });
});

/* ── a filter you cannot see is a filter you cannot turn off ───────────── */

describe('when an agent stops', () => {
  it('drops a selection the menu can no longer show', () => {
    /*
     * The row disappears from the menu while the selection survives in
     * storage, leaving a filter on with no visible way to clear it. That reads
     * as "the app lost my projects".
     */
    const available = availableAgentFilters([{agentId:'pi'}]);
    expect(pruneAgentFilter(['pi', 'claude-code'], available)).toEqual(['pi']);
  });

  it('leaves a live selection alone', () => {
    const available = availableAgentFilters([{agentId:'pi'},{agentId:'claude-code'}]);
    expect(pruneAgentFilter(['pi'], available)).toEqual(['pi']);
  });
});

/* ── two key spaces ────────────────────────────────────────────────────── */

describe('gathering the ids', () => {
  const ours = [
    { projectId: 'p1', agentId: 'claude-code' },
    { projectId: 'p2', agentId: 'codex' },
  ];
  const herdr = [
    { projectName: 'alpha', agentId: 'pi' },
    { projectName: 'beta', agentId: 'claude' },
  ];

  it('takes from both sources', () => {
    expect(collectFilterableRows(ours, herdr).map(r => r.agentId).sort()).toEqual(['claude', 'claude-code', 'codex', 'pi']);
  });

  it('matches OUR rows by project id and herdr\'s by project NAME', () => {
    /*
     * The two do not carry the same key: our rows carry the id because
     * revealing a card needs it, and a herdr pane knows only the directory it
     * is in. Matching on the wrong one returns an empty list, which the filter
     * would read as "no agents here" and hide the project.
     */
    const got = collectFilterableRows(ours, herdr, { id: 'p1', name: 'alpha' }).map(r => r.agentId);
    expect(got.sort()).toEqual(['claude-code', 'pi']);
  });

  it('does not let a project id match a herdr row by accident', () => {
    expect(collectFilterableRows([], herdr, { id: 'alpha', name: 'nope' })).toEqual([]);
  });

  it('skips rows with no agent rather than counting an empty one', () => {
    expect(collectFilterableRows([{ projectId: 'p1', agentId: '' }], [])).toEqual([]);
  });
});

describe('one map for names, not a second one here', () => {
  it('takes the label from agentLabels, the map that exists for this', () => {
    /*
     * That file says in its own comment that it was made because two places
     * rendered agent names and disagreed - the rail showed `claude-code` while
     * the picker beside it showed `Claude Code`. A labels map in this file
     * would have been the fourth.
     */
    expect(availableAgentFilters([{agentId:'pi'}])[0].label).toBe('Pi');
    expect(availableAgentFilters([{agentId:'gemini'}])[0].label).toBe('Gemini CLI');
  });
});

/* ── herdr is a SOURCE, not an agent ───────────────────────────────────── */

describe('what herdr means in this menu', () => {
  it('tags a pane by its agent AND by herdr', () => {
    /*
     * THE BUG THIS FIXES. herdr's panes report `claude` and `pi`, never
     * `herdr` - so treating it as one more agent id made the herdr row appear
     * only when an attached terminal happened to be open, and choosing it hid
     * everything. "Show me what herdr is holding" has to find a pi pane.
     */
    expect(agentTags({ agentId: 'pi', fromHerdr: true }).sort())
      .toEqual([HERDR_SOURCE_TAG, 'pi']);
  });

  it('finds a herdr pane under Pi as well', () => {
    // Both directions, or the tag has replaced the agent rather than joined it.
    expect(matchesAgentFilter({ agentId: 'pi', fromHerdr: true }, ['pi'])).toBe(true);
    expect(matchesAgentFilter({ agentId: 'pi', fromHerdr: true }, [HERDR_SOURCE_TAG])).toBe(true);
  });

  it('does not tag one of our own terminals as herdr', () => {
    expect(matchesAgentFilter({ agentId: 'pi' }, [HERDR_SOURCE_TAG])).toBe(false);
  });

  it('gives the ATTACH only the herdr tag, not an agent it is not', () => {
    /*
     * The attached terminal's "agent" is the multiplexer. Listing it under
     * Claude or Pi would claim a session it is not - it is a view onto all of
     * them.
     */
    expect(agentTags({ agentId: 'herdr' })).toEqual([HERDR_SOURCE_TAG]);
  });

  it('does not tag the attach TWICE for being herdr from herdr', () => {
    /*
     * Its agent id IS the source tag, and it also comes from herdr, so it
     * earns the same tag by both routes. Counted twice, the menu would read
     * "herdr 3" for two panes - a number somebody would try to reconcile.
     */
    expect(agentTags({ agentId: 'herdr', fromHerdr: true })).toEqual([HERDR_SOURCE_TAG]);
    const opts = availableAgentFilters([{ agentId: 'herdr', fromHerdr: true }]);
    expect(opts.find(o => o.agentId === HERDR_SOURCE_TAG)?.count).toBe(1);
  });

  it('counts herdr as how much it is HOLDING, not how many tabs are open', () => {
    const opts = availableAgentFilters([
      { agentId: 'pi', fromHerdr: true },
      { agentId: 'claude', fromHerdr: true },
      { agentId: 'claude-code' },
    ]);
    expect(opts.find(o => o.agentId === HERDR_SOURCE_TAG)?.count).toBe(2);
    expect(opts.find(o => o.agentId === 'claude-code')?.count).toBe(2);
  });

  it('marks a herdr row as such when gathering, so the tag survives', () => {
    const rows = collectFilterableRows([], [{ projectName: 'x', agentId: 'pi' }]);
    expect(rows[0].fromHerdr).toBe(true);
  });

  it('reads `source` on our own rows, which is where the tree already put it', () => {
    /*
     * A pane herdr is holding also appears as a session row, carrying
     * `source: 'herdr'`. Dropping it there would make a CARD whose only
     * session is a herdr pane invisible to the herdr filter - and because the
     * field is optional, nothing would have complained.
     */
    const rows = collectFilterableRows([{ projectId: 'p', agentId: 'pi', source: 'herdr' }], []);
    expect(rows[0].fromHerdr).toBe(true);
  });
});

/* ── the filter has to reach the cards ─────────────────────────────────── */

describe('a card', () => {
  const rows = [
    { itemId: 'c1', agentId: 'pi' },
    { itemId: 'c2', agentId: 'claude-code' },
    { itemId: 'c3', agentId: 'claude', fromHerdr: true },
  ];

  it('survives when ITS session matches', () => {
    expect(cardMatchesAgentFilter('c1', rows, ['pi'])).toBe(true);
  });

  it('goes when its session is a different agent', () => {
    /*
     * Stopping at the project answers "which project" and leaves the real
     * question where it was: one project here holds twenty-nine cards, and
     * showing all of them under a Pi filter is not an answer.
     */
    expect(cardMatchesAgentFilter('c2', rows, ['pi'])).toBe(false);
  });

  it('is not matched by ANOTHER card\'s session', () => {
    // The itemId has to be part of the test, or the filter degenerates into
    // "does this project have one anywhere".
    expect(cardMatchesAgentFilter('c2', rows, ['pi'])).toBe(false);
  });

  it('answers the herdr filter through its herdr session', () => {
    expect(cardMatchesAgentFilter('c3', rows, [HERDR_SOURCE_TAG])).toBe(true);
  });

  it('with no session at all goes while a filter is on', () => {
    expect(cardMatchesAgentFilter('nope', rows, ['pi'])).toBe(false);
  });

  it('with no session STAYS when no filter is on', () => {
    // Empty means everything, here too.
    expect(cardMatchesAgentFilter('nope', rows, [])).toBe(true);
  });
});

/* ── what a project has to show ────────────────────────────────────────── */

describe('a project branch', () => {
  it('counts panes as well as cards', () => {
    /*
     * THE BUG. The chevron, the count and the whole expandable list were gated
     * on the CARD count, and the herdr rows lived inside that list. Filtering
     * to herdr removes every card - those panes belong to the project's own
     * checkout and to no card at all - so a project holding a dozen panes
     * collapsed into an empty folder that could not even be opened.
     *
     * Nothing threw and no test failed. The list was correct; it was never
     * rendered.
     */
    expect(projectChildCount([], ['pane', 'pane'])).toBe(2);
  });

  it('is empty only when BOTH are', () => {
    expect(projectChildCount([], [])).toBe(0);
  });

  it('still counts cards on their own', () => {
    // The fix must not have traded one omission for the other.
    expect(projectChildCount(['card'], [])).toBe(1);
  });
});

/* ── settling a list of ids ────────────────────────────────────────────── */

describe('settleIds', () => {
  it('hands back the OLD array when the contents match', () => {
    /*
     * THE BUG, and the assertion is about identity rather than equality
     * because identity is the whole mechanism: an equal-but-new array is a
     * state change to React, so the effect that built one on every run kept
     * scheduling renders and the suite stopped finishing.
     */
    const prev = ['a', 'b'];
    expect(settleIds(prev, ['a', 'b'])).toBe(prev);
  });

  it('takes the new one when an id changed', () => {
    const next = ['a', 'c'];
    expect(settleIds(['a', 'b'], next)).toBe(next);
  });

  it('takes the new one when the length changed', () => {
    const next = ['a', 'b', 'c'];
    expect(settleIds(['a', 'b'], next)).toBe(next);
  });

  it('is order-sensitive: the tree renders in this order', () => {
    const next = ['b', 'a'];
    expect(settleIds(['a', 'b'], next)).toBe(next);
  });

  it('settles two empties on the old one, which is the unfiltered case', () => {
    // The default state. Rebuilding [] on every run is what span the core.
    const prev: string[] = [];
    expect(settleIds(prev, [])).toBe(prev);
  });
});
