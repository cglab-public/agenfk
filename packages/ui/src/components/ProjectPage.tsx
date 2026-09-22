import React from 'react';
import { Folder, LayoutGrid, List, Play, Settings2, Sparkles } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import type { AgEnFKItem, Project } from '../types';
import { ItemTypeSquare } from './ItemTypeSquare';
import { ItemType } from '../types';

/**
 * Where you land after a project is created, and where you go to see what it
 * is doing.
 *
 * A project that was just added has nothing in it, and dropping somebody onto
 * an empty board answers none of the questions they arrived with. This page
 * answers three: what the project HAS, the two ways to add to it, and where the
 * board is.
 *
 * THE BOARD IS NOT DRAWN HERE. AgEnFK already has a Kanban whose columns come
 * from the project's flow; a second list of the same cards would be a second
 * place to look for one truth. What this page owes is the way in — and that
 * lives in the HEADER rather than in a footer, because the header survives
 * whichever tab the page grows next. A control that exists on one screen of
 * four is the defect this design went through three rounds to remove.
 *
 * TWO TABS, and only two. A tab bar whose other tabs have nothing behind them
 * is the door-with-no-room this product has already drawn three times; Agents
 * and Pull requests arrive when each has content of its own.
 */
export interface ProjectPageProps {
  readonly project: Project;
  /**
   * THE PROJECT'S CARDS — all of them, not only the ones in flight.
   *
   * This used to be handed the "which card?" picker's list, which the server
   * builds by EXCLUDING the anchors: a project whose cards were all still in
   * TODO — every project whose cards had just been created — read as empty
   * while the board beside it listed them.
   */
  readonly cards: readonly AgEnFKItem[];
  /** How many agent sessions are running in this project right now. */
  readonly runningAgents?: number;
  /**
   * Which of these cards already have a session, so a row can say OPEN rather
   * than START. Spawning a second agent in the same worktree is possible from
   * the tab bar, and is not what pressing a card's own button means.
   */
  readonly runningItemIds?: readonly string[];
  /**
   * Start work on this card — the press that this page did not have.
   *
   * The page listed the work and could do nothing with it: opening a terminal
   * meant going to the board and finding the card again. The caller decides
   * between resuming a session and asking WHICH AGENT; both are its job, and
   * both are already implemented there.
   *
   * A press, deliberately. Creating cards spawns nothing — "agents STARTING"
   * is neither cheap nor reversible (artifact aca414c7 §06) — so this moves
   * where the button is, not whether there is one.
   */
  readonly onStartAgent?: (item: AgEnFKItem) => void;
  readonly onOpenBoard?: (projectId: string) => void;
  readonly onOpenCard?: (item: AgEnFKItem) => void;
  readonly onAsk?: (projectId: string) => void;
  /** Write a card by hand — the fallback the panel offers from inside. */
  readonly onNewCard?: (projectId: string) => void;
}

/**
 * How deep a card sits, by walking up its parents within this list.
 *
 * Bounded by the list length rather than by trust: `parentId` comes from the
 * database and a cycle there would hang the render. Capped at four because
 * nothing indents usefully past that.
 */
function depthOf(item: AgEnFKItem, byId: Map<string, AgEnFKItem>): number {
  let depth = 0;
  let cursor: AgEnFKItem | undefined = item;
  const seen = new Set<string>();
  while (cursor?.parentId && !seen.has(cursor.id) && depth < 4) {
    seen.add(cursor.id);
    cursor = byId.get(cursor.parentId);
    if (cursor) depth++;
  }
  return depth;
}

