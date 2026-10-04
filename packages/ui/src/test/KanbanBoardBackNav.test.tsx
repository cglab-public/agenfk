/**
 * @vitest-environment jsdom
 *
 * Going back out of a drill-down (STORY 7dd83104). While drilled in, the
 * breadcrumb's first button stops being "Top Level" and becomes "Back" (up one
 * level). Any move back up — Back or an earlier crumb — highlights the card
 * the user came OUT of, scrolls to it, and opens the collapsed section it
 * sits in, so they are never left hunting for the parent they were just in.
 */
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react';
import { KanbanBoard } from '../components/KanbanBoard';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '../ThemeContext';
import { ActiveProjectProvider } from '../ActiveProject';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from '../api';
import { ItemType, Status } from '../types';
import { guardTokens } from './helpers/tokenGuard';

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({
    connect: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn(),
  })),
}));

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(query => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// jsdom has no layout. Record WHICH element was scrolled, not just that one was.
const scrolled: string[] = [];
window.HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
  scrolled.push(this.id);
} as any;

const DEFAULT_FLOW_MOCK = {
  id: 'default',
  name: 'Default Flow',
  projectId: '__builtin__',
  steps: [
    { id: 's-ideas', name: 'IDEAS', label: 'IDEAS', order: 0, isSpecial: true },
    { id: 's-todo', name: 'TODO', label: 'TODO', order: 1 },
    { id: 's-ip', name: 'IN_PROGRESS', label: 'IN PROGRESS', order: 2 },
    { id: 's-review', name: 'REVIEW', label: 'REVIEW', order: 3 },
    { id: 's-test', name: 'TEST', label: 'TEST', order: 4 },
    { id: 's-done', name: 'DONE', label: 'DONE', order: 5 },
    { id: 's-blocked', name: 'BLOCKED', label: 'BLOCKED', order: 6, isSpecial: true },
    { id: 's-paused', name: 'PAUSED', label: 'PAUSED', order: 7, isSpecial: true },
    { id: 's-archived', name: 'ARCHIVED', label: 'ARCHIVED', order: 8, isSpecial: true },
  ],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

vi.mock('../api', () => ({
  api: {
    listProjects: vi.fn(() => Promise.resolve([])),
    listItems: vi.fn(() => Promise.resolve([])),
    getItem: vi.fn(() => Promise.resolve({})),
    createItem: vi.fn(() => Promise.resolve({})),
    updateItem: vi.fn(() => Promise.resolve({})),
    deleteItem: vi.fn(() => Promise.resolve({})),
    deleteProject: vi.fn(() => Promise.resolve({})),
    createProject: vi.fn(() => Promise.resolve({ id: 'p-new', name: 'New' })),
    bulkUpdateItems: vi.fn(() => Promise.resolve({})),
    trashArchivedItems: vi.fn(() => Promise.resolve({})),
    getJiraStatus: vi.fn(() => Promise.resolve({ configured: false, connected: false })),
    getLatestRelease: vi.fn(() => Promise.resolve(null)),
    getVersion: vi.fn(() => Promise.resolve({ version: '1.0.0' })),
    getProjectFlow: vi.fn(() => Promise.resolve(DEFAULT_FLOW_MOCK)),
    getGitHubStatus: vi.fn(() => Promise.resolve({ configured: false })),
  }
}));

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, gcTime: 0 } },
});

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={queryClient}>
    <ActiveProjectProvider>
      <ThemeProvider>{children}</ThemeProvider>
    </ActiveProjectProvider>
  </QueryClientProvider>
);

const NOW = new Date();
const item = (id: string, title: string, type: ItemType, extra: Record<string, unknown> = {}) => ({
  id, projectId: 'p1', type, title, status: Status.TODO, createdAt: NOW, updatedAt: NOW, ...extra,
});

// Three drill levels: Epic One > Story Two > Sub Story > Leaf Task, plus an
// unrelated top-level card so "the right card is highlighted" means something.
const EPIC = item('epic-1', 'Epic One', ItemType.EPIC);
const STORY = item('story-2', 'Story Two', ItemType.STORY, { parentId: 'epic-1' });
const SUB = item('sub-3', 'Sub Story', ItemType.STORY, { parentId: 'story-2' });
const LEAF = item('leaf-4', 'Leaf Task', ItemType.TASK, { parentId: 'sub-3' });
const OTHER = item('other-5', 'Other Epic', ItemType.EPIC);

function setItems(items: unknown[]) {
  vi.mocked(api.listItems).mockResolvedValue(items as any);
}

function card(id: string) {
  return document.getElementById(`card-${id}`);
}

function highlighted() {
  return Array.from(document.querySelectorAll('.search-highlight')).map(el => el.id);
}

