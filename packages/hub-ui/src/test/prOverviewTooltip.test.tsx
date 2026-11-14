/**
 * @vitest-environment jsdom
 *
 * PR Overview heatmap tooltip is readable in BOTH themes (user report
 * 2026-09-24): it was bg-card-glass + text-white, and card-glass is 82% white
 * in light mode, so the text vanished. jsdom runs no Tailwind, so the test
 * hovers a real cell, takes the tooltip's own bg/text classes, resolves them
 * through brand/tokens.css for each theme (compositing a translucent fill over
 * the page canvas) and requires WCAG AA.
 */
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import * as fs from 'fs';
import * as path from 'path';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PrOverviewPage } from '../pages/PrOverview';
import { cellTooltip } from '../prPerDay';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;

const overview = {
  period: { from: '2026-08-10T00:00:00.000Z', to: '2026-08-22T23:59:59.999Z' },
  buckets: ['xs', 's', 'm', 'l', 'xl'],
  totals: { prs: 2, sizePoints: 8, developers: 1, medianBucket: 'xs' },
  resized: { count: 0, grew: 0, shrank: 0 },
  byDay: [
    {
      day: '2026-08-13',
      sizes: { xs: 1, s: 0, m: 0, l: 1, xl: 0 },
      total: 2,
      devBySize: {
        xs: [{ user_key: 'alice@acme.com', count: 1 }],
        s: [], m: [], l: [{ user_key: 'alice@acme.com', count: 1 }], xl: [],
      },
    },
  ],
  byDeveloper: [
    {
      user_key: 'alice@acme.com',
      prs: 2,
      sizePoints: 8,
      sizes: { xs: 1, s: 0, m: 0, l: 1, xl: 0 },
      daily: { '2026-08-13': 2 },
    },
  ],
  byModel: [
    { model: 'claude-opus-5', harnesses: ['claude-code'], prs: 2, sizePoints: 8, sizes: { xs: 1, s: 0, m: 0, l: 1, xl: 0 } },
  ],
  prs: [
    {
      repo: 'cglab-PRIVATE/smartshot',
      prNumber: 202,
      url: 'https://github.com/cglab-PRIVATE/smartshot/pull/202',
      user_key: 'alice@acme.com',
      model: 'claude-opus-5',
      harness: 'claude-code',
      openedAt: '2026-08-13T16:50:18Z',
      day: '2026-08-13',
      points: 2,
      bucket: 'xs',
    },
    {
      repo: 'cglab-PRIVATE/smartshot',
      prNumber: 203,
      url: null, // non-GitHub host — the hub deliberately derives no link
      user_key: 'alice@acme.com',
      model: 'claude-opus-5',
      harness: 'claude-code',
      openedAt: '2026-08-13T18:12:13Z',
      day: '2026-08-13',
      points: 16,
      bucket: 'l',
    },
  ],
  previous: { prs: 1, sizePoints: 4 },
};


const TOKENS = fs.readFileSync(path.resolve(__dirname, '../../../brand/tokens.css'), 'utf8');
function block(selector: string): Record<string, string> {
  const open = TOKENS.indexOf('{', TOKENS.indexOf(selector));
  let depth = 0, end = open;
  for (let i = open; i < TOKENS.length; i++) {
    if (TOKENS[i] === '{') depth++;
    if (TOKENS[i] === '}' && --depth === 0) { end = i; break; }
  }
  const out: Record<string, string> = {};
  for (const m of TOKENS.slice(open + 1, end).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}
/** Tailwind colour name -> the brand token it reads, from the @theme block. */
const THEME = block('\n@theme {');
const LIGHT = block('\n:root {');
const DARK = block('.dark, .dark *');
type RGBA = [number, number, number, number];
function parse(v: string): RGBA {
  if (v.startsWith('#')) return [1, 3, 5].map(i => parseInt(v.slice(i, i + 2), 16)).concat(1) as RGBA;
  const m = /rgba?\(([^)]+)\)/.exec(v);
  if (!m) throw new Error(`cannot read colour ${v}`);
  const [r, g, b, a = '1'] = m[1].split(',').map(s => s.trim());
  return [Number(r), Number(g), Number(b), Number(a)];
}
function resolve(name: string, theme: Record<string, string>): RGBA {
  if (name === 'white') return [255, 255, 255, 1];
  if (name === 'black') return [0, 0, 0, 1];
  const ref = THEME[`--color-${name}`];
  if (!ref) throw new Error(`no theme colour for ${name}`);
  const token = /var\((--[\w-]+)\)/.exec(ref)?.[1];
  return parse(token ? theme[token] ?? LIGHT[token] : ref);
}
const over = (fg: RGBA, bg: RGBA): RGBA => [0, 1, 2].map(i => Math.round(fg[i] * fg[3] + bg[i] * (1 - fg[3]))).concat(1) as RGBA;
const lum = ([r, g, b]: RGBA) => [r, g, b].map(v => v / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a: RGBA, b: RGBA) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const FIXTURE_NOW = new Date('2026-08-14T12:00:00.000Z');
beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); vi.setSystemTime(FIXTURE_NOW); get.mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); get.mockReset(); });

describe('PR heatmap tooltip', () => {
  it('is readable in light and dark mode', async () => {
    get.mockImplementation(async (url: string) => {
      if (url.startsWith('/v1/projects')) return { data: { projects: ['cglab-PRIVATE/smartshot'] } };
      if (url.startsWith('/v1/child-hubs')) return { data: { childHubs: [], hasLocal: true } };
      return { data: overview };
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={['/prs']}><PrOverviewPage /></MemoryRouter></QueryClientProvider>);
    const cell = await screen.findByRole('button', { name: '2 PRs by alice@acme.com on 2026-08-13 — open list' });
    fireEvent.mouseEnter(cell);
    const tip = await screen.findByText(cellTooltip('alice@acme.com', '2026-08-13', 2));
    const classes = tip.className.split(/\s+/);
    const isColourText = (c: string) => c.startsWith('text-') && !/^text-\[/.test(c) && !/^text-(xs|sm|base|lg|left|right|center)$/.test(c);
    // In dark mode a `dark:` class wins over the base one, so check that one.
    const pick = (dark: boolean, test: (c: string) => boolean, prefix: string) =>
      ((dark && classes.find(c => c.startsWith('dark:') && test(c.slice(5)))?.slice(5)) || classes.find(test)!).slice(prefix.length);
    for (const [label, theme] of [['light', LIGHT], ['dark', DARK]] as const) {
      const bgName = pick(label === 'dark', c => c.startsWith('bg-'), 'bg-');
      const textName = pick(label === 'dark', isColourText, 'text-');
      const canvas = resolve('canvas', theme);
      const bg = over(resolve(bgName, theme), canvas);
      const fg = over(resolve(textName, theme), bg);
      expect(contrast(fg, bg), `${label}: text-${textName} on bg-${bgName}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
