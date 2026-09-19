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
  collectAgentIds,
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
    const [claude] = availableAgentFilters(['claude', 'claude-code', 'claude']);
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
    const ids = availableAgentFilters(['pi', 'herdr']).map(o => o.agentId);
    expect(ids.sort()).toEqual(['herdr', 'pi']);
    expect(ids).not.toContain('gemini');
  });

  it('sorts by name, so the rows do not move as work starts and stops', () => {
    // A menu you have to re-read each time it opens is worse than an unsorted
    // one, because it looks stable.
    const labels = availableAgentFilters(['pi', 'claude', 'codex']).map(o => o.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
  });

  it('ignores blanks rather than inventing an unnamed agent', () => {
    expect(availableAgentFilters(['', '   ', 'pi'])).toHaveLength(1);
  });

  it('writes herdr the way herdr writes it', () => {
    const [herdr] = availableAgentFilters(['herdr']);
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
    expect(matchesAgentFilter('pi', [])).toBe(true);
    expect(projectMatchesAgentFilter([], [])).toBe(true);
  });
});

describe('a selection', () => {
  it('matches across the differing ids', () => {
    // Picking Claude must find herdr's panes too, or the fold was pointless.
    expect(matchesAgentFilter('claude', ['claude-code'])).toBe(true);
    expect(matchesAgentFilter('claude-code', ['claude-code'])).toBe(true);
  });

  it('excludes what was not picked', () => {
    expect(matchesAgentFilter('pi', ['claude-code'])).toBe(false);
  });
});

/* ── which projects survive ────────────────────────────────────────────── */

describe('a project', () => {
  it('survives when it has one agent of the chosen kind', () => {
    expect(projectMatchesAgentFilter(['pi', 'claude-code'], ['pi'])).toBe(true);
  });

  it('is hidden when it has none', () => {
    /*
     * The point of the filter: "where is pi running" is answered by a SHORTER
     * LIST OF PROJECTS, not the same list with emptier branches.
     */
    expect(projectMatchesAgentFilter(['claude-code'], ['pi'])).toBe(false);
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
    const available = availableAgentFilters(['pi']);
    expect(pruneAgentFilter(['pi', 'claude-code'], available)).toEqual(['pi']);
  });

  it('leaves a live selection alone', () => {
    const available = availableAgentFilters(['pi', 'claude-code']);
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
    expect(collectAgentIds(ours, herdr).sort()).toEqual(['claude', 'claude-code', 'codex', 'pi']);
  });

  it('matches OUR rows by project id and herdr\'s by project NAME', () => {
    /*
     * The two do not carry the same key: our rows carry the id because
     * revealing a card needs it, and a herdr pane knows only the directory it
     * is in. Matching on the wrong one returns an empty list, which the filter
     * would read as "no agents here" and hide the project.
     */
    const got = collectAgentIds(ours, herdr, { id: 'p1', name: 'alpha' });
    expect(got.sort()).toEqual(['claude-code', 'pi']);
  });

  it('does not let a project id match a herdr row by accident', () => {
    expect(collectAgentIds([], herdr, { id: 'alpha', name: 'nope' })).toEqual([]);
  });

  it('skips rows with no agent rather than counting an empty one', () => {
    expect(collectAgentIds([{ projectId: 'p1', agentId: '' }], [])).toEqual([]);
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
    expect(availableAgentFilters(['pi'])[0].label).toBe('Pi');
    expect(availableAgentFilters(['gemini'])[0].label).toBe('Gemini CLI');
  });
});
