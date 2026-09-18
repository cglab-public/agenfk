/**
 * @vitest-environment jsdom
 *
 * The board's half of the tainted-format-string defect (CodeQL js/tainted-format-string).
 *
 * Two call sites in KanbanBoard.tsx put caller-controlled text into argument 0
 * of a console call, where it is read as a format string:
 *
 *  - the `project_switched` handler, which is the nastier of the two because it
 *    ALREADY passes `%c` directives on purpose. A projectId containing `%c`
 *    does not merely garble the line — it consumes one of the two colour
 *    arguments, so the styles slide onto the wrong segments and whatever came
 *    after is swallowed;
 *  - the blocked flow transition warning, whose interpolated step names come
 *    from a flow that may have been installed from a community registry.
 *
 * As in the api.ts spec, the assertions are positional rather than textual: the
 * broken code contains the same words the fixed code does, so only the argument
 * positions can tell the two apart.
 */
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KanbanBoard } from '../components/KanbanBoard';
import { ThemeProvider } from '../ThemeContext';
import { ActiveProjectProvider } from '../ActiveProject';
import { SocketProvider } from '../SocketContext';
import { api } from '../api';
import { ItemType } from '../types';

// Handlers are recorded rather than dropped, so a spec can fire a server event.
const socketHandlers: Record<string, (payload: unknown) => void> = {};
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({
    connected: true,
    connect: vi.fn(),
    on: vi.fn((event: string, handler: (payload: unknown) => void) => { socketHandlers[event] = handler; }),
    off: vi.fn((event: string) => { delete socketHandlers[event]; }),
    emit: vi.fn(),
    disconnect: vi.fn(),
  })),
}));

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
    getProjectFlow: vi.fn(() => Promise.resolve(null)),
    getGitHubStatus: vi.fn(() => Promise.resolve({ configured: false })),
  },
}));

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  })),
});
window.HTMLElement.prototype.scrollTo = vi.fn();
window.HTMLElement.prototype.scrollIntoView = vi.fn();

const DIRECTIVE = /%[sdifoOjc]/g;

function directiveCount(format: unknown): number {
  if (typeof format !== 'string') return 0;
  return (format.replace(/%%/g, '').match(DIRECTIVE) ?? []).length;
}

/** See the api.ts spec: presence in the argument list is not survival. */
function survivesFormatting(args: unknown[], value: unknown): boolean {
  const index = args.indexOf(value);
  if (index < 1) return false;
  return index > directiveCount(args[0]);
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={queryClient}>
    <ActiveProjectProvider>
      <SocketProvider>
        <ThemeProvider>{children}</ThemeProvider>
      </SocketProvider>
    </ActiveProjectProvider>
  </QueryClientProvider>
);

