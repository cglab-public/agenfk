/**
 * @vitest-environment jsdom
 *
 * The sidebar's Flows entry, which took the Inbox placeholder's slot.
 *
 * The distinction this file exists to hold is the one the Inbox row failed:
 * a nav row that lands on a stated empty state is scaffolding, and Flows is
 * not. It opens the flow editor - the same modal the board's Manage Flow
 * button opens - and leaves you where you were. So the assertions are about
 * the modal appearing and the view NOT changing, which is what separates a
 * real control from a fourth destination.
 *
 * The editor itself is stubbed. Its behaviour has its own suite
 * (FlowEditorModal.test.tsx); what is unverified without this file is the
 * wiring between the sidebar row and the modal's props.
 */
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppShell } from '../components/AppShell';
import { SocketProvider } from '../SocketContext';
import { ActiveProjectProvider } from '../ActiveProject';

vi.mock('../api', () => ({
  api: {
    listProjects: vi.fn(async () => [
      { id: 'p1', name: 'agenfk', createdAt: new Date(), updatedAt: new Date() },
      // A second one so switching projects is reachable, which is what the
      // editor must not follow.
      { id: 'p2', name: 'horizon-lab', createdAt: new Date(), updatedAt: new Date() },
    ]),
    listActiveItems: vi.fn(async () => []),
    getVersion: vi.fn(async () => ({ version: '1.1.18' })),
    getReadme: vi.fn(async () => ({ content: '# Readme' })),
    getLatestRelease: vi.fn(async () => ({
      version: '1.1.18', tagName: 'v1.1.18', name: '', body: '', publishedAt: '', url: '',
      currentVersion: '1.1.18',
    })),
    updateItem: vi.fn(async () => ({})),
    getSettings: vi.fn(async () => ({ tmuxByDefault: false })),
    updateSettings: vi.fn(async () => ({ tmuxByDefault: false })),
    listRuns: vi.fn(async () => []),
    getProjectFlow: vi.fn(async () => ({ id: 'flow-tdd', name: 'TDD Flow', steps: [] })),
  },
}));

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({
    connect: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn(),
  })),
}));

/*
 * Stubbed at the agenfk wrapper, not at @agenfk/flow-editor: the wrapper is
 * what AppShell imports, and it is also what pulls in ThemeContext, which has
 * no provider in this suite. Rendering the props rather than recording them
 * keeps the test indifferent to whether the shell mounts the modal always or
 * only while it is open.
 */
vi.mock('../components/FlowEditorModal', () => ({
  FlowEditorModal: (props: { isOpen: boolean; onClose: () => void; projectId: string; activeFlowId?: string }) => (
    props.isOpen ? (
      <div data-testid="flow-editor">
        <span data-testid="flow-editor-project">{props.projectId}</span>
        <span data-testid="flow-editor-active-flow">{props.activeFlowId ?? ''}</span>
        <button onClick={props.onClose}>Close flow editor</button>
      </div>
    ) : null
  ),
}));

const renderShell = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ActiveProjectProvider>
      <SocketProvider>
        <AppShell><div>THE BOARD</div></AppShell>
      </SocketProvider>
    </ActiveProjectProvider>
  </QueryClientProvider>,
);

const workNav = () => screen.getByRole('navigation', { name: /work/i });
const workRow = (name: RegExp) => within(workNav()).getByRole('button', { name });

beforeEach(() => {
  localStorage.clear();
  // A project has to be open for the editor to have anything to edit. Set the
  // same key ActiveProject persists to, so the shell starts where a returning
  // user would.
  localStorage.setItem('agenfk_project_id', 'p1');
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  // Cleared on the way OUT as well as in. The runner shares one jsdom across
  // files, so an active project left behind here changes what the next file's
  // shell opens on - which showed up as two unrelated terminal tests failing
  // only when this file ran before them.
  localStorage.clear();
});

