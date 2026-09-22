/**
 * The herdr panes, as rows a person can read (96953f6a / CGLAB-266).
 *
 * `w2:p1P` tells nobody anything. What a developer recognises is the repository
 * and what the agent is doing in it — and herdr answers both outright, without
 * this product having to scrape a screen for them.
 *
 * Pure, so the ordering and the labels are testable without a socket or a render.
 */
import { describe, it, expect } from 'vitest';
import { paneRows, groupPanes, type RawPane } from '../herdrPaneRows';

const pane = (over: Partial<RawPane> = {}): RawPane => ({
  pane_id: 'w1:p1',
  cwd: '/Users/x/GitHub/agenfk',
  agent: 'claude',
  agent_status: 'idle',
  terminal_title_stripped: 'Some card title',
  ...over,
});

describe('one row', () => {
  it('is titled by what the agent is doing, not by its pane id', () => {
    const [r] = paneRows([pane({ terminal_title_stripped: '◐ Criar branch com Electron' })]);
    expect(r.title).toBe('◐ Criar branch com Electron');
    expect(r.title).not.toContain('w1:p1');
  });

  it('falls back to the directory when herdr has no title for it', () => {
    // A shell pane has no agent and often no meaningful title. The directory is
    // still something; an empty row is not.
    const [r] = paneRows([pane({ terminal_title_stripped: undefined, agent: undefined })]);
    expect(r.title).toBe('agenfk');
  });

  it('keeps the pane id, because that is what the content route needs', () => {
    expect(paneRows([pane()])[0].paneId).toBe('w1:p1');
  });

  it('says which harness, including ones this product cannot launch', () => {
    /*
     * `pi` is the case that matters. AgEnFK can only launch `claude-code`, and
     * `pi` publishes no OSC title, so the screen-scraping path is blind to it.
     * herdr names it.
     */
    expect(paneRows([pane({ agent: 'pi' })])[0].agent).toBe('pi');
  });

  it('calls a pane with no agent a shell, rather than leaving it blank', () => {
    expect(paneRows([pane({ agent: undefined })])[0].agent).toBe('shell');
  });
});

describe('what the row says is happening', () => {
  it('passes herdr\'s own word through, rather than inventing a vocabulary', () => {
    for (const s of ['working', 'idle', 'blocked', 'unknown']) {
      expect(paneRows([pane({ agent_status: s })])[0].status).toBe(s);
    }
  });

  it('marks BLOCKED as needing a person — the state we cannot produce ourselves', () => {
    /*
     * `blocked` is unreachable in this product's own Agents screen: `runState`
     * only ever answers failed/running/idle/unverifiable, so the amber dot has
     * never had a producer. herdr produces it, and two panes were in it when
     * this was written.
     */
    expect(paneRows([pane({ agent_status: 'blocked' })])[0].needsAPerson).toBe(true);
    expect(paneRows([pane({ agent_status: 'working' })])[0].needsAPerson).toBe(false);
  });

  it('does not claim to know what herdr says is unknown', () => {
    // herdr answers `unknown` for shells rather than guessing `idle`. Turning
    // that into "idle" here would invent a fact the multiplexer refused to.
    const [r] = paneRows([pane({ agent: undefined, agent_status: 'unknown' })]);
    expect(r.status).toBe('unknown');
    expect(r.needsAPerson).toBe(false);
  });
});

describe('grouping them', () => {
  const panes = [
    pane({ pane_id: 'a', cwd: '/x/agenfk', agent_status: 'working' }),
    pane({ pane_id: 'b', cwd: '/x/agenfk', agent: 'pi', agent_status: 'blocked' }),
    pane({ pane_id: 'c', cwd: '/x/horizon', agent_status: 'idle' }),
    pane({ pane_id: 'd', cwd: '/x/horizon/.worktrees/feat', agent_status: 'idle' }),
  ];

  it('groups by directory, because that is how a person finds their own work', () => {
    const groups = groupPanes(paneRows(panes));
    expect(groups.map(g => g.dir)).toEqual(['agenfk', 'horizon', 'feat']);
  });

  it('puts the group that needs a person FIRST', () => {
    /*
     * The whole reason to show this at all is the pane nobody is watching. A
     * list sorted by name buries it.
     */
    const groups = groupPanes(paneRows(panes));
    expect(groups[0].dir).toBe('agenfk');
    expect(groups[0].needsAPerson).toBe(1);
  });

  it('keeps the full path, because two directories can share a last segment', () => {
    // `/x/agenfk` and `/y/agenfk` are different work. The label is the same.
    const groups = groupPanes(paneRows([
      pane({ pane_id: 'a', cwd: '/x/agenfk' }),
      pane({ pane_id: 'b', cwd: '/y/agenfk' }),
    ]));
    expect(groups).toHaveLength(2);
    expect(groups.map(g => g.path)).toEqual(['/x/agenfk', '/y/agenfk']);
  });

  it('holds panes with no cwd in a group of their own, instead of dropping them', () => {
    // A pane we cannot place is still a pane someone is running.
    const groups = groupPanes(paneRows([pane({ pane_id: 'a', cwd: undefined })]));
    expect(groups).toHaveLength(1);
    expect(groups[0].dir).toMatch(/unknown|no directory/i);
    expect(groups[0].panes).toHaveLength(1);
  });

  it('is stable: equal urgency falls back to the name, so the list does not wobble', () => {
    const a = groupPanes(paneRows(panes)).map(g => g.path);
    const b = groupPanes(paneRows([...panes].reverse())).map(g => g.path);
    expect(a).toEqual(b);
  });
});