describe('KanbanBoard console calls never let data become a format string', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    queryClient.clear();
    for (const key of Object.keys(socketHandlers)) delete socketHandlers[key];
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  describe('the project_switched log, which uses %c deliberately', () => {
    // A uuid is what belongs here; a `%c` is what an agent-driven event can put
    // here, and the handler hands it straight to the console as a directive.
    const TAINTED_PROJECT = '%cp2';

    async function switchTo(projectId: string): Promise<unknown[]> {
      const projects = [
        { id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() },
        { id: projectId, name: 'P2', createdAt: new Date(), updatedAt: new Date() },
      ];
      const mine = { id: 'a1', projectId: 'p1', type: ItemType.TASK, title: 'My Work', status: 'TODO', createdAt: new Date(), updatedAt: new Date() };
      vi.mocked(api.listProjects).mockResolvedValue(projects as never);
      vi.mocked(api.listItems).mockResolvedValue([mine] as never);
      localStorage.setItem('agenfk_project_id', 'p1');

      render(<KanbanBoard />, { wrapper });
      await screen.findByText('My Work');

      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await act(async () => { socketHandlers['project_switched']?.({ projectId }); });

      const call = spy.mock.calls.find(
        (args) => typeof args[0] === 'string' && (args[0] as string).includes('[WS_PROJECT]'),
      );
      expect(call, 'the board did not log the project switch at all').toBeDefined();
      return call as unknown[];
    }

    it('lets the projectId survive as its own argument instead of a directive', async () => {
      const args = await switchTo(TAINTED_PROJECT);
      // Broken: the id is baked into argument 0, so it is nowhere in the
      // argument list and its `%c` has stolen a colour argument on the way in.
      expect(survivesFormatting(args, TAINTED_PROJECT)).toBe(true);
    });

    it('keeps exactly the two %c directives it intends, and no more', async () => {
      const args = await switchTo(TAINTED_PROJECT);
      expect(directiveCount(args[0])).toBe(2);
    });

    it('keeps the style arguments aligned with the segments they colour', async () => {
      const args = await switchTo(TAINTED_PROJECT);
      // The two directives in argument 0 must be satisfied by the two style
      // strings, in order. If the id shifted them, these are not CSS.
      expect(args[1]).toEqual(expect.stringContaining('color:'));
      expect(args[2]).toEqual(expect.stringContaining('color:'));
    });

    it('keeps the message greppable', async () => {
      const args = await switchTo(TAINTED_PROJECT);
      expect(args[0] as string).toContain('[WS_PROJECT]');
      expect(args[0] as string).toContain('Switching to active project');
    });
  });

  describe('the blocked flow transition warning', () => {
    // Step names come from the project's flow, which can be installed from a
    // community registry — not text this codebase wrote.
    const TAINTED_STEP = '%s%s%sQA';

    const FLOW = {
      id: 'f1',
      name: 'Tainted Flow',
      projectId: 'p1',
      steps: [
        { id: 's-todo', name: 'TODO', label: 'TODO', order: 0 },
        { id: 's-ip', name: 'IN_PROGRESS', label: 'IN PROGRESS', order: 1 },
        { id: 's-qa', name: TAINTED_STEP, label: 'QA COLUMN', order: 2 },
        { id: 's-done', name: 'DONE', label: 'DONE', order: 3 },
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    async function blockedDrop(): Promise<unknown[]> {
      const project = { id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() };
      const item = { id: 'i1', projectId: 'p1', type: ItemType.TASK, title: 'Task One', status: 'TODO', sortOrder: 0, createdAt: new Date(), updatedAt: new Date(), history: [] };
      vi.mocked(api.listProjects).mockResolvedValue([project] as never);
      vi.mocked(api.listItems).mockResolvedValue([item] as never);
      vi.mocked(api.getProjectFlow).mockResolvedValue(FLOW as never);
      localStorage.setItem('agenfk_project_id', 'p1');

      render(<KanbanBoard />, { wrapper });

      const card = (await screen.findByText('Task One')).closest('[draggable="true"]')!;
      const target = (await screen.findByText('QA COLUMN')).closest('.flex-col')!;

      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const dataTransfer = { setData: vi.fn(), getData: vi.fn((key: string) => (key === 'itemId' ? 'i1' : '')), effectAllowed: 'move' };
      fireEvent.dragStart(card, { dataTransfer });
      fireEvent.drop(target, { dataTransfer });

      const call = spy.mock.calls.find(
        (args) => typeof args[0] === 'string' && (args[0] as string).includes('[FLOW]'),
      );
      expect(call, 'the board did not block the two-step transition').toBeDefined();
      // The transition must actually have been refused, or the warning is moot.
      expect(api.updateItem).not.toHaveBeenCalled();
      return call as unknown[];
    }

    it('puts no step name into argument 0', async () => {
      const args = await blockedDrop();
      expect(args[0]).toEqual(expect.any(String));
      expect(args[0] as string).not.toMatch(DIRECTIVE);
    });

    it('lets the step names survive as arguments of their own', async () => {
      const args = await blockedDrop();
      expect(survivesFormatting(args, 'TODO')).toBe(true);
      expect(survivesFormatting(args, TAINTED_STEP)).toBe(true);
    });

    it('keeps the message greppable', async () => {
      const args = await blockedDrop();
      expect(args[0] as string).toContain('[FLOW] Blocked transition');
    });
  });
});
