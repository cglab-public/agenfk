/**
 * One attempt to run one card on one agent (CGLAB-206).
 *
 * THE TEST THAT MATTERS IS WHAT IT REFUSES. A state machine that accepts every
 * transition is a text field with a nicer name, and the interesting thing
 * about one is always the moves it will not make.
 *
 * THE SECOND IS THE GATE. A coordinator resolving its own gate is the shape
 * this is easiest to ship with - check only that the caller is inside the run
 * and the authorised caller turns out to BE the coordinator. That is a
 * formality wearing a checkpoint's name, and nothing about it looks wrong
 * until somebody asks who approved.
 */
import { describe, it, expect } from 'vitest';
import {
  canTransition,
  isTerminal,
  stateAfterMessage,
  messageNeedsPerson,
  resolveGate,
  type DispatchState,
} from '../dispatch';

const ALL: DispatchState[] = ['queued', 'running', 'blocked', 'unverifiable', 'done', 'failed'];

describe('the moves it allows', () => {
  it('starts an attempt', () => {
    expect(canTransition('queued', 'running').allowed).toBe(true);
  });

  it('lets contact come back', () => {
    /*
     * The point of `unverifiable`: it is a gap in KNOWLEDGE, not a fate. An
     * attempt we could not see and can see again is running, and a machine
     * that treated the state as terminal would strand live work.
     */
    expect(canTransition('unverifiable', 'running').allowed).toBe(true);
    expect(canTransition('unverifiable', 'done').allowed).toBe(true);
  });

  it('lets a blocked attempt carry on once it is answered', () => {
    expect(canTransition('blocked', 'running').allowed).toBe(true);
  });
});

describe('the moves it refuses', () => {
  it('will not finish an attempt that never ran', () => {
    /*
     * THE test. queued -> done would let a bookkeeping slip look like
     * completed work, and nothing downstream could tell the difference
     * between a card that was done and one that was skipped.
     */
    const t = canTransition('queued', 'done');
    expect(t.allowed, 'an attempt that never started was recorded as finished').toBe(false);
    expect(t.reason).toContain('cannot go from queued to done');
  });

  it('will not reopen a terminal attempt', () => {
    for (const from of ['done', 'failed'] as const) {
      for (const to of ALL) {
        expect(canTransition(from, to).allowed, `${from} -> ${to} was allowed`).toBe(false);
      }
    }
  });

  it('tells you to start a new attempt rather than reopening', () => {
    // A refusal that only states the rule leaves somebody looking for a flag
    // to force it.
    expect(canTransition('done', 'running').reason).toMatch(/start a new one/i);
  });

  it('treats a move to the same state as no move at all', () => {
    // Not an error, and not allowed: reporting it as allowed lets a caller
    // rewrite startedAt on a no-op.
    expect(canTransition('running', 'running').allowed).toBe(false);
    expect(canTransition('running', 'running').reason).toMatch(/already running/i);
  });

  it('lists the moves that WOULD work, so the refusal is actionable', () => {
    expect(canTransition('queued', 'blocked').reason).toMatch(/may go to: running, failed/);
  });
});

