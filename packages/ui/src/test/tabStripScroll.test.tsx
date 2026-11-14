/**
 * @vitest-environment jsdom
 *
 * The terminal tab strip when the tabs outnumber the room.
 *
 * The complaint: with a lot of terminals open, the ones off the end were
 * unreachable. Reading the strip says why, and it is not "scrolling is
 * missing" - the strip had no `overflow-x` AT ALL, and its tabs carried
 * `max-w-[220px]` with no `shrink-0`. So extra tabs never overflowed, they
 * COMPRESSED: ten terminals became ten unreadable slivers, and there was
 * nothing to scroll because nothing was ever out of view.
 *
 * Hence two parts, and both are asserted here: the tabs stop shrinking, and the
 * strip - not the window, not the pane below - becomes the thing that scrolls.
 */
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TerminalTab, type TerminalSession } from '../components/TerminalTab';

/*
 * The strip reads git status for the active session's card, so rendering it wants
 * a query client and an api. Both are stubs, deliberately: this file is about how
 * the strip arranges and scrolls, and a real fetch would turn it into a test of
 * git.
 */
vi.mock('../api', () => ({
  api: {
    getGitStatus: vi.fn(async () => ({ changed: 0, staged: 0, files: [] })),
  },
}));

/*
 * Built as an ELEMENT, not as a call to render, so a test that re-renders with a
 * different selection re-mounts through the same providers - `rerender` replaces
 * the whole tree, and a bare element would drop the query client with it.
 */
const stripElement = (
  count: number,
  activeId: string | null = 's1',
  titleBar?: { reserveWindowControls: boolean },
) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <TerminalTab
        sessions={Array.from({ length: count }, (_, i) => session(i + 1))}
        activeId={activeId}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onNew={vi.fn()}
        titleBar={titleBar}
      />
    </QueryClientProvider>
  );
};

const renderStrip = (
  count: number,
  activeId: string | null = 's1',
  titleBar?: { reserveWindowControls: boolean },
) => render(stripElement(count, activeId, titleBar));

const session = (n: number): TerminalSession => ({
  id: `s${n}`,
  title: `Some work ${n}`,
  agentId: 'claude-code',
  autoApprove: false,
  persist: false,
  openedAt: new Date(2026, 9, 3, 10, n).toISOString(),
});

const strip = (): HTMLElement => screen.getByTestId('terminal-tab-strip');
const tabs = (): HTMLElement[] => screen.getAllByTestId('terminal-tab');

/**
 * jsdom has no layout, so `scrollLeft` is whatever we say it is. Asserting the
 * MAPPING is the point here: how far the strip moved is the browser's business
 * once the arithmetic is right.
 */
const trackScrollLeft = (el: HTMLElement): (() => number) => {
  let value = 0;
  Object.defineProperty(el, 'scrollLeft', {
    get: () => value,
    set: (v: number) => { value = v; },
    configurable: true,
  });
  return () => value;
};

/** Which elements were asked to reveal themselves. */
let revealed: HTMLElement[] = [];

beforeEach(() => {
  revealed = [];
  // jsdom does not implement it at all; the global shim in setup.ts is a bare
  // vi.fn(), and this records the receiver so "the ACTIVE tab" can be asserted
  // rather than "something, somewhere".
  HTMLElement.prototype.scrollIntoView = vi.fn(function (this: HTMLElement) {
    revealed.push(this);
  });
});

afterEach(cleanup);

