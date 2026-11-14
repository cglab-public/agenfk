/** cc5e4943 (CGLAB-434): the wait between polls of a background verify run. */
import { describe, it, expect } from 'vitest';
import { nextPollDelay } from '../pollBackoff';

const schedule = (n: number, cap?: number) => {
  const out: number[] = [];
  let d: number | undefined;
  for (let i = 0; i < n; i++) { d = nextPollDelay(d, cap); out.push(d); }
  return out;
};

describe('nextPollDelay', () => {
  it('starts at 100ms and doubles up to 1500ms by default', () => {
    expect(schedule(7)).toEqual([100, 200, 400, 800, 1500, 1500, 1500]);
  });
  it('stops at a given cap, and never starts above it', () => {
    expect(schedule(4, 300)).toEqual([100, 200, 300, 300]);
    expect(schedule(2, 50)).toEqual([50, 50]);
  });
  it('a cap of 0 polls without waiting (what the tests of the loops pass)', () => {
    expect(schedule(3, 0)).toEqual([0, 0, 0]);
  });
});
