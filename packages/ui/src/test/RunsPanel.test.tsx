/**
 * @vitest-environment jsdom
 *
 * RunsPanel (CGLAB-18c). Behaviour-based: mocked api + socket, asserts the run
 * list, default selection of the latest run, transcript rendering, live pill,
 * and the empty state.
 */
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { RunsPanel } from '../components/RunsPanel';
import { api } from '../api';

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({ on: vi.fn(), off: vi.fn(), emit: vi.fn(), disconnect: vi.fn() })),
}));

vi.mock('../api', () => ({
  api: { listAgentRuns: vi.fn(), listRunEvents: vi.fn() },
}));

function renderPanel(itemId = 'i1') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <RunsPanel itemId={itemId} />
    </QueryClientProvider>,
  );
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('RunsPanel', () => {
  it('shows an empty state when there are no runs', async () => {
    vi.mocked(api.listAgentRuns).mockResolvedValue([]);
    renderPanel();
    await waitFor(() => expect(screen.getByText(/no agent runs recorded/i)).toBeDefined());
  });

  it('lists runs, defaults to the latest, and renders its transcript', async () => {
    vi.mocked(api.listAgentRuns).mockResolvedValue([
      { id: 'r1', itemId: 'i1', step: 'CREATE_UNIT_TESTS', actor: 'worker', harness: 'pi', model: 'qwen3.6:27b', status: 'done', verdict: 'APPROVED', startedAt: '2026-07-21T10:00:00.000Z' },
      { id: 'r2', itemId: 'i1', step: 'IN_PROGRESS', actor: 'worker', harness: 'pi', model: 'qwen3.6:27b', status: 'running', startedAt: '2026-07-21T10:05:00.000Z' },
    ] as any);
    vi.mocked(api.listRunEvents).mockImplementation((runId: string) =>
      Promise.resolve(runId === 'r2' ? [
        { id: 'e1', runId: 'r2', seq: 0, ts: 't', lane: 'orchestrator', kind: 'dispatch', text: 'implement it' },
        { id: 'e2', runId: 'r2', seq: 1, ts: 't', lane: 'worker', kind: 'tool', tool: 'bash', text: 'npx vitest' },
      ] as any : []),
    );

    renderPanel();

    // Both runs listed (the selected run's step also appears in the transcript header)
    await waitFor(() => expect(screen.getByText('CREATE_UNIT_TESTS')).toBeDefined());
    expect(screen.getAllByText('IN_PROGRESS').length).toBeGreaterThanOrEqual(1);

    // Latest run (r2, running) selected by default → its events render
    await waitFor(() => expect(screen.getByText('npx vitest')).toBeDefined());
    expect(screen.getByText('implement it')).toBeDefined();

    // Running run shows the LIVE pill
    expect(screen.getByText(/live/i)).toBeDefined();

    // listRunEvents was queried for the latest run
    expect(api.listRunEvents).toHaveBeenCalledWith('r2');
  });

  // CGLAB-20: the un-proxied /agent-runs route served the SPA index.html, so
  // axios handed back an HTML string. RunsPanel must degrade to an empty state
  // rather than throw "a.map is not a function" and white-screen the whole app.
  const HTML_STRING = '<!doctype html><html><body><div id="root"></div></body></html>';

  it('does not throw when the runs endpoint returns a non-array (renders empty state)', async () => {
    vi.mocked(api.listAgentRuns).mockResolvedValue(HTML_STRING as any);
    renderPanel();
    await waitFor(() => expect(screen.getByText(/no agent runs recorded/i)).toBeDefined());
  });

  it('does not throw when the events endpoint returns a non-array (renders "No events yet.")', async () => {
    vi.mocked(api.listAgentRuns).mockResolvedValue([
      { id: 'r1', itemId: 'i1', step: 'CREATE_UNIT_TESTS', actor: 'worker', harness: 'pi', model: 'qwen3.6:27b', status: 'done', startedAt: '2026-07-21T10:00:00.000Z' },
    ] as any);
    vi.mocked(api.listRunEvents).mockResolvedValue(HTML_STRING as any);
    renderPanel();
    // Run list renders (we got past the runs array)...
    await waitFor(() => expect(screen.getByText('CREATE_UNIT_TESTS')).toBeDefined());
    // ...and the transcript degrades gracefully instead of crashing on events.map
    await waitFor(() => expect(screen.getByText(/no events yet/i)).toBeDefined());
  });
});
