/**
 * @vitest-environment jsdom
 *
 * Phone and narrow-window layout (STORY b9ec05d4). The 240px sidebar never
 * collapsed, so at 390px it took half the screen and squeezed every page.
 * Below md the sidebar becomes a drawer behind a top-bar menu button; md and
 * up keep the static sidebar.
 *
 * jsdom has no media queries, so the breakpoint itself is asserted through
 * the classes that implement it. Everything a user does — open, close,
 * focus, follow a link — is asserted as behaviour.
 */
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ThemeProvider } from '../ThemeContext';
import { Layout } from '../components/Layout';

vi.mock('../api', () => ({
  api: {
    get: vi.fn(async (url: string) => {
      if (url === '/auth/me') return { data: { userId: 'u1', orgId: 'o1', role: 'member', name: 'Ada' } };
      if (url === '/healthz') return { data: { ok: true, version: '1.1.20' } };
      return { data: {} };
    }),
    post: vi.fn(async () => ({ data: {} })),
  },
}));

function renderLayout() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/']}>
        <ThemeProvider>
          <Routes>
            <Route path="/" element={<Layout><div>org page</div></Layout>} />
            <Route path="/prs" element={<Layout><div>prs page</div></Layout>} />
          </Routes>
        </ThemeProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const menuButton = () => screen.getByRole('button', { name: 'Open navigation' });
const sidebar = () => document.getElementById(menuButton().getAttribute('aria-controls')!)!;
const classes = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/);

