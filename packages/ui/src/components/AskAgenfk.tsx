import React from 'react';
import { api } from '../api';
import { ItemTypeSquare } from './ItemTypeSquare';
import { ItemType } from '../types';
import {
  creatableItems, creationOrder, issuesFor, keptItems, treeIssues,
  type ReviewedProposal,
} from '../proposalTree';
import { extractProposal } from '../agentAnswer';
import { listAgentsFromBridge, onProposeOutputFromBridge, proposeFromBridge } from './agentBridge';
import { AddProjectDialog } from './AddProjectDialog';
import { X } from 'lucide-react';
import { AgentPicker } from './AgentPicker';
import { ProjectPicker } from './ProjectPicker';

/**
 * Describe the objective; an agent proposes the decomposition; you keep, drop
 * and only then create (artifact aca414c7 §06).
 *
 * IT PROPOSES, IT DOES NOT CREATE. Nothing on this screen writes to the board
 * until the button at the bottom is pressed, and that button creates the rows
 * that survived — one at a time, through the same route the rest of the app
 * uses, so the flow is enforced for these cards exactly as for any other. An
 * agent that silently creates eight cards is an agent nobody lets near a board
 * twice.
 *
 * THE ANSWER ARRIVES BY HAND, and that is this card's one design decision.
 * Capturing a model's reply out of a pty means parsing terminal output — the
 * artifact does not specify it, and getting it wrong means the screen either
 * misses the answer or invents one. So the session is opened seeded with the
 * exact command, and the reply is brought here. Automatic capture can land on
 * top of this later; a fallback built after the shortcut is a fallback nobody
 * tests.
 */
export interface AskAgenfkProps {
  /**
   * Where accepted cards land, to begin with.
   *
   * The panel is opened from a terminal or a board that already implies a
   * project, so this is the default rather than the decision — the screen
   * shows it and lets it be changed, because "where did my cards go" is not a
   * question a person should have to answer by looking at the board
   * afterwards.
   */
  readonly projectId: string;
  /**
   * Cards landed. The PROJECT travels with the count, because the panel lets
   * the project be changed after it opened — the caller's own idea of where
   * this was for can be out of date by the time anything is created.
   */
  readonly onCreated?: (count: number, projectId: string) => void;
  /**
   * A project was added from inside here.
   *
   * Separate from `onCreated`: nothing has been written to a board yet, but
   * the person just made a thing and has nowhere to see it. Closing the panel
   * onto the screen they started from is how "where did it go?" begins.
   */
  readonly onProjectAdded?: (projectId: string) => void;
  /**
   * Write the card by hand instead.
   *
   * The former sibling door, moved inside: proposing needs an agent that is
   * installed, authenticated and answering, and this is the path that works
   * without one. A single door with no fallback would leave a machine with no
   * agent unable to create anything at all.
   */
  readonly onWriteByHand?: (projectId: string) => void;
  readonly onClose?: () => void;
}

/** What the person runs, shown rather than implied. */
export function seedCommand(objective: string): string {
  return `agenfk analyze ${JSON.stringify(objective.trim())} --proposal`;
}