describe('the sidebar Flows entry', () => {
  it('takes the Inbox placeholder slot, leaving no Inbox row or panel behind', async () => {
    renderShell();
    await screen.findByRole('button', { name: 'agenfk' });

    expect(workRow(/flows/i)).toBeDefined();
    expect(screen.queryByRole('button', { name: /inbox/i })).toBeNull();
    expect(document.getElementById('panel-inbox')).toBeNull();
    // Agents is a placeholder with its own card and is deliberately untouched.
    expect(workRow(/agents/i)).toBeDefined();
  });

  it('opens the flow editor on the open project', async () => {
    renderShell();
    await screen.findByRole('button', { name: 'agenfk' });
    expect(screen.queryByTestId('flow-editor')).toBeNull();

    fireEvent.click(workRow(/flows/i));

    await screen.findByTestId('flow-editor');
    expect(screen.getByTestId('flow-editor-project').textContent).toBe('p1');
  });

  it('is already on the project’s flow the moment it appears', async () => {
    /*
     * Not "eventually on it". The editor reads `activeFlowId` once, when it
     * mounts, and ignores every later value — so a modal that appears with the
     * prop still undefined opens on nothing selected and stays there, and an
     * assertion that merely waits for the prop to arrive would call that a
     * pass. The wait here is for the modal, and the flow is read in the same
     * tick it first exists.
     */
    renderShell();
    await screen.findByRole('button', { name: 'agenfk' });

    fireEvent.click(workRow(/flows/i));

    await screen.findByTestId('flow-editor');
    expect(screen.getByTestId('flow-editor-active-flow').textContent).toBe('flow-tdd');
  });

  it('closes when the project changes, and does not come back on its own', async () => {
    /*
     * The editor binds a flow to the project it was opened on. Following a
     * project switch would write project A's flow onto project B, because the
     * selection it is showing was seeded once at mount and never re-read.
     *
     * The second half is the one that bites without being noticed: hiding the
     * editor by dropping the project, while leaving the open flag set, means it
     * reappears with no click behind it as soon as a project is picked again.
     */
    renderShell();
    await screen.findByRole('button', { name: 'agenfk' });
    fireEvent.click(workRow(/flows/i));
    await screen.findByTestId('flow-editor');

    fireEvent.click(screen.getByRole('button', { name: 'horizon-lab' }));
    expect(screen.queryByTestId('flow-editor')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'agenfk' }));
    expect(screen.queryByTestId('flow-editor')).toBeNull();
  });

  it('leaves the board on screen - it is a window, not a fourth destination', async () => {
    renderShell();
    await screen.findByRole('button', { name: 'agenfk' });
    expect(workRow(/tasks/i).getAttribute('aria-current')).toBe('page');

    fireEvent.click(workRow(/flows/i));
    await screen.findByTestId('flow-editor');

    expect(document.getElementById('panel-kanban')!.hasAttribute('hidden')).toBe(false);
    expect(screen.getByText('THE BOARD')).toBeDefined();
    // Still on Tasks: opening a window does not move you.
    expect(workRow(/tasks/i).getAttribute('aria-current')).toBe('page');
    expect(workRow(/flows/i).getAttribute('aria-current')).toBeNull();
  });

  it('closes again when the editor asks it to', async () => {
    renderShell();
    await screen.findByRole('button', { name: 'agenfk' });
    fireEvent.click(workRow(/flows/i));
    await screen.findByTestId('flow-editor');

    fireEvent.click(screen.getByRole('button', { name: /close flow editor/i }));

    expect(screen.queryByTestId('flow-editor')).toBeNull();
    // And it can be opened a second time, which a one-way flag would break.
    fireEvent.click(workRow(/flows/i));
    expect(await screen.findByTestId('flow-editor')).toBeDefined();
  });

  it('says why it cannot act when no project is open, rather than opening an editor with nothing to edit', async () => {
    localStorage.removeItem('agenfk_project_id');
    renderShell();
    await screen.findByRole('button', { name: 'agenfk' });

    const flows = workRow(/flows/i) as HTMLButtonElement;
    /*
     * `aria-disabled` and still focusable, NOT the `disabled` attribute. A
     * disabled button drops out of the tab order, which takes the title - the
     * only place the reason is written - out of reach of the keyboard and
     * screen-reader users it is written for.
     */
    expect(flows.getAttribute('aria-disabled')).toBe('true');
    expect(flows.disabled).toBe(false);
    expect(flows.title).toMatch(/project/i);

    fireEvent.click(flows);
    expect(screen.queryByTestId('flow-editor')).toBeNull();
  });
});

describe('the sidebar WORK group heading', () => {
  it('is not drawn, but the group is still named for assistive tech', async () => {
    renderShell();
    await screen.findByRole('button', { name: 'agenfk' });

    expect(screen.queryByRole('heading', { name: /^work$/i })).toBeNull();
    // The name moved to the landmark, so a screen-reader user can still jump
    // to the group by name. Dropping both would leave it anonymous.
    expect(workNav()).toBeDefined();
  });

  it('keeps the nav rows clear of the row above now that the heading is gone', async () => {
    /*
     * The heading carried the group's top padding, so deleting the text alone
     * butts the first row against the collapse control. jsdom has no layout
     * engine, so the declared class is the only observable there is here - a
     * weaker assertion than a measured gap, kept because losing the padding
     * again would otherwise be invisible to the suite.
     */
    renderShell();
    await screen.findByRole('button', { name: 'agenfk' });

    expect(workNav().className).toMatch(/\bpt-2\b/);
  });
});