describe('Layout on narrow screens', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(cleanup);

  describe('top bar', () => {
    it('has a menu button that controls the sidebar and starts collapsed', async () => {
      renderLayout();
      await screen.findByText('org page');

      expect(menuButton().getAttribute('aria-expanded')).toBe('false');
      expect(sidebar().tagName).toBe('ASIDE');
    });

    it('exists only below md', async () => {
      renderLayout();
      await screen.findByText('org page');

      const bar = menuButton().closest('[data-topbar]')!;
      expect(bar).not.toBeNull();
      expect(classes(bar)).toContain('md:hidden');
    });
  });

  describe('closed drawer', () => {
    it('is off screen and out of the tab order below md, and a normal sidebar from md up', async () => {
      renderLayout();
      await screen.findByText('org page');

      const c = classes(sidebar());
      // invisible = no focus, no screen reader; md:visible restores both.
      expect(c).toContain('invisible');
      expect(c).toContain('md:visible');
      expect(c).toContain('-translate-x-full');
      expect(c).toContain('md:translate-x-0');
      expect(c).toContain('md:static');
    });
  });

  describe('opening', () => {
    it('shows the drawer and moves focus into it', async () => {
      renderLayout();
      await screen.findByText('org page');

      fireEvent.click(menuButton());

      expect(menuButton().getAttribute('aria-expanded')).toBe('true');
      expect(classes(sidebar())).not.toContain('invisible');
      expect(classes(sidebar())).not.toContain('-translate-x-full');
      await waitFor(() => expect(sidebar().contains(document.activeElement)).toBe(true));
    });

    it('puts a backdrop behind it that only narrow screens see', async () => {
      renderLayout();
      await screen.findByText('org page');
      expect(screen.queryByTestId('drawer-backdrop')).toBeNull();

      fireEvent.click(menuButton());

      expect(classes(screen.getByTestId('drawer-backdrop'))).toContain('md:hidden');
    });
  });

  describe('closing', () => {
    async function openDrawer() {
      renderLayout();
      await screen.findByText('org page');
      fireEvent.click(menuButton());
      await waitFor(() => expect(sidebar().contains(document.activeElement)).toBe(true));
    }
    const isClosed = () => menuButton().getAttribute('aria-expanded') === 'false' && classes(sidebar()).includes('invisible');

    it('closes on Escape and returns focus to the menu button', async () => {
      await openDrawer();

      fireEvent.keyDown(document.activeElement!, { key: 'Escape' });

      expect(isClosed()).toBe(true);
      await waitFor(() => expect(document.activeElement).toBe(menuButton()));
    });

    it('closes from its own close button and returns focus to the menu button', async () => {
      await openDrawer();

      fireEvent.click(screen.getByRole('button', { name: 'Close navigation' }));

      expect(isClosed()).toBe(true);
      await waitFor(() => expect(document.activeElement).toBe(menuButton()));
    });

    it('closes when the backdrop is tapped', async () => {
      await openDrawer();

      fireEvent.click(screen.getByTestId('drawer-backdrop'));

      expect(isClosed()).toBe(true);
      expect(screen.queryByTestId('drawer-backdrop')).toBeNull();
    });

    it('closes after following a link in it', async () => {
      await openDrawer();

      fireEvent.click(screen.getByRole('link', { name: /PR overview/ }));

      await screen.findByText('prs page');
      expect(isClosed()).toBe(true);
    });

    it('stops listening for Escape once closed', async () => {
      await openDrawer();
      fireEvent.click(screen.getByTestId('drawer-backdrop'));
      const elsewhere = screen.getByRole('button', { name: /Sign out/ });
      elsewhere.focus();

      // A listener left behind would pull focus back to the menu button.
      fireEvent.keyDown(elsewhere, { key: 'Escape' });

      expect(document.activeElement).toBe(elsewhere);
    });

    it('ignores Escape while already closed', async () => {
      renderLayout();
      await screen.findByText('org page');
      const before = document.activeElement;

      fireEvent.keyDown(document.body, { key: 'Escape' });

      expect(isClosed()).toBe(true);
      expect(document.activeElement).toBe(before);
    });
  });

  describe('while open', () => {
    it('is a modal dialog and the page behind it is inert', async () => {
      renderLayout();
      await screen.findByText('org page');
      const main = document.querySelector('main[data-scroll-root]')!;
      const bar = menuButton().closest('[data-topbar]')!;
      expect(main.hasAttribute('inert')).toBe(false);
      expect(sidebar().getAttribute('role')).toBeNull();

      fireEvent.click(menuButton());

      // inert keeps Tab and screen readers out of the page under the backdrop.
      expect(main.hasAttribute('inert')).toBe(true);
      expect(bar.hasAttribute('inert')).toBe(true);
      expect(sidebar().getAttribute('role')).toBe('dialog');
      expect(sidebar().getAttribute('aria-modal')).toBe('true');
      expect(sidebar().getAttribute('aria-label')).toBe('Navigation');

      fireEvent.click(screen.getByRole('button', { name: 'Close navigation' }));
      expect(main.hasAttribute('inert')).toBe(false);
      expect(bar.hasAttribute('inert')).toBe(false);
      expect(sidebar().getAttribute('role')).toBeNull();
    });

    it.each([
      ['Escape', () => fireEvent.keyDown(document.activeElement!, { key: 'Escape' })],
      ['the close button', () => fireEvent.click(screen.getByRole('button', { name: 'Close navigation' }))],
    ])('returns focus only once the top bar is no longer inert (%s)', async (_how, close) => {
      // Browsers ignore focus() inside an inert subtree, and jsdom does not
      // enforce inert, so record the attribute at the moment focus is asked for.
      renderLayout();
      await screen.findByText('org page');
      fireEvent.click(menuButton());
      await waitFor(() => expect(sidebar().contains(document.activeElement)).toBe(true));
      const button = menuButton();
      const bar = button.closest('[data-topbar]')!;
      const inertAtFocus: boolean[] = [];
      const realFocus = button.focus.bind(button);
      button.focus = (opts?: FocusOptions) => { inertAtFocus.push(bar.hasAttribute('inert')); realFocus(opts); };

      close();

      await waitFor(() => expect(document.activeElement).toBe(button));
      expect(inertAtFocus).toEqual([false]);
    });

    it('becomes visible at once on open and hides only after sliding out on close', async () => {
      // Visibility under transition stays `hidden` until the transition ends,
      // and browsers refuse focus() there: an open that animated visibility
      // would leave focus outside the drawer. jsdom has no computed styles, so
      // the timing is pinned on the class that sets it.
      renderLayout();
      await screen.findByText('org page');
      const closedTransition = classes(sidebar()).filter(c => c.startsWith('[transition:'));
      expect(closedTransition).toEqual(['[transition:translate_200ms,visibility_0s_200ms]']);

      fireEvent.click(menuButton());

      const openTransition = classes(sidebar()).filter(c => c.startsWith('[transition:'));
      expect(openTransition).toEqual(['[transition:translate_200ms,visibility_0s]']);
      expect(classes(sidebar())).toEqual(expect.arrayContaining(['motion-reduce:transition-none', 'md:transition-none']));
    });

    it('sits above its backdrop, on an opaque surface', async () => {
      renderLayout();
      await screen.findByText('org page');
      fireEvent.click(menuButton());

      const z = (el: Element) => Number(classes(el).find(c => /^z-\d+$/.test(c))?.slice(2));
      const aside = classes(sidebar());
      expect(aside).toContain('fixed');
      // A backdrop above the drawer would swallow every tap on a link.
      expect(z(sidebar())).toBeGreaterThan(z(screen.getByTestId('drawer-backdrop')));
      expect(aside).toEqual(expect.arrayContaining(['bg-surface', 'md:bg-nav-surface']));
      expect(aside).not.toContain('bg-nav-surface');
    });

    it('closes when the window widens to md, where the sidebar is static', async () => {
      const listeners: Array<(e: { matches: boolean }) => void> = [];
      const original = window.matchMedia;
      window.matchMedia = ((q: string) => ({
        matches: false, media: q,
        addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => { if (q.includes('48rem')) listeners.push(fn); },
        removeEventListener: () => {},
      })) as unknown as typeof window.matchMedia;
      try {
        renderLayout();
        await screen.findByText('org page');
        fireEvent.click(menuButton());
        expect(menuButton().getAttribute('aria-expanded')).toBe('true');

        act(() => listeners.forEach(fn => fn({ matches: true })));

        expect(menuButton().getAttribute('aria-expanded')).toBe('false');
        expect(screen.queryByTestId('drawer-backdrop')).toBeNull();
      } finally {
        window.matchMedia = original;
      }
    });
  });

  describe('shell', () => {
    it('stacks the top bar over the content below md and puts the sidebar beside it from md', async () => {
      renderLayout();
      await screen.findByText('org page');

      const shell = classes(sidebar().parentElement!);
      expect(shell).toEqual(expect.arrayContaining(['flex', 'flex-col', 'md:flex-row']));
      // dvh, not vh: iOS Safari's 100vh runs under its toolbar and clips the end of the page.
      expect(shell).toContain('h-dvh');
      expect(shell).not.toContain('h-screen');
    });
  });

  describe('content', () => {
    it('is the containing block for what it holds, so hidden text cannot stretch the page', async () => {
      // sr-only spans are position:absolute; with no positioned ancestor they
      // took the page as their box, and long admin tables made the whole
      // shell scroll away (epic review, measured at 390px).
      renderLayout();
      await screen.findByText('org page');
      expect(classes(document.querySelector('main[data-scroll-root]')!)).toContain('relative');
    });

    it('pads 16px below md, then as before', async () => {
      renderLayout();
      await screen.findByText('org page');

      const c = classes(document.querySelector('main[data-scroll-root]')!);
      expect(c).toEqual(expect.arrayContaining(['p-4', 'md:p-6', 'lg:p-8']));
      expect(c).not.toContain('p-6');
    });
  });
});
