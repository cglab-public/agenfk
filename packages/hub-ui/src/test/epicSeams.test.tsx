/**
 * @vitest-environment jsdom
 *
 * Seams from the epic review of "[UX] Mobile and accessibility" (BUG
 * de113d39): rows that could not wrap on a phone. jsdom has no layout, so the
 * classes that let them wrap are pinned; each was measured in Chrome at 390px.
 */
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '../ThemeContext';
import { Callout, Button } from '../components/ui';
import { ModelTable } from '../components/ModelTable';
import { AdminInstallations } from '../pages/Admin';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;
beforeEach(() => { get.mockReset(); get.mockResolvedValue({ data: [] }); });
afterEach(cleanup);
const mount = (el: React.ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<ThemeProvider><QueryClientProvider client={qc}><MemoryRouter>{el}</MemoryRouter></QueryClientProvider></ThemeProvider>);
};
const classes = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/);

describe('a notice with an action', () => {
  it('wraps the action under the text on a phone instead of squeezing the text', () => {
    render(<Callout tone="warn" title="Action required" action={<Button size="sm">I've updated my deployment</Button>}>Set the org id before the next restart.</Callout>);
    const action = screen.getByRole('button', { name: "I've updated my deployment" }).parentElement!;
    expect(classes(action.parentElement!)).toContain('flex-wrap');
    expect(classes(action)).toEqual(expect.arrayContaining(['basis-full', 'sm:basis-auto']));
    expect(classes(action)).not.toContain('shrink-0');
  });
});

describe('the Models table header', () => {
  it('lets the classification hint shrink and wrap instead of widening the page', () => {
    mount(<ModelTable groups={[]} metaRows={[] as never} loading={false} onError={() => {}} invalidate={vi.fn()}
      onUnmap={() => {}} unmapping={false} unmappedCount={0} unusedCount={0} />);
    const hint = screen.getByText(/Off: only models actually reported/);
    expect(hint.closest('[class~="shrink-0"]')).toBeNull();
    expect(classes(hint.parentElement!.parentElement!)).toContain('min-w-0');
  });
});

describe('the Installations header', () => {
  it('wraps its controls under the description on a phone', async () => {
    mount(<AdminInstallations />);
    const heading = await screen.findByRole('heading', { name: 'Installations' });
    expect(classes(heading.closest('header')!)).toContain('flex-wrap');
  });
});
