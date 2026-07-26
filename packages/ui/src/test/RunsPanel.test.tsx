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

function renderPanelWithClient(itemId = 'i1') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <RunsPanel itemId={itemId} />
    </QueryClientProvider>,
  );
  return qc;
}

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

  // CGLAB-21: each transcript event shows an identity caption — worker events
  // show "<harness> · <pretty model>" (e.g. "pi · Qwen"), orchestrator events
  // show "orchestrator".
  it('renders per-event identity captions (harness · model for worker, role for orchestrator)', async () => {
    vi.mocked(api.listAgentRuns).mockResolvedValue([
      { id: 'r2', itemId: 'i1', step: 'IN_PROGRESS', actor: 'worker', harness: 'pi', model: 'qwen3.6:27b', status: 'running', startedAt: '2026-07-21T10:05:00.000Z' },
    ] as any);
    vi.mocked(api.listRunEvents).mockResolvedValue([
      { id: 'e1', runId: 'r2', seq: 0, ts: 't', lane: 'orchestrator', kind: 'dispatch', text: 'implement it' },
      { id: 'e2', runId: 'r2', seq: 1, ts: 't', lane: 'worker', kind: 'tool', tool: 'bash', text: 'npx vitest' },
    ] as any);

    renderPanel();

    await waitFor(() => expect(screen.getByText('npx vitest')).toBeDefined());
    // Worker caption: harness + prettified model (qwen3.6:27b -> Qwen)
    expect(screen.getByText('pi · Qwen')).toBeDefined();
    // Orchestrator caption
    expect(screen.getByText('orchestrator')).toBeDefined();
  });

  it('omits the separator in the worker caption when the model is unknown', async () => {
    vi.mocked(api.listAgentRuns).mockResolvedValue([
      { id: 'r3', itemId: 'i1', step: 'IN_PROGRESS', actor: 'worker', harness: 'pi', model: '', status: 'done', startedAt: '2026-07-21T10:00:00.000Z' },
    ] as any);
    vi.mocked(api.listRunEvents).mockResolvedValue([
      { id: 'e1', runId: 'r3', seq: 0, ts: 't', lane: 'worker', kind: 'note', text: 'no model set' },
    ] as any);
    renderPanel();
    await waitFor(() => screen.getByText('no model set'));
    // Caption is just the harness, with no trailing "· "
    expect(screen.getByText('pi')).toBeDefined();
    expect(screen.queryByText(/pi ·\s*$/)).toBeNull();
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

  // CGLAB-21 follow-up #4: non-worker lanes must also show harness · model in
  // the identity caption when the event's lane matches the run's actor — e.g. a
  // reviewer run shows "claude-code · Claude", not just "reviewer".
  it('shows harness · model in the caption for a reviewer run', async () => {
    vi.mocked(api.listAgentRuns).mockResolvedValue([
      { id: 'rv', itemId: 'i1', step: 'REVIEW', actor: 'reviewer', harness: 'claude-code', model: 'claude-opus-4-8', status: 'done', verdict: 'APPROVE', startedAt: '2026-07-21T10:00:00.000Z' },
    ] as any);
    vi.mocked(api.listRunEvents).mockResolvedValue([
      { id: 'e1', runId: 'rv', seq: 0, ts: 't', lane: 'reviewer', kind: 'verdict', text: 'looks good' },
    ] as any);
    renderPanel();
    await waitFor(() => expect(screen.getByText('looks good')).toBeDefined());
    // prettyModel('claude-opus-4-8') -> 'Claude'
    expect(screen.getByText('claude-code · Claude')).toBeDefined();
  });

  // CGLAB-21 follow-up #3: while a run is live, the LIVE pill pulses; once done
  // it shows the verdict without pulsing.
  it('pulses the LIVE pill while running and stops once done', async () => {
    vi.mocked(api.listAgentRuns).mockResolvedValue([
      { id: 'r2', itemId: 'i1', step: 'IN_PROGRESS', actor: 'worker', harness: 'pi', model: 'qwen3.6:27b', status: 'running', startedAt: '2026-07-21T10:05:00.000Z' },
    ] as any);
    vi.mocked(api.listRunEvents).mockResolvedValue([
      { id: 'e1', runId: 'r2', seq: 0, ts: 't', lane: 'worker', kind: 'note', text: 'working' },
    ] as any);
    renderPanel();
    const livePill = await waitFor(() => screen.getByText(/live/i));
    expect(livePill.className).toContain('animate-pulse');
  });

  it('does not pulse the status pill when the run is done', async () => {
    vi.mocked(api.listAgentRuns).mockResolvedValue([
      { id: 'r1', itemId: 'i1', step: 'IN_PROGRESS', actor: 'worker', harness: 'pi', model: 'qwen3.6:27b', status: 'done', verdict: 'passed', startedAt: '2026-07-21T10:00:00.000Z' },
    ] as any);
    vi.mocked(api.listRunEvents).mockResolvedValue([
      { id: 'e1', runId: 'r1', seq: 0, ts: 't', lane: 'worker', kind: 'note', text: 'done working' },
    ] as any);
    renderPanel();
    await waitFor(() => expect(screen.getByText('done working')).toBeDefined());
    const pill = screen.getByText(/passed/i);
    expect(pill.className).not.toContain('animate-pulse');
  });

  // CGLAB-21 follow-up #2: when a new run appears (e.g. IN_PROGRESS starts), the
  // panel auto-follows to the newest run instead of staying on the first.
  it('auto-selects the newest run when a new run appears', async () => {
    let runs: any[] = [
      { id: 'r1', itemId: 'i1', step: 'CREATE_UNIT_TESTS', actor: 'worker', harness: 'pi', model: 'qwen3.6:27b', status: 'done', startedAt: '2026-07-21T10:00:00.000Z' },
    ];
    vi.mocked(api.listAgentRuns).mockImplementation(() => Promise.resolve(runs) as any);
    vi.mocked(api.listRunEvents).mockImplementation((id: string) =>
      Promise.resolve((id === 'r1'
        ? [{ id: 'e1', runId: 'r1', seq: 0, ts: 't', lane: 'worker', kind: 'note', text: 'tests phase' }]
        : [{ id: 'e2', runId: 'r2', seq: 0, ts: 't', lane: 'worker', kind: 'note', text: 'impl phase' }]) as any),
    );
    const qc = renderPanelWithClient();
    await waitFor(() => expect(screen.getByText('tests phase')).toBeDefined());
    // A new run starts:
    runs = [
      ...runs,
      { id: 'r2', itemId: 'i1', step: 'IN_PROGRESS', actor: 'worker', harness: 'pi', model: 'qwen3.6:27b', status: 'running', startedAt: '2026-07-21T10:05:00.000Z' },
    ];
    await qc.invalidateQueries({ queryKey: ['agent-runs', 'i1'] });
    // Selection auto-advances to the newest run → its transcript renders.
    await waitFor(() => expect(screen.getByText('impl phase')).toBeDefined());
  });

  it('renders the event timestamp (date + time) under the identity caption when ts is valid', async () => {
    vi.mocked(api.listAgentRuns).mockResolvedValue([
      { id: 'r1', itemId: 'i1', step: 'IN_PROGRESS', actor: 'worker', harness: 'pi', model: 'qwen3.6:27b', status: 'done', startedAt: '2026-07-21T10:00:00.000Z' },
    ] as any);
    vi.mocked(api.listRunEvents).mockResolvedValue([
      { id: 'e1', runId: 'r1', seq: 0, ts: '2026-07-21T10:00:00.000Z', lane: 'worker', kind: 'note', text: 'hello' },
    ] as any);
    renderPanel();
    await waitFor(() => expect(screen.getByText('hello')).toBeDefined());
    // The formatted date and time appear somewhere in the DOM (they are inside the gutter)
    // toLocaleDateString / toLocaleTimeString output is locale-dependent, so just assert
    // that the caption is present and the gutter content is richer than just the caption.
    const who = screen.getByText('pi · Qwen');
    // The timestamp is rendered as a sibling span inside the same gutter div
    const gutterDiv = (who.parentElement as HTMLElement);
    const timestampSpans = gutterDiv.querySelectorAll('span');
    // There should be more than just the avatar + who caption (the timestamp span is extra)
    // The timestamp span contains two lines (date \n time)
    expect(timestampSpans.length).toBeGreaterThanOrEqual(3);
  });

  it('renders nothing for the timestamp when ts is missing or unparseable', async () => {
    vi.mocked(api.listAgentRuns).mockResolvedValue([
      { id: 'r1', itemId: 'i1', step: 'IN_PROGRESS', actor: 'worker', harness: 'pi', model: 'qwen3.6:27b', status: 'done', startedAt: '2026-07-21T10:00:00.000Z' },
    ] as any);
    vi.mocked(api.listRunEvents).mockResolvedValue([
      { id: 'e1', runId: 'r1', seq: 0, ts: 'not-a-date', lane: 'worker', kind: 'note', text: 'bad ts' },
      { id: 'e2', runId: 'r1', seq: 1, lane: 'worker', kind: 'note', text: 'missing ts' },
    ] as any);
    renderPanel();
    await waitFor(() => expect(screen.getByText('bad ts')).toBeDefined());
    // No "Invalid Date" anywhere
    expect(screen.queryByText('Invalid Date')).toBeNull();
  });
});