describe('which states are the end', () => {
  it('is done and failed, and nothing else', () => {
    expect(isTerminal('done')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
    for (const s of ['queued', 'running', 'blocked', 'unverifiable'] as const) {
      expect(isTerminal(s), `${s} was treated as terminal`).toBe(false);
    }
  });
});

describe('what a message does to the attempt', () => {
  it('blocks on a question and on an escalation', () => {
    expect(stateAfterMessage('running', 'question')).toBe('blocked');
    expect(stateAfterMessage('running', 'escalation')).toBe('blocked');
  });

  it('changes nothing on progress', () => {
    /*
     * A machine that transitioned on every report would spend its time
     * confirming what it already knew, and every confirmation is a write.
     */
    expect(stateAfterMessage('running', 'progress')).toBeNull();
  });

  it('lifts loss of contact on a heartbeat, and only that', () => {
    // Hearing from it at all is the one thing that can answer "can we see it".
    expect(stateAfterMessage('unverifiable', 'heartbeat')).toBe('running');
    expect(stateAfterMessage('running', 'heartbeat')).toBeNull();
  });

  it('does NOT unblock a blocked attempt on a heartbeat', () => {
    /*
     * The question is still unanswered. A heartbeat clearing it would be the
     * machine answering on the agent's behalf, which is the same class of
     * mistake as treating absence as an answer.
     */
    expect(stateAfterMessage('blocked', 'heartbeat'), 'a heartbeat answered a question').toBeNull();
  });

  it('ignores every message once the attempt is over', () => {
    for (const kind of ['progress', 'question', 'escalation', 'done', 'heartbeat'] as const) {
      expect(stateAfterMessage('done', kind), `${kind} moved a finished attempt`).toBeNull();
      expect(stateAfterMessage('failed', kind), `${kind} moved a failed attempt`).toBeNull();
    }
  });

  it('never proposes a move the table refuses', () => {
    /*
     * THE test of this pair, and the one that found six disagreements. Two
     * functions that each look right on their own can still contradict each
     * other, and a caller trusting `stateAfterMessage` would then walk straight
     * past the table - the guarantees live in the table, so walking past it is
     * walking past all of them.
     *
     * Checked across the whole cross-product rather than case by case: the
     * point is that no pair CAN disagree, which a handful of examples cannot
     * establish.
     */
    for (const from of ALL) {
      for (const kind of ['progress', 'question', 'escalation', 'done', 'heartbeat'] as const) {
        const to = stateAfterMessage(from, kind);
        if (to === null) continue;
        expect(
          canTransition(from, to).allowed,
          `${from} + ${kind} proposed ${to}, which the table refuses`,
        ).toBe(true);
      }
    }
  });

  it('ignores a message from an attempt that was never started', () => {
    /*
     * A queued attempt has not been handed to anybody, so there is nobody to
     * be reporting. Honouring it would give the attempt a state it reached
     * without ever running - the same hole as queued -> done, arriving by the
     * side door.
     */
    for (const kind of ['question', 'escalation', 'done', 'heartbeat'] as const) {
      expect(stateAfterMessage('queued', kind), `${kind} moved a queued attempt`).toBeNull();
    }
  });

  it('lets an agent that went quiet come back WITH a question', () => {
    /*
     * Contact returning and a question arriving are the same event here. The
     * table has to allow unverifiable -> blocked or the message would be
     * dropped, and a dropped question is one nobody ever answers.
     */
    expect(stateAfterMessage('unverifiable', 'question')).toBe('blocked');
  });

  it('lets a blocked attempt report that it finished anyway', () => {
    // The question stopped mattering, or the agent answered it itself. Real,
    // and refusing it would strand the attempt in blocked forever.
    expect(stateAfterMessage('blocked', 'done')).toBe('done');
  });

  it('marks the two kinds that need a person, and only those', () => {
    expect(messageNeedsPerson('question')).toBe(true);
    expect(messageNeedsPerson('escalation')).toBe(true);
    for (const kind of ['progress', 'done', 'heartbeat'] as const) {
      expect(messageNeedsPerson(kind), `${kind} was sent to a person`).toBe(false);
    }
  });
});

describe('a gate needs somebody on the other side', () => {
  it('refuses the coordinator resolving its own gate', () => {
    /*
     * THE test, and the shape this is easiest to ship with: check only that
     * the caller is inside the run's scope, and the authorised caller turns
     * out to BE the coordinating terminal. A formality wearing a checkpoint's
     * name, and nothing looks wrong until somebody asks who approved.
     */
    const r = resolveGate({ gateId: 'g1', resolvedBy: 'coordinator-1', raisedBy: 'coordinator-1' });
    expect(r.allowed, 'a coordinator approved its own gate').toBe(false);
    expect(r.reason).toMatch(/cannot resolve it/i);
  });

  it('says why, so nobody adds a flag to allow it', () => {
    const r = resolveGate({ gateId: 'g1', resolvedBy: 'c1', raisedBy: 'c1' });
    expect(r.reason).toMatch(/put somebody else in the loop/i);
  });

  it('accepts a different party', () => {
    expect(resolveGate({ gateId: 'g1', resolvedBy: 'leonardo', raisedBy: 'coordinator-1' }).allowed).toBe(true);
  });

  it('refuses an anonymous approval', () => {
    // Without a name there is nobody in the loop, which is the same gate with
    // an extra step.
    for (const who of ['', '   ']) {
      expect(resolveGate({ gateId: 'g1', resolvedBy: who, raisedBy: 'c1' }).allowed).toBe(false);
    }
  });
});
