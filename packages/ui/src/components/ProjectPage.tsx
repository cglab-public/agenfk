import React from 'react';
import { Check, ChevronDown, ChevronLeft, ChevronRight, Folder, LayoutGrid, List, ListFilter, Play, RotateCcw, Search, Settings2, Sparkles, Terminal as TerminalIcon } from 'lucide-react';
import { createPortal } from 'react-dom';
import { OrgFlowPicker } from './OrgFlowPicker';
import {
  PRESETS, ago, backlogStates, finishedStates, matchesQuery, presentStates, presetStates, rowAction, selectedStates,
  type Preset, type Selection,
} from '../cardFilters';
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
  readonly flow?: { steps: readonly { name: string; order: number; isSpecial?: boolean; isAnchor?: boolean }[] } | null;
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
 * How deep a card sits, counting only the ancestors that are on screen.
 *
 * The indent means "under the row above". With an ancestor filtered out it
 * would draw a child of nothing, so a hidden parent is stepped over rather
 * than counted — which flattens a filtered list without a separate rule for
 * when a filter is on (and Open, the default, hides every finished parent).
 *
 * Bounded by a seen-set rather than by trust: `parentId` comes from the
 * database and a cycle there would hang the render. Capped at four because
 * nothing indents usefully past that.
 */
function depthOf(item: AgEnFKItem, byId: Map<string, AgEnFKItem>, shownIds: ReadonlySet<string>): number {
  let depth = 0;
  let cursor: AgEnFKItem | undefined = item;
  const seen = new Set<string>();
  while (cursor?.parentId && !seen.has(cursor.id) && depth < 4) {
    seen.add(cursor.id);
    cursor = byId.get(cursor.parentId);
    if (cursor && shownIds.has(cursor.id)) depth++;
  }
  return depth;
}

/** The colour of a state's dot: waiting, working, being reviewed, finished. */
function stateDot(state: string, finished: ReadonlySet<string>, backlog: ReadonlySet<string>): string {
  if (finished.has(state)) return 'bg-ink-tertiary opacity-40';
  if (backlog.has(state)) return 'bg-ink-tertiary';
  if (state.includes('REVIEW')) return 'bg-amber-400';
  return 'bg-brand';
}

/** What a finished card says instead of a button. */
const finishedWord = (status: string): string =>
  status === 'ARCHIVED' ? 'Archived' : status === 'TRASHED' ? 'Trashed' : 'Done';

/**
 * One filter, as a menu: a button that says what is selected, and the choices
 * behind it.
 *
 * A MENU, not a row of chips. The first version laid every state and type out
 * on the page, and on a TDD project that was two rows of controls above the
 * list they were meant to narrow.
 *
 * Portalled because, absolutely positioned inside the list it filters, it is
 * clipped by the first scrolling ancestor — the list itself. Dismissed with
 * the menu counted as inside, so a press on an option does not unmount it
 * before the click lands, and left OPEN on a tick: several ticks in a row is
 * what a multi-select is for.
 */
function FilterMenu(
  { testId, label, summary, active, open, onOpenChange, children }: {
    testId: string;
    label: string;
    summary: string;
    /** Something other than the default is selected: the button says so. */
    active: boolean;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: React.ReactNode;
  },
) {
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
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
      onOpenChange(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onOpenChange(false);
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
  }, [open, onOpenChange]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-testid={testId}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold ${
          active
            ? 'border-border-brand bg-chip text-accent-text'
            : 'border-border-soft bg-canvas text-ink-secondary hover:text-ink'
        }`}
      >
        <ListFilter size={12} />
        <span className="font-normal text-ink-tertiary">{label}</span>
        <span>{summary}</span>
        <ChevronDown size={12} className="text-ink-tertiary" />
      </button>
      {open && anchor && createPortal(
        <div
          ref={listRef}
          role="menu"
          aria-label={label}
          style={{ position: 'fixed', top: anchor.top, left: anchor.left, minWidth: 240 }}
          className="z-[60] max-h-[22rem] overflow-y-auto rounded-xl border border-border-soft bg-surface py-1 shadow-2xl"
        >
          {children}
        </div>,
        document.body,
      )}
    </>
  );
}

/** One choice in a FilterMenu: a tick (or a radio, for a preset) and its count. */
function MenuOption(
  { testId, countTestId, role, checked, onClick, count, children }: {
    testId: string;
    countTestId?: string;
    role: 'menuitemcheckbox' | 'menuitemradio';
    checked: boolean;
    onClick: () => void;
    count: number;
    children: React.ReactNode;
  },
) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={checked}
      data-testid={testId}
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs ${
        checked ? 'text-ink' : 'text-ink-secondary hover:bg-chip hover:text-ink'
      }`}
    >
      <span
        className={`grid h-3.5 w-3.5 shrink-0 place-items-center border ${role === 'menuitemradio' ? 'rounded-full' : 'rounded'} ${
          checked ? 'border-border-brand bg-brand text-navy' : 'border-border-soft'
        }`}
      >
        {checked && <Check size={10} strokeWidth={3} />}
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate">{children}</span>
      <span data-testid={countTestId} className="shrink-0 font-mono text-[10px] text-ink-tertiary">{count}</span>
    </button>
  );
}

