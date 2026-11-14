/**
 * @vitest-environment jsdom
 *
 * Movement, and the rules it has to obey.
 *
 * The point of animating the sidebar and the project folders is not polish: it
 * is that without it the content JUMPS, and the eye has to re-find where it
 * was. That is the whole justification, and it is also why the list of things
 * that animate is short.
 *
 * Two rules are non-negotiable and are what this file actually guards.
 *
 * **`prefers-reduced-motion` must disable all of it.** Not a style preference —
 * for some people motion causes real nausea. Every transition added here has to
 * carry the escape, and a test has to fail when a new one forgets.
 *
 * **Terminal output never animates.** xterm writes dozens of frames a second;
 * any transition over it is pure jank. Neither do counters that change on their
 * own from socket events: animating something the user did not cause draws the
 * eye to the wrong place.
 */
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { AppShell } from '../components/AppShell';
import { ActiveProjectProvider } from '../ActiveProject';
import { SocketProvider } from '../SocketContext';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '../api';

vi.mock('../api', () => ({
  api: {
    listProjects: vi.fn(async () => [
      { id: 'p1', name: 'agenfk', createdAt: new Date(), updatedAt: new Date() },
    ]),
    listActiveItems: vi.fn(async () => []),
    listRuns: vi.fn(async () => []),
    getVersion: vi.fn(async () => ({ version: '1.1.18' })),
    getReadme: vi.fn(async () => ({ content: '' })),
    getLatestRelease: vi.fn(async () => null),
    updateItem: vi.fn(async () => ({})),
  },
}));

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({
    connected: true, connect: vi.fn(), on: vi.fn(), off: vi.fn(), emit: vi.fn(), disconnect: vi.fn(),
  })),
}));

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, 'agenfkDesktop', {
    value: { isDesktop: true, platform: 'darwin', versions: { electron: '40', chrome: '1', node: '24' } },
    configurable: true, writable: true,
  });
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation(q => ({
      matches: false, media: q, onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    })),
  });
});
afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).agenfkDesktop;
});

const renderShell = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ActiveProjectProvider>
        <SocketProvider>
          <AppShell><div>board</div></AppShell>
        </SocketProvider>
      </ActiveProjectProvider>
    </QueryClientProvider>,
  );
};

/**
 * Elements that actually MOVE.
 *
 * Deliberately not every `transition-*`. A 120ms colour or opacity fade is not
 * motion and does not cause the harm `prefers-reduced-motion` exists to
 * prevent; demanding an escape for those would be noise that trains people to
 * add the class without thinking. What needs the escape is transform, size and
 * position — and keyframe animations, which are motion by definition.
 */
const movingElements = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>('*')).filter(el => {
    const cls = el.className || '';
    if (/\banimate-(?!none)/.test(cls)) return true;
    return /\btransition(-(transform|all))?\b/.test(cls) && !/transition-(colors|opacity|shadow)/.test(cls);
  });

describe('the reduced-motion escape is not optional', () => {
  it('every animated element can be stilled', () => {
    // The rule that has to hold as the app grows. A transition added without
    // the escape fails here, naming the element, rather than shipping and
    // making someone ill.
    renderShell();
    const offenders = movingElements().filter(el => {
      const cls = el.className || '';
      // Tailwind's `motion-safe:` prefix already means "only when motion is
      // welcome", so it is its own escape. Otherwise an explicit
      // `motion-reduce:` override is required.
      if (/motion-safe:/.test(cls)) return false;
      return !/motion-reduce:(transition-none|animate-none|duration-0)/.test(cls);
    });
    expect(
      offenders.map(o => o.className),
      'these animate with no reduced-motion escape',
    ).toEqual([]);
  });
});

describe('what moves', () => {
  it('animates the sidebar collapsing, so the content does not jump', async () => {
    renderShell();
    const aside = document.querySelector('aside')!;
    expect(aside.className).toMatch(/transition/);
  });

  it('animates a project folder opening', async () => {
    // Without it the whole list below jumps and the user loses their place.
    const { api: mockedApi } = await import('../api');
    vi.mocked(mockedApi.listActiveItems).mockResolvedValue([
      { id: 'i1', projectId: 'p1', type: 'TASK', title: 'Work', status: 'IN_PROGRESS' },
    ] as never);
    renderShell();
    const toggle = await screen.findByRole('button', { name: /expand agenfk/i });
    fireEvent.click(toggle);
    const list = document.getElementById('work-p1');
    expect(list?.className).toMatch(/transition|animate-/);
  });
});

describe('what must NOT move', () => {
  it('never animates anything inside the terminal panel', () => {
    // xterm writes dozens of frames a second. A transition over that region is
    // pure jank, and it is the one place where "polish" actively costs.
    renderShell();
    const panel = document.getElementById('panel-terminal');
    const moving = panel
      ? Array.from(panel.querySelectorAll<HTMLElement>('*')).filter(el =>
          /\b(transition|animate-(?!none))/.test(el.className || ''))
      : [];
    expect(moving.map(m => m.className)).toEqual([]);
  });

  it('does not animate the in-flight counts, which change on their own', () => {
    // They move on socket events the user did not cause. Animating them draws
    // the eye to the wrong place at the wrong moment.
    renderShell();
    const count = document.querySelector('[data-testid="in-flight-count"]');
    expect(count?.className ?? '').not.toMatch(/transition|animate-/);
  });
});
