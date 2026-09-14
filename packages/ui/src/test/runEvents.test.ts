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
