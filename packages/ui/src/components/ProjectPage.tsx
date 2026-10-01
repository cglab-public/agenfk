import React from 'react';
import { Check, ChevronDown, Folder, LayoutGrid, List, ListFilter, Play, Settings2, Sparkles, Terminal as TerminalIcon } from 'lucide-react';
import { createPortal } from 'react-dom';
import { OrgFlowPicker } from './OrgFlowPicker';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import type { AgEnFKItem, Project } from '../types';
import { ItemTypeSquare } from './ItemTypeSquare';
import { Switch } from './ui/switch';
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
 * is the door-with-no-room this product has already drawn three times; Pull
 * requests arrives when it has content of its own.
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
   * What is already working on each card, and therefore what its button means.
   *
   * THREE SITUATIONS, where the button had two. The work can be in a terminal
   * this app owns, in a conversation this app owns — a subagent's run whose
   * session is one of ours — or somewhere else entirely: another machine,
   * another client, a pane this app never opened. Only the last of those is
   * "nothing here is on it", and only it may offer to start.
   *
   * `ours` means this app can take you to it. `elsewhere` means an agent is on
   * the card and we are not hosting it, so offering Start would open a SECOND
   * agent in the same worktree.
   */
  readonly working?: Readonly<Record<string, 'ours' | 'elsewhere'>>;
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
  /** Show what an agent we do not host is doing: its run, read-only. */
  readonly onShowRuns?: (item: AgEnFKItem) => void;
  /**
   * The project's active flow, for the state filter.
   *
   * The states are NOT a fixed list. This project may run the TDD flow —
   * DISCOVERY, CREATE_UNIT_TESTS, REFACTOR — where another runs the default,
   * and offering a hard-coded set would name states this project does not have
   * while hiding the ones it does. Absent means "only the types can filter",
   * which is honest rather than a guess.
   */
  readonly flow?: { steps: readonly { name: string; order: number; isSpecial?: boolean }[] } | null;
  readonly onOpenBoard?: (projectId: string) => void;
  readonly onOpenCard?: (item: AgEnFKItem) => void;
  readonly onAsk?: (projectId: string) => void;
  /**
   * Open an ordinary terminal on this project, with no card.
   *
   * The second way to start work, and the one that needs no screen at all: the
   * agent runs in the checkout and writes the card itself with the CLI. The
   * proposal panel is the other — it shows you the tree before anything is
   * written. Neither replaces the other (artifact aca414c7 §05).
   */
  readonly onOpenTerminal?: () => void;
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

/**
 * Where a value came from, in a sentence.
 *
 * The screen used to print the model's own slug — SET HERE, CLI ONLY,
 * MAIN ONLY — which is vocabulary, not language. Worse, the only one that read
 * like an invitation ("set here") sat on rows where nothing could be pressed.
 * These say the same facts as sentences, and the ACTION is a control beside
 * them rather than a word pretending to be one.
 */
const ORIGIN_TEXT: Record<string, string> = {
  'from-file': 'Declared by the repository.',
  'set-here': 'Chosen for this project.',
  inherited: 'Inherited — this project has not chosen one.',
  inferred: 'Guessed from the project, not set by anyone.',
  'cli-only': 'Only the CLI can set this.',
  'main-only': 'Only the desktop app can set this.',
};

/**
 * Whether a row's value reads as ON. Core writes 'On'/'Off'; this page compared
 * against 'on', so the switch drew every project as off and every press sent
 * `true` - it could never turn anything off.
 */
const isOn = (value: string | null): boolean => value?.toLowerCase() === 'on';

/** The one row this page writes, unless the repository's file decided it. */
const hasSwitch = (row: { key: string; origin: string }): boolean =>
  row.key === 'autoWorktree' && row.origin !== 'from-file';

