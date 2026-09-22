/**
 * @vitest-environment jsdom
 *
 * Where you land after creating a project.
 *
 * A project that was just added has nothing in it, and dropping someone onto
 * an empty board answers none of the questions they arrived with. What this
 * page owes them is: what is in flight, the two ways to add to it, and the way
 * to the board — which is a destination, not a tab.
 */
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ProjectPage } from '../components/ProjectPage';
import { api } from '../api';
import { ItemType, Status } from '../types';

vi.mock('../api', () => ({ api: { projectSettings: vi.fn() } }));

afterEach(() => cleanup());

const project = { id: 'p1', name: 'horizon-ds', projectRoot: '/checkout/horizon-ds' };

const cards = [
  { id: 'e1', projectId: 'p1', type: ItemType.EPIC, title: 'Port the admin API', status: Status.TODO },
  { id: 's1', projectId: 'p1', type: ItemType.STORY, title: 'Move services private', status: Status.IN_PROGRESS, parentId: 'e1' },
  { id: 't1', projectId: 'p1', type: ItemType.TASK, title: 'terraform port', status: Status.TODO, parentId: 's1' },
] as never[];

const open = (props: Partial<React.ComponentProps<typeof ProjectPage>> = {}) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <ProjectPage project={project as never} cards={cards} runningAgents={1} {...props} />
    </QueryClientProvider>,
  );
};

describe('the header', () => {
  it('names the project and shows where it lives', () => {
    open();
    expect(screen.getByTestId('project-page-name').textContent).toBe('horizon-ds');
    expect(screen.getByTestId('project-page-root').textContent).toBe('/checkout/horizon-ds');
  });

  /*
   * IN THE HEADER, not in a tab's footer. It was drawn in the footer of the
   * card list first, which meant somebody on any other tab had no route to the
   * board at all — a control present on one screen of four.
   */
  it('offers the board from the header', () => {
    const onOpenBoard = vi.fn();
    open({ onOpenBoard });
    fireEvent.click(screen.getByTestId('project-page-board'));
    expect(onOpenBoard).toHaveBeenCalledWith('p1');
  });

  it('says so when the project has no folder yet', () => {
    // A project with no checkout cannot host an agent, and the page is where
    // that becomes visible rather than at the moment a run fails.
    open({ project: { id: 'p1', name: 'horizon-ds' } as never });
    expect(screen.getByTestId('project-page-root').textContent).toMatch(/no folder/i);
  });
});

describe('what is in flight', () => {
  it('lists the cards, nested the way the tree nests them', () => {
    open();
    // The child is indented under its parent: a flat list of three titles says
    // nothing about which story the task belongs to.
    // On the ROW, which now carries the title and the start button together —
    // indenting only the title would step the two apart.
    const row = (id: string) => screen.getByTestId(`project-card-${id}`).parentElement as HTMLElement;
    expect(row('e1').style.marginLeft).toBe('0px');
    expect(row('s1').style.marginLeft).toBe('18px');
    expect(row('t1').style.marginLeft).toBe('36px');
  });

  it('shows what kind of work each one is', () => {
    open();
    expect(screen.getByTestId('project-card-type-e1')).toBeDefined();
  });

  it('counts what is there, as information rather than a third button', () => {
    open();
    expect(screen.getByTestId('project-page-summary').textContent).toMatch(/3 cards/);
    expect(screen.getByTestId('project-page-summary').textContent).toMatch(/1 agent/);
  });

  it('counts in the singular when there is one of something', () => {
    open({ cards: [cards[0]], runningAgents: 0 });
    expect(screen.getByTestId('project-page-summary').textContent).toMatch(/1 card/);
    expect(screen.getByTestId('project-page-summary').textContent).not.toMatch(/agent/);
  });

  it('opens a card when it is clicked', () => {
    const onOpenCard = vi.fn();
    open({ onOpenCard });
    fireEvent.click(screen.getByTestId('project-card-s1'));
    expect(onOpenCard).toHaveBeenCalledWith(cards[1]);
  });
});

describe('the empty project', () => {
  /*
   * ONE DOOR, not two. Describing the objective already covers writing a
   * single card — the contract tells the agent to propose one item when the
   * objective is one unit of work — so a second button beside it was a choice
   * the product was asking for and did not need. Writing by hand moved inside
   * the panel, where it is the path that still works with no agent.
   */
  it('offers one door, and it is the one that proposes', () => {
    open({ cards: [] });
    expect(screen.getByTestId('project-page-empty')).toBeDefined();
    expect(screen.getByTestId('project-page-ask').textContent).toMatch(/new task/i);
    expect(screen.queryByTestId('project-page-new')).toBeNull();
  });

  it('still offers the board, because an empty project can still have one', () => {
    open({ cards: [] });
    expect(screen.getByTestId('project-page-board')).toBeDefined();
  });
});

describe('the door', () => {
  it('starts a task in this project', () => {
    const onAsk = vi.fn();
    open({ onAsk });
    fireEvent.click(screen.getByTestId('project-page-ask'));
    expect(onAsk).toHaveBeenCalledWith('p1');
  });
});

