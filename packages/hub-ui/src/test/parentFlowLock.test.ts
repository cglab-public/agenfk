// A flow the parent hub sent is not this hub's to change (CGLAB-182, task 3).
// The server refuses the write; this is the part that tells the admin WHY
// before they click, instead of letting them draft an edit into a 409.
import { describe, it, expect } from 'vitest';
import { parentFlowLock } from '../pages/parentFlowLock';

describe('parentFlowLock', () => {
  it('locks a parent-origin flow and explains where it came from', () => {
    const s = parentFlowLock('parent');
    expect(s.locked).toBe(true);
    expect(s.reason).toMatch(/parent hub/i);
  });

  it('says the flows stay and become editable if the hub leaves the group', () => {
    // The promise the detach path keeps. An admin reading "you cannot edit
    // this" needs to know the exit is not "lose the flow".
    expect(parentFlowLock('parent').reason).toMatch(/leaves the group|detach/i);
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
