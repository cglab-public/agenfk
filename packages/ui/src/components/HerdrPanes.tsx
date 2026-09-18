/**
 * The herdr panes, on screen (96953f6a / CGLAB-266).
 *
 * Work that is already running — the developer's own and AgEnFK's — in one list
 * a person can scan. It exists because that work was invisible here: on the
 * machine this was written for, twenty-four panes and eighteen agents that no
 * screen in this product could show.
 *
 * IT IS A PHOTOGRAPH, NOT A TERMINAL, and the copy says so. Nothing here
 * streams; opening a pane fetches what the mirror holds right now. collie, which
 * solved this first, puts the same warning on its own page — a surface that
 * looks like a terminal and does not advance is worse than one that admits it.
 *
 * EXTERNAL IS AN ANSWER. Most panes belong to nobody here, and the row says so
 * rather than leaving a blank cell: blank reads as missing data.
 */
import React from 'react';
import { clsx } from 'clsx';
import { useQuery } from '@tanstack/react-query';
import { API_URL } from '../apiUrl';
import { paneRows, groupPanes, type RawPane } from '../herdrPaneRows';

interface PaneOwner {
  readonly kind: 'card' | 'project' | 'external';
  readonly cardId?: string;
  readonly title?: string;
  readonly status?: string;
  readonly branchName?: string;
  readonly projectName?: string;
}

interface SessionView {
  readonly name: string;
  readonly socketPath: string;
  readonly reachable: boolean;
  readonly panes: readonly (RawPane & { owner?: PaneOwner })[];
}

interface HerdrBody {
  readonly available: boolean;
  readonly reason: string;
  readonly sessions: readonly SessionView[];
}

/** Which session a pane came from, so its content can be asked for. */
function socketOf(body: HerdrBody | undefined, paneId: string): string {
  for (const s of body?.sessions ?? []) {
    if (s.panes.some(p => p.pane_id === paneId)) return s.socketPath;
  }
  return '';
}

function ownerCell(owner: PaneOwner | undefined, paneId: string): React.ReactElement {
  const kind = owner?.kind ?? 'external';
  if (kind === 'card') {
    return (
      <span data-testid={`herdr-owner-${paneId}`} className="text-ink-secondary">
        {owner?.title}
        <span className="text-ink-tertiary"> · {owner?.status}</span>
        {owner?.branchName && <span className="text-ink-tertiary"> · {owner.branchName}</span>}
      </span>
    );
  }
  if (kind === 'project') {
    return (
      <span data-testid={`herdr-owner-${paneId}`} className="text-ink-tertiary">
        project {owner?.projectName}
      </span>
    );
  }
  // Not ours, and said out loud. A blank cell would read as data we failed to
  // fetch rather than as the answer.
  return (
    <span data-testid={`herdr-owner-${paneId}`} className="text-ink-tertiary">
      external
    </span>
  );
}

export function HerdrPanes(): React.ReactElement {
  const [open, setOpen] = React.useState<string | null>(null);

  const { data, isLoading, isError } = useQuery<HerdrBody>({
    queryKey: ['herdr-panes'],
    queryFn: async () => {
      const r = await fetch(`${API_URL}/herdr/sessions`);
      if (!r.ok) throw new Error(`herdr sessions: ${r.status}`);
      const body = await r.json();
      // A 200 of the wrong shape would throw inside the render below, and there
      // is no ErrorBoundary in this package - it would take the dashboard down
      // rather than this panel.
      if (!body || !Array.isArray(body.sessions)) throw new Error('herdr sessions: unexpected shape');
      return body;
    },
    staleTime: 10_000,
  });

  const socket = open ? socketOf(data, open) : '';
  const { data: content, isLoading: loadingContent } = useQuery<{ text: string; truncated: boolean }>({
    queryKey: ['herdr-content', open, socket],
    // NOTHING IS READ UNTIL SOMEBODY OPENS ONE. Dragging every pane's text into
    // a listing is a different amount of data and a different decision.
    enabled: Boolean(open && socket),
    queryFn: async () => {
      const r = await fetch(
        `${API_URL}/herdr/panes/${encodeURIComponent(open ?? '')}/content`
        + `?socket=${encodeURIComponent(socket)}&lines=200&source=recent`,
      );
      if (!r.ok) throw new Error(`pane content: ${r.status}`);
      return r.json();
    },
  });

  if (isLoading) return <p className="p-4 text-[13px] text-ink-tertiary">Looking for herdr…</p>;
  if (isError) return <p className="p-4 text-[13px] text-ink-tertiary">Could not ask the server for herdr sessions.</p>;

  const panes = (data?.sessions ?? []).filter(s => s.reachable).flatMap(s => s.panes);
  const ownerById = new Map(panes.map(p => [p.pane_id, p.owner]));
  const groups = groupPanes(paneRows(panes));

  if (groups.length === 0) {
    return (
      <p data-testid="herdr-empty" className="p-4 text-[13px] text-ink-tertiary">
        {data?.reason ?? 'No herdr sessions found.'} Nothing to show here while herdr is not running.
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
      <p className="text-[12px] text-ink-tertiary">
        Agents already running in herdr. This is a mirror, not a terminal — it shows what the pane
        held when it was read.
      </p>

      {groups.map(group => (
        <section key={group.path || group.dir} data-testid={`herdr-group-${group.path || group.dir}`}>
          <h4 className="mb-1 flex items-baseline gap-2 text-[13px] font-medium text-ink">
            {group.dir}
            <span className="text-[11px] text-ink-tertiary">
              {group.panes.length} pane{group.panes.length === 1 ? '' : 's'}
            </span>
            {group.needsAPerson > 0 && (
              <span
                data-testid="herdr-needs-person"
                className="text-[11px] text-amber-600 dark:text-amber-400"
              >
                {group.needsAPerson} waiting on a person
              </span>
            )}
          </h4>

          <ul className="flex flex-col gap-px">
            {group.panes.map(row => (
              <li key={row.paneId}>
                <button
                  type="button"
                  data-testid={`herdr-pane-${row.paneId}`}
                  onClick={() => setOpen(o => (o === row.paneId ? null : row.paneId))}
                  className={clsx(
                    'flex w-full items-baseline gap-2 rounded px-2 py-1 text-left text-[12px]',
                    'hover:bg-nav-surface focus-visible:outline focus-visible:outline-1',
                    open === row.paneId && 'bg-nav-surface',
                  )}
                >
                  <span className="w-14 shrink-0 font-mono text-[11px] text-ink-tertiary">{row.agent}</span>
                  <span
                    className={clsx(
                      'w-16 shrink-0 text-[11px]',
                      row.needsAPerson ? 'text-amber-600 dark:text-amber-400' : 'text-ink-tertiary',
                    )}
                  >
                    {row.status}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-ink-secondary">{row.title}</span>
                  {ownerCell(ownerById.get(row.paneId), row.paneId)}
                </button>

                {open === row.paneId && (
                  <pre
                    data-testid={`herdr-content-${row.paneId}`}
                    className="mx-2 mb-2 max-h-72 overflow-auto rounded bg-sunken p-2 font-mono text-[11px] leading-snug text-ink-secondary"
                  >
                    {loadingContent ? 'Reading…' : (content?.text ?? 'Nothing to read in this pane.')}
                  </pre>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
