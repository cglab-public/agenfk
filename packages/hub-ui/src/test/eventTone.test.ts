/**
 * Event and item-type badges on the user page (CGLAB-434 S3.2).
 *
 * They used a rainbow of eleven palette colours with no meaning (pink comments,
 * yellow tests, amber transitions). Now: state gets the reserved status tones,
 * work-item lifecycle gets the accent, everything else stays neutral, and item
 * types use their own type tokens.
 */
import { describe, it, expect } from 'vitest';
import { eventTone, itemTypeClass } from '../eventTone';

describe('eventTone', () => {
  it('passes are ok, failures and deletions are danger', () => {
    expect(eventTone('validate.passed')).toBe('ok');
    expect(eventTone('validate.failed')).toBe('danger');
    expect(eventTone('item.deleted')).toBe('danger');
  });

  it('work-item lifecycle is the accent', () => {
    for (const t of ['item.created', 'item.updated', 'item.moved', 'item.closed', 'step.transitioned']) expect(eventTone(t), t).toBe('accent');
  });

  it('everything else is neutral, including types the hub has never seen', () => {
    for (const t of ['comment.added', 'test.logged', 'validate.invoked', 'session.started', 'brand.new']) expect(eventTone(t), t).toBe('neutral');
  });
});

describe('itemTypeClass', () => {
  it('uses each type token for text, border and a faint tint', () => {
    for (const [t, token] of [['EPIC', 'type-epic'], ['STORY', 'type-story'], ['TASK', 'type-task'], ['BUG', 'type-bug']] as const) {
      const cls = itemTypeClass(t);
      expect(cls, t).toMatch(new RegExp(`(?:^|\\s)text-${token}(?:\\s|$)`));
      expect(cls, t).toMatch(new RegExp(`(?:^|\\s)bg-${token}/10(?:\\s|$)`));
    }
  });

  it('an unknown type is neutral', () => {
    expect(itemTypeClass('SPIKE')).not.toMatch(/type-/);
  });
});
