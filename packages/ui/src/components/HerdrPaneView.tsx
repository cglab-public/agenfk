/**
 * One herdr pane, on screen (96953f6a / CGLAB-266).
 *
 * Clicking a herdr row in the tree opens this: what that pane held when it was
 * read. It is where a person goes to see what the agent they did not start is
 * actually doing.
 *
 * A MIRROR, AND IT SAYS SO. Nothing streams here - the content is one
 * `pane.read` at the moment you asked. A surface that looks like a terminal and
 * never advances is worse than one that admits what it is, which is the warning
 * collie puts on its own page for the same reason.
 *
 * IT CAN BE TYPED INTO, and that is the point: two agents on this machine sit
 * `blocked` waiting for a person, and answering them is a single keystroke -
 * `1` for a permission prompt, `2` for an option. Before this, seeing them was
 * all you could do.
 *
 * TYPING AND SUBMITTING ARE TWO ACTS. `pane.send_text` never appends Enter, so
 * Send does both on purpose and Type does only the first. collie draws the same
 * line, and it is the difference between putting a command in somebody's
 * terminal and running it.
 *
 * `pane.focus` is the one action that reaches outside this panel - it moves the
 * operator's real screen - so it stays a button nobody presses by accident.
 */
import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { API_URL } from '../apiUrl';
import { HerdrMark } from './HerdrMark';
import type { ProjectPaneRow } from '../herdrTreeRows';

/** Keys worth one tap: answering a prompt, interrupting, getting out. */
const QUICK_KEYS = ['1', '2', '3', 'Enter', 'Escape', 'ctrl+c'] as const;

