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
    const ts = '2026-07-21T10:00:00.000Z';
    vi.mocked(api.listRunEvents).mockResolvedValue([
      { id: 'e1', runId: 'r1', seq: 0, ts, lane: 'worker', kind: 'note', text: 'hello' },
    ] as any);
    renderPanel();
    await waitFor(() => expect(screen.getByText('hello')).toBeDefined());
    // Assert the rendered date and time themselves, not just that an extra span
    // exists — a span-count check passes on any garbage the formatter emits.
    // The exact strings are locale- and timezone-dependent, so derive the
    // expectation the same way the component does rather than hardcoding it.
    const d = new Date(ts);
    const gutter = (screen.getByText('pi · Qwen').parentElement as HTMLElement);
    expect(gutter.textContent).toContain(d.toLocaleDateString());
    expect(gutter.textContent).toContain(d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  });

  // CGLAB-18d: non-tool events must render markdown as formatted HTML, not raw syntax.
  it('renders markdown constructs (bold, code, list) as real DOM elements in a non-tool event', async () => {
    vi.mocked(api.listAgentRuns).mockResolvedValue([
      { id: 'r1', itemId: 'i1', step: 'IN_PROGRESS', actor: 'worker', harness: 'pi', model: 'qwen3.6:27b', status: 'done', startedAt: '2026-07-21T10:00:00.000Z' },
    ] as any);
    vi.mocked(api.listRunEvents).mockResolvedValue([
      { id: 'e1', runId: 'r1', seq: 0, ts: 't', lane: 'worker', kind: 'note', text: '**bold text** and `inline code`\n\n- first item\n- second item' },
    ] as any);
    renderPanel();

    // Wait for the CONTENT, not the container: the transcript div is present on
    // the very first render, before the events query resolves, so awaiting the
    // testid alone returns an empty transcript and every assertion below races.
    await waitFor(() =>
      expect(screen.getByTestId('runs-transcript').querySelector('strong')).not.toBeNull()
    );
    const transcript = screen.getByTestId('runs-transcript');

    // After the fix, **bold text** produces a <strong> element
    expect(transcript.querySelector('strong')).not.toBeNull();
    expect(transcript.querySelector('strong')?.textContent).toBe('bold text');

    // After the fix, `inline code` produces a <code> element (inside a paragraph)
    const code = transcript.querySelector('code');
    expect(code).not.toBeNull();
    expect(code?.textContent).toBe('inline code');

    // After the fix, list items are <li> elements (not "- item" text)
    const lis = transcript.querySelectorAll('li');
    expect(lis.length).toBe(2);
    expect(lis[0].textContent).toBe('first item');

    // Literal markdown syntax must NOT survive in the rendered output
    expect(transcript.textContent).not.toContain('**');
    expect(transcript.textContent).not.toContain('- first item');
  });

  // CGLAB-18d: remark-gfm must be wired up, not just react-markdown alone.
  it('renders a GFM strikethrough as a <del> element', async () => {
    vi.mocked(api.listAgentRuns).mockResolvedValue([
      { id: 'r1', itemId: 'i1', step: 'IN_PROGRESS', actor: 'worker', harness: 'pi', model: 'qwen3.6:27b', status: 'done', startedAt: '2026-07-21T10:00:00.000Z' },
    ] as any);
    vi.mocked(api.listRunEvents).mockResolvedValue([
      { id: 'e1', runId: 'r1', seq: 0, ts: 't', lane: 'worker', kind: 'note', text: '~~strikethrough~~' },
    ] as any);
    renderPanel();

    // Await the content, not the container — see the note in the test above.
    await waitFor(() =>
      expect(screen.getByTestId('runs-transcript').querySelector('del')).not.toBeNull()
    );
    const transcript = screen.getByTestId('runs-transcript');
    // After the fix, ~~strikethrough~~ produces a <del> element
    expect(transcript.querySelector('del')).not.toBeNull();
    expect(transcript.querySelector('del')?.textContent).toBe('strikethrough');
  });

  // CGLAB-18d: tool events must NOT render markdown — they stay literal in <pre>.
  it('keeps markdown literal in a tool event (renders in <pre>, no formatting)', async () => {
    vi.mocked(api.listAgentRuns).mockResolvedValue([
      { id: 'r1', itemId: 'i1', step: 'IN_PROGRESS', actor: 'worker', harness: 'pi', model: 'qwen3.6:27b', status: 'done', startedAt: '2026-07-21T10:00:00.000Z' },
    ] as any);
    vi.mocked(api.listRunEvents).mockResolvedValue([
      { id: 'e1', runId: 'r1', seq: 0, ts: 't', lane: 'worker', kind: 'tool', tool: 'bash', text: '**bold** and `code`\n- list' },
    ] as any);
    renderPanel();

    // Wait for the <pre> to appear (tool events render text in <pre>)
    await waitFor(() => expect(document.querySelector('pre')).not.toBeNull());
    const pre = document.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toContain('**bold**');
    expect(pre?.textContent).toContain('- list');

    // No markdown-formatted elements should appear
    expect(document.querySelector('strong')).toBeNull();
  });

  // CGLAB-18d: think events keep their italic visual distinction.
  it('keeps italic styling on think events after markdown rendering', async () => {
    vi.mocked(api.listAgentRuns).mockResolvedValue([
      { id: 'r1', itemId: 'i1', step: 'IN_PROGRESS', actor: 'worker', harness: 'pi', model: 'qwen3.6:27b', status: 'done', startedAt: '2026-07-21T10:00:00.000Z' },
    ] as any);
    vi.mocked(api.listRunEvents).mockResolvedValue([
      { id: 'e1', runId: 'r1', seq: 0, ts: 't', lane: 'worker', kind: 'think', text: 'reasoning here' },
    ] as any);
    renderPanel();

    await waitFor(() => expect(screen.getByText('reasoning here')).toBeDefined());
    const textEl = screen.getByText('reasoning here');
    expect(textEl.closest('.italic')).not.toBeNull();
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
    // queryByText('Invalid Date') is NOT enough: with the guard removed the span
    // renders "Invalid Date" twice (date + <br> + time), whose normalised
    // textContent never equals the exact string — so that assertion passes on
    // the very bug it exists to catch. Match the substring, and assert the
    // timestamp span is genuinely absent rather than merely not-that-string.
    for (const text of ['bad ts', 'missing ts']) {
      const gutter = (screen.getByText(text).closest('.flex.gap-3') as HTMLElement)
        .firstElementChild as HTMLElement;
      expect(gutter.textContent).not.toMatch(/Invalid/);
      // avatar tile + who caption only — no third (timestamp) span.
      expect(gutter.querySelectorAll('span')).toHaveLength(2);
    }
  });

  // Fix 5a: stripAnsi must be applied to non-tool event text.
  // Mutation: changing stripAnsi(ev.text) back to ev.text would let escapes survive.
  it('strips ANSI escapes from non-tool event text', async () => {
    vi.mocked(api.listAgentRuns).mockResolvedValue([
      { id: 'r1', itemId: 'i1', step: 'IN_PROGRESS', actor: 'worker', harness: 'pi', model: 'qwen3.6:27b', status: 'done', startedAt: '2026-07-21T10:00:00.000Z' },
    ] as any);
    vi.mocked(api.listRunEvents).mockResolvedValue([
      { id: 'e1', runId: 'r1', seq: 0, ts: 't', lane: 'worker', kind: 'note', text: '\x1b[31mred error\x1b[0m' },
    ] as any);
    renderPanel();
    await waitFor(() => expect(screen.getByText('red error')).toBeDefined());
    // The raw escape sequence must not appear in the rendered output
    expect(screen.queryByText(/\x1b\[31m/)).toBeNull();
  });

  // Fix 5b: stripAnsi must be applied to tool event text.
  // Mutation: omitting stripAnsi on the tool <pre> would let escapes render as garbage glyphs.
  it('strips ANSI escapes from tool event text', async () => {
    vi.mocked(api.listAgentRuns).mockResolvedValue([
      { id: 'r1', itemId: 'i1', step: 'IN_PROGRESS', actor: 'worker', harness: 'pi', model: 'qwen3.6:27b', status: 'done', startedAt: '2026-07-21T10:00:00.000Z' },
    ] as any);
    vi.mocked(api.listRunEvents).mockResolvedValue([
      { id: 'e1', runId: 'r1', seq: 0, ts: 't', lane: 'worker', kind: 'tool', tool: 'bash', text: '\x1b[31mred error\x1b[0m' },
    ] as any);
    renderPanel();
    await waitFor(() => expect(screen.getByText('red error')).toBeDefined());
    // The raw escape sequence must not appear in the rendered output
    expect(screen.queryByText(/\x1b\[31m/)).toBeNull();
  });

  // Fix 5c: the prose classes must be present on the markdown wrapper.
  // Mutation: deleting the class string would not break any semantic test.
  it('wraps markdown output in an element with prose and dark:prose-invert classes', async () => {
    vi.mocked(api.listAgentRuns).mockResolvedValue([
      { id: 'r1', itemId: 'i1', step: 'IN_PROGRESS', actor: 'worker', harness: 'pi', model: 'qwen3.6:27b', status: 'done', startedAt: '2026-07-21T10:00:00.000Z' },
    ] as any);
    vi.mocked(api.listRunEvents).mockResolvedValue([
      { id: 'e1', runId: 'r1', seq: 0, ts: 't', lane: 'worker', kind: 'note', text: 'hello world' },
    ] as any);
    renderPanel();
    await waitFor(() => expect(screen.getByText('hello world')).toBeDefined());
    const prose = document.querySelector('.prose');
    expect(prose).not.toBeNull();
    expect(prose?.className).toContain('prose');
    expect(prose?.className).toContain('dark:prose-invert');
  });

  // Fix 5d: markdown images must not produce real <img> elements that fetch remote URLs.
  it('does not render <img> elements for markdown image syntax in event text', async () => {
    vi.mocked(api.listAgentRuns).mockResolvedValue([
      { id: 'r1', itemId: 'i1', step: 'IN_PROGRESS', actor: 'worker', harness: 'pi', model: 'qwen3.6:27b', status: 'done', startedAt: '2026-07-21T10:00:00.000Z' },
    ] as any);
    vi.mocked(api.listRunEvents).mockResolvedValue([
      { id: 'e1', runId: 'r1', seq: 0, ts: 't', lane: 'worker', kind: 'note', text: '![tracking pixel](https://evil.example/track.png)' },
    ] as any);
    renderPanel();
    // Wait for the alt text to appear (rendered as plain text instead of <img>)
    await waitFor(() => expect(screen.getByText('tracking pixel')).toBeDefined());
    // No <img> element should exist in the DOM
    expect(document.querySelector('img')).toBeNull();
  });

  // CGLAB-33: machine-output kinds (result, diff) must render literally, not as markdown.

  it('renders a diff event inside <pre> and preserves leading spaces on context lines', async () => {
    vi.mocked(api.listAgentRuns).mockResolvedValue([
      { id: 'r1', itemId: 'i1', step: 'IN_PROGRESS', actor: 'worker', harness: 'pi', model: 'qwen3.6:27b', status: 'done', startedAt: '2026-07-21T10:00:00.000Z' },
    ] as any);
    vi.mocked(api.listRunEvents).mockResolvedValue([
      { id: 'e1', runId: 'r1', seq: 0, ts: 't', lane: 'worker', kind: 'diff', text: '--- a/file.py\n+++ b/file.py\n@@ -1 +1 @@\n- old line\n+ new line\n unchanged line' },
    ] as any);
    renderPanel();

    await waitFor(() => expect(document.querySelector('pre')).not.toBeNull());
    const pre = document.querySelector('pre');
    expect(pre).not.toBeNull();
    // Leading space on context line must survive (diff alignment)
    expect(pre?.textContent).toContain(' unchanged line');
    // Must NOT produce markdown artefacts like <hr> or <ul>
    expect(screen.queryByRole('separator')).toBeNull();
    expect(screen.getByTestId('runs-transcript').querySelector('ul')).toBeNull();
  });

  it('renders __init__ verbatim in a result event (no <strong> from double underscores)', async () => {
    vi.mocked(api.listAgentRuns).mockResolvedValue([
      { id: 'r1', itemId: 'i1', step: 'IN_PROGRESS', actor: 'worker', harness: 'pi', model: 'qwen3.6:27b', status: 'done', startedAt: '2026-07-21T10:00:00.000Z' },
    ] as any);
    vi.mocked(api.listRunEvents).mockResolvedValue([
      { id: 'e1', runId: 'r1', seq: 0, ts: 't', lane: 'worker', kind: 'result', text: "AttributeError: '__init__' missing" },
    ] as any);
    renderPanel();

    await waitFor(() => expect(document.querySelector('pre')).not.toBeNull());
    const pre = document.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toContain('__init__');
    // Double underscores must NOT produce a <strong>
    expect(screen.getByTestId('runs-transcript').querySelector('strong')).toBeNull();
  });

  it('does not produce a <table> from pipe-aligned lines in a result event', async () => {
    vi.mocked(api.listAgentRuns).mockResolvedValue([
      { id: 'r1', itemId: 'i1', step: 'IN_PROGRESS', actor: 'worker', harness: 'pi', model: 'qwen3.6:27b', status: 'done', startedAt: '2026-07-21T10:00:00.000Z' },
    ] as any);
    vi.mocked(api.listRunEvents).mockResolvedValue([
      { id: 'e1', runId: 'r1', seq: 0, ts: 't', lane: 'worker', kind: 'result', text: 'a | b | c\n--|--|--\n1 | 2 | 3' },
    ] as any);
    renderPanel();

    await waitFor(() => expect(document.querySelector('pre')).not.toBeNull());
    const pre = document.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toContain('a | b | c');
    expect(pre?.textContent).toContain('1 | 2 | 3');
    // Must NOT produce a GFM table
    expect(screen.getByTestId('runs-transcript').querySelector('table')).toBeNull();
  });

  it('still renders markdown in a note event (prose path regression guard)', async () => {
    vi.mocked(api.listAgentRuns).mockResolvedValue([
      { id: 'r1', itemId: 'i1', step: 'IN_PROGRESS', actor: 'worker', harness: 'pi', model: 'qwen3.6:27b', status: 'done', startedAt: '2026-07-21T10:00:00.000Z' },
    ] as any);
    vi.mocked(api.listRunEvents).mockResolvedValue([
      { id: 'e1', runId: 'r1', seq: 0, ts: 't', lane: 'worker', kind: 'note', text: '**prose markdown** is still rendered' },
    ] as any);
    renderPanel();

    await waitFor(() =>
      expect(screen.getByTestId('runs-transcript').querySelector('strong')).not.toBeNull()
    );
    const transcript = screen.getByTestId('runs-transcript');
    expect(transcript.querySelector('strong')).not.toBeNull();
    expect(transcript.querySelector('strong')?.textContent).toBe('prose markdown');
  });

  // Fix 5e: links must open in a new tab with noopener/noreferrer for safety.
  it('renders markdown links with target="_blank" and rel containing noopener', async () => {
    vi.mocked(api.listAgentRuns).mockResolvedValue([
      { id: 'r1', itemId: 'i1', step: 'IN_PROGRESS', actor: 'worker', harness: 'pi', model: 'qwen3.6:27b', status: 'done', startedAt: '2026-07-21T10:00:00.000Z' },
    ] as any);
    vi.mocked(api.listRunEvents).mockResolvedValue([
      { id: 'e1', runId: 'r1', seq: 0, ts: 't', lane: 'worker', kind: 'note', text: '[click me](https://example.com)' },
    ] as any);
    renderPanel();
    await waitFor(() => expect(screen.getByText('click me')).toBeDefined());
    const link = document.querySelector('a');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toContain('noopener');
    expect(link?.getAttribute('rel')).toContain('noreferrer');
  });
});
