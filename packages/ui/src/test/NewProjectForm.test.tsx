/**
 * @vitest-environment jsdom
 *
 * The create-project form, held against the create-card form (CGLAB-164, §03).
 *
 * The two screens do the same thing — name a new thing and confirm — and were
 * built years apart, so they read as different products: different label
 * typography, a different field surface, and a footer whose buttons sit in the
 * opposite order. These tests pin the parity in the only way that survives a
 * refactor of either screen: every style assertion is made TWICE, once against
 * the card form and once against the project form. Change the card form alone
 * and this suite goes red pointing at the pair, instead of silently blessing a
 * new divergence.
 *
 * The other half is the two commands. `verifyCommand` and `setupCommand` are
 * shell strings this machine later runs, so `PUT /projects/:id` refuses them
 * (server.ts — the allowlist is name/description/autoWorktree) and only the
 * internal-token routes may write them. A browser cannot hold that token, so
 * the form must NOT grow inputs for them — it must say what their absence
 * does, and where they are actually set. The last test is the guard against
 * someone adding the input anyway and shipping a control that cannot work.
 */
import React from 'react';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
// Straight from the server's own module: the notice the screen paraphrases is
// derived here rather than retyped, so the two cannot disagree in silence.
import { planWorktreeSetup } from '../../../server/src/worktreeSetup';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KanbanBoard } from '../components/KanbanBoard';
import { CardDetailModal } from '../components/CardDetailModal';
import { SocketProvider } from '../SocketContext';
import { ThemeProvider } from '../ThemeContext';
import { ActiveProjectProvider } from '../ActiveProject';
import { ItemType, Status, type AgEnFKItem } from '../types';
import { api } from '../api';

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({
    connect: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn(),
  })),
}));

vi.mock('../posthog', () => ({ capture: vi.fn(), initPosthog: vi.fn() }));

const DEFAULT_FLOW_MOCK = {
  id: 'default',
  name: 'Default Flow',
  projectId: '__builtin__',
  steps: [
    { id: 's-todo', name: 'TODO', label: 'TODO', order: 0 },
    { id: 's-ip', name: 'IN_PROGRESS', label: 'IN PROGRESS', order: 1 },
    { id: 's-done', name: 'DONE', label: 'DONE', order: 2 },
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
    moveItem: vi.fn(() => Promise.resolve({})),
    deleteProject: vi.fn(() => Promise.resolve({})),
    createProject: vi.fn(() => Promise.resolve({ id: 'p-new', name: 'New' })),
    bulkUpdateItems: vi.fn(() => Promise.resolve({})),
    trashArchivedItems: vi.fn(() => Promise.resolve({})),
    getJiraStatus: vi.fn(() => Promise.resolve({ configured: false, connected: false })),
    getGitHubStatus: vi.fn(() => Promise.resolve({ configured: false })),
    getLatestRelease: vi.fn(() => Promise.resolve(null)),
    getVersion: vi.fn(() => Promise.resolve({ version: '1.0.0' })),
    getProjectFlow: vi.fn(() => Promise.resolve(DEFAULT_FLOW_MOCK)),
    listAgentRuns: vi.fn(() => Promise.resolve([])),
    listRunEvents: vi.fn(() => Promise.resolve([])),
  },
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

if (typeof window !== 'undefined') {
  window.HTMLElement.prototype.scrollTo = vi.fn();
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={queryClient}>
    <SocketProvider>
      <ActiveProjectProvider>
        <ThemeProvider>{children}</ThemeProvider>
      </ActiveProjectProvider>
    </SocketProvider>
  </QueryClientProvider>
);

/** The class atoms on an element, as a sorted list — order of authoring never decides a result. */
function atoms(el: Element): string[] {
  return [...new Set(el.className.split(/\s+/).filter(Boolean))].sort();
}

/**
 * The two elements must carry the SAME classes, not merely overlap.
 *
 * Subset matching was the first version of this and it was the wrong tool: an
 * ADDED class passes a subset check, and in Tailwind an added class is exactly
 * how the two screens drift — `dark:bg-slate-800` sitting next to
 * `dark:bg-slate-950` leaves stylesheet order to decide what the field looks
 * like, while a subset assertion reports parity. Anything the project form is
 * meant to carry alone has to be named in `allowedExtra`, which makes each
 * deliberate difference a line somebody wrote on purpose.
 */
function expectSameClasses(
  reference: Element,
  subject: Element,
  what: string,
  allowedExtra: readonly string[] = [],
): void {
  const want = atoms(reference);
  const got = atoms(subject).filter(c => !allowedExtra.includes(c));
  expect(got, `${what} does not carry the card form's classes`).toEqual(want);
}

/**
 * DOM order is only half of "cancel before confirm". CSS can paint the footer
 * backwards while leaving the markup untouched — `flex-row-reverse`, an
 * `order-*` utility on either button, or a `flex-col` footer where "before"
 * becomes "above". The guard runs on BOTH footers, because parity broken from
 * the card side is still broken.
 */
function expectNotVisuallyReordered(footer: Element, what: string): void {
  const reordering = atoms(footer).filter(c => /-reverse$/.test(c) || /^order-/.test(c) || c === 'flex-col');
  expect(reordering, `${what} reorders its buttons in CSS`).toEqual([]);
}

/** Open the create-project form through the empty-install welcome screen. */
async function openProjectForm() {
  vi.mocked(api.listProjects).mockResolvedValue([]);
  render(<KanbanBoard />, { wrapper });
  fireEvent.click(await screen.findByRole('button', { name: /new project/i }));
  return await screen.findByTestId('create-project-form');
}

/** Render the card form in its NEW-item state — the screen being matched. */
function renderCardDraft() {
  // `isNew` in CardDetailModal is `!item.id` — the blank id IS the draft state.
  const draft: AgEnFKItem = {
    id: '',
    projectId: 'p1',
    type: ItemType.TASK,
    title: '',
    description: '',
    status: Status.TODO,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    history: [],
  };
  render(
    <CardDetailModal
      item={draft}
      allItems={[]}
      onClose={() => {}}
      onSelectItem={() => {}}
      onAddItem={async () => {}}
      onDeleteItem={async () => {}}
    />,
    { wrapper },
  );
}

/*
 * The ONE deliberate difference between the two name fields.
 *
 * Neither modal panel sets a text colour, so both inputs inherit theirs. The
 * card form gets away with it; the project panel is reached from a welcome
 * screen and a switch-project overlay, and the field is stated rather than
 * inherited there. Listed here so it reads as a decision, and so that any
 * OTHER extra class on this input fails the comparison.
 */
const PROJECT_INPUT_ONLY = ['text-slate-900', 'dark:text-white'] as const;
/** Same reason, same two atoms, on the description box. */
const PROJECT_DESCRIPTION_ONLY = PROJECT_INPUT_ONLY;

// One reset for both suites. They render the same board against the same
// module-level mocks, so a leftover from either would show up in the other.
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  queryClient.clear();
});
afterEach(() => cleanup());

