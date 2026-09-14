/**
 * Appending a streamed event to a transcript (CGLAB f713eb70).
 *
 * The old version scanned, copied and RE-SORTED an already-sorted array on
 * every event — work proportional to the square of the session's length.
 *
 * The risk in making it cheap is not performance, it is ORDER. A transcript in
 * the wrong order reads as a different conversation, so most of what follows
 * is about the paths that are no longer sorted, and whether they still have to
 * be.
 */
import { describe, it, expect } from 'vitest';
import { appendEvent } from '../runEvents';

const ev = (seq: number) => ({ seq, text: `event ${seq}` });
const seqs = (list: readonly { seq: number }[]) => list.map(e => e.seq);

describe('the ordinary path: newest last', () => {
  it('appends an event that follows the newest one', () => {
    expect(seqs(appendEvent([ev(1), ev(2)], ev(3)))).toEqual([1, 2, 3]);
  });

  it('handles the very first event', () => {
    expect(seqs(appendEvent(undefined, ev(1)))).toEqual([1]);
    expect(seqs(appendEvent([], ev(1)))).toEqual([1]);
  });

  it('stays ordered across a long monotonic run', () => {
    // The real shape: hundreds of events, each newer than the last. This is
    // the path that used to re-sort the whole array every time.
    let list: readonly { seq: number }[] = [];
    for (let i = 1; i <= 300; i += 1) list = appendEvent(list, ev(i));
    expect(list).toHaveLength(300);
    expect(seqs(list)).toEqual([...seqs(list)].sort((a, b) => a - b));
  });

  it('does not require the sequence to be contiguous', () => {
    // Gaps are ordinary: the server records seven tool names and skips the
    // rest, so the numbers a panel sees are not consecutive.
    expect(seqs(appendEvent([ev(1), ev(9)], ev(40)))).toEqual([1, 9, 40]);
  });
});

describe('duplicates', () => {
  it('returns the SAME array when the newest event arrives twice', () => {
    /*
     * Reference identity, not just contents, and it is the point. React Query
     * re-renders on identity, so returning a copy would repaint every row of
     * the transcript to show nothing new — and duplicates are ordinary here,
     * because a refetch and the socket can both deliver the same event.
     */
    const prev = [ev(1), ev(2)];
    expect(appendEvent(prev, ev(2))).toBe(prev);
  });

  it('returns the same array for a duplicate of an OLDER event', () => {
    // The slow path has to preserve this too. It is the case a tail-only check
    // would miss, and missing it puts the same event on screen twice.
    const prev = [ev(1), ev(2), ev(3)];
    expect(appendEvent(prev, ev(1))).toBe(prev);
  });
});

describe('out of order, which is rare but must not corrupt anything', () => {
  it('puts an event that arrives late into its right place', () => {
    /*
     * The case the fast path deliberately does not handle. Appending blindly
     * would leave the transcript reading 1, 3, 2 — a conversation in the wrong
     * order, which is a worse failure than any amount of slowness.
     */
    expect(seqs(appendEvent([ev(1), ev(3)], ev(2)))).toEqual([1, 2, 3]);
  });

  it('puts an event older than everything at the front', () => {
    expect(seqs(appendEvent([ev(5), ev(6)], ev(2)))).toEqual([2, 5, 6]);
  });

  it('leaves the list sorted after a mix of orders', () => {
    // Belt and braces on the property that actually matters: whatever order
    // they arrive in, what comes out is ordered.
    let list: readonly { seq: number }[] = [];
    for (const n of [5, 1, 9, 3, 7, 2, 8, 4, 6]) list = appendEvent(list, ev(n));
    expect(seqs(list)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe('what it never does', () => {
  it('does not mutate the array it was given', () => {
    // The cache holds this array. Mutating it would change what other readers
    // see without telling React anything changed.
    const prev = [ev(1), ev(2)];
    const copy = seqs(prev);
    appendEvent(prev, ev(3));
    expect(seqs(prev)).toEqual(copy);
  });

  it('keeps the event objects themselves, rather than copies of them', () => {
    // The rows are keyed and memoised on these objects; rebuilding them would
    // re-render every row on every event, which is the cost being removed.
    const first = ev(1);
    const result = appendEvent([first], ev(2));
    expect(result[0]).toBe(first);
  });
});

/**
 * Events with no position at all (BUG 510df783).
 *
 * The server assigns the position inside the insert and, for a while, emitted
 * the object it had been handed rather than the one it wrote — so every socket
 * event carried `seq: undefined`. Two of those compare EQUAL, so the second
 * event and every one after it read as a duplicate of the first and were
 * discarded: a live session showed one line in the transcript and then nothing.
 *
 * The server is fixed. These exist because the UI must not collapse a
 * transcript again if anything upstream ever stops numbering — the failure was
 * total and completely silent.
 */
describe('an event with no seq', () => {
  const bare = (text: string) => ({ text } as { seq?: number; text: string });

  it('is kept, not mistaken for a duplicate of the last one', () => {
    const list = appendEvent([bare('first')], bare('second'));
    expect(list).toHaveLength(2);
  });

  it('keeps a whole stream of them, in arrival order', () => {
    // The exact shape of the bug: five events in, one event out.
    let list: readonly { seq?: number; text: string }[] = [];
    for (const t of ['a', 'b', 'c', 'd', 'e']) list = appendEvent(list, bare(t));
    expect(list.map(e => e.text)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('appends a numbered event onto unnumbered history without reordering it', () => {
    // Mixed streams are possible: the pi tailer numbers its events and the
    // hook does not. Sorting a list that is partly unnumbered would shuffle
    // the unnumbered ones to the front.
    const list = appendEvent([bare('a'), bare('b')], { seq: 7, text: 'c' });
    expect(list.map(e => e.text)).toEqual(['a', 'b', 'c']);
  });

  it('appends an unnumbered event onto numbered history', () => {
    const list = appendEvent([{ seq: 1, text: 'a' }], bare('b'));
    expect(list.map(e => e.text)).toEqual(['a', 'b']);
  });
});
