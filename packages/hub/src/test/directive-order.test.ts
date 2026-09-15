// The two dispatch kinds share one directive feed and a child takes ONE per
// poll, so which is served is decided by comparing two created_at values that
// come from DIFFERENT tables. Postgres hands those back as Dates and SQLite as
// ISO strings, and the comparison has to be right whichever it gets — and,
// importantly, right when it gets one of each.
import { describe, it, expect } from 'vitest';
import { msOf } from '../routes/federation';

describe('msOf — comparing dispatch timestamps across backend row shapes', () => {
  // Deliberately NOT on a whole second: String(aDate) drops milliseconds, so
  // a version of msOf that stringifies a Date instead of reading it passes at
  // .000 and silently loses precision everywhere else.
  const iso = '2026-09-15T10:00:00.123Z';

  it('reads a Date, the shape Postgres returns, without losing milliseconds', () => {
    expect(msOf(new Date(iso))).toBe(Date.parse(iso));
  });

  it('reads an ISO string, the shape SQLite returns', () => {
    expect(msOf(iso)).toBe(Date.parse(iso));
  });

  it('orders a Date against a string correctly — where a bare < silently fails', () => {
    // `new Date(...) < '2026-...'` is false in BOTH directions: the relational
    // operators coerce the Date to a number and the string to NaN. A feed
    // comparing the two raw would serve the same wrong directive forever.
    const older = new Date('2026-09-15T09:00:00.000Z');
    const newer = '2026-09-15T11:00:00.000Z';
    expect((older as any) < newer).toBe(false);
    expect((newer as any) < older).toBe(false);
    expect(msOf(older) < msOf(newer)).toBe(true);
  });

  it('sorts an unusable value LAST, so it loses rather than wins', () => {
    // A malformed or null timestamp must not take the feed down — but it must
    // also not be treated as the oldest thing in the world, because oldest
    // WINS here. Sorting it first would promote one broken row ahead of every
    // correct one, permanently.
    const valid = msOf('2026-09-15T10:00:00.000Z');
    for (const bad of [null, undefined, 'not a date', {}, NaN]) {
      expect(msOf(bad) > valid).toBe(true);
    }
  });
});
