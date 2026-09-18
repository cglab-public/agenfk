/**
 * The herdr panes, on screen (96953f6a / CGLAB-266).
 *
 * The list a person reads to find work that is already running — theirs and
 * ours — and open one of them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { HerdrPanes } from '../components/HerdrPanes';

const SOCKET = '/cfg/herdr/herdr.sock';

const pane = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  pane_id: 'w1:p1', cwd: '/Users/x/GitHub/agenfk', agent: 'claude',
  agent_status: 'idle', terminal_title_stripped: 'Alguma coisa',
  owner: { kind: 'external' }, ...over,
});

const body = (panes: Record<string, unknown>[], over: Record<string, unknown> = {}): unknown => ({
  available: true, reason: '1 of 1 herdr session answered',
  sessions: [{ name: 'default', socketPath: SOCKET, reachable: true, protocol: 17,
    counts: { workspaces: 1, tabs: 1, panes: panes.length, agents: panes.length },
    byAgent: {}, panes }],
  ...over,
});

function mount(payload: unknown): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <HerdrPanes />
    </QueryClientProvider>,
  );
  void payload;
}

beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const answer = (payload: unknown): void => {
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: true, status: 200, json: async () => payload,
  } as unknown as Response);
};

describe('the list', () => {
  it('shows what is running, grouped by the directory a person recognises', async () => {
    answer(body([
      pane({ pane_id: 'a', cwd: '/x/agenfk' }),
      pane({ pane_id: 'b', cwd: '/x/horizon' }),
    ]));
    mount(null);
    await waitFor(() => expect(screen.getByText('agenfk')).toBeTruthy());
    expect(screen.getByText('horizon')).toBeTruthy();
  });

  it('puts the group waiting on a person FIRST', async () => {
    /*
     * The reason this screen exists is the pane nobody is watching. Sorted by
     * name, that row is buried.
     */
    answer(body([
      pane({ pane_id: 'a', cwd: '/x/aaa', agent_status: 'idle' }),
      pane({ pane_id: 'b', cwd: '/x/zzz', agent_status: 'blocked' }),
    ]));
    mount(null);
    await waitFor(() => expect(screen.getAllByTestId(/^herdr-group-/).length).toBe(2));
    const first = screen.getAllByTestId(/^herdr-group-/)[0];
    expect(first.getAttribute('data-testid')).toBe('herdr-group-/x/zzz');
  });

  it('says a pane is waiting on a person, in a colour that exists', async () => {
    // `text-warn` compiles to nothing in this build; the convention is amber.
    answer(body([pane({ agent_status: 'blocked' })]));
    mount(null);
    const badge = await screen.findByTestId('herdr-needs-person');
    expect(badge.className).toMatch(/amber/);
  });

  it('names the harness, including one this product cannot launch', async () => {
    answer(body([pane({ agent: 'pi' })]));
    mount(null);
    expect(await screen.findByText(/\bpi\b/)).toBeTruthy();
  });
});

describe('whose pane it is', () => {
  it('shows the CARD when the pane belongs to one', async () => {
    answer(body([pane({
      owner: { kind: 'card', cardId: 'c-1', title: 'Adapter herdr', status: 'IN_PROGRESS', branchName: 'feat/x' },
    })]));
    mount(null);
    expect(await screen.findByText('Adapter herdr')).toBeTruthy();
    expect(screen.getByText(/IN_PROGRESS/)).toBeTruthy();
  });

  it('shows the project when it is only that', async () => {
    answer(body([pane({ owner: { kind: 'project', projectName: 'agenfk' } })]));
    mount(null);
    expect(await screen.findByTestId('herdr-owner-w1:p1').then(e => e.textContent)).toMatch(/agenfk/);
  });

  it('says EXTERNAL plainly, rather than leaving it blank', async () => {
    /*
     * Seventeen of twenty-four panes on this machine are somebody's own work.
     * A blank cell reads as missing data; "external" reads as an answer.
     */
    answer(body([pane({ owner: { kind: 'external' } })]));
    mount(null);
    const cell = await screen.findByTestId('herdr-owner-w1:p1');
    expect(cell.textContent).toMatch(/external|not ours|sua/i);
  });
});

describe('when there is nothing to show', () => {
  it('says so, instead of drawing an empty box', async () => {
    answer({ available: false, reason: 'no herdr sessions found', sessions: [] });
    mount(null);
    expect(await screen.findByTestId('herdr-empty')).toBeTruthy();
  });

  it('does not draw a failure over mere absence', async () => {
    answer({ available: false, reason: 'no herdr sessions found', sessions: [] });
    mount(null);
    const empty = await screen.findByTestId('herdr-empty');
    expect(empty.className).not.toMatch(/danger|red/);
  });
});

describe('opening one', () => {
  it('asks for its content only when opened, never for the whole list', async () => {
    /*
     * A listing that drags every pane's text is a different amount of data and
     * a different decision. Nothing is read until somebody opens one.
     */
    answer(body([pane()]));
    mount(null);
    await screen.findByTestId('herdr-pane-w1:p1');
    const urls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map(c => String(c[0]));
    expect(urls.some(u => u.includes('/content'))).toBe(false);
  });

  it('fetches the content, with the socket the session came from', async () => {
    answer(body([pane()]));
    mount(null);
    fireEvent.click(await screen.findByTestId('herdr-pane-w1:p1'));
    await waitFor(() => {
      const urls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map(c => String(c[0]));
      const content = urls.find(u => u.includes('/content'));
      expect(content, 'the content call must carry the pane and its socket').toBeTruthy();
      expect(content).toContain(encodeURIComponent(SOCKET));
    });
  });
});
