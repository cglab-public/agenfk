// A flow the parent hub sent is not this hub's to change (CGLAB-182, task 3).
// The server refuses the write; this is the part that tells the admin WHY
// before they click, instead of letting them draft an edit into a 409.
import { describe, it, expect } from 'vitest';
import { parentFlowLock, PARENT_FLOW_LOCK_REASON } from '../pages/parentFlowLock';

describe('parentFlowLock', () => {
  it('locks a parent-origin flow and explains where it came from', () => {
    const s = parentFlowLock('parent');
    expect(s.locked).toBe(true);
    expect(s.reason).toMatch(/parent hub/i);
  });

  it('hands back the shared reason rather than a sentence of its own', () => {
    // Pins the WIRING, not the wording: re-asserting the prose here would be a
    // text-rubric test that can only fail when someone rephrases it.
    expect(parentFlowLock('parent').reason).toBe(PARENT_FLOW_LOCK_REASON);
  });

  it('leaves this hub\'s own flows alone', () => {
    expect(parentFlowLock('hub').locked).toBe(false);
    expect(parentFlowLock('hub').reason).toBeNull();
  });

  it('leaves a community flow alone — installing a copy makes it ours', () => {
    expect(parentFlowLock('community').locked).toBe(false);
  });

  it('treats an absent source as local, not locked', () => {
    // A flow row from an older hub has no source. Defaulting to locked would
    // freeze an org out of its own flows on upgrade.
    expect(parentFlowLock(undefined).locked).toBe(false);
    expect(parentFlowLock(null).locked).toBe(false);
  });
});
