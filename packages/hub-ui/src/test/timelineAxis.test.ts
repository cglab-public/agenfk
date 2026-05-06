import { describe, it, expect } from 'vitest';
import {
  buildAxis,
  effectiveBucket,
  fromIsoForRange,
  rangeToDays,
  shortLabel,
  startOfLocalDay,
} from '../components/timelineAxis';

describe('rangeToDays', () => {
  it('maps named ranges to days; today is 0', () => {
    expect(rangeToDays('today')).toBe(0);
    expect(rangeToDays('7d')).toBe(7);
    expect(rangeToDays('30d')).toBe(30);
    expect(rangeToDays('90d')).toBe(90);
  });
});

describe('effectiveBucket', () => {
  it('forces hour bucket when range is today, regardless of selection', () => {
    expect(effectiveBucket('today', 'day')).toBe('hour');
    expect(effectiveBucket('today', 'hour')).toBe('hour');
  });
  it('passes through bucket otherwise', () => {
    expect(effectiveBucket('7d', 'day')).toBe('day');
    expect(effectiveBucket('30d', 'hour')).toBe('hour');
  });
});

describe('startOfLocalDay', () => {
  it('returns midnight of the local day for the given Date', () => {
    const d = new Date(2026, 4, 6, 14, 37, 12); // 2026-05-06 14:37:12 local
    const s = startOfLocalDay(d);
    expect(s.getFullYear()).toBe(2026);
    expect(s.getMonth()).toBe(4);
    expect(s.getDate()).toBe(6);
    expect(s.getHours()).toBe(0);
    expect(s.getMinutes()).toBe(0);
    expect(s.getSeconds()).toBe(0);
  });
});

describe('fromIsoForRange', () => {
  it('today → ISO of local midnight (start-of-today)', () => {
    const now = new Date(2026, 4, 6, 14, 37, 0);
    const iso = fromIsoForRange(now, 'today');
    // Round-tripping the iso should yield the same instant as local midnight.
    const back = new Date(iso);
    expect(back.getTime()).toBe(new Date(2026, 4, 6, 0, 0, 0).getTime());
  });
  it('Nd → ISO of (now - N*86400s)', () => {
    const now = new Date(Date.UTC(2026, 4, 6, 12, 0, 0));
    const iso = fromIsoForRange(now, '7d');
    expect(new Date(iso).getTime()).toBe(now.getTime() - 7 * 86400_000);
  });
});

describe('buildAxis (today)', () => {
  it('returns hourly buckets from 00:00 through the current hour, all on today', () => {
    const now = new Date(2026, 4, 6, 14, 37, 0); // local 14:37
    const axis = buildAxis(now, 'today', 'day' /* should be ignored */);
    expect(axis.length).toBe(15); // 00:00 through 14:00 inclusive
    expect(axis[0]).toBe('2026-05-06T00:00');
    expect(axis[axis.length - 1]).toBe('2026-05-06T14:00');
  });
  it('emits exactly 1 bucket at the start of the day', () => {
    const now = new Date(2026, 4, 6, 0, 5, 0);
    const axis = buildAxis(now, 'today', 'hour');
    expect(axis).toEqual(['2026-05-06T00:00']);
  });
  it('emits 24 buckets at 23:xx', () => {
    const now = new Date(2026, 4, 6, 23, 59, 0);
    const axis = buildAxis(now, 'today', 'hour');
    expect(axis.length).toBe(24);
    expect(axis[0]).toBe('2026-05-06T00:00');
    expect(axis[23]).toBe('2026-05-06T23:00');
  });
});

describe('buildAxis (Nd)', () => {
  it('day bucket gives N+1 day keys for an N-day range', () => {
    const now = new Date(2026, 4, 6, 10, 0, 0);
    const axis = buildAxis(now, '7d', 'day');
    expect(axis.length).toBe(8);
    expect(axis[axis.length - 1]).toBe('2026-05-06');
  });
});

describe('shortLabel', () => {
  it('day bucket → "MM/DD"', () => {
    expect(shortLabel('2026-05-06', 'day', '7d')).toBe('05/06');
  });
  it('hour bucket on today → "HH:00"', () => {
    expect(shortLabel('2026-05-06T08:00', 'hour', 'today')).toBe('08:00');
  });
  it('hour bucket on multi-day range → "HH:00"', () => {
    expect(shortLabel('2026-05-06T08:00', 'hour', '7d')).toBe('08:00');
  });
});
