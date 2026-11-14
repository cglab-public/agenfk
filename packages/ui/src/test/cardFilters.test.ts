/**
 * What the project page's Cards tab means by Open, In flight and Done.
 *
 * The questions that went wrong live here, apart from the component: a DONE
 * card offered Start, and hiding the finished rows took a menu that could only
 * show one state at a time. Every answer is read off the project's own flow,
 * because a TDD project's states are not the default flow's.
 */
import { describe, it, expect } from 'vitest';
import {
  ago, backlogStates, closedAt, finishedStates, matchesQuery, presentStates, presetStates, rowAction, selectedStates,
} from '../cardFilters';

const TDD = {
  steps: [
    { name: 'TODO', order: 0, isSpecial: true },
    { name: 'DISCOVERY', order: 1 },
    { name: 'CREATE_UNIT_TESTS', order: 2 },
    { name: 'IN_PROGRESS', order: 3 },
    { name: 'REVIEW', order: 5 },
    { name: 'DONE', order: 9, isSpecial: true },
  ],
};

/** A flow whose exit is not called DONE. */
const SHIPPING = {
  steps: [
    { name: 'START', order: 0, isAnchor: true },
    { name: 'WORK', order: 1 },
    { name: 'SHIPPED', order: 2, isSpecial: true },
  ],
};

/** A flow that ends on a working step: cards there are still being worked. */
const ENDS_WORKING = {
  steps: [
    { name: 'START', order: 0, isAnchor: true },
    { name: 'WORK', order: 1 },
    { name: 'CHECK', order: 2 },
  ],
};

const card = (status: string, extra: Record<string, unknown> = {}) => ({ id: `id-${status}`, title: status, status, ...extra });

describe('finished states', () => {
  it('are DONE and the out-of-play states on the default shape', () => {
    expect([...finishedStates(TDD)].sort()).toEqual(['ARCHIVED', 'DONE', 'TRASHED']);
  });

  it("include the flow's own exit, whatever it is called", () => {
    expect(finishedStates(SHIPPING).has('SHIPPED')).toBe(true);
  });

  it('leave out a last step that is a working step, as the server does', () => {
    // finishedStatusesOf on the server counts the last step only when it is a
    // boundary; a card in CHECK still has CHECK to leave.
    expect(finishedStates(ENDS_WORKING).has('CHECK')).toBe(false);
  });

  it('still know DONE when the flow has not loaded', () => {
    expect(finishedStates(null).has('DONE')).toBe(true);
  });
});

describe('backlog states', () => {
  it("are TODO and the flow's first anchor, where cards wait to be picked up", () => {
    expect(backlogStates(TDD).has('TODO')).toBe(true);
    expect(backlogStates(SHIPPING).has('START')).toBe(true);
    expect(backlogStates(TDD).has('DISCOVERY')).toBe(false);
  });
});

describe('the states there is a chip for', () => {
  it("follow the flow's order, and only the ones a card is in", () => {
    const cards = [card('REVIEW'), card('TODO'), card('DISCOVERY'), card('DONE')];
    // IN_PROGRESS and CREATE_UNIT_TESTS hold nothing: a chip for them could
    // only ever empty the list.
    expect(presentStates(TDD, cards)).toEqual(['TODO', 'DISCOVERY', 'REVIEW', 'DONE']);
  });

  it('name the states outside the flow too, so no card is unreachable', () => {
    const cards = [card('ARCHIVED'), card('TODO'), card('PAUSED'), card('BLOCKED')];
    // After the flow, alphabetically - with the finished ones last.
    expect(presentStates(TDD, cards)).toEqual(['TODO', 'BLOCKED', 'PAUSED', 'ARCHIVED']);
  });

  it("still exist when the flow is unknown, from the cards' own states", () => {
    expect(presentStates(null, [card('DONE'), card('TODO')])).toEqual(['TODO', 'DONE']);
  });
});

describe('the presets', () => {
  const states = ['TODO', 'DISCOVERY', 'REVIEW', 'PAUSED', 'DONE', 'ARCHIVED'];

  it('Open is everything not finished', () => {
    expect(presetStates('open', states, TDD)).toEqual(['TODO', 'DISCOVERY', 'REVIEW', 'PAUSED']);
  });

  it('In flight leaves out the backlog as well', () => {
    expect(presetStates('inflight', states, TDD)).toEqual(['DISCOVERY', 'REVIEW', 'PAUSED']);
  });

  it('Done is the finished ones', () => {
    expect(presetStates('done', states, TDD)).toEqual(['DONE', 'ARCHIVED']);
  });

  it('All is all of them', () => {
    expect(presetStates('all', states, TDD)).toEqual(states);
  });

  it("read a custom flow's exit as done", () => {
    expect(presetStates('done', ['START', 'WORK', 'SHIPPED'], SHIPPING)).toEqual(['SHIPPED']);
    expect(presetStates('open', ['START', 'WORK', 'SHIPPED'], SHIPPING)).toEqual(['START', 'WORK']);
  });
});