// ── Settings, and the reason this page is a page ───────────────────────────
// Half of a project's configuration is inferred, and an inferred value that is
// wrong is invisible: four projects on this machine have a folder pointing at
// $HOME. The rows exist so that is readable.
describe('the settings tab', () => {
  const rows = [
    {
      key: 'projectRoot', label: 'Project folder', description: 'Where agents run.',
      value: '/Users/me', origin: 'main-only', from: 'Set when the project was added.',
      how: 'agenfk update-project <id>',
      warning: 'This is your home directory. Worktrees would be cut from it.',
    },
    {
      key: 'autoWorktree', label: 'A worktree per card', description: 'Cut one when a card starts.',
      value: 'On', origin: 'set-here', from: 'The one thing this page owns.',
    },
    {
      key: 'setupCommand', label: 'Setup command', description: 'Run once in a fresh worktree.',
      value: null, origin: 'cli-only', from: 'Not set.',
      how: 'agenfk update-project <id> --setup-command "<cmd>"',
      warning: 'A new worktree starts with no dependencies installed.',
    },
  ];

  it('asks for nothing until the tab is opened', async () => {
    open();
    // Most visits are about the cards, and this answer walks the flow and the
    // filesystem defaults to build itself.
    expect(api.projectSettings).not.toHaveBeenCalled();
  });

  it('shows each value with where it came from', async () => {
    (api.projectSettings as any).mockResolvedValue({ projectId: 'p1', rows });
    open();
    fireEvent.click(screen.getByTestId('project-tab-settings'));
    await waitFor(() => screen.getByTestId('setting-projectRoot'));
    expect(screen.getByTestId('setting-origin-projectRoot').textContent).toMatch(/main only/i);
    expect(screen.getByTestId('setting-origin-autoWorktree').textContent).toMatch(/set here/i);
  });

  it('shows the value even when the row cannot be edited here', async () => {
    // Hiding what cannot be edited is exactly how an inferred value stays
    // wrong for four projects.
    (api.projectSettings as any).mockResolvedValue({ projectId: 'p1', rows });
    open();
    fireEvent.click(screen.getByTestId('project-tab-settings'));
    await waitFor(() => screen.getByTestId('setting-projectRoot'));
    expect(screen.getByTestId('setting-projectRoot').textContent).toContain('/Users/me');
    expect(screen.getByTestId('setting-how-projectRoot').textContent).toMatch(/agenfk update-project/);
  });

  it('says what a wrong or missing value costs', async () => {
    (api.projectSettings as any).mockResolvedValue({ projectId: 'p1', rows });
    open();
    fireEvent.click(screen.getByTestId('project-tab-settings'));
    await waitFor(() => screen.getByTestId('setting-warning-projectRoot'));
    expect(screen.getByTestId('setting-warning-projectRoot').textContent).toMatch(/home directory/i);
    expect(screen.getByTestId('setting-warning-setupCommand').textContent).toMatch(/dependencies/i);
  });

  it('keeps the board reachable from Settings', async () => {
    // The defect this page went through three rounds to remove: a control that
    // exists on one screen of several.
    (api.projectSettings as any).mockResolvedValue({ projectId: 'p1', rows });
    open();
    fireEvent.click(screen.getByTestId('project-tab-settings'));
    expect(screen.getByTestId('project-page-board')).toBeDefined();
  });
});

/*
 * Starting work from the row.
 *
 * The page listed the cards and could do nothing with them: opening a terminal
 * meant going to the board and finding the same card again. The press stays a
 * press — creating cards still spawns nothing — it just exists where the cards
 * are.
 */
describe('starting an agent from a card', () => {
  const rows = [
    { id: 'i1', projectId: 'p1', type: ItemType.TASK, title: 'port the admin API', status: Status.TODO },
    { id: 'i2', projectId: 'p1', type: ItemType.TASK, title: 'terraform the gateway', status: Status.IN_PROGRESS },
  ] as never;

  it('hands the card back, so the caller decides between resuming and asking', async () => {
    const onStartAgent = vi.fn();
    open({ cards: rows, onStartAgent });
    fireEvent.click(screen.getByTestId('project-card-start-i1'));
    expect(onStartAgent).toHaveBeenCalledWith(rows[0]);
  });

  it('says Open, not Start, where a session is already running', async () => {
    // Spawning a second agent in the same worktree is possible from the tab
    // bar and is not what pressing a card's own button means.
    open({ cards: rows, runningItemIds: ['i2'], onStartAgent: () => {} });
    expect(screen.getByTestId('project-card-start-i2').textContent).toContain('Open');
    expect(screen.getByTestId('project-card-start-i1').textContent).toContain('Start');
    expect(screen.getByTestId('project-card-live-i2')).toBeTruthy();
  });

  it('names the card it will act on, so a column of identical buttons is not a guess', async () => {
    open({ cards: rows, onStartAgent: () => {} });
    expect(screen.getByTestId('project-card-start-i1').getAttribute('aria-label'))
      .toBe('Start an agent on port the admin API');
  });

  it('opening the card is still its own gesture', async () => {
    // Two things on one row, and they stay separate: the title reveals it on
    // the board, the button starts work.
    const onOpenCard = vi.fn();
    const onStartAgent = vi.fn();
    open({ cards: rows, onOpenCard, onStartAgent });
    fireEvent.click(screen.getByTestId('project-card-i1'));
    expect(onOpenCard).toHaveBeenCalledWith(rows[0]);
    expect(onStartAgent).not.toHaveBeenCalled();
  });

  it('shows no button at all when the host has nowhere to send it', async () => {
    // A control that calls nothing is the dead button this product has drawn
    // three times.
    open({ cards: rows });
    expect(screen.queryByTestId('project-card-start-i1')).toBeNull();
  });
});