async function drillInto(title: string) {
  const el = await screen.findByText(title);
  const host = el.closest('[draggable="true"]') as HTMLElement;
  const btn = host.querySelector('button[aria-label$="child items"]') as HTMLElement;
  fireEvent.click(btn);
}

function breadcrumbButton(name: RegExp) {
  return screen.getByRole('button', { name });
}

// A click handler that throws leaves the view untouched, which a "nothing
// happened" assertion would mistake for a deliberate no-op. Collect them.
function collectHandlerErrors() {
  const errors: unknown[] = [];
  const onError = (e: ErrorEvent) => { errors.push(e.error); e.preventDefault(); };
  window.addEventListener('error', onError);
  return { errors, stop: () => window.removeEventListener('error', onError) };
}

describe('KanbanBoard back navigation out of a drill-down', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    queryClient.clear();
    scrolled.length = 0;
    window.history.pushState({}, '', '/');
    vi.mocked(api.getProjectFlow).mockResolvedValue(DEFAULT_FLOW_MOCK as any);
    vi.mocked(api.listProjects).mockResolvedValue([{ id: 'p1', name: 'P1', createdAt: NOW, updatedAt: NOW }] as any);
    localStorage.setItem('agenfk_project_id', 'p1');
    setItems([EPIC, STORY, SUB, LEAF, OTHER]);
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  guardTokens();

  describe('the first breadcrumb button', () => {
    it('reads Top Level at the top of the board, with no Back button', async () => {
      render(<KanbanBoard />, { wrapper });
      await screen.findByText('Epic One');

      expect(breadcrumbButton(/Top Level/)).toBeDefined();
      expect(screen.queryByRole('button', { name: /^Back/ })).toBeNull();
    });

    it('does nothing when clicked at the top of the board', async () => {
      render(<KanbanBoard />, { wrapper });
      await screen.findByText('Epic One');
      const handlerErrors = collectHandlerErrors();

      fireEvent.click(breadcrumbButton(/Top Level/));

      await new Promise(r => setTimeout(r, 500));
      handlerErrors.stop();
      expect(handlerErrors.errors).toEqual([]);
      expect(highlighted()).toEqual([]);
      expect(scrolled).toEqual([]);
    });

    it('becomes Back, naming All Items, one level in', async () => {
      render(<KanbanBoard />, { wrapper });
      await drillInto('Epic One');
      await screen.findByText('Story Two');

      expect(breadcrumbButton(/^Back to All Items$/)).toBeDefined();
      expect(screen.queryByRole('button', { name: /Top Level/ })).toBeNull();
    });

    it('names the parent level it returns to when deeper in', async () => {
      render(<KanbanBoard />, { wrapper });
      await drillInto('Epic One');
      await drillInto('Story Two');
      await screen.findByText('Sub Story');

      expect(breadcrumbButton(/^Back to Epic One$/)).toBeDefined();
    });

    it('turns back into Top Level once the user is back at the top', async () => {
      render(<KanbanBoard />, { wrapper });
      await drillInto('Epic One');
      fireEvent.click(await screen.findByRole('button', { name: /^Back to All Items$/ }));

      await waitFor(() => expect(breadcrumbButton(/Top Level/)).toBeDefined());
      expect(screen.queryByRole('button', { name: /^Back/ })).toBeNull();
    });
  });

  describe('Back', () => {
    it('goes up exactly one level', async () => {
      render(<KanbanBoard />, { wrapper });
      await drillInto('Epic One');
      await drillInto('Story Two');
      await screen.findByText('Sub Story');

      fireEvent.click(breadcrumbButton(/^Back to Epic One$/));

      // Epic One's children are shown again: Story Two is a card, the top level is not.
      await waitFor(() => expect(card('story-2')).not.toBeNull());
      expect(card('other-5')).toBeNull();
      expect(card('sub-3')).toBeNull();
    });

    it('highlights and scrolls to the card the user came out of', async () => {
      render(<KanbanBoard />, { wrapper });
      await drillInto('Epic One');
      await screen.findByText('Story Two');

      fireEvent.click(breadcrumbButton(/^Back to All Items$/));

      await waitFor(() => expect(highlighted()).toEqual(['card-epic-1']));
      await waitFor(() => expect(scrolled).toContain('card-epic-1'));
      expect(scrolled).not.toContain('card-other-5');
    });

    it('clears the highlight after 3 seconds', async () => {
      render(<KanbanBoard />, { wrapper });
      await drillInto('Epic One');
      await screen.findByText('Story Two');

      vi.useFakeTimers({ shouldAdvanceTime: true });
      fireEvent.click(breadcrumbButton(/^Back to All Items$/));
      await waitFor(() => expect(highlighted()).toEqual(['card-epic-1']));

      await act(async () => { vi.advanceTimersByTime(2900); });
      expect(highlighted()).toEqual(['card-epic-1']);
      await act(async () => { vi.advanceTimersByTime(200); });
      expect(highlighted()).toEqual([]);
    });
  });

  describe('a highlight already running', () => {
    it('does not cut the new highlight short with its own 3s timer', async () => {
      render(<KanbanBoard />, { wrapper });
      await screen.findByText('Epic One');

      vi.useFakeTimers({ shouldAdvanceTime: true });
      // Search rings Story Two (inside Epic One) and starts its 3s clear.
      const input = await screen.findByPlaceholderText('Search Item ID or Name...');
      fireEvent.change(input, { target: { value: 'Story Two' } });
      fireEvent.submit(input.closest('form')!);
      await waitFor(() => expect(highlighted()).toEqual(['card-story-2']));

      await act(async () => { vi.advanceTimersByTime(2000); });
      fireEvent.click(breadcrumbButton(/^Back to All Items$/));
      await waitFor(() => expect(highlighted()).toEqual(['card-epic-1']));

      // The search's timer would have fired 1s in; Back's own runs the full 3s.
      await act(async () => { vi.advanceTimersByTime(2900); });
      expect(highlighted()).toEqual(['card-epic-1']);
    });
  });

  describe('pending scrolls', () => {
    it('scroll only to the latest of two quick navigations', async () => {
      // Epic One and Other Epic both sit on the top level, so a scroll still
      // queued for the first would visibly yank the board after the second.
      render(<KanbanBoard />, { wrapper });
      await screen.findByText('Other Epic');
      const input = await screen.findByPlaceholderText('Search Item ID or Name...');
      fireEvent.change(input, { target: { value: 'Epic' } });
      fireEvent.submit(input.closest('form')!);
      fireEvent.click(await screen.findByTitle('Next match'));

      await new Promise(r => setTimeout(r, 500));
      expect(scrolled).toHaveLength(1);
      expect(highlighted()).toEqual([scrolled[0]]);
    });

    it('do not fire once the board has unmounted', async () => {
      const first = render(<KanbanBoard />, { wrapper });
      await drillInto('Epic One');
      fireEvent.click(await screen.findByRole('button', { name: /^Back to All Items$/ }));
      first.unmount();

      // A fresh board renders the same card id; a scroll queued by the old
      // one must not land on it.
      render(<KanbanBoard />, { wrapper });
      await screen.findByText('Epic One');
      await new Promise(r => setTimeout(r, 500));
      expect(scrolled).toEqual([]);
    });
  });

  describe('clicking an earlier breadcrumb', () => {
    it('highlights the level just below the one clicked, not the deepest one', async () => {
      render(<KanbanBoard />, { wrapper });
      await drillInto('Epic One');
      await drillInto('Story Two');
      await drillInto('Sub Story');
      await screen.findByText('Leaf Task');

      // Jump from Sub Story's view straight to Epic One's: Story Two is the
      // card on screen there that the user came through.
      fireEvent.click(breadcrumbButton(/Epic One/));

      await waitFor(() => expect(highlighted()).toEqual(['card-story-2']));
      await waitFor(() => expect(scrolled).toContain('card-story-2'));
    });

    it('does nothing when the crumb is the level already shown', async () => {
      render(<KanbanBoard />, { wrapper });
      await drillInto('Epic One');
      await screen.findByText('Story Two');
      scrolled.length = 0;
      const handlerErrors = collectHandlerErrors();

      fireEvent.click(breadcrumbButton(/Epic One/));

      // Give any highlight/scroll timer the chance to fire before asserting none did.
      await new Promise(r => setTimeout(r, 500));
      handlerErrors.stop();
      expect(handlerErrors.errors).toEqual([]);
      expect(highlighted()).toEqual([]);
      expect(scrolled).toEqual([]);
      expect(card('story-2')).not.toBeNull();
    });
  });

  describe('a parent in a collapsed section', () => {
    // Paused / Blocked / Archived / Ideas are hidden while drilled in. Search
    // can land the user inside a parent from one of them without opening it
    // (search opens the MATCH's section, not its parent's), so going back must.
    it('leaves the sections alone when going back to a level they are not shown on', async () => {
      // Search lands in Epic One > Paused Story. Back goes to Epic One's view,
      // where Paused cards are never shown: nothing to ring there, and the
      // Paused section must not have been opened behind the user's back.
      const pausedStory = item('paused-2', 'Paused Story', ItemType.STORY, { parentId: 'epic-1', status: Status.PAUSED });
      const task = item('task-9', 'Deep Task', ItemType.TASK, { parentId: 'paused-2' });
      setItems([EPIC, pausedStory, task, OTHER]);

      render(<KanbanBoard />, { wrapper });
      await screen.findByText('Other Epic');
      const input = await screen.findByPlaceholderText('Search Item ID or Name...');
      fireEvent.change(input, { target: { value: 'Deep Task' } });
      fireEvent.submit(input.closest('form')!);
      await waitFor(() => expect(card('task-9')).not.toBeNull());

      fireEvent.click(breadcrumbButton(/^Back to Epic One$/));
      await waitFor(() => expect(breadcrumbButton(/^Back to All Items$/)).toBeDefined());
      expect(highlighted()).toEqual([]);

      fireEvent.click(breadcrumbButton(/^Back to All Items$/));
      await waitFor(() => expect(highlighted()).toEqual(['card-epic-1']));
      // An open section shows a "Collapse Column" control; all must still be collapsed.
      expect(screen.queryAllByTitle('Collapse Column')).toEqual([]);
    });

    it.each([
      [Status.PAUSED, 'Paused'],
      [Status.BLOCKED, 'Blocked'],
      [Status.ARCHIVED, 'Archived'],
      [Status.IDEAS, 'Ideas'],
    ])('opens the %s section so the highlighted parent can be seen', async (status) => {
      const parked = item('parked-1', 'Parked Epic', ItemType.EPIC, { status });
      const child = item('child-1', 'Findable Child', ItemType.TASK, { parentId: 'parked-1' });
      setItems([parked, child, OTHER]);

      render(<KanbanBoard />, { wrapper });
      await screen.findByText('Other Epic');
      expect(card('parked-1')).toBeNull();

      const input = await screen.findByPlaceholderText('Search Item ID or Name...');
      fireEvent.change(input, { target: { value: 'Findable Child' } });
      fireEvent.submit(input.closest('form')!);
      await waitFor(() => expect(card('child-1')).not.toBeNull());

      fireEvent.click(breadcrumbButton(/^Back to All Items$/));

      await waitFor(() => expect(card('parked-1')).not.toBeNull());
      await waitFor(() => expect(highlighted()).toEqual(['card-parked-1']));
    });
  });
});