export function AskAgenfk({ projectId, onCreated, onProjectAdded, onWriteByHand, onClose }: AskAgenfkProps) {
  /** The project the cards are created in, and the one the agent runs in. */
  const [target, setTarget] = React.useState(projectId);
  const [projects, setProjects] = React.useState<Array<{ id: string; name: string; projectRoot?: string }>>([]);

  const [busy, setBusy] = React.useState(false);
  /* Escape, because a dialog that traps you until you find the X is the same
     complaint one layer down. */
  React.useEffect(() => {
    /*
     * NOT WHILE IT IS WRITING. `create` is a loop of POSTs that cannot be
     * called back, so dismissing mid-loop did not cancel anything: the cards
     * kept appearing and the app then navigated to them, seconds after the
     * person had said no. A screen whose whole premise is "nothing has been
     * written yet" cannot have a Cancel that means "carry on".
     */
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose?.(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    /* The dialog above stops the key before it reaches here, so Escape closes
       the innermost thing rather than both at once. */
  }, [onClose, busy]);

  React.useEffect(() => {
    // Kept to a tail: this is a window onto a long run, not a transcript, and
    // an unbounded array of a chatty agent's output is a memory leak with a
    // scrollbar.
    const off = onProposeOutputFromBridge(e => setOutput(prev => [...prev, e].slice(-200)));
    return () => { off?.(); };
  }, []);

  React.useEffect(() => {
    let alive = true;
    void api.listProjects()
      .then((list: never[]) => { if (alive) setProjects(list as never); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  const [objective, setObjective] = React.useState('');
  const [answer, setAnswer] = React.useState('');
  const [reviewed, setReviewed] = React.useState<ReviewedProposal | null>(null);
  const [dropped, setDropped] = React.useState<Set<string>>(new Set());
  const [error, setError] = React.useState<string | null>(null);
  /** The text to hand the agent, once it has been asked for. */
  const [contract, setContract] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [agentId, setAgentId] = React.useState('');
  /** The clone form, open only when somebody asked for it. */
  const [adding, setAdding] = React.useState(false);
  /*
   * What the agent is printing, while it prints it.
   *
   * "The agent is working on it" cannot tell thinking from wedged from a CLI
   * that is out of quota and saying so on stderr where nobody could see it.
   * Any agent can end a run that way — a token limit, an expired login, a
   * model that is not enabled on the account — so this is the generic answer
   * rather than a special case for whichever one failed first.
   */
  const [output, setOutput] = React.useState<{ stream: 'stdout' | 'stderr'; line: string }[]>([]);
  /** The live session, while an agent is working on the objective. */
  const [running, setRunning] = React.useState(false);

  /*
   * A first choice, so the button is usable without touching the picker.
   * `AgentPicker` renders the list and the logos; what it does not do is
   * decide which one is selected before anyone has chosen.
   */
  React.useEffect(() => {
    let alive = true;
    void listAgentsFromBridge()
      .then(list => {
        if (!alive) return;
        // `installed`, which is what the bridge actually reports. `available`
        // type-checked nowhere and only showed up in the BUILD, because vitest
        // transpiles without checking types.
        setAgentId(prev => prev || (list.find(a => a.installed)?.id ?? list[0]?.id ?? ''));
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);



  const kept = reviewed ? keptItems(reviewed.items, dropped) : [];
  /*
   * A row that carries an issue cannot be created, so the gate counts what is
   * actually creatable rather than what is ticked. Saying "Create 5" and
   * creating 3 is the kind of number nobody reconciles afterwards.
   */
  /*
   * What will actually be created, and the number on the button is its length.
   *
   * Subtracting the blocked rows from `kept` was wrong twice over: it left the
   * CHILDREN of a blocked row in the count (they were then created as loose
   * cards at the root — see creatableItems), and it counted rows that
   * `creationOrder` would never emit, because that step dedupes by ref and the
   * agent can answer with rows that carry none. Both ways the promise on the
   * button and the cards on the board disagreed, silently.
   */
  const willCreate = reviewed
    ? creationOrder(creatableItems(
      kept,
      dropped,
      ref => !ref || issuesFor(reviewed.issues, ref).length > 0,
    ))
    : [];
  const creatable = willCreate.length;
  const blocked = kept.length - creatable;

  const review = async (raw = answer) => {
    setError(null);
    /*
     * Anything the agent printed, not just clean JSON.
     *
     * `extractProposal` strips ANSI and finds the last balanced object that
     * looks like a proposal, so pasting a whole terminal scroll — prose,
     * colour, prompt and all — works. Asking a person to trim a JSON object
     * out of a scrollback by eye is the manual step this screen exists to
     * remove.
     */
    const parsed = extractProposal(raw);
    if (!parsed) {
      setError('No proposal found in that. Paste the agent’s answer, or the whole output — the JSON is picked out of it.');
      return;
    }
    setBusy(true);
    try {
      setReviewed(await api.reviewProposal(parsed));
      setDropped(new Set());
    } catch {
      setError('The server could not review that proposal.');
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (!reviewed) return;
    setBusy(true);
    setError(null);
    // Parents first, and their real ids handed to their children: a child
    // POSTed before its parent has nothing to point at.
    const idByRef = new Map<string, string>();
    let made = 0;
    try {
      // The same list the button counted. Skipping rows HERE was the bug: a
      // skipped parent left its children pointing at nothing.
      for (const item of willCreate) {
        const created = await api.createItem({
          projectId: target,
          type: item.type as ItemType,
          title: item.title,
          description: item.description,
          parentId: item.parentRef ? idByRef.get(item.parentRef) : undefined,
        } as any);
        if (created?.id) idByRef.set(item.ref, created.id);
        made++;
      }
      onCreated?.(made, target);
    } catch {
      // Said with the count, because some cards may already exist: a bare
      // "failed" would send the person hunting for what landed.
      setError(`Created ${made} of ${creatable} before the server refused one.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="ask-agenfk" className="flex flex-col gap-4 p-4">
      {/*
       * A WAY OUT THAT IS ON THE SCREEN. Clicking the backdrop closed this,
       * and Escape did nothing — both are gestures you have to already know.
       * The one thing every other dialog in this app has is an X.
       */}
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-semibold text-ink">Ask AgEnFK</p>
        <button
          type="button"
          data-testid="ask-close"
          aria-label="Close"
          disabled={busy}
          onClick={() => onClose?.()}
          className="shrink-0 rounded p-1 text-ink-tertiary transition-colors hover:text-ink disabled:opacity-40"
        >
          <X size={16} />
        </button>
      </div>
      {/*
       * WHERE, BEFORE WHAT.
       *
       * This sat beside the objective, and that was wrong for a reason worth
       * writing down: the project decides where the cards land AND where the
       * agent runs, so it is a precondition of the question rather than a
       * detail of it. Asked first, the path is also on screen — "which agenfk"
       * is a real question on a machine with three checkouts of it.
       */}
      <div className="flex items-center gap-2 rounded-xl border border-border-soft bg-canvas px-3 py-2">
        <ProjectPicker
          testId="ask-project"
          value={target}
          projects={projects}
          onChange={setTarget}
        />
        <span data-testid="ask-project-root" className="shrink-0 truncate font-mono text-[11px] text-ink-tertiary">
          {projects.find(p => p.id === target)?.projectRoot ?? 'no folder'}
        </span>
        {/* The way out of "I have no project for this yet", which was a dead
            end: every other door here assumes the project already exists. The
            three ways in live behind this one button, in their own dialog —
            they used to be bolted onto this row, where the folder button and
            the clone URL sat side by side with nothing to do with each other. */}
        <button
          type="button"
          data-testid="ask-add-project"
          onClick={() => { setError(null); setAdding(true); }}
          className="shrink-0 rounded-md border border-border-brand bg-chip px-2 py-1 text-[11px] font-semibold text-accent-text"
        >
          ＋ Add project
        </button>
      </div>

      <AddProjectDialog
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={id => {
          // The project EXISTS by now; refreshing the list is cosmetic, so a
          // failure here must not become an unhandled rejection. Select it
          // either way — the id is the thing that was asked for.
          setTarget(id);
          void api.listProjects().then(list => setProjects(list as never)).catch(() => {});
          /*
           * Take them to it — UNLESS there is a reviewed proposal on screen.
           * Navigating closes this panel, and a person who realises mid-review
           * that the cards belong in a new project would lose the objective,
           * the answer and every keep/drop decision to the act of creating it.
           * With nothing to lose, landing on the new project is the point.
           */
          if (!reviewed) onProjectAdded?.(id);
        }}
      />

      <div>
        <label htmlFor="ask-objective" className="block text-xs font-bold uppercase tracking-widest text-ink-tertiary">
          What are you trying to do?
        </label>
        <input
          id="ask-objective"
          data-testid="ask-objective"
          value={objective}
          onChange={e => setObjective(e.target.value)}
          placeholder="Port the admin API to horizon-lab, private subnets, keep the public gateway"
          className="mt-1 w-full rounded-xl border border-border-soft bg-surface px-4 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand"
        />
      </div>

      {/* The command is shown, not hidden behind the button: this screen does
          not decompose anything, an agent does, and the person should be able
          to see exactly what it is asked. */}
      <div className="rounded-xl border border-border-soft bg-canvas p-3">
        <button
          type="button"
          data-testid="ask-seed"
          disabled={!objective.trim() || busy || !agentId}
          onClick={async () => {
            /*
             * RUN IT. This button has been three things: a clipboard copy that
             * drew nothing, and then an interactive session whose answer had
             * to be read out of a terminal scroll. Both were the long way
             * round a question that has one answer and no follow-up — so it
             * asks the agent in its own non-interactive mode and takes stdout.
             */
            setError(null);
            // A new run starts with an empty log: the last run's lines beside
            // this run's spinner would be the worst of both.
            setOutput([]);
            setRunning(true);
            try {
              const pending = proposeFromBridge({ projectId: target, agentId, objective: objective.trim() });
              if (!pending) {
                // Named, because every failure used to look the same from the
                // outside: "it asked me to copy something".
                const text = await api.decompositionContract(objective.trim());
                setContract(text);
                await navigator.clipboard?.writeText?.(text).catch(() => {});
                setCopied(true);
                setError('This build cannot run an agent for you — it predates that, or this is the browser. The contract is on the clipboard.');
                return;
              }
              const { stdout } = await pending;
              setAnswer(stdout);
              await review(stdout);
            } catch (e: any) {
              setError(String(e?.message ?? e));
            } finally {
              setRunning(false);
            }
          }}
          className="rounded-lg border border-border-brand bg-chip px-3 py-1.5 text-xs font-semibold text-accent-text disabled:opacity-50"
        >
          {running ? 'Asking the agent…' : 'Propose the decomposition'}
        </button>
        {/* What is actually run, for the person who wants to run it
            themselves — or to see that the app is not doing something else. */}
        {onWriteByHand && (
          <p className="mt-2 text-[11px] text-ink-tertiary">
            Know exactly what you want?{' '}
            <button
              type="button"
              data-testid="ask-by-hand"
              onClick={() => onWriteByHand(target)}
              className="font-semibold text-accent-text underline underline-offset-2"
            >
              Write the card yourself
            </button>{' '}
            — no agent needed.
          </p>
        )}
        <pre data-testid="ask-command" className="mt-2 overflow-x-auto font-mono text-[11px] text-ink-tertiary">
          {objective.trim() ? seedCommand(objective) : 'agenfk analyze "<objective>" --proposal'}
        </pre>
        {running && (
          <p data-testid="ask-running" className="mt-2 text-[11px] text-accent-text">
            The agent is working on it. This takes as long as it takes — the proposal appears below.
          </p>
        )}
        {output.length > 0 && (
          /* STDERR TOO, and marked. A run that ends "out of tokens" says so on
             the stream nobody was showing — and then the screen reports "the
             agent printed nothing", which blames the answer for the run. */
          <pre
            data-testid="ask-output"
            className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border border-border-soft bg-canvas p-2 font-mono text-[10.5px] leading-relaxed"
          >
            {output.map((o, i) => (
              <span
                key={i}
                data-testid={o.stream === 'stderr' ? 'ask-output-stderr' : 'ask-output-stdout'}
                className={o.stream === 'stderr' ? 'block text-danger-text' : 'block text-ink-tertiary'}
              >
                {o.line}
              </span>
            ))}
          </pre>
        )}
        {contract && !running && (
          <>
            <p data-testid="ask-copied" className="mt-2 text-[11px] text-accent-text">
              {copied ? 'Copied. Paste it into your agent, then bring the answer back below.'
                      : 'Hand this to your agent, then bring the answer back below.'}
            </p>
            {/* The contract itself, on screen. It is what the agent is being
                asked, and a person who cannot read it has to trust a button. */}
            <details className="mt-1">
              <summary className="cursor-pointer text-[11px] text-ink-tertiary">What the agent is asked</summary>
              <pre data-testid="ask-contract" className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-ink-tertiary">
                {contract}
              </pre>
            </details>
          </>
        )}
      </div>

      <div>
        <label htmlFor="ask-answer" className="block text-xs font-bold uppercase tracking-widest text-ink-tertiary">
          The agent&rsquo;s answer
        </label>
        <textarea
          id="ask-answer"
          data-testid="ask-answer"
          /*
           * LOCKED WHILE THE AGENT WORKS, and saying so by sweeping rather
           * than by a spinner in a corner. The wait belongs to THIS field — it
           * is the one about to be written into — and anything typed here
           * meanwhile would be overwritten by the answer the moment it lands.
           */
          disabled={running}
          value={answer}
          onChange={e => setAnswer(e.target.value)}
          // Reviewed on paste, because pasting IS the gesture. Making someone
          // paste and then press a button is a step that exists only because
          // the code was written that way.
          onPaste={e => {
            const pasted = e.clipboardData?.getData('text') ?? '';
            if (pasted.trim()) window.setTimeout(() => void review(pasted), 0);
          }}
          className={`mt-1 min-h-[120px] w-full rounded-xl border px-4 py-3 font-mono text-xs text-ink focus:outline-none focus:ring-2 focus:ring-brand ${
            running ? 'agent-sweep cursor-wait border-border-brand bg-canvas' : 'border-border-soft bg-surface'
          }`}
          placeholder={running
            ? `Asking ${agentId || 'the agent'}…`
            : 'Paste the agent’s answer — prose, colour and all. The proposal is picked out of it.'}
        />
        <div className="mt-2 flex items-center justify-between gap-3">
          <button
          type="button"
          data-testid="ask-review"
          disabled={!answer.trim() || busy || running}
          // `() => review()`, never `onClick={review}`: React hands the click
          // event to the handler, and it would arrive where the text to review
          // belongs. The picker beside this has the same comment for the same
          // reason.
          onClick={() => void review()}
          className="mt-2 rounded-lg border border-border-soft bg-surface px-3 py-1.5 text-xs font-semibold text-ink disabled:opacity-50"
        >
          Review the proposal
          </button>
          {/* WHO is asked, beside WHAT is asked of them. It sat at the top,
              above the objective's own controls, where it read as a setting
              for the panel rather than as part of the action. */}
          <label className="flex items-center gap-2 text-[11px] text-ink-tertiary">
            Agent
            <span data-testid="ask-agent">
              <AgentPicker value={agentId} onChange={setAgentId} listAgents={listAgentsFromBridge} />
            </span>
          </label>
        </div>
      </div>

      {error && (
        <p data-testid="ask-error" className="text-xs text-danger-text">{error}</p>
      )}

      {reviewed && (
        <div className="flex flex-col gap-2">
          {treeIssues(reviewed.issues).map((issue, i) => (
            <p key={i} data-testid="ask-tree-issue" className="text-xs text-danger-text">{issue.message}</p>
          ))}

          <ul data-testid="ask-tree" className="flex flex-col gap-1">
            {reviewed.items.map(item => {
              const isDropped = !kept.some(k => k.ref === item.ref);
              const rowIssues = issuesFor(reviewed.issues, item.ref);
              return (
                <li
                  key={item.ref}
                  data-testid={`ask-row-${item.ref}`}
                  style={{ marginLeft: `${Math.min(item.depth, 4) * 18}px` }}
                  className={`flex items-start gap-2 rounded-lg border border-border-soft px-2 py-1.5 ${isDropped ? 'opacity-40' : ''}`}
                >
                  <ItemTypeSquare type={item.type as ItemType} />
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-xs text-ink ${isDropped ? 'line-through' : ''}`}>{item.title}</span>
                    {rowIssues.map((issue, i) => (
                      <span key={i} data-testid={`ask-row-issue-${item.ref}`} className="block text-[11px] text-danger-text">
                        {issue.message}
                      </span>
                    ))}
                  </span>
                  <button
                    type="button"
                    data-testid={`ask-drop-${item.ref}`}
                    onClick={() => setDropped(prev => {
                      const next = new Set(prev);
                      // Undropping a row whose PARENT is still dropped cannot
                      // bring it back, and the list says so by leaving it
                      // struck through — the state here is only ever the rows
                      // the person acted on.
                      next.has(item.ref) ? next.delete(item.ref) : next.add(item.ref);
                      return next;
                    })}
                    className="shrink-0 text-[11px] text-ink-tertiary"
                  >
                    {dropped.has(item.ref) ? 'keep' : 'drop'}
                  </button>
                </li>
              );
            })}
          </ul>

          {/* The gate. It states what has NOT happened, because that is the
              thing a person cannot see. */}
          <p data-testid="ask-gate" className="text-xs text-ink-secondary">
            Nothing has been written.{' '}
            <span className="font-mono font-bold text-accent-text">{creatable}</span>{' '}
            {creatable === 1 ? 'card' : 'cards'} will be created in{' '}
            <span className="font-mono font-bold text-accent-text">TODO</span>. None of them starts
            until you move it.
            {blocked > 0 && (
              <span data-testid="ask-blocked"> {blocked} {blocked === 1 ? 'row has' : 'rows have'} a
                problem and will be skipped.</span>
            )}
          </p>

          <div className="flex items-center gap-2">
            {/* Disabled while the loop runs, for the same reason as the X and
                Escape: it cannot stop what it says it stops. */}
            <button type="button" data-testid="ask-cancel" disabled={busy} onClick={() => onClose?.()}
              className="rounded-lg border border-border-soft bg-surface px-3 py-1.5 text-xs font-semibold text-ink disabled:opacity-50">
              Cancel
            </button>
            <button
              type="button"
              data-testid="ask-create"
              disabled={creatable === 0 || busy}
              onClick={create}
              className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-navy disabled:opacity-50"
            >
              Create {creatable} {creatable === 1 ? 'card' : 'cards'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