/**
 * One filter control, as a menu.
 *
 * Portalled for the same reason the project and agent pickers are: absolutely
 * positioned inside the list it filters, it is clipped by the first scrolling
 * ancestor — which here is the list itself. And dismissed the way they are,
 * with the menu counted as inside: a press on an option must not unmount the
 * option before the click reaches it.
 */
function FilterMenu(
  { testId, label, value, options, onChange }: {
    testId: string;
    label: string;
    value: string;
    options: readonly { value: string; label: string }[];
    onChange: (next: string) => void;
  },
) {
  const [open, setOpen] = React.useState(false);
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const listRef = React.useRef<HTMLUListElement>(null);
  const [anchor, setAnchor] = React.useState<{ top: number; left: number } | null>(null);

  React.useEffect(() => {
    if (!open) return;
    const place = (): void => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (rect) setAnchor({ top: rect.bottom + 6, left: rect.left });
    };
    place();
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node;
      if (buttonRef.current?.contains(target) || listRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const chosen = options.find(o => o.value === value);
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-testid={testId}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold ${
          value
            ? 'border-border-brand bg-chip text-accent-text'
            : 'border-border-soft bg-canvas text-ink-secondary hover:text-ink'
        }`}
      >
        <ListFilter size={12} />
        {chosen ? chosen.label : label}
        <ChevronDown size={12} className="text-ink-tertiary" />
      </button>
      {open && anchor && createPortal(
        <ul
          ref={listRef}
          role="listbox"
          aria-label={label}
          style={{ position: 'fixed', top: anchor.top, left: anchor.left, minWidth: 200 }}
          className="z-[60] max-h-[20rem] overflow-y-auto rounded-xl border border-border-soft bg-surface py-1 shadow-2xl"
        >
          {options.map(o => (
            <li key={o.value || 'all'}>
              <button
                type="button"
                role="option"
                aria-selected={o.value === value}
                data-testid={`${testId}-${o.value || 'all'}`}
                onClick={() => { onChange(o.value); setOpen(false); }}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs ${
                  o.value === value ? 'bg-chip text-ink' : 'text-ink-secondary hover:bg-chip hover:text-ink'
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.value === value && <Check size={13} className="shrink-0 text-accent-text" />}
              </button>
            </li>
          ))}
        </ul>,
        document.body,
      )}
    </>
  );
}

export function ProjectPage({
  project, cards, runningAgents = 0, working = {}, onOpenBoard, onOpenCard, onAsk,
  onStartAgent, onShowRuns, onOpenTerminal, flow,
}: ProjectPageProps) {
  const [tab, setTab] = React.useState<'cards' | 'settings'>('cards');
  const [changingFlow, setChangingFlow] = React.useState(false);
  const [togglingWorktree, setTogglingWorktree] = React.useState(false);
  const [approvingCommand, setApprovingCommand] = React.useState(false);
  const [approveError, setApproveError] = React.useState<string | null>(null);
  const [typeFilter, setTypeFilter] = React.useState<string>('');
  const [statusFilter, setStatusFilter] = React.useState<string>('');
  const filtering = Boolean(typeFilter || statusFilter);

  /*
   * ANCHORS INCLUDED, unlike the board.
   *
   * The board hides `isSpecial` steps as columns because TODO and DONE are
   * where work waits rather than happens. Filtering is the opposite case: on a
   * project with 135 cards most of them ARE in those two, and a state filter
   * that cannot name them is a filter for the small half.
   */
  const statuses = React.useMemo(
    () => [...(flow?.steps ?? [])].sort((a, b) => a.order - b.order).map(s => s.name),
    [flow],
  );

  const shown = React.useMemo(
    () => cards.filter(c =>
      (!typeFilter || String(c.type) === typeFilter)
      && (!statusFilter || String(c.status) === statusFilter)),
    [cards, typeFilter, statusFilter],
  );
  const byId = React.useMemo(() => new Map(cards.map(c => [c.id, c])), [cards]);
  const root = project.projectRoot;

  // Asked for only when the tab is opened: most visits are about the cards,
  // and this answer walks the flow and the filesystem defaults to build itself.
  const { data: settings, refetch: refetchSettings } = useQuery({
    queryKey: ['project-settings', project.id],
    queryFn: () => api.projectSettings(project.id),
    enabled: tab === 'settings',
  });
  /** The repository's command on this row, when a person here has not approved it yet. */
  const pendingApproval = (row: { key: string; origin: string }) =>
    row.origin === 'from-file' ? settings?.fileCommands?.find(c => c.key === row.key && !c.approved) : undefined;

  /*
   * How many of how many, once a filter is on. "135 cards" over a list of
   * three is the same lie the old "in flight" count told, in the other
   * direction — one number describing a different set than the rows under it.
   */
  const count = filtering
    ? `${shown.length} of ${cards.length} ${cards.length === 1 ? 'card' : 'cards'}`
    : `${cards.length} ${cards.length === 1 ? 'card' : 'cards'}`;

  const summary = [
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
          <>
          {settings?.fileProblems?.length ? (
            /* What the file ASKED FOR and could not have. A hand-edited key
               that does nothing has to say so, or somebody spends an afternoon
               on it. */
            <ul data-testid="setting-file-problems" className="mb-3 flex flex-col gap-1 rounded-xl border border-border-soft bg-canvas px-4 py-3">
              {settings.fileProblems.map(problem => (
                <li key={problem} className="text-[11px] text-ink-tertiary">{problem}</li>
              ))}
            </ul>
          ) : null}
          <ul data-testid="project-settings" className="flex flex-col">
            {(settings?.rows ?? []).map(row => (
              <li key={row.key} data-testid={`setting-${row.key}`} className="border-b border-border-soft py-4 last:border-b-0">
                <div className="flex items-center gap-2.5">
                  <span className="text-sm font-semibold text-ink">{row.label}</span>
                  <span className="flex-1" />
                  {/*
                   * THE ACTION, where the badge used to promise one. Only for
                   * the rows this screen may actually write: the others keep
                   * their value and their command, because hiding what cannot
                   * be edited here is how a wrong project root stayed
                   * invisible in four projects.
                   */}
                  {row.key === 'flow' && row.origin !== 'from-file' && (
                    <button
                      type="button"
                      data-testid="setting-change-flow"
                      onClick={() => setChangingFlow(true)}
                      className="shrink-0 rounded-lg border border-border-soft bg-canvas px-2.5 py-1 text-[11px] font-semibold text-ink"
                    >
                      Change…
                    </button>
                  )}
                  {/*
                    * NOT OFFERED when the repository declared it. The next read
                    * of the file puts the value back, so a control here would
                    * lose silently — which is worse than no control. The row
                    * still shows the value and says where it came from.
                    */}
                  {hasSwitch(row) && (
                    <Switch
                      data-testid="setting-toggle-autoWorktree"
                      aria-label={row.label}
                      checked={isOn(row.value)}
                      disabled={togglingWorktree}
                      onCheckedChange={async next => {
                        setTogglingWorktree(true);
                        try {
                          await api.updateProject(project.id, { autoWorktree: next });
                          await refetchSettings();
                        } finally {
                          setTogglingWorktree(false);
                        }
                      }}
                    />
                  )}
                  {/*
                    * A command the repository asks this machine to run, not yet
                    * approved: the approval is a person's, so it lives here and
                    * nowhere an agent can reach (34ee6b8a). What is approved is
                    * exactly the text shown in full under it.
                    */}
                  {(() => {
                    const pending = pendingApproval(row);
                    if (!pending) return null;
                    return (
                      <button
                        type="button"
                        data-testid={`setting-approve-${row.key}`}
                        disabled={approvingCommand}
                        title="Let this machine run the command the repository declares"
                        onClick={async () => {
                          setApprovingCommand(true);
                          setApproveError(null);
                          try {
                            await api.approveFileCommand(project.id, pending.command);
                            await refetchSettings();
                          } catch (e) {
                            // Said on screen: a refusal (another origin, a rate limit) must not look like nothing happened.
                            const detail = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
                            setApproveError(detail ?? (e instanceof Error ? e.message : 'The approval failed.'));
                          } finally {
                            setApprovingCommand(false);
                          }
                        }}
                        className="shrink-0 rounded-lg border border-border-brand bg-brand px-2.5 py-1 text-[11px] font-semibold text-navy disabled:opacity-50"
                      >
                        Approve
                      </button>
                    );
                  })()}
                </div>
                <p className="mt-1 text-xs text-ink-tertiary">{row.description}</p>
                {/* The switch IS the value where there is one; the text repeated under it read as the control. */}
                {!hasSwitch(row) && (() => {
                  /*
                   * In FULL while it waits for approval: truncated, a harmless
                   * prefix could hide the rest of the line, or a second line,
                   * from the person approving it (review of 34ee6b8a).
                   */
                  const pending = pendingApproval(row);
                  return (
                    <p data-testid={`setting-value-${row.key}`} className={`mt-2 rounded-lg border px-3 py-2 font-mono text-[11px] ${
                      pending ? 'whitespace-pre-wrap break-all' : 'truncate'
                    } ${
                      row.value
                        ? 'border-border-soft bg-canvas text-ink-secondary'
                        : 'border-dashed border-border-soft text-ink-tertiary'
                    }`}>
                      {pending ? pending.command : row.value ?? 'not set'}
                    </p>
                  );
                })()}
                {approveError && pendingApproval(row) && (
                  <p data-testid={`setting-approve-error-${row.key}`} className="mt-1.5 text-[11px] text-danger-text">
                    {approveError}
                  </p>
                )}
                {row.warning && (
                  <p data-testid={`setting-warning-${row.key}`} className="mt-1.5 text-[11px] text-danger-text">
                    {row.warning}
                  </p>
                )}
                <p data-testid={`setting-origin-${row.key}`} className="mt-1.5 text-[11px] text-ink-tertiary">
                  {row.from}
                  {ORIGIN_TEXT[row.origin] && row.from !== ORIGIN_TEXT[row.origin]
                    ? ` ${ORIGIN_TEXT[row.origin]}`
                    : ''}
                </p>
                {row.how && (
                  <p data-testid={`setting-how-${row.key}`} className="mt-1 font-mono text-[11px] text-ink-tertiary">
                    {row.how}
                  </p>
                )}
              </li>
            ))}
          </ul>
          </>
        ) : (
          <>
            {/* Only when there is something to filter: a control that can only
                produce the empty list it is already showing is noise. */}
            {cards.length > 0 && (
              <div data-testid="project-filters" className="flex items-center gap-2">
                <FilterMenu
                  testId="project-filter-type"
                  label="Type"
                  value={typeFilter}
                  onChange={setTypeFilter}
                  options={[
                    { value: '', label: 'All types' },
                    ...Object.values(ItemType).map(t => ({ value: String(t), label: String(t) })),
                  ]}
                />
                {statuses.length > 0 && (
                  <FilterMenu
                    testId="project-filter-status"
                    label="State"
                    value={statusFilter}
                    onChange={setStatusFilter}
                    options={[
                      { value: '', label: 'All states' },
                      ...statuses.map(name => ({ value: name, label: name })),
                    ]}
                  />
                )}
              </div>
            )}
            {cards.length === 0 ? (
          /* The moment this page exists for: the two doors, and nothing else
             to read instead of deciding. */
          <div data-testid="project-page-empty" className="rounded-xl border border-dashed border-border-soft px-5 py-10 text-center">
            <p className="text-sm font-semibold text-ink">No cards yet.</p>
            <p className="mx-auto mt-1 max-w-[46ch] text-xs text-ink-tertiary">
              Describe what you are trying to do, and review the proposed decomposition before
              anything is created.
            </p>
          </div>
        ) : shown.length === 0 ? (
          /* A DIFFERENT SENTENCE from "no cards yet": there are cards, and the
             filter is what emptied the list. Saying the project is empty when
             135 rows are one click away sends people looking for the bug. */
          <div data-testid="project-page-no-match" className="rounded-xl border border-dashed border-border-soft px-5 py-10 text-center">
            <p className="text-sm font-semibold text-ink">No card matches this filter.</p>
            <button
              type="button"
              data-testid="project-filter-clear"
              onClick={() => { setTypeFilter(''); setStatusFilter(''); }}
              className="mt-2 text-xs font-semibold text-accent-text underline underline-offset-2"
            >
              Clear the filter
            </button>
          </div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {shown.map(card => {
              const on = working[card.id];
              return (
              /*
               * FLAT WHILE FILTERED. The indent means "child of the row above";
               * with the ancestors filtered out it would draw a child of
               * nothing, which is a worse answer than a flat list.
               */
              <li key={card.id} className="flex items-center gap-1.5" style={{ marginLeft: `${filtering ? 0 : depthOf(card, byId) * 18}px` }}>
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
                    aria-label={
                      on === 'ours' ? `Open the agent working on ${card.title}`
                        : on === 'elsewhere' ? `See the run working on ${card.title}`
                          : `Start an agent on ${card.title}`
                    }
                    title={
                      on === 'ours' ? 'Open the agent working on this card'
                        : on === 'elsewhere' ? 'An agent is already working on this card, elsewhere'
                          : 'Start an agent on this card'
                    }
                    onClick={() => {
                      // Never a spawn while something is already on the card:
                      // that is a second agent in the same worktree.
                      if (on === 'elsewhere') onShowRuns?.(card);
                      else onStartAgent(card);
                    }}
                    className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-2 text-[11px] font-semibold ${
                      on
                        ? 'border-border-brand bg-chip text-accent-text'
                        : 'border-border-soft bg-canvas text-ink-secondary hover:text-ink'
                    }`}
                  >
                    {on
                      ? <span data-testid={`project-card-live-${card.id}`} className="h-1.5 w-1.5 rounded-full bg-brand" />
                      : <Play size={12} />}
                    {on === 'ours' ? 'Open' : on === 'elsewhere' ? 'Running' : 'Start'}
                  </button>
                )}
              </li>
              );
            })}
          </ul>
            )}
          </>
        )}
      </div>

      {/* The flow picker this row is about. Mounted only while it is open:
          it has its own queries, and this page is not the place to hold them. */}
      {changingFlow && (
        <OrgFlowPicker
          open
          projectId={project.id}
          onClose={() => { setChangingFlow(false); void refetchSettings(); }}
        />
      )}

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
        {onOpenTerminal && (
          /*
           * THE OTHER WAY IN, and deliberately the quieter one.
           *
           * "New task" proposes and shows you the tree before anything is
           * written; this opens an ordinary terminal on the project and lets
           * the agent write the card itself with the CLI. Same room, different
           * doors — one for the person who wants to review first, one for the
           * person who already knows and would rather just talk to the agent.
           */
          <button
            type="button"
            data-testid="project-page-terminal"
            onClick={onOpenTerminal}
            /* `bg-surface`, not `bg-canvas`: the footer IS canvas, so the
               button dissolved into it and read as transparent. */
            className="flex items-center gap-2 rounded-lg border border-border-soft bg-surface px-3 py-1.5 text-xs font-semibold text-ink-secondary hover:text-ink"
          >
            <TerminalIcon size={14} /> Open a terminal
          </button>
        )}
        <span className="flex-1" />
        {/* Information, not a third button competing with the two doors. */}
        <span data-testid="project-page-summary" className="truncate text-[11px] text-ink-tertiary">
          <span data-testid="project-page-count">{count}</span>
          {summary ? ` · ${summary}` : ''}
        </span>
      </footer>
    </div>
  );
}