describe('what is selected', () => {
  it('re-reads a preset against the states there are now', () => {
    // Taken as a list when Open was pressed, a card reaching REVIEW for the
    // first time would have been hidden by a filter nobody chose.
    expect([...selectedStates({ preset: 'open' }, ['TODO'], TDD)]).toEqual(['TODO']);
    expect([...selectedStates({ preset: 'open' }, ['TODO', 'REVIEW'], TDD)]).toEqual(['TODO', 'REVIEW']);
  });

  it('keeps a hand-picked set as it was picked', () => {
    expect([...selectedStates({ states: ['DONE'] }, ['TODO', 'DONE'], TDD)]).toEqual(['DONE']);
  });
});

describe("the row's action", () => {
  it('a finished card has nothing to start', () => {
    expect(rowAction('DONE', undefined, TDD)).toBe('done');
    expect(rowAction('SHIPPED', undefined, SHIPPING)).toBe('done');
    expect(rowAction('ARCHIVED', undefined, TDD)).toBe('done');
  });

  it('even when a session is still open on it', () => {
    // The terminal outlives the card; "Open" there is a door to finished work
    // that the row itself already opens.
    expect(rowAction('DONE', 'ours', TDD)).toBe('done');
  });

  it('a card waiting in the backlog is started', () => {
    expect(rowAction('TODO', undefined, TDD)).toBe('start');
    expect(rowAction('START', undefined, SHIPPING)).toBe('start');
  });

  it('an idea waits in the backlog too, and can be started', () => {
    // Deliberately unlike the server's close rule, where IDEAS counts as out
    // of play: an idea does not hold its parent's close, but it is not
    // finished either - it is work nobody has picked up yet.
    expect(rowAction('IDEAS', undefined, TDD)).toBe('start');
    expect(presetStates('open', ['IDEAS', 'DONE'], TDD)).toEqual(['IDEAS']);
  });

  it('a card part-way through, with nothing on it, is resumed', () => {
    expect(rowAction('REVIEW', undefined, TDD)).toBe('resume');
    expect(rowAction('PAUSED', undefined, TDD)).toBe('resume');
  });

  it('a card something is already working is opened, or watched', () => {
    expect(rowAction('REVIEW', 'ours', TDD)).toBe('open');
    expect(rowAction('TODO', 'ours', TDD)).toBe('open');
    expect(rowAction('REVIEW', 'elsewhere', TDD)).toBe('elsewhere');
  });
});

describe('the search', () => {
  const c = { id: '8024f6c4-aaaa', title: 'Parent closes over an open child' };

  it('matches the title, whatever the case', () => {
    expect(matchesQuery(c, 'OPEN CHILD')).toBe(true);
    expect(matchesQuery(c, 'nothing like it')).toBe(false);
  });

  it('matches the start of the id, which is how cards are named in chat', () => {
    expect(matchesQuery(c, '8024')).toBe(true);
    expect(matchesQuery(c, 'aaaa')).toBe(false);
  });

  it('matches everything when empty or blank', () => {
    expect(matchesQuery(c, '')).toBe(true);
    expect(matchesQuery(c, '   ')).toBe(true);
  });
});

describe('when a card finished', () => {
  const history = [
    { fromStatus: 'TODO', toStatus: 'REVIEW', timestamp: '2026-09-20T10:00:00Z' },
    { fromStatus: 'REVIEW', toStatus: 'DONE', timestamp: '2026-09-25T10:00:00Z' },
    { fromStatus: 'DONE', toStatus: 'REVIEW', timestamp: '2026-09-26T10:00:00Z' },
    { fromStatus: 'REVIEW', toStatus: 'DONE', timestamp: '2026-09-27T10:00:00Z' },
  ];

  it('is the last time it entered the state it is in', () => {
    expect(closedAt({ status: 'DONE', history })).toBe('2026-09-27T10:00:00Z');
  });

  it('is not when it was last edited', () => {
    // updatedAt moves on every edit: a card closed a week ago and renamed
    // today read "Done just now".
    expect(closedAt({ status: 'DONE', history, updatedAt: '2026-10-01T10:00:00Z' })).toBe('2026-09-27T10:00:00Z');
  });

  it('is unknown rather than guessed when the history does not say', () => {
    expect(closedAt({ status: 'DONE', history: [] })).toBeNull();
    expect(closedAt({ status: 'DONE' })).toBeNull();
  });
});

describe('how long ago', () => {
  const now = Date.parse('2026-10-01T12:00:00Z');
  const before = (ms: number) => new Date(now - ms).toISOString();
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  it('is coarse, the way a list wants it', () => {
    expect(ago(before(10_000), now)).toBe('just now');
    expect(ago(before(5 * MIN), now)).toBe('5m ago');
    expect(ago(before(3 * HOUR), now)).toBe('3h ago');
    expect(ago(before(5 * DAY), now)).toBe('5d ago');
    expect(ago(before(21 * DAY), now)).toBe('3w ago');
    expect(ago(before(120 * DAY), now)).toBe('4mo ago');
  });

  it('says nothing rather than something wrong', () => {
    expect(ago(undefined, now)).toBeNull();
    expect(ago('not a date', now)).toBeNull();
  });

  it('never says "in the future"', () => {
    // A clock a few seconds ahead on another machine.
    expect(ago(new Date(now + 30_000).toISOString(), now)).toBe('just now');
  });
});