describe('the tab strip with more tabs than room', () => {
  it('stops the tabs shrinking, so the extra ones overflow instead of compressing', () => {
    /*
     * THE root cause. Without a floor, flex children shrink to fit, so the
     * tenth tab is not off-screen - it is 12px wide. A strip that scrolls but
     * still squashes has not fixed the complaint.
     */
    renderStrip(10);
    const all = tabs();
    expect(all).toHaveLength(10);
    for (const tab of all) {
      expect(tab.className, 'this tab can still be squeezed').toContain('shrink-0');
      expect(tab.className, 'no floor: ten tabs compress instead of overflowing').toContain('min-w-[120px]');
    }
    // The ceiling stays, so one tab cannot eat the whole strip.
    expect(all[0].className).toContain('max-w-[220px]');
  });

  it('makes the strip itself the scroller, with no visible scrollbar', () => {
    renderStrip(10);
    const el = strip();
    expect(el.className).toContain('overflow-x-auto');
    // A visible bar under the tabs eats the 36px row that CGLAB-164 fought for.
    expect(el.className).toContain('scrollbar-none');
    // Without min-w-0 a flex child refuses to go below its content width, so
    // the strip would grow past the window and take the + button with it.
    expect(el.className, 'the strip will not shrink, so it cannot scroll').toContain('min-w-0');
  });

  it('keeps the + button outside the scroller, where it cannot scroll out of reach', () => {
    /*
     * The one control you need precisely when the tabs are the problem. Inside
     * the scroller it would slide off the end with them, and the way back would
     * be the gesture you are already struggling with.
     */
    renderStrip(10);
    const plus = screen.getByRole('button', { name: /new terminal/i });
    expect(strip().contains(plus), 'the + scrolls away with the tabs').toBe(false);
  });

  it('scrolls sideways on a vertical wheel, which is the two-finger gesture', () => {
    /*
     * A trackpad's horizontal swipe arrives as deltaX and the browser scrolls
     * that natively - but "roll with two fingers", which is how this was asked
     * for, is usually the VERTICAL gesture, and deltaY on a container that can
     * only scroll horizontally does not move it in every engine. So the mapping
     * is explicit rather than hoped for.
     */
    renderStrip(10);
    const el = strip();
    const read = trackScrollLeft(el);

    fireEvent.wheel(el, { deltaY: 120, deltaX: 0 });
    expect(read(), 'a two-finger scroll left the strip where it was').toBe(120);
    fireEvent.wheel(el, { deltaY: 60, deltaX: 0 });
    expect(read()).toBe(180);
  });

  it('leaves a horizontal gesture alone, because the browser already scrolls it', () => {
    // Handling it too would move the strip twice as far as the fingers did.
    renderStrip(10);
    const el = strip();
    const read = trackScrollLeft(el);
    fireEvent.wheel(el, { deltaX: 120, deltaY: 4 });
    expect(read(), 'the horizontal gesture was handled twice').toBe(0);
  });

  it('brings the ACTIVE tab into view, on mount and on every change', () => {
    /*
     * On mount too, not only on change: a restored session list reopens in the
     * middle of a long strip, and the tab you are looking at has to be the one
     * on screen - the alternative is a strip that is scrolled to the start while
     * showing a terminal from the end.
     */
    const activeTab = () => document.querySelector('[role="tab"][aria-selected="true"]');
    const { rerender } = render(stripElement(10, 's1'));
    expect(revealed.at(-1), 'the first tab was not brought into view').toBe(activeTab());

    rerender(stripElement(10, 's7'));
    expect(revealed.at(-1), 'the selected tab stayed off-screen').toBe(activeTab());
    // `inline: nearest` - scroll the fewest pixels that reveal it, rather than
    // re-centring the strip on every selection.
    expect((HTMLElement.prototype.scrollIntoView as unknown as { mock: { calls: unknown[][] } })
      .mock.calls.at(-1)?.[0]).toEqual({ inline: 'nearest', block: 'nearest' });
  });

  it('stays the window handle when it is the title bar', () => {
    /*
     * The strip doubles as the macOS title bar, so this row carries the drag
     * region and the traffic-light reserve. Turning it into a scroll container
     * must not take either away - nor may the scroller become a drag region
     * itself, which would swallow the pointer.
     */
    renderStrip(10, 's1', { reserveWindowControls: true });
    const tablist = screen.getByRole('tablist', { name: /open terminals/i });
    expect(tablist.getAttribute('data-app-region')).toBe('drag');
    expect(tablist.getAttribute('data-reserves-window-controls')).toBe('true');
    // The tabs opt out of it, or none of them could be clicked.
    for (const tab of tabs()) expect(tab.getAttribute('data-app-region')).toBe('no-drag');
  });
});