export function HerdrPaneView({
  pane,
  onFocus,
}: {
  readonly pane: ProjectPaneRow;
  /** Bring it to the front in herdr. Absent means the action is not offered. */
  readonly onFocus?: (pane: ProjectPaneRow) => void;
}): React.ReactElement {
  const [draft, setDraft] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const [sendError, setSendError] = React.useState<string | null>(null);
  const { data, isLoading, isError, error, dataUpdatedAt, refetch, isFetching } = useQuery<{
    text: string; truncated: boolean; revision?: number;
  }>({
    queryKey: ['herdr-pane', pane.paneId, pane.socketPath],
    enabled: Boolean(pane.socketPath),
    queryFn: async () => {
      const r = await fetch(
        `${API_URL}/herdr/panes/${encodeURIComponent(pane.paneId)}/content`
        + `?socket=${encodeURIComponent(pane.socketPath)}&lines=300&source=recent`,
      );
      if (r.status === 404) throw new Error('That pane is gone — herdr does not know it any more.');
      if (!r.ok) throw new Error(`Could not read the pane (${r.status}).`);
      return r.json();
    },
    // A photograph, so it does not refresh itself. The button says when it was
    // taken and takes another.
    staleTime: Infinity,
  });

  const post = async (path: string, body: Record<string, unknown>): Promise<void> => {
    const r = await fetch(`${API_URL}/herdr/panes/${encodeURIComponent(pane.paneId)}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ socket: pane.socketPath, ...body }),
    });
    if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`);
  };

  /**
   * `submit` decides whether Enter follows the text.
   *
   * The keys go FIRST when there is no text, and the text is never typed if the
   * submit cannot be delivered - half of an instruction sitting in somebody's
   * terminal is worse than none of it.
   */
  const send = async (text: string, submit: boolean): Promise<void> => {
    setSending(true);
    setSendError(null);
    try {
      if (text) await post('text', { text });
      if (submit) await post('keys', { keys: ['Enter'] });
      setDraft('');
      // Read straight back, so the screen shows what the keystroke did rather
      // than what was there before it.
      await refetch();
    } catch (e) {
      setSendError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const tap = async (key: string): Promise<void> => {
    setSending(true);
    setSendError(null);
    try {
      await post('keys', { keys: [key] });
      await refetch();
    } catch (e) {
      setSendError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-border-soft px-4 py-2">
        <HerdrMark className="h-4 w-4 shrink-0 text-ink-tertiary" />
        <span className="font-mono text-[11px] text-ink-tertiary">{pane.agentId}</span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink" title={pane.title}>
          {pane.title}
        </span>
        <button
          type="button"
          onClick={() => void refetch()}
          disabled={isFetching}
          className="shrink-0 rounded px-2 py-1 font-mono text-[10px] text-ink-tertiary transition-colors hover:text-ink disabled:opacity-60"
        >
          {isFetching ? 'Reading…' : 'Read again'}
        </button>
        {onFocus && (
          /*
           * The ONE action, and it is explicit. `pane.focus` moves the pane,
           * the tab AND the workspace on the operator's real screen while they
           * are working - collie reaches for it from exactly one place too.
           */
          <button
            type="button"
            onClick={() => onFocus(pane)}
            className="shrink-0 rounded border border-border-soft px-2 py-1 text-[10px] text-ink-secondary transition-colors hover:text-ink"
          >
            Show in herdr
          </button>
        )}
      </header>

      <p className="shrink-0 px-4 pt-2 text-[11px] text-ink-tertiary">
        A mirror, not a terminal — this is what the pane held when it was read
        {dataUpdatedAt ? `, ${new Date(dataUpdatedAt).toLocaleTimeString()}` : ''}.
      </p>

      {!pane.socketPath ? (
        // A guessed socket would read somebody else's pane, so the honest
        // answer is to say we cannot rather than to try.
        <p data-testid="herdr-pane-nosocket" className="px-4 py-3 text-[12px] text-amber-600 dark:text-amber-400">
          This pane did not say which herdr session it belongs to, so it cannot be read.
        </p>
      ) : isLoading ? (
        <p className="px-4 py-3 text-[12px] text-ink-tertiary">Reading…</p>
      ) : isError ? (
        <p data-testid="herdr-pane-error" className="px-4 py-3 text-[12px] text-amber-600 dark:text-amber-400">
          {(error as Error).message}
        </p>
      ) : (
        <pre
          data-testid="herdr-pane-content"
          className="m-4 mt-2 min-h-0 flex-1 overflow-auto rounded bg-sunken p-3 font-mono text-[11px] leading-snug text-ink-secondary"
        >
          {data?.text?.trimEnd() || 'This pane has nothing to show right now.'}
        </pre>
      )}

      {data?.truncated && (
        <p className="shrink-0 px-4 pb-3 text-[11px] text-ink-tertiary">
          herdr had more than it sent; this is the tail.
        </p>
      )}

      {pane.socketPath && (
        <div className="shrink-0 border-t border-border-soft px-4 py-2">
          {sendError && (
            <p data-testid="herdr-send-error" className="mb-1 text-[11px] text-amber-600 dark:text-amber-400">
              {sendError}
            </p>
          )}
          <div className="flex items-center gap-2">
            <input
              data-testid="herdr-input"
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(draft, true); }
              }}
              placeholder={`Type into ${pane.agentId}…`}
              disabled={sending}
              className="min-w-0 flex-1 rounded border border-border-soft bg-sunken px-2 py-1 font-mono text-[11px] text-ink placeholder:text-ink-tertiary"
            />
            <button
              type="button"
              data-testid="herdr-send"
              onClick={() => void send(draft, true)}
              disabled={sending || !draft}
              className="shrink-0 rounded bg-brand px-3 py-1 text-[11px] font-semibold text-white disabled:opacity-50"
            >
              {sending ? 'Sending…' : 'Send'}
            </button>
            <button
              type="button"
              data-testid="herdr-type"
              onClick={() => void send(draft, false)}
              disabled={sending || !draft}
              title="Type it without pressing Enter"
              className="shrink-0 rounded border border-border-soft px-2 py-1 text-[11px] text-ink-secondary disabled:opacity-50"
            >
              Type
            </button>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {/* One tap each. A blocked agent is usually one of these away. */}
            {QUICK_KEYS.map(k => (
              <button
                key={k}
                type="button"
                data-testid={`herdr-key-${k}`}
                onClick={() => void tap(k)}
                disabled={sending}
                className="rounded border border-border-soft px-1.5 py-0.5 font-mono text-[10px] text-ink-tertiary transition-colors hover:text-ink disabled:opacity-50"
              >
                {k}
              </button>
            ))}
            <span className="ml-1 text-[10px] text-ink-tertiary">
              Enter sends · Shift+Enter types without sending
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