describe('create-project form: the card form’s visual language', () => {
  it('labels the name field exactly as the card form labels its title', async () => {
    renderCardDraft();
    // Held after cleanup: the node detaches but its className survives, which
    // is what lets the card form be the reference rather than a copy of it.
    const cardLabel = screen.getByText('Title');
    cleanup();

    await openProjectForm();
    expectSameClasses(cardLabel, screen.getByText(/project name/i), 'the create-project name label');
  });

  it('gives the name input the card form’s field surface', async () => {
    renderCardDraft();
    const cardInput = screen.getByPlaceholderText(/title of your new task/i);
    cleanup();

    await openProjectForm();
    expectSameClasses(
      cardInput,
      screen.getByPlaceholderText(/my awesome app/i),
      'the create-project name input',
      PROJECT_INPUT_ONLY,
    );
  });

  it('puts the cancel before the confirm, in both forms', async () => {
    renderCardDraft();
    const cardCancel = screen.getByRole('button', { name: /^cancel$/i });
    const cardCreate = screen.getByRole('button', { name: /create task/i });
    expect(
      cardCancel.compareDocumentPosition(cardCreate) & Node.DOCUMENT_POSITION_FOLLOWING,
      'the card form should render Cancel before Create',
    ).toBeTruthy();
    expect(cardCancel.parentElement).toBe(cardCreate.parentElement);
    expectNotVisuallyReordered(cardCancel.parentElement!, 'the card form footer');
    cleanup();

    const form = await openProjectForm();
    const projectCancel = within(form).getByRole('button', { name: /^cancel$/i });
    const projectCreate = within(form).getByRole('button', { name: /create project/i });
    expect(
      projectCancel.compareDocumentPosition(projectCreate) & Node.DOCUMENT_POSITION_FOLLOWING,
      'the create-project form should render Cancel before Create project',
    ).toBeTruthy();
    expect(projectCancel.parentElement).toBe(projectCreate.parentElement);
    expectNotVisuallyReordered(projectCancel.parentElement!, 'the create-project footer');
  });

  it('shapes both footer buttons like the card form’s', async () => {
    renderCardDraft();
    const cardCreate = screen.getByRole('button', { name: /create task/i });
    const cardCancel = screen.getByRole('button', { name: /^cancel$/i });
    cleanup();

    const form = await openProjectForm();
    expectSameClasses(
      cardCreate,
      within(form).getByRole('button', { name: /create project/i }),
      'the create-project primary',
    );
    expectSameClasses(
      cardCancel,
      within(form).getByRole('button', { name: /^cancel$/i }),
      'the create-project cancel',
    );
  });

  it('will not create a project whose name is only whitespace', async () => {
    /*
     * The card form gates on `!title.trim()`, and so does the sidebar's own
     * create-project field. This one gated on `!newProjectName`, and `!"   "`
     * is false — so the confirm enabled, `POST /projects` accepted it (the
     * server's guard is `if (!name)` too), and the picker grew a row with a
     * blank name that nothing could tell from the next one.
     */
    const form = await openProjectForm();
    fireEvent.change(screen.getByPlaceholderText(/my awesome app/i), { target: { value: '   ' } });

    const create = within(form).getByRole('button', { name: /create project/i }) as HTMLButtonElement;
    expect(create.disabled, 'a whitespace-only name must not enable the confirm').toBe(true);

    fireEvent.click(create);
    fireEvent.keyDown(screen.getByPlaceholderText(/my awesome app/i), { key: 'Enter' });
    await waitFor(() => expect(api.createProject).not.toHaveBeenCalled());
  });

  it('sends the name without its surrounding whitespace', async () => {
    const form = await openProjectForm();
    fireEvent.change(screen.getByPlaceholderText(/my awesome app/i), { target: { value: '  Aurora  ' } });
    fireEvent.click(within(form).getByRole('button', { name: /create project/i }));
    await waitFor(() => expect(api.createProject).toHaveBeenCalledWith({ name: 'Aurora' }));
  });

  it('still creates the project', async () => {
    const form = await openProjectForm();
    fireEvent.change(screen.getByPlaceholderText(/my awesome app/i), { target: { value: 'Aurora' } });
    fireEvent.click(within(form).getByRole('button', { name: /create project/i }));
    await waitFor(() => expect(api.createProject).toHaveBeenCalledWith({ name: 'Aurora' }));
  });

  it('takes a description, the way the card form does', async () => {
    /*
     * The card form is Title + Description; this one was Name alone, so a
     * project created from the UI could never have a description at all —
     * `api.createProject` and `POST /projects` have both accepted one the whole
     * time. Unlike the two commands, nothing refuses this field: it is a plain
     * string on the open route.
     */
    const form = await openProjectForm();
    fireEvent.change(screen.getByPlaceholderText(/my awesome app/i), { target: { value: 'Aurora' } });
    fireEvent.change(within(form).getByRole('textbox', { name: /description/i }), {
      target: { value: 'The console the team actually opens.' },
    });
    fireEvent.click(within(form).getByRole('button', { name: /create project/i }));
    await waitFor(() => expect(api.createProject).toHaveBeenCalledWith({
      name: 'Aurora',
      description: 'The console the team actually opens.',
    }));
  });

  it('omits the description entirely when it was left blank', async () => {
    // Not `description: ''` — an empty string is a value somebody typed, and
    // the server already defaults the field. Sending one makes "unset" and
    // "cleared" the same request.
    const form = await openProjectForm();
    fireEvent.change(screen.getByPlaceholderText(/my awesome app/i), { target: { value: 'Aurora' } });
    fireEvent.change(within(form).getByRole('textbox', { name: /description/i }), { target: { value: '   ' } });
    fireEvent.click(within(form).getByRole('button', { name: /create project/i }));
    await waitFor(() => expect(api.createProject).toHaveBeenCalledWith({ name: 'Aurora' }));
  });

  it('gives the description box the card form’s description surface', async () => {
    renderCardDraft();
    const cardDescription = screen.getByPlaceholderText(/describe what needs to be done/i);
    cleanup();

    const form = await openProjectForm();
    expectSameClasses(
      cardDescription,
      within(form).getByRole('textbox', { name: /description/i }),
      'the create-project description box',
      PROJECT_DESCRIPTION_ONLY,
    );
  });
});