export function ProjectPage({
  project, cards, runningAgents = 0, runningItemIds = [], onOpenBoard, onOpenCard, onAsk,
  onNewCard, onStartAgent,
}: ProjectPageProps) {
  const [tab, setTab] = React.useState<'cards' | 'settings'>('cards');
  const byId = React.useMemo(() => new Map(cards.map(c => [c.id, c])), [cards]);
  const root = project.projectRoot;

  // Asked for only when the tab is opened: most visits are about the cards,
  // and this answer walks the flow and the filesystem defaults to build itself.
  const { data: settings } = useQuery({
    queryKey: ['project-settings', project.id],
    queryFn: () => api.projectSettings(project.id),
    enabled: tab === 'settings',
  });

  const summary = [
    /*
     * The count says what the list IS. It said "in flight" while showing every
     * card, which is the same mismatch that made this page look empty — one
     * number describing a different set than the rows under it.
     */
    `${cards.length} ${cards.length === 1 ? 'card' : 'cards'}`,
    // Omitted rather than shown as zero: "0 agents running" is a fact nobody
    // needs, competing for the same line as one that matters.
    runningAgents > 0 ? `${runningAgents} ${runningAgents === 1 ? 'agent' : 'agents'} running` : null,
  ].filter(Boolean).join(' · ');

  return (
    <div data-testid="project-page" className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-3 px-5 py-4">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-border-soft bg-canvas text-ink-tertiary">
          <Folder size={17} />
        </span>
        <span data-testid="project-page-name" className="truncate text-lg font-bold tracking-tight text-ink">
          {project.name}
        </span>
        <span
          data-testid="project-page-root"
          /* The folder, on the page. A project with no checkout cannot host an
             agent, and this is where that becomes visible — rather than at the
             moment a run fails with nowhere to start. */
          className={`min-w-0 flex-1 truncate font-mono text-[11px] ${root ? 'text-ink-tertiary' : 'text-danger-text'}`}
          title={root ?? undefined}
        >
          {root ?? 'no folder yet — an agent has nowhere to run'}
        </span>
        <button
          type="button"
          data-testid="project-page-board"
          onClick={() => onOpenBoard?.(project.id)}
          className="flex shrink-0 items-center gap-2 rounded-lg bg-brand px-3 py-1.5 text-xs font-bold text-navy"
        >
          <LayoutGrid size={14} /> View board
        </button>
      </header>

      <nav className="flex gap-2 px-5 pb-3" aria-label="Project sections">
        {([['cards', 'Cards', List], ['settings', 'Settings', Settings2]] as const).map(([id, label, Icon]) => (
          <button
            key={id}
            type="button"
            data-testid={`project-tab-${id}`}
            aria-current={tab === id ? 'page' : undefined}
            onClick={() => setTab(id)}
            className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs ${
              tab === id
                ? 'border-border-soft bg-surface font-semibold text-ink'
                : 'border-transparent text-ink-tertiary hover:text-ink'
            }`}
          >
            <Icon size={14} /> {label}
          </button>
        ))}
      </nav>

      <div className="min-h-0 flex-1 overflow-auto scrollbar-slim px-5 pb-4">
        {tab === 'settings' ? (
          <ul data-testid="project-settings" className="flex flex-col">
            {(settings?.rows ?? []).map(row => (
              <li key={row.key} data-testid={`setting-${row.key}`} className="border-b border-border-soft py-4 last:border-b-0">
                <div className="flex items-center gap-2.5">
                  <span className="text-sm font-semibold text-ink">{row.label}</span>
                  {/* The badge says whether this screen may change the value —
                      and when it may not, the row still shows the value,
                      because that is the part worth seeing. */}
                  <span
                    data-testid={`setting-origin-${row.key}`}
                    className={`rounded-full border px-2 py-0.5 font-mono text-[9.5px] uppercase tracking-wider ${
                      row.origin === 'set-here'
                        ? 'border-border-brand bg-chip text-accent-text'
                        : row.origin === 'cli-only' || row.origin === 'main-only'
                          ? 'border-border-soft text-danger-text'
                          : 'border-border-soft text-ink-tertiary'
                    }`}
                  >
                    {row.origin.replace('-', ' ')}
                  </span>
                </div>
                <p className="mt-1 text-xs text-ink-tertiary">{row.description}</p>
                <p className={`mt-2 truncate rounded-lg border px-3 py-2 font-mono text-[11px] ${
                  row.value
                    ? 'border-border-soft bg-canvas text-ink-secondary'
                    : 'border-dashed border-border-soft text-ink-tertiary'
                }`}>
                  {row.value ?? 'not set'}
                </p>
                {row.warning && (
                  <p data-testid={`setting-warning-${row.key}`} className="mt-1.5 text-[11px] text-danger-text">
                    {row.warning}
                  </p>
                )}
                <p className="mt-1.5 text-[11px] text-ink-tertiary">{row.from}</p>
                {row.how && (
                  <p data-testid={`setting-how-${row.key}`} className="mt-1 font-mono text-[11px] text-ink-tertiary">
                    {row.how}
                  </p>
                )}
              </li>
            ))}
          </ul>
        ) : cards.length === 0 ? (
          /* The moment this page exists for: the two doors, and nothing else
             to read instead of deciding. */
          <div data-testid="project-page-empty" className="rounded-xl border border-dashed border-border-soft px-5 py-10 text-center">
            <p className="text-sm font-semibold text-ink">No cards yet.</p>
            <p className="mx-auto mt-1 max-w-[46ch] text-xs text-ink-tertiary">
              Describe what you are trying to do, and review the proposed decomposition before
              anything is created.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {cards.map(card => {
              const live = runningItemIds.includes(card.id);
              return (
              <li key={card.id} className="flex items-center gap-1.5" style={{ marginLeft: `${depthOf(card, byId) * 18}px` }}>
                <button
                  type="button"
                  data-testid={`project-card-${card.id}`}
                  onClick={() => onOpenCard?.(card)}
                  className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg border border-border-soft bg-canvas px-2.5 py-2 text-left hover:bg-chip"
                >
                  <ItemTypeSquare type={card.type as ItemType} size="sm" testId={`project-card-type-${card.id}`} />
                  <span className="min-w-0 flex-1 truncate text-xs text-ink">{card.title}</span>
                  <span className="shrink-0 font-mono text-[10px] tracking-wide text-ink-tertiary">
                    {String(card.status)}
                  </span>
                </button>
                {onStartAgent && (
                  /* The press this page was missing. Named by what it will do
                     to THIS card, because a row of identical play buttons is
                     the control people click by accident. */
                  <button
                    type="button"
                    data-testid={`project-card-start-${card.id}`}
                    aria-label={live
                      ? `Open the running terminal for ${card.title}`
                      : `Start an agent on ${card.title}`}
                    title={live ? 'Open the running terminal' : 'Start an agent on this card'}
                    onClick={() => onStartAgent(card)}
                    className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-2 text-[11px] font-semibold ${
                      live
                        ? 'border-border-brand bg-chip text-accent-text'
                        : 'border-border-soft bg-canvas text-ink-secondary hover:text-ink'
                    }`}
                  >
                    {live
                      ? <span data-testid={`project-card-live-${card.id}`} className="h-1.5 w-1.5 rounded-full bg-brand" />
                      : <Play size={12} />}
                    {live ? 'Open' : 'Start'}
                  </button>
                )}
              </li>
              );
            })}
          </ul>
        )}
      </div>

      <footer className="flex items-center gap-2 border-t border-border-soft bg-canvas px-5 py-3">
        {/*
          * ONE DOOR. It was two side by side — describe an objective, or write
          * the card yourself — and the first already does the second: the
          * contract tells the agent to propose ONE item when the objective is
          * a single unit of work. Two doors to the same room is a choice the
          * product was asking for and should not have.
          *
          * Writing it by hand is not gone; it moved inside, where the panel
          * already explains itself when it cannot reach an agent. That path is
          * the one that works with no agent installed, so it must survive.
          */}
        <button
          type="button"
          data-testid="project-page-ask"
          onClick={() => onAsk?.(project.id)}
          className="flex items-center gap-2 rounded-lg border border-border-brand bg-chip px-3 py-1.5 text-xs font-semibold text-accent-text"
        >
          <Sparkles size={14} /> New task
        </button>
        <span className="flex-1" />
        {/* Information, not a third button competing with the two doors. */}
        <span data-testid="project-page-summary" className="truncate text-[11px] text-ink-tertiary">
          {summary}
        </span>
      </footer>
    </div>
  );
}
