/**
 * @vitest-environment jsdom
 *
 * DailyBarChart's stacked mode (GH-391 follow-up, token types): a stacked bar
 * stands exactly as tall as the same value drawn unstacked, and a bar whose
 * parts are missing or do not add up to it is drawn whole rather than stacked.
 */
import { render, screen, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { DailyBarChart, type DailyBar } from '../components/DailyBarChart';

afterEach(cleanup);

const SERIES = [{ label: 'A', color: 'red' }, { label: 'B', color: 'blue' }];
const format = (v: number) => `${v} units`;
const draw = (title: string, bars: DailyBar[], stacked: boolean) =>
  render(<DailyBarChart title={title} bars={bars} format={format} {...(stacked ? { series: SERIES } : {})} />);
const fillOf = (title: string, day: string) => {
  const bar = within(screen.getByRole('region', { name: title })).getByRole('option', { name: new RegExp(`^${day}`) });
  return bar.firstElementChild as HTMLElement;
};

describe('DailyBarChart, stacked', () => {
  const bars: DailyBar[] = [
    { day: '2026-11-18', value: 40, parts: [30, 10] },
    { day: '2026-11-19', value: 100, parts: [25, 75] },
  ];

  it('a stacked bar is exactly as tall as the same value unstacked', () => {
    draw('stacked', bars, true);
    draw('plain', bars.map(({ parts: _p, ...b }) => b), false);
    for (const day of ['2026-11-18', '2026-11-19']) {
      expect(fillOf('stacked', day).style.height).toBe(fillOf('plain', day).style.height);
    }
    expect(fillOf('stacked', '2026-11-19').querySelectorAll('[data-series]')).toHaveLength(2);
  });

  it.each([
    ['parts that do not add up to the value', [20, 20]],
    ['too few parts', [100]],
    ['no parts', undefined],
  ])('with %s, the bar is drawn whole, unstacked, and its name claims no split', (_label, parts) => {
    draw('chart', [{ day: '2026-11-19', value: 100, ...(parts ? { parts } : {}) }], true);
    const fill = fillOf('chart', '2026-11-19');
    expect(fill.querySelectorAll('[data-series]')).toHaveLength(0);
    expect(fill.style.height).toBe('100%');
    expect(within(screen.getByRole('region', { name: 'chart' })).getByRole('option')).toHaveAccessibleName('2026-11-19: 100 units');
  });
});