describe('create-project form: the two commands it cannot set', () => {
  /*
   * ANCHORED IN THE SERVER, NOT IN THE SCREEN'S OWN WORDS.
   *
   * The first version of these tests matched loose keywords against the
   * rendered text — `/worktree/i`, `/dependenc/i`. Copy saying the exact
   * OPPOSITE ("dependencies already installed, inferred from the lockfile")
   * satisfied all three, so a screen could have been rewritten to promise that
   * AgEnFK guesses the command and the suite would have stayed green. A screen
   * that lies about the server is the defect this card exists to close, so the
   * facts are now read from the code that produces them: rename the error or
   * change the notice, and this file goes red instead of the screen going
   * quietly wrong.
   */
  // Walk up to the monorepo root rather than assume a cwd: this file is run
  // both from packages/ui and from the repo root, and the two disagree.
  const repoFile = (rel: string): string => {
    let dir = process.cwd();
    while (!existsSync(join(dir, 'packages', 'server', 'src', 'server.ts'))) {
      const up = dirname(dir);
      if (up === dir) throw new Error('monorepo root not found from ' + process.cwd());
      dir = up;
    }
    return readFileSync(join(dir, 'packages', ...rel.split('/')), 'utf8');
  };

  it('names the error the server actually returns', async () => {
    // Not a literal typed twice: the code is read out of the route that emits
    // it, so renaming it there fails here rather than in a user's terminal.
    const serverSource = repoFile('server/src/server.ts');
    const emitted = serverSource.match(/error:\s*"(NO_[A-Z_]+)"/)?.[1];
    expect(emitted, 'server.ts no longer returns a NO_* error on the final step').toBe('NO_VERIFY_COMMAND');

    const form = await openProjectForm();
    expect(form.textContent).toContain(emitted);
  });

  it('describes the verify gate as conditional, because the call may carry the command', async () => {
    /*
     * `resolvedCommand = command || project.verifyCommand` — a verify that
     * passes its own command is never refused, so "the last step is refused"
     * full stop would be a screen telling somebody a thing is impossible when
     * it is one argument away.
     */
    const form = await openProjectForm();
    expect(form.textContent).toMatch(/unless one is passed to that call/i);
  });

  it('repeats the worktree notice the server would print, not its opposite', async () => {
    // The real decision for "a repo with a manifest, and no declared command".
    const notice = planWorktreeSetup({ declared: undefined, hasManifest: true }).notice;
    expect(notice, 'the server no longer reports missing dependencies').toMatch(/no dependencies installed/i);
    expect(notice, 'the server no longer promises not to guess').toMatch(/nothing is guessed/i);
    expect(planWorktreeSetup({ declared: undefined, hasManifest: true }).ready).toBe(false);

    const form = await openProjectForm();
    // Tight phrases, deliberately: "dependencies ALREADY installed" and
    // "nothing is guessed about the rest" both have to fail here.
    expect(form.textContent).toMatch(/dependencies not installed/i);
    expect(form.textContent).toMatch(/nothing is guessed from a lockfile/i);
  });

  it('scopes that to repos with a manifest, because the other branch says the opposite', async () => {
    // No manifest ⇒ ready, and "No dependencies to install". A screen claiming
    // a bare worktree for those repos would be describing a notice they never
    // see — the module's own comment warns against exactly that.
    const noManifest = planWorktreeSetup({ declared: undefined, hasManifest: false });
    expect(noManifest.ready).toBe(true);
    expect(noManifest.notice).toMatch(/no dependencies to install/i);

    const form = await openProjectForm();
    expect(form.textContent).toMatch(/declares a dependency manifest/i);
  });

  it('prints CLI flags the CLI actually defines', async () => {
    const cliSource = repoFile('cli/src/index.ts');
    const flags = ['--verify-command', '--setup-command'];
    for (const flag of flags) {
      expect(cliSource, `${flag} is no longer a flag on update-project`).toContain(`.option('${flag} <cmd>'`);
    }

    const form = await openProjectForm();
    expect(form.textContent).toMatch(/agenfk update-project/);
    for (const flag of flags) expect(form.textContent).toContain(flag);
  });

  it('offers no field for either command — the browser cannot write them', async () => {
    const form = await openProjectForm();
    /*
     * Named, not counted. A bare length check locked the door on every future
     * field, including ones the API accepts; what actually must never appear is
     * a control for a value this origin cannot save. Both commands are refused
     * by `PUT /projects/:id` and gated behind the x-agenfk-internal token, so an
     * input for either would take the text, fail, and look to the person typing
     * exactly like a saved setting. Adding a legitimate field means adding its
     * name below — a line somebody writes on purpose.
     */
    const controls = [...form.querySelectorAll('input, textarea, select')];
    const describedBy = (c: Element): string =>
      [c.id, c.getAttribute('placeholder'), c.getAttribute('aria-label'), c.getAttribute('name'),
       c.id ? form.querySelector(`label[for="${c.id}"]`)?.textContent : ''].filter(Boolean).join(' ');

    expect(
      controls.map(describedBy).filter(d => /verify|setup|command/i.test(d)),
      'the form must not offer a field for a value this origin cannot save',
    ).toEqual([]);

    expect(controls.map(c => c.id).sort()).toEqual(['new-project-description', 'new-project-name']);
  });
});