/** Rows per page. Enough to scan, few enough that the pager is not a scroll. */
const PAGE_SIZE = 25;
const PAGER_BUTTON = 'grid h-7 w-7 place-items-center rounded-lg border border-border-soft bg-canvas text-ink-secondary hover:text-ink disabled:opacity-40 disabled:hover:text-ink-secondary';

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

/**
 * A command with every character a screen cannot show faithfully written out
 * as `⟨U+XXXX⟩` - the same set core's hiddenCharacters names, so a bidi
 * override or a zero-width space is SEEN rather than obeyed (review of
 * 34ee6b8a). Tab and newline are left as they are; a carriage return is not.
 */
const revealHidden = (text: string): string =>
  text.replace(/[\p{Cf}\p{Cc}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu, ch =>
    (ch === '\t' || ch === '\n') ? ch : `⟨U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟩`);

/** The one row this page writes, unless the repository's file decided it. */
const hasSwitch = (row: { key: string; origin: string }): boolean =>
  row.key === 'autoWorktree' && row.origin !== 'from-file';

export function ProjectPage({
  project, cards, runningAgents = 0, working = {}, onOpenBoard, onOpenCard, onAsk,
  onStartAgent, onShowRuns, onOpenTerminal, flow,
}: ProjectPageProps) {
  const [tab, setTab] = React.useState<'cards' | 'settings'>('cards');
  const [changingFlow, setChangingFlow] = React.useState(false);
  const [togglingWorktree, setTogglingWorktree] = React.useState(false);
  const [approvingCommand, setApprovingCommand] = React.useState(false);
  const [approveError, setApproveError] = React.useState<string | null>(null);
  /*
   * OPEN BY DEFAULT. The report this answers: 135 cards, most of them DONE,
   * and every finished row offering Start. Open means "not finished" on THIS
   * project's flow — whatever its exit is called.
   */
  const [selection, setSelection] = React.useState<Selection>({ preset: 'open' });
  const [types, setTypes] = React.useState<readonly string[]>([]);
  const [query, setQueryRaw] = React.useState('');
  const [menu, setMenu] = React.useState<'state' | 'type' | null>(null);
  const [page, setPage] = React.useState(0);
  // Every change to WHAT is shown starts again at its first page: page 3 of a
  // different list is a place nobody asked to go.
  const setQuery = (next: string) => { setQueryRaw(next); setPage(0); };

  const finished = React.useMemo(() => finishedStates(flow), [flow]);
  const backlog = React.useMemo(() => backlogStates(flow), [flow]);
  /*
   * ANCHORS INCLUDED, unlike the board.
   *
   * The board hides `isSpecial` steps as columns because TODO and DONE are
   * where work waits rather than happens. Filtering is the opposite case: on a
   * project with 135 cards most of them ARE in those two, and a state filter
   * that cannot name them is a filter for the small half. Only the states a
   * card is in are offered — an empty one could only empty the list — and
   * states outside the flow (PAUSED, BLOCKED) are offered too, or the cards in
   * them could not be reached.
   */
  const states = React.useMemo(() => presentStates(flow, cards), [flow, cards]);
  const chosen = React.useMemo(() => selectedStates(selection, states, flow), [selection, states, flow]);
  const typeSet = React.useMemo(() => new Set(types), [types]);

  /*
   * Every number the menus show, in one pass. Each option counts what ticking
   * it would add under the OTHER two filters — a state ignores the state
   * selection, a type the type selection — so "DONE 44" reads the same whether
   * DONE is ticked or not.
   */
  const tally = React.useMemo(() => {
    const byState = new Map<string, number>();
    const byType = new Map<string, number>();
    const shownCards: AgEnFKItem[] = [];
    for (const c of cards) {
      if (!matchesQuery(c, query)) continue;
      const state = String(c.status);
      const type = String(c.type);
      const ofType = typeSet.size === 0 || typeSet.has(type);
      if (ofType) byState.set(state, (byState.get(state) ?? 0) + 1);
      if (chosen.has(state)) {
        byType.set(type, (byType.get(type) ?? 0) + 1);
        if (ofType) shownCards.push(c);
      }
    }
    return { byState, byType, shown: shownCards };
  }, [cards, chosen, typeSet, query]);
  const shown = tally.shown;
  /** What a preset would show: its states' counts, since a card is in one state. */
  const presetCount = (preset: Preset) =>
    presetStates(preset, states, flow).reduce((n, s) => n + (tally.byState.get(s) ?? 0), 0);
  /*
   * The page, clamped rather than stored clamped: cards closed elsewhere can
   * shrink the list under the page you are on, and the answer is its new last
   * page, not an empty one.
   */
  const lastPage = Math.max(0, Math.ceil(shown.length / PAGE_SIZE) - 1);
  const currentPage = Math.min(page, lastPage);
  const pageCards = shown.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const pageIds = React.useMemo(() => new Set(pageCards.map(c => c.id)), [pageCards]);

  /*
   * Which preset the selection IS. A hand-picked set that happens to equal one
   * (Open with DONE added back is All) reads as that preset, so the bar never
   * shows a selection no button describes when one does.
   */
  const sameSet = (a: ReadonlySet<string>, b: readonly string[]) => a.size === b.length && b.every(x => a.has(x));
  const activePreset: Preset | null = 'preset' in selection
    ? selection.preset
    : chosen.size === 0 ? null : (PRESETS.find(p => sameSet(chosen, presetStates(p.id, states, flow)))?.id ?? null);
  const isDefault = activePreset === 'open' && typeSet.size === 0 && !query.trim();
  const choose = (next: Selection) => { setSelection(next); setPage(0); };
  const reset = () => { choose({ preset: 'open' }); setTypes([]); setQuery(''); };
  const toggleState = (state: string) => {
    const next = new Set(chosen);
    if (next.has(state)) next.delete(state); else next.add(state);
    choose({ states: states.filter(s => next.has(s)) });
  };
  const toggleType = (type: string) => {
    setTypes(prev => (prev.includes(type) ? prev.filter(t => t !== type) : [...prev, type]));
    setPage(0);
  };
  /** What the closed menus say: the preset, the one state, or how many. */
  const stateSummary = activePreset ? PRESETS.find(p => p.id === activePreset)!.label
    : chosen.size === 1 ? [...chosen][0]
      : chosen.size === 0 ? 'None' : `${chosen.size} states`;
  const typeSummary = types.length === 0 ? 'All types' : types.length === 1 ? types[0] : `${types.length} types`;
  // One menu open at a time; closing one never closes the other.
  const onStateMenu = React.useCallback((open: boolean) =>
    setMenu(current => (open ? 'state' : current === 'state' ? null : current)), []);
  const onTypeMenu = React.useCallback((open: boolean) =>
    setMenu(current => (open ? 'type' : current === 'type' ? null : current)), []);
  /** The types there is an option for: the ones a card is, in the usual order. */
  const presentTypes = Object.values(ItemType).map(String).filter(t => cards.some(c => String(c.type) === t));

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
   * How many of how many, whenever the rows are not all of them — the default
   * included, since Open hides the finished ones. "135 cards" over a list of
   * three is the same lie the old "in flight" count told, in the other
   * direction: one number describing a different set than the rows under it.
   */
  const count = shown.length !== cards.length
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
                    // The server refuses these anyway: say why here, instead of offering a button that fails.
                    if (pending.hidden?.length) {
                      return (
                        <span data-testid={`setting-hidden-${row.key}`} className="shrink-0 text-[11px] font-semibold text-danger-text">
                          Holds hidden characters ({pending.hidden.join(', ')}): fix the file to approve it
                        </span>
                      );
                    }
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
                      {pending ? revealHidden(pending.command) : row.value ?? 'not set'}
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
              <div data-testid="project-filters" className="mb-3 flex flex-wrap items-center gap-2">
                {/*
                 * ONE LINE: two menus and a search box. The presets live INSIDE
                 * the State menu, above the ticks — the four questions people
                 * come with (what is left, what is moving, what is finished,
                 * everything), counted before they are pressed.
                 */}
                <FilterMenu
                  testId="project-filter-state"
                  label="State"
                  summary={stateSummary}
                  active={activePreset !== 'open'}
                  open={menu === 'state'}
                  onOpenChange={onStateMenu}
                >
                  {PRESETS.map(p => (
                    <MenuOption
                      key={p.id}
                      testId={`project-preset-${p.id}`}
                      countTestId={`project-preset-count-${p.id}`}
                      role="menuitemradio"
                      checked={activePreset === p.id}
                      count={presetCount(p.id)}
                      onClick={() => { choose({ preset: p.id }); setMenu(null); }}
                    >
                      {p.label}
                    </MenuOption>
                  ))}
                  <div role="separator" className="my-1 border-t border-border-soft" />
                  {states.map(state => (
                    <MenuOption
                      key={state}
                      testId={`project-filter-state-${state}`}
                      countTestId={`project-filter-state-count-${state}`}
                      role="menuitemcheckbox"
                      checked={chosen.has(state)}
                      count={tally.byState.get(state) ?? 0}
                      onClick={() => toggleState(state)}
                    >
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${stateDot(state, finished, backlog)}`} />
                      <span className="truncate font-mono text-[11px]">{state}</span>
                    </MenuOption>
                  ))}
                </FilterMenu>
                <FilterMenu
                  testId="project-filter-type"
                  label="Type"
                  summary={typeSummary}
                  active={types.length > 0}
                  open={menu === 'type'}
                  onOpenChange={onTypeMenu}
                >
                  {presentTypes.map(type => (
                    <MenuOption
                      key={type}
                      testId={`project-filter-type-${type}`}
                      role="menuitemcheckbox"
                      checked={typeSet.has(type)}
                      count={tally.byType.get(type) ?? 0}
                      onClick={() => toggleType(type)}
                    >
                      <ItemTypeSquare type={type as ItemType} size="sm" />
                      <span className="truncate">{type}</span>
                    </MenuOption>
                  ))}
                </FilterMenu>
                <label className="flex min-w-[10rem] max-w-xs flex-1 items-center gap-2 rounded-lg border border-border-soft bg-canvas px-2.5 py-1.5 text-ink-tertiary focus-within:border-border-brand">
                  <Search size={12} className="shrink-0" />
                  <input
                    type="search"
                    data-testid="project-filter-search"
                    aria-label="Search cards"
                    placeholder="Search title or id"
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    className="min-w-0 flex-1 bg-transparent text-[11px] text-ink outline-none placeholder:text-ink-tertiary"
                  />
                </label>
                {!isDefault && (
                  /* Back to OPEN, not to everything: the default is the answer
                     to "what is left", and that is what a reset is for. */
                  <button
                    type="button"
                    data-testid="project-filters-reset"
                    onClick={reset}
                    className="text-[11px] font-semibold text-accent-text underline underline-offset-2"
                  >
                    Clear filters
                  </button>
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
        ) : shown.length === 0 && isDefault ? (
          /* EVERYTHING IS FINISHED, which is not the same as empty and not a
             filter somebody set: Open is the default, so a finished project
             would otherwise read as a list with nothing to clear. */
          <div data-testid="project-page-all-done" className="rounded-xl border border-dashed border-border-soft px-5 py-10 text-center">
            <p className="text-sm font-semibold text-ink">
              {cards.length === 1 ? 'The one card here is finished.' : `All ${cards.length} cards are finished.`}
            </p>
            <button
              type="button"
              data-testid="project-page-show-done"
              onClick={() => choose({ preset: 'done' })}
              className="mt-2 text-xs font-semibold text-accent-text underline underline-offset-2"
            >
              Show them
            </button>
          </div>
        ) : shown.length === 0 ? (
          /* A DIFFERENT SENTENCE from "no cards yet": there are cards, and the
             filter is what emptied the list. Saying the project is empty when
             135 rows are one click away sends people looking for the bug. */
          <div data-testid="project-page-no-match" className="rounded-xl border border-dashed border-border-soft px-5 py-10 text-center">
            <p className="text-sm font-semibold text-ink">No card matches these filters.</p>
            <button
              type="button"
              data-testid="project-filter-clear"
              onClick={reset}
              className="mt-2 text-xs font-semibold text-accent-text underline underline-offset-2"
            >
              Clear filters
            </button>
          </div>
        ) : (
          <>
          <ul className="flex flex-col gap-1.5">
            {pageCards.map(card => {
              const on = working[card.id];
              const action = rowAction(card.status, on, flow);
              const done = action === 'done';
              const when = done ? ago(card.updatedAt) : null;
              return (
              /*
               * Indented under the ancestors that are ON THIS PAGE only
               * (depthOf): with a parent filtered out or a page away, an indent
               * would draw a child of nothing, which is worse than a flat row.
               */
              <li key={card.id} className="flex items-center gap-1.5" style={{ marginLeft: `${depthOf(card, byId, pageIds) * 18}px` }}>
                <button
                  type="button"
                  data-testid={`project-card-${card.id}`}
                  onClick={() => onOpenCard?.(card)}
                  className={`flex min-w-0 flex-1 items-center gap-2.5 rounded-lg border border-border-soft px-2.5 py-2 text-left hover:bg-chip ${
                    done ? 'bg-transparent' : 'bg-canvas'
                  }`}
                >
                  <ItemTypeSquare type={card.type as ItemType} size="sm" testId={`project-card-type-${card.id}`} />
                  <span className={`min-w-0 flex-1 truncate text-xs ${done ? 'text-ink-tertiary' : 'text-ink'}`}>{card.title}</span>
                  <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10px] tracking-wide text-ink-tertiary">
                    <span className={`h-1.5 w-1.5 rounded-full ${stateDot(String(card.status), finished, backlog)}`} />
                    {String(card.status)}
                  </span>
                </button>
                {done ? (
                  /* NOTHING TO START. A finished card offered Start, and the
                     press opened an agent on work that was over. It says when
                     it closed instead; the row itself still opens the card. */
                  <span
                    data-testid={`project-card-done-${card.id}`}
                    className="flex shrink-0 items-center gap-1.5 px-2 text-[11px] text-ink-tertiary"
                    title={card.updatedAt ? new Date(card.updatedAt).toLocaleString() : undefined}
                  >
                    <Check size={12} />
                    {when ? `${finishedWord(String(card.status))} ${when}` : finishedWord(String(card.status))}
                  </span>
                ) : onStartAgent && (
                  /* The press this page was missing. Named by what it will do
                     to THIS card, because a row of identical play buttons is
                     the control people click by accident. */
                  <button
                    type="button"
                    data-testid={`project-card-start-${card.id}`}
                    aria-label={
                      action === 'open' ? `Open the agent working on ${card.title}`
                        : action === 'elsewhere' ? `See the run working on ${card.title}`
                          : action === 'resume' ? `Resume work on ${card.title}`
                            : `Start an agent on ${card.title}`
                    }
                    title={
                      action === 'open' ? 'Open the agent working on this card'
                        : action === 'elsewhere' ? 'An agent is already working on this card, elsewhere'
                          : action === 'resume' ? 'Pick this card up where it was left'
                            : 'Start an agent on this card'
                    }
                    onClick={() => {
                      // Never a spawn while something is already on the card:
                      // that is a second agent in the same worktree.
                      if (action === 'elsewhere') onShowRuns?.(card);
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
                      : action === 'resume' ? <RotateCcw size={12} /> : <Play size={12} />}
                    {action === 'open' ? 'Open' : action === 'elsewhere' ? 'Running' : action === 'resume' ? 'Resume' : 'Start'}
                  </button>
                )}
              </li>
              );
            })}
          </ul>
          {shown.length > PAGE_SIZE && (
            /* A page at a time once the list stops fitting. The footer's count
               still describes the whole filter; this says where in it you are. */
            <nav data-testid="project-page-pager" aria-label="Pages" className="mt-3 flex items-center justify-end gap-2 text-[11px] text-ink-tertiary">
              <button
                type="button"
                data-testid="project-page-prev"
                aria-label="Previous page"
                disabled={currentPage === 0}
                onClick={() => setPage(currentPage - 1)}
                className={PAGER_BUTTON}
              >
                <ChevronLeft size={14} />
              </button>
              <span data-testid="project-page-range" className="font-mono">
                {`${currentPage * PAGE_SIZE + 1}–${Math.min((currentPage + 1) * PAGE_SIZE, shown.length)} of ${shown.length}`}
              </span>
              <button
                type="button"
                data-testid="project-page-next"
                aria-label="Next page"
                disabled={currentPage === lastPage}
                onClick={() => setPage(currentPage + 1)}
                className={PAGER_BUTTON}
              >
                <ChevronRight size={14} />
              </button>
            </nav>
          )}
          </>
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