/**
 * Task 803c4633 (user request, 2026-10-04): a breadcrumb too wide for its row
 * used to clip its LAST items - the immediate parent and the level you are on -
 * off the right edge. The topmost levels give way first now: they shrink and
 * ellipsise, so the parent and the current level keep their room. jsdom has no
 * layout, so this pins the contract the browser lays out: the trail clips
 * rather than scrolls, ancestors shrink ahead of the last two, and every crumb
 * keeps its full title for assistive tech and as a tooltip.
 */
describe('a breadcrumb too long for its row', () => {
  beforeEach(() => {
    localStorage.setItem('agenfk_project_id', 'p1');
    setItems([EPIC, STORY, SUB, LEAF, OTHER]);
  });
  afterEach(() => cleanup());

  const crumb = (title: string) => screen.getAllByTestId('breadcrumb-crumb').find(b => b.textContent?.includes(title)) as HTMLElement;
  const shrink = (el: HTMLElement) => Number(el.style.flexShrink || getComputedStyle(el).flexShrink || 1);

  it('clips instead of scrolling the last levels out of view', async () => {
    render(<KanbanBoard />, { wrapper });
    await drillInto('Epic One');
    await drillInto('Story Two');
    await drillInto('Sub Story');
    await screen.findByText('Leaf Task');
    const trail = screen.getByTestId('breadcrumb-trail');
    expect(trail.className).not.toMatch(/overflow-x-auto/);
    expect(trail.className).toMatch(/overflow-hidden/);
    expect(trail.className).toMatch(/min-w-0/);
  });

  it('gives way at the top: ancestors shrink and ellipsise before the parent and the current level', async () => {
    render(<KanbanBoard />, { wrapper });
    await drillInto('Epic One');
    await drillInto('Story Two');
    await drillInto('Sub Story');
    await screen.findByText('Leaf Task');
    const top = crumb('Epic One'), parent = crumb('Story Two'), current = crumb('Sub Story');
    expect(shrink(top)).toBeGreaterThan(shrink(parent));
    expect(shrink(top)).toBeGreaterThan(shrink(current));
    // The title itself is what ellipsises; the button may shrink below its text, down to its dot and an ellipsis.
    expect(top.className).toMatch(/min-w-\[3rem\]/);
    expect(top.querySelector('[data-testid="breadcrumb-title"]')!.className).toMatch(/truncate/);
    // The last two shrink only once the ancestors cannot.
    expect(shrink(parent)).toBeGreaterThan(0);
    expect(shrink(current)).toBeGreaterThan(0);
  });

  it('keeps every full title for screen readers and as a tooltip, however short it is drawn', async () => {
    render(<KanbanBoard />, { wrapper });
    await drillInto('Epic One');
    await drillInto('Story Two');
    await screen.findByText('Sub Story');
    for (const t of ['Epic One', 'Story Two']) {
      expect(crumb(t)).toHaveAttribute('title', t);
      expect(crumb(t).textContent).toContain(t);
    }
  });
});
