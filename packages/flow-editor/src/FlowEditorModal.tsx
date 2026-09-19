import React, { useState, useRef, useEffect, useCallback, createContext, useContext } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import mermaid from 'mermaid';
import type { Flow, FlowStep, RegistryFlow, FlowClient, RegistryClient } from './types';
import { extractApiError } from './apiError';
import { flowDefinitionIssues, nextStepName, stepIssue, withStepIds } from './flowDefinition';
import { ExitCriteriaEditorModal } from './ExitCriteriaEditorModal';
import { estimateTokenCount } from './estimateTokens';

// ── Host injection ─────────────────────────────────────────────────────────
// The editor accepts its data layer (server REST + community registry) and
// theme via context, so consumers can route the same UI at either the local
// agenfk server or the corp Hub admin endpoints without forking the component.

interface FlowEditorHost {
  flowClient: FlowClient;
  registryClient: RegistryClient;
  theme: 'light' | 'dark';
  /** Tab captions, supplied by the host. See `FlowEditorModalPublicProps`. */
  tabLabels: { myFlows: string; registry: string };
  /** Footer CTA captions, supplied by the host. */
  labels: FlowEditorLabels;
  /** Optional host control above the registry search box. */
  registryToolbar?: React.ReactNode;
}

const DEFAULT_HOST_TAB_LABELS = { myFlows: 'My Flows', registry: 'Community' };

const HostContext = createContext<FlowEditorHost | null>(null);

function useHost(): FlowEditorHost {
  const ctx = useContext(HostContext);
  if (!ctx) throw new Error('FlowEditor: HostContext is missing — wrap in <FlowEditorModal flowClient registryClient theme />');
  return ctx;
}
const useFlowClient = (): FlowClient => useHost().flowClient;
const useRegistryClient = (): RegistryClient => useHost().registryClient;
const useEditorTheme = (): 'light' | 'dark' => useHost().theme;
const useTabLabels = () => useHost().tabLabels;
const useEditorLabels = (): FlowEditorLabels => useHost().labels;
import { X, Plus, Trash2, GripVertical, Save, GitBranch, Check, CopyPlus, Lock, Search, Globe, Loader2, AlertCircle, AlertTriangle, ChevronRight, Download, Upload, ExternalLink, Zap, FlaskConical, ShieldCheck, Clock, BookOpen, Briefcase, Eye, Code, Bug, Star, Lightbulb, Pause, Archive } from 'lucide-react';

// Available icons for flow steps — key stored in FlowStep.icon, value rendered in UI
const STEP_ICON_OPTIONS: { key: string; label: string; node: React.ReactNode }[] = [
  { key: 'zap',       label: 'Zap',         node: <Zap size={14} /> },
  { key: 'plus',      label: 'Plus',        node: <Plus size={14} /> },
  { key: 'check',     label: 'Check',       node: <Check size={14} /> },
  { key: 'search',    label: 'Search',      node: <Search size={14} /> },
  { key: 'flask',     label: 'Test',        node: <FlaskConical size={14} /> },
  { key: 'shield',    label: 'Review',      node: <ShieldCheck size={14} /> },
  { key: 'eye',       label: 'Eye',         node: <Eye size={14} /> },
  { key: 'code',      label: 'Code',        node: <Code size={14} /> },
  { key: 'clock',     label: 'Clock',       node: <Clock size={14} /> },
  { key: 'book',      label: 'Book',        node: <BookOpen size={14} /> },
  { key: 'briefcase', label: 'Briefcase',   node: <Briefcase size={14} /> },
  { key: 'star',      label: 'Star',        node: <Star size={14} /> },
  { key: 'lightbulb', label: 'Lightbulb',   node: <Lightbulb size={14} /> },
  { key: 'bug',       label: 'Bug',         node: <Bug size={14} /> },
  { key: 'git',       label: 'Git Branch',  node: <GitBranch size={14} /> },
  { key: 'pause',     label: 'Pause',       node: <Pause size={14} /> },
  { key: 'archive',   label: 'Archive',     node: <Archive size={14} /> },
];

export function renderStepIcon(iconKey: string | undefined, fallback: React.ReactNode = <Zap size={14} />): React.ReactNode {
  if (!iconKey) return fallback;
  return STEP_ICON_OPTIONS.find(o => o.key === iconKey)?.node ?? fallback;
}
import { clsx } from 'clsx';

/**
 * Names that are reserved and cannot be used as custom step names.
 * TODO and DONE are anchor steps (always first/last in every flow).
 * The rest are platform-level statuses that exist outside flow definitions.
 */
const RESERVED_NAMES = new Set([
  'TODO', 'DONE', 'BLOCKED', 'PAUSED', 'IDEAS', 'ARCHIVED', 'TRASHED',
]);

const BUILTIN_ID = '__builtin__';

/**
 * CGLAB-164. The per-step colour is a stripe on the row's leading edge. Two
 * variants render it — an anchor's is decorative, a working step's carries the
 * colour input on top of it — and the whole point of the stripe is that it
 * reads as one continuous rail down the list, which it stops doing the moment
 * the two drift apart. Stated once so they cannot.
 */
const STEP_STRIPE_CLASS = 'shrink-0 self-stretch';
const STEP_STRIPE_WIDTH = 4;

/**
 * The transparent `<input type="color">` that turns the rail into a control.
 *
 * Both dimensions are explicit on purpose. Given only `inset-y-0` and no
 * height, a colour input falls back to its INTRINSIC size — Blink renders a
 * ~50x27 colour-well — and the box becomes over-constrained, so `bottom` and
 * `right` are dropped. Measured in Chrome, that left the lower half of a
 * visible rail dead to the click and pushed the live area sideways over the
 * step number, so clicking the number opened the colour picker. jsdom has no
 * layout, so no test in this suite can see any of that: the guard has to be
 * that the declaration itself cannot fall back to auto.
 *
 * 24px wide against a 4px rail is WCAG 2.2 SC 2.5.8 (24x24 minimum target).
 * The extra 20px is hit area, not paint: it hangs off the row's left edge and
 * stops 2px short of the step-number column.
 */
const STEP_COLOR_INPUT_CLASS =
  'absolute top-0 -left-2.5 h-full w-6 opacity-0 cursor-pointer border-0 p-0 bg-transparent disabled:cursor-not-allowed';

/**
 * Column widths, shared by the rows and by the single heading above them. The
 * heading only stays honest if it is the same width as the column it names, so
 * neither side gets to hand-copy the number.
 */
const STEP_COL_INDEX = 'w-4';
const STEP_COL_ICON = 'w-6';
const STEP_COL_NAME = 'w-52';
const STEP_COL_ACTIONS = 'w-[46px]';

/**
 * Footer CTA captions. The editor's own wording is correct for the standalone
 * client; a host that binds flows at a different scope overrides them so the
 * button names the write it performs. See `DEFAULT_EDITOR_LABELS`.
 */
export interface FlowEditorLabels {
  save: string;
  /**
   * Confirmation shown in the Save button's place after a clean save. A
   * separate caption rather than a suffix rule: English past tense is not
   * mechanical, and appending "d" to the hub's "Save & publish to org" reads
   * as "Save & publish to orgd".
   */
  saved: string;
  useFlow: string;
}

/**
 * Standalone-client captions. "Save" persists a personal flow and "Use this
 * Flow" makes it this project's active flow — both accurate when one machine
 * owns the whole lifecycle. The hub admin passes different strings because
 * over there Save is the fleet-wide publish and "Use this Flow" only writes
 * an assignment row; see `EDITOR_LABELS_HUB` in hub-ui.
 */
export const DEFAULT_EDITOR_LABELS: FlowEditorLabels = {
  save: 'Save',
  saved: 'Saved',
  useFlow: 'Use this Flow',
};

function generateUUID(): string {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}

function makeFreshAnchors(): [FlowStep, FlowStep] {
  return [
    { id: generateUUID(), name: 'TODO', label: 'To Do', order: 0, exitCriteria: '', isAnchor: true },
    { id: generateUUID(), name: 'DONE', label: 'Done', order: 0, exitCriteria: '', isAnchor: true },
  ];
}

function cloneFlow(source: Flow, newName: string): Omit<Flow, 'id' | 'createdAt' | 'updatedAt'> & { id?: undefined } {
  const [todo, done] = makeFreshAnchors();
  const middle = source.steps
    .filter(s => !s.isAnchor)
    .map((s, i) => ({ ...s, id: generateUUID(), order: i + 1 }));
  done.order = middle.length + 1;
  return {
    name: newName,
    description: source.description,
    steps: [todo, ...middle, done],
  };
}

interface FlowEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  activeFlowId?: string;   // currently active flow id (undefined = default/builtin flow)
  initialFlowId?: string;  // pre-select this flow on open
  // When false, the editor hides its flow-*selection* actions ("Use this Flow").
  // Used by hub-connected installations, where team-flow selection is owned by
  // the hub (Org Flows picker) — the client may only author + publish. Defaults
  // to true (standalone installs and the hub admin, where it means set-default).
  canSelectFlow?: boolean;
  // When true, a flow with source='hub' is presented as owned elsewhere and is
  // not editable here. Set by the local agenfk UI, whose server answers any
  // mutation of a hub-sourced flow with 409 (BUG 269eeec8 (b)) — offering Save
  // was offering a guaranteed failure. The hub admin leaves this false: over
  // there, hub-sourced flows are exactly the ones you are meant to edit.
  hubManagedReadOnly?: boolean;
  /**
   * Tab captions. Defaults to "My Flows" / "Community", which is correct for
   * the standalone client. The hub admin overrides them: its first tab is the
   * org-wide catalogue rather than a personal list, and its registry tab lists
   * whatever repo the org configured — after CGLAB-138 that is often a PRIVATE
   * repo, where the word "Community" would describe the opposite of what the
   * tab shows.
   */
  tabLabels?: { myFlows?: string; registry?: string };
  /**
   * Footer CTA captions. Defaults to "Save" / "Use this Flow", which is right
   * for the standalone client. The hub admin overrides them: there, saving the
   * row IS the fleet-wide publish (the bumped `version` is the ETag every
   * installation polls), and the selection button writes an org-default
   * assignment rather than "using" anything. Same reasoning as `tabLabels`.
   */
  /**
   * Footer CTA captions, supplied by the host. Read from host context rather
   * than as a prop, so it follows the same path as `tabLabels` and every
   * nested editor sees one host.
   */
  labels?: Partial<FlowEditorLabels>;
  /** Optional host control above the registry search box (registry switcher). */
  registryToolbar?: React.ReactNode;
}

// Keep legacy Props alias so KanbanBoard can pass open= until it's updated
interface LegacyProps {
  open: boolean;
  onClose: () => void;
  flow?: Flow | null;
  projectId: string;
}

type Props = FlowEditorModalProps | LegacyProps;

function isLegacyProps(p: Props): p is LegacyProps {
  return 'open' in p;
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function makeBlankStep(order: number): FlowStep {
  return {
    id: generateId(),
    name: '',
    label: '',
    order,
    exitCriteria: '',
  };
}

/**
 * The flow definition in the shape the save mutation sends it: `name`,
 * `description`, and steps with `order` authoritative from array position.
 *
 * Used both to build the payload and to baseline the dirty check, so the two
 * are comparable. The projection is deliberately narrow and ordered:
 *
 * - **Step ids are excluded.** Both servers run steps through
 *   `normalizeFlowSteps`, which re-issues an id for any step that arrives
 *   without one or with a duplicate. A baseline that carried the id the editor
 *   generated could never match the row that came back, so every save would
 *   leave the panel looking dirty.
 * - **Keys are emitted in a fixed order and absent fields are dropped.**
 *   `JSON.stringify` follows insertion order, so a baseline built from the
 *   loaded row and a comparison built from the edited state would disagree on
 *   key order alone. `{ exitCriteria: '' }` and `{}` are also the same step to
 *   the server, which drops empty fields on the round-trip.
 */
function serializeDefinition(
  name: string,
  description: string,
  steps: FlowStep[],
): string {
  const canonical = (Array.isArray(steps) ? steps : [])
    .map((s, i) => ({
      name: s?.name ?? '',
      label: s?.label ?? '',
      order: i,
      ...(s?.exitCriteria ? { exitCriteria: s.exitCriteria } : {}),
      ...(s?.color ? { color: s.color } : {}),
      ...(s?.icon ? { icon: s.icon } : {}),
      ...(s?.isAnchor ? { isAnchor: true } : {}),
    }))
    .sort((a, b) => a.order - b.order);
  return JSON.stringify({ name, description, steps: canonical });
}

// ── Exit criteria summary trigger (CGLAB-109) ─────────────────────────────────
// The inline field that used to be a short-text textarea is now a compact,
// read-only summary: first line of the criteria (or an empty state) plus the
// token estimate. Clicking it opens the full popup editor
// (ExitCriteriaEditorModal) — the only place criteria are edited.
interface ExitCriteriaSummaryProps {
  index: number;
  value: string;
  disabled: boolean;
  onEdit: () => void;
  /**
   * CGLAB-164. A WORKING step with no exit criteria is a gate that does not
   * close — the gatekeeper reads this field and `agenfk verify` refuses without
   * it, so an empty one lets work through unchecked. That is legal, and worth
   * seeing, so it is stated in amber rather than rendered as a blank field.
   * Anchors pass `false`: TODO and DONE carry no criteria by design, and
   * flagging them would only teach the reader to ignore the colour.
   */
  warnWhenEmpty?: boolean;
}

const ExitCriteriaSummary: React.FC<ExitCriteriaSummaryProps> = ({ index, value, disabled, onEdit, warnWhenEmpty = false }) => {
  const trimmed = value.trim();
  const firstLine = trimmed.split('\n').find(l => l.trim()) ?? '';
  const tokens = estimateTokenCount(trimmed);
  const warn = !trimmed && warnWhenEmpty;
  return (
    <button
      data-testid={`step-exit-criteria-${index}`}
      type="button"
      disabled={disabled}
      onClick={onEdit}
      title={disabled ? undefined : 'Edit exit criteria (markdown)'}
      className={clsx(
        'w-full text-left px-2 py-1.5 rounded-md border transition-colors disabled:opacity-60 disabled:cursor-not-allowed',
        warn
          ? 'border-amber-300 dark:border-amber-500/50 bg-amber-50 dark:bg-amber-900/20 hover:border-amber-400 dark:hover:border-amber-400'
          : 'border-border-soft bg-canvas hover:border-border-brand'
      )}
    >
      {firstLine ? (
        <span className="text-xs text-ink-secondary line-clamp-3">{firstLine}</span>
      ) : warn ? (
        <span
          data-testid={`step-exit-criteria-empty-${index}`}
          className="flex items-start gap-1 text-xs text-amber-700 dark:text-amber-400"
        >
          <AlertTriangle size={12} className="shrink-0 mt-0.5" />
          <span>No exit criteria — this step lets work through unchecked.</span>
        </span>
      ) : (
        <span className="block text-xs italic text-ink-tertiary">
          No exit criteria — click to add
        </span>
      )}
      <span className="block text-[10px] tabular-nums text-ink-tertiary mt-0.5">
        ~{tokens} {tokens === 1 ? 'token' : 'tokens'} (estimate){disabled ? '' : warn ? ' · add' : ' · edit'}
      </span>
    </button>
  );
};

// ── Inner editor component (right panel) ──────────────────────────────────────

interface EditorPanelProps {
  flow: Flow | null;             // null = new flow
  isReadOnly: boolean;
  projectId: string;
  activeFlowId: string | undefined;
  onSaved: (flow: Flow) => void;
  onClose: () => void;
  onClone?: () => void;
  onUseDefault?: () => void;    // only provided for the builtin default flow row
  canSelectFlow: boolean;       // false → hide "Use this Flow" (selection is hub-owned)
  isHubManaged: boolean;        // true → owned by the org Hub, not editable here
}

const EditorPanel: React.FC<EditorPanelProps> = ({
  flow,
  isReadOnly: isBuiltinReadOnly,
  projectId,
  activeFlowId,
  onSaved,
  onClose,
  onClone,
  onUseDefault,
  canSelectFlow,
  isHubManaged,
}) => {
  // Two independent reasons this panel can't be edited: it's the built-in
  // default flow, or (BUG 269eeec8 (b)) it's owned by the org Hub and this host
  // can only read it. They render different badges but lock the same controls.
  const isReadOnly = isBuiltinReadOnly || isHubManaged;

  const queryClient = useQueryClient();
  const flowClient = useFlowClient();
  const registryClient = useRegistryClient();
  const labels = useEditorLabels();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [steps, setSteps] = useState<FlowStep[]>([]);
  /** Step ids whose key is already on the server. See the load effect. */
  const [savedKeys, setSavedKeys] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useState(false);
  // The definition as last persisted, as the editor serialises it. `saved`
  // alone cannot answer "is there an unsaved edit?": it is a badge flag that
  // every keystroke clears, so it cannot distinguish a freshly-loaded row from
  // a loaded row the admin has since renamed. "Use this Flow" needs that
  // distinction — it binds an id, and binding while the panel holds edits
  // silently assigns the version that is already on the server.
  const [persisted, setPersisted] = useState<string | null>(null);
  const [openIconPickerIndex, setOpenIconPickerIndex] = useState<number | null>(null);
  // CGLAB-164: the description is written once and rarely reopened, so it sits
  // collapsed in the header meta line instead of taking a third of the height
  // above the steps — which are what this screen is opened to change.
  // Deliberately NOT reset when the selected flow changes (unlike name /
  // description / steps below): whether the reader wants the description open
  // is a preference about the view, not a property of the flow being viewed.
  const [descriptionOpen, setDescriptionOpen] = useState(false);
  // CGLAB-109: which step's exit criteria are open in the popup editor.
  const [exitCriteriaEditIndex, setExitCriteriaEditIndex] = useState<number | null>(null);

  // Loads a freshly-selected flow into the form. Keyed on the flow's IDENTITY,
  // not on the object: saving a new flow hands the parent a new `flow` for the
  // same row, and re-running this effect would reset the form to the stale
  // object the sidebar still holds (pre-save name) and drop the "Saved" badge
  // and the dirty baseline the save just established. A refetch that returns
  // genuinely edited content for the SAME id is deliberately not re-loaded —
  // that would clobber an admin's in-progress edits mid-typing.
  const flowId = flow?.id ?? null;
  useEffect(() => {
    if (flow) {
      setName(flow.name);
      setDescription(flow.description ?? '');
      // Filter out platform statuses — they are never part of flow definitions
      const flowSteps = [...flow.steps]
        .filter(s => {
          const upper = s.name.toUpperCase();
          return upper === 'TODO' || upper === 'DONE' || !RESERVED_NAMES.has(upper);
        })
        .sort((a, b) => a.order - b.order);
      setSteps(flowSteps);
      /*
       * The keys that already exist OUT THERE. A step loaded from the server
       * has a status items may already hold, and `PUT /flows/:id` does not
       * migrate anything across a rename — so nothing typed into a label may
       * move it. A step added in this session is not in this set, and its key
       * is simply the spelling of its label until it is saved.
       */
      setSavedKeys(new Set(flowSteps.map(s => s.id)));
      // Baseline the dirty check on the SAME canonical shape the save mutation
      // sends, so a round-trip through the editor is not itself a change.
      setPersisted(serializeDefinition(flow.name, flow.description ?? '', flowSteps));
    } else {
      setName('');
      setDescription('');
      const [todo, done] = makeFreshAnchors();
      const blank = makeBlankStep(1);
      done.order = 2;
      setSteps([todo, blank, done]);
      // Nothing persisted at all — an unsaved new flow is dirty by definition.
      setPersisted(null);
    }
    setSaved(false);
    // `flow` is read but intentionally not a dependency — see the note above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowId]);

  // Validate: any non-anchor step name that matches a reserved name is invalid
  const reservedNameError = steps.some(s => {
    if (s.isAnchor) return false;
    const upper = s.name.toUpperCase();
    return RESERVED_NAMES.has(upper);
  });

  // ── Drag-to-reorder (native HTML5 DnD) ──────────────────────────────────────
  const dragIndexRef = useRef<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const handleDragStart = useCallback((index: number) => {
    dragIndexRef.current = index;
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    setDragOverIndex(index);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, dropIndex: number) => {
    e.preventDefault();
    const dragIndex = dragIndexRef.current;
    if (dragIndex === null || dragIndex === dropIndex) {
      setDragOverIndex(null);
      dragIndexRef.current = null;
      return;
    }
    setSteps(prev => {
      const next = [...prev];
      const [moved] = next.splice(dragIndex, 1);
      next.splice(dropIndex, 0, moved);
      return next.map((s, i) => ({ ...s, order: i }));
    });
    setDragOverIndex(null);
    dragIndexRef.current = null;
  }, []);

  const handleDragEnd = useCallback(() => {
    setDragOverIndex(null);
    dragIndexRef.current = null;
  }, []);

  // ── Step helpers ─────────────────────────────────────────────────────────────
  const updateStep = useCallback((index: number, patch: Partial<FlowStep>) => {
    setSteps(prev => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }, []);

  const addStep = useCallback(() => {
    setSteps(prev => [...prev, makeBlankStep(prev.length)]);
  }, []);

  const removeStep = useCallback((index: number) => {
    setSteps(prev => {
      const next = prev.filter((_, i) => i !== index);
      return next.map((s, i) => ({ ...s, order: i }));
    });
  }, []);

  // ── Mutations ────────────────────────────────────────────────────────────────

  /**
   * Persist the panel as it currently stands. Shared by the Save button and by
   * the two actions that cannot mean anything until the definition is on the
   * server (binding, publishing).
   */
  const persist = useCallback(async (): Promise<Flow> => {
    const payload: Partial<Flow> = {
      name,
      description,
      // order is authoritative from array position; ids are backfilled so a
      // flow loaded without them (MCP create_flow never sent ids) still
      // satisfies the Hub's id rule.
      steps: withStepIds(steps, generateUUID).map((s, i) => ({ ...s, order: i })),
    };
    const saved = flow?.id
      ? await flowClient.updateFlow(flow.id, payload)
      : await flowClient.createFlow(payload);
    // What was typed this session is now a status on the server, so it stops
    // following its label from here on.
    setSavedKeys(new Set(steps.map(st => st.id)));
    return saved;
  }, [flow?.id, name, description, steps, flowClient]);

  /**
   * Re-baseline the dirty check after a write.
   *
   * The baseline comes from the SERVER's response, not from what the panel
   * sent. Both servers normalise steps on the way in — `normalizeFlowSteps`
   * whitelists the fields and re-issues duplicate or missing ids — so
   * comparing the panel against the request would leave a legitimate write
   * looking permanently dirty, and every subsequent bind/publish would fire a
   * redundant save.
   */
  const rebaseOn = useCallback((savedFlow: Flow | undefined | null) => {
    if (!savedFlow) return;
    setPersisted(serializeDefinition(
      savedFlow.name,
      savedFlow.description ?? '',
      [...(savedFlow.steps ?? [])].sort((a, b) => a.order - b.order),
    ));
  }, []);

  const saveMutation = useMutation({
    mutationFn: persist,
    onSuccess: (savedFlow) => {
      queryClient.invalidateQueries({ queryKey: ['flows'] });
      queryClient.invalidateQueries({ queryKey: ['flow', projectId] });
      rebaseOn(savedFlow);
      setSaved(true);
      onSaved(savedFlow);
    },
  });

  const useFlowMutation = useMutation({
    // Binding an id is only meaningful once the definition behind that id is
    // stored. This mutation used to bind `flow.id` straight away, so with
    // unsaved edits in the panel it assigned the version already on the server
    // and reported success — the admin's edits were silently dropped. Save
    // first, then bind the id that now points at those edits.
    //
    // The bind happens HERE, not in onSuccess. Saving a brand-new flow makes
    // the parent adopt its id, which remounts this panel; a success callback
    // firing into a component that has already unmounted would bind whatever
    // id its closure still held — for a new flow, `undefined`, which the host
    // reads as "clear the binding" rather than "bind what I just created".
    mutationFn: async () => {
      const current = isDirty ? await persist() : (flow as Flow);
      await flowClient.setProjectFlow(projectId, current.id);
      return current;
    },
    onSuccess: (current) => {
      rebaseOn(current);
      queryClient.invalidateQueries({ queryKey: ['flows'] });
      queryClient.invalidateQueries({ queryKey: ['flow', projectId] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      setSaved(true);
      onSaved(current);
    },
  });

  const isBusy = saveMutation.isPending || useFlowMutation.isPending;

  /**
   * Whether the panel holds an edit the server does not have. An unsaved new
   * flow (no persisted baseline) is always dirty; an existing flow is dirty
   * when its serialised definition differs from the one it was loaded with or
   * last saved.
   */
  const isDirty = persisted === null || serializeDefinition(name, description, steps) !== persisted;

  // BUG 269eeec8 (a): read the server's `{ error }` body, not Error.message —
  // the latter is only ever "Request failed with status code N".
  const failure = saveMutation.error ?? useFlowMutation.error ?? null;
  const errorMsg = failure ? extractApiError(failure, 'Failed to save flow.') : null;

  // BUG 269eeec8 (c): mirror the Hub's definition contract so a payload it would
  // reject never leaves the browser, and the reason is pinned to its step.
  const definitionIssues = flowDefinitionIssues(name, steps);
  const isSaveDisabled = isBusy || reservedNameError || definitionIssues.length > 0;

  /**
   * Whether this panel can write its definition at all. The two read-only
   * cases — the built-in default flow and a hub-owned flow on a client that
   * may only read it — are where the server refuses the write outright.
   */
  const canSave = !isReadOnly;

  /** Why Save/Publish are dead. Surfaced as the button's tooltip. */
  const saveBlockedReason = reservedNameError
    ? 'A step uses a reserved name (TODO, DONE, BLOCKED, PAUSED, IDEAS, ARCHIVED, TRASHED)'
    : definitionIssues[0]?.message ?? 'Fix the highlighted step first';

  // Every reason Save is blocked MUST be visible somewhere, or the user is left
  // with a dead button and no way to fix it — the exact failure mode this whole
  // change exists to kill. Per-step messages render inside the step column, but
  // only for non-anchor steps (anchors expose no name field), and a flow-level
  // issue has no column at all. Surface anything that would otherwise be silent.
  // A step column renders its own issue only when it has an editable name field
  // (anchors don't) and isn't already showing the reserved-name message.
  const stepShowsOwnIssue = (index: number): boolean => {
    const step = steps[index];
    if (!step || step.isAnchor) return false;
    return !RESERVED_NAMES.has((step.name ?? '').toUpperCase());
  };
  const silentIssues = definitionIssues.filter(
    issue => issue.stepIndex === undefined || !stepShowsOwnIssue(issue.stepIndex),
  );

  const isActive = flow?.id !== undefined && flow.id === activeFlowId;

  // ── Publish to registry ──────────────────────────────────────────────────
  const [publishResult, setPublishResult] = useState<{ url: string; kind: 'pr' | 'existing' | 'direct' } | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);

  /**
   * Whether this host can publish at all. Optional on `RegistryClient` because
   * the hub admin cannot (its PAT is hub-held and there is no publish route),
   * and a button wired to a function that only rejects is not an action — it
   * is a way to discover a dead end.
   */
  const canPublish = typeof registryClient.publishToRegistry === 'function';

  const publishMutation = useMutation({
    // Publishing pushes the SERVER's copy of the flow, so unsaved edits would
    // not be in it. Save first when there are any, then publish the id that
    // carries them — the same ordering rule as the bind path above.
    mutationFn: async () => {
      if (!canPublish) throw new Error('This host cannot publish flows.');
      let id = flow?.id;
      if (isDirty || !id) {
        const saved = await persist();
        rebaseOn(saved);
        id = saved?.id;
      }
      if (!id) throw new Error('Flow must be saved before publishing.');
      return registryClient.publishToRegistry!(id);
    },
    onSuccess: (data) => {
      setPublishResult({ url: data.url, kind: data.kind ?? 'pr' });
      setPublishError(null);
      setSaved(true);
    },
    onError: (e: unknown) => {
      setPublishError(extractApiError(e, 'Failed to publish.'));
    },
  });

  // Rendered alongside the footer that owns the button — a button whose
  // outcome renders in a different footer is a silent failure.
  const publishFeedback = (
    <>
      {publishResult && (
        <a
          data-testid="publish-success-link"
          href={publishResult.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400 font-semibold hover:underline"
        >
          <ExternalLink size={12} />
          {publishResult.kind === 'pr' ? 'PR opened — view on GitHub' : 'Already published — view on registry'}
        </a>
      )}
      {publishError && (
        <p data-testid="publish-error" className="text-xs text-red-600 dark:text-red-400 flex items-center gap-1">
          <AlertCircle size={11} />
          {publishError}
        </p>
      )}
    </>
  );

  return (
    <div className="flex flex-col h-full" data-testid="editor-panel">
      {/* Right panel header — inline-editable flow name, then a meta line
          carrying the step count, the version and the description disclosure.
          CGLAB-164: the description used to be the first block of the
          scrollable body, between the name and the steps; it pushed the step
          list — the reason the screen is open — below the fold. */}
      <div className="px-6 pt-5 pb-3 shrink-0" data-testid="flow-editor-header">
        <div className="flex items-center gap-2 mb-1.5">
          {isHubManaged ? (
            <span
              data-testid="hub-managed-badge"
              title="This flow is managed by your organization's Hub. Edit it in the Hub admin, or clone it to author a local copy."
              className="text-xs font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-300"
            >
              Managed by Hub
            </span>
          ) : isBuiltinReadOnly ? (
            <span className="text-xs font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-chip text-ink-secondary">
              Default (read-only)
            </span>
          ) : (
            <>
              {isActive && (
                <span
                  data-testid="active-badge"
                  className="text-xs font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-chip text-accent-text"
                >
                  Active
                </span>
              )}
            </>
          )}
        </div>
        {isReadOnly ? (
          // Don't hardcode "Default Flow" — this branch now also renders
          // hub-managed flows, which have their own names.
          <h3 data-testid="flow-name-heading" className="text-xl font-bold text-ink">
            {isHubManaged ? name || flow?.name : 'Default Flow'}
          </h3>
        ) : (
          <input
            data-testid="flow-name-input"
            type="text"
            value={name}
            onChange={e => { setName(e.target.value); setSaved(false); }}
            placeholder="Flow name…"
            className="w-full text-xl font-bold text-ink bg-transparent border-b-2 border-transparent hover:border-border-brand focus:border-brand focus:outline-none placeholder-ink-tertiary transition-colors pb-0.5"
          />
        )}

        {/* Meta line: step count · version · description disclosure */}
        <div className="flex items-center flex-wrap gap-2 mt-1.5 text-xs text-ink-secondary">
          <span data-testid="flow-step-count">
            {steps.length} {steps.length === 1 ? 'step' : 'steps'}
          </span>
          {flow?.version && (
            <>
              <span aria-hidden="true">·</span>
              <span
                data-testid="flow-version-badge"
                className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-canvas text-ink-secondary"
              >
                v{flow.version}
              </span>
            </>
          )}
          <span aria-hidden="true">·</span>
          <button
            data-testid="flow-description-toggle"
            type="button"
            aria-expanded={descriptionOpen}
            aria-controls="flow-description-field"
            onClick={() => setDescriptionOpen(open => !open)}
            className="inline-flex items-center gap-0.5 rounded hover:text-ink focus:outline-none focus:ring-1 focus:ring-brand transition-colors"
          >
            <ChevronRight size={12} className={clsx('transition-transform', descriptionOpen && 'rotate-90')} />
            description
            {description.trim() !== '' && (
              <>
                <span
                  data-testid="flow-description-indicator"
                  aria-hidden="true"
                  className="ml-0.5 w-1.5 h-1.5 rounded-full bg-ink-tertiary"
                />
                <span className="sr-only"> (this flow has one)</span>
              </>
            )}
          </button>
        </div>
        {descriptionOpen && (
          <textarea
            data-testid="flow-description-input"
            id="flow-description-field"
            value={description}
            onChange={e => { setDescription(e.target.value); setSaved(false); }}
            rows={2}
            placeholder="Optional description of this flow"
            disabled={isReadOnly}
            className="w-full mt-2 px-3 py-2 rounded-lg border border-border-soft bg-canvas text-ink text-sm focus:outline-none focus:ring-2 focus:ring-brand resize-none disabled:opacity-60 disabled:cursor-not-allowed"
          />
        )}
      </div>

      {/* Scrollable form body */}
      <div className="flex-1 overflow-y-auto px-6 pb-4 space-y-5 [&::-webkit-scrollbar]:hidden" style={{ msOverflowStyle: 'none', scrollbarWidth: 'none' } as React.CSSProperties}>

        {/* Steps */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs font-semibold text-ink-secondary uppercase tracking-wide">
              Steps
            </label>
            {!isReadOnly && (
              <button
                data-testid="add-step-btn"
                type="button"
                onClick={addStep}
                className="flex items-center gap-1 text-xs font-semibold text-accent-text hover:opacity-80 transition-colors"
              >
                <Plus size={14} />
                Add Step
              </button>
            )}
          </div>

          {/* CGLAB-164: one ROW per step, read top to bottom.

              This was a horizontal kanban strip of w-52 columns, which put
              664px of steps past the right edge and made drag-to-reorder a
              drag across a scroll — one of the hardest interactions there is.
              Vertical shows the whole flow at once, the numbers carry the
              order, and "name (key)" / "label (display)" stop being repeated
              once per step: they are a column heading now, stated once. */}
          <div className="flex flex-col gap-2 pb-2" data-testid="steps-columns">
            <div
              data-testid="steps-header-row"
              className="flex items-center gap-3 text-[10px] font-semibold uppercase tracking-wide text-ink-tertiary"
              style={{ paddingLeft: `calc(0.75rem + ${STEP_STRIPE_WIDTH + 1}px)`, paddingRight: '0.75rem' }}
            >
              <span className={clsx(STEP_COL_INDEX, 'shrink-0 text-right')}>#</span>
              <span className={clsx(STEP_COL_ICON, 'shrink-0')} aria-hidden="true" />
              <span className={clsx(STEP_COL_NAME, 'shrink-0')}>name · label</span>
              <span className="flex-1 min-w-0">exit criteria</span>
              <span className={clsx(STEP_COL_ACTIONS, 'shrink-0')} aria-hidden="true" />
            </div>

            {steps.map((step, index) => {
              const isAnchor = !!step.isAnchor;
              const isTodoAnchor = isAnchor && step.name.toUpperCase() === 'TODO';
              const isDoneAnchor = isAnchor && step.name.toUpperCase() === 'DONE';
              const isStepLocked = isReadOnly || isAnchor;
              const stepNameUpper = step.name.toUpperCase();
              const hasReservedName = !isAnchor && RESERVED_NAMES.has(stepNameUpper);
              // A reserved name has its own dedicated message below, so only
              // show the shape issue when that isn't already being reported.
              const shapeIssue = stepShowsOwnIssue(index) ? stepIssue(definitionIssues, index) : undefined;
              const stepColor = step.color ?? '#04cc98';
              const anchorColor = isDoneAnchor ? '#10b981' : '#94a3b8';
              // Short flows always have room below; long ones do not, for the
              // rows past the midpoint. This is a HEURISTIC, not a solution:
              // the predicate is the row's index in the list, while the real
              // constraint is where the scroller happens to be parked. Swept
              // across every scroll position of a 16-step flow at 1280x720, it
              // leaves the popover fully visible 85% of the time against 77%
              // for always-below and 81% for always-above — better on every
              // row and worse on none, but rows in the FIRST half still clip
              // about a fifth of the time. Measuring the badge against the
              // scroller's viewport is the real fix; see the card's follow-up.
              const iconPickerAbove = steps.length > 5 && index > steps.length / 2;

              return (
                <div
                  key={step.id}
                  data-testid={`step-row-${index}`}
                  draggable={!isStepLocked}
                  onDragStart={() => !isStepLocked && handleDragStart(index)}
                  onDragOver={e => !isStepLocked && handleDragOver(e, index)}
                  onDrop={e => !isStepLocked && handleDrop(e, index)}
                  onDragEnd={handleDragEnd}
                  className={clsx(
                    // Left corners square so the colour rail can be flush
                    // against them; see STEP_STRIPE_CLASS.
                    'flex w-full items-stretch rounded-r-xl border transition-all',
                    // Anchors are scaffolding, not work: dashed and dimmed so
                    // the eye skips them on the way down the list.
                    isAnchor
                      ? 'border-dashed bg-canvas border-border-soft opacity-70'
                      : dragOverIndex === index
                      ? 'bg-canvas border-border-brand shadow-md'
                      : 'bg-canvas border-border-soft'
                  )}
                >
                  {/* The colour, as a 4px stripe on the leading edge. It used
                      to be a 16px swatch sitting next to the icon badge, where
                      the two competed for the same 40px and the coloured fill
                      swallowed the glyph. On the edge it reads as a stripe down
                      the whole list at a glance — which is what a per-step
                      colour is FOR — and on a working step the stripe IS the
                      picker: the native input lies transparent on top of it. */}
                  {isAnchor ? (
                    <div
                      data-testid={`step-color-swatch-${index}`}
                      className={STEP_STRIPE_CLASS}
                      style={{ width: STEP_STRIPE_WIDTH, backgroundColor: anchorColor }}
                      title="Step color (fixed for anchor steps)"
                    />
                  ) : (
                    <div
                      data-testid={`step-color-stripe-${index}`}
                      className={clsx('relative focus-within:ring-2 focus-within:ring-brand', STEP_STRIPE_CLASS)}
                      style={{ width: STEP_STRIPE_WIDTH, backgroundColor: stepColor }}
                    >
                      <input
                        data-testid={`step-color-${index}`}
                        type="color"
                        value={stepColor}
                        onChange={e => updateStep(index, { color: e.target.value })}
                        disabled={isReadOnly}
                        aria-label={`Step ${index + 1} color`}
                        title={isReadOnly ? 'Step color' : 'Step color — click to pick'}
                        className={STEP_COLOR_INPUT_CLASS}
                      />
                    </div>
                  )}

                  <div className="flex-1 min-w-0 flex items-start gap-3 px-3 py-2.5">
                    {/* Position in the flow — the order the strip used to carry
                        by being horizontal. */}
                    <span
                      data-testid={`step-index-${index}`}
                      className={clsx(STEP_COL_INDEX, 'shrink-0 pt-1 text-right text-xs font-mono tabular-nums text-ink-tertiary')}
                    >
                      {index + 1}
                    </span>

                    {/* Icon badge — still a button, still the same 17-icon
                        popover; it just no longer carries the colour fill. */}
                    {isAnchor ? (
                      <div
                        data-testid={`step-anchor-lock-${index}`}
                        className={clsx(STEP_COL_ICON, 'h-6 shrink-0 flex items-center justify-center rounded border border-dashed border-border-soft text-ink-tertiary')}
                        title="Anchor step — cannot be moved or deleted"
                      >
                        <Lock size={12} />
                      </div>
                    ) : (
                      <div className="relative shrink-0">
                        <button
                          data-testid={`step-icon-btn-${index}`}
                          type="button"
                          disabled={isReadOnly}
                          onClick={() => setOpenIconPickerIndex(openIconPickerIndex === index ? null : index)}
                          title="Pick step icon"
                          className={clsx(STEP_COL_ICON, 'h-6 flex items-center justify-center rounded border border-border-soft text-ink-secondary hover:bg-chip transition-colors disabled:opacity-50 disabled:cursor-not-allowed')}
                        >
                          {renderStepIcon(step.icon, <Zap size={12} />)}
                        </button>
                        {openIconPickerIndex === index && !isReadOnly && (
                          <div
                            data-testid={`step-icon-picker-${index}`}
                            data-placement={iconPickerAbove ? 'above' : 'below'}
                            className={clsx(
                              'absolute left-0 z-50 bg-surface border border-border-soft rounded-lg shadow-lg p-2 grid grid-cols-6 gap-1 w-44',
                              iconPickerAbove ? 'bottom-7' : 'top-7'
                            )}
                          >
                            {STEP_ICON_OPTIONS.map(opt => (
                              <button
                                key={opt.key}
                                data-testid={`step-icon-option-${index}-${opt.key}`}
                                type="button"
                                title={opt.label}
                                aria-pressed={step.icon === opt.key}
                                onClick={() => { updateStep(index, { icon: opt.key }); setOpenIconPickerIndex(null); }}
                                className={clsx(
                                  'w-6 h-6 flex items-center justify-center rounded transition-colors text-ink-secondary',
                                  step.icon === opt.key
                                    ? 'bg-chip text-accent-text'
                                    : 'hover:bg-chip'
                                )}
                              >
                                {opt.node}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Name (the key) and label (what the board shows). */}
                    <div className={clsx(STEP_COL_NAME, 'shrink-0 min-w-0')}>
                      {isAnchor ? (
                        <>
                          <p className="text-xs font-mono uppercase tracking-wide text-ink-secondary truncate">
                            {step.name}
                          </p>
                          <p className="text-xs text-ink-tertiary truncate">
                            {step.label}
                          </p>
                        </>
                      ) : (
                        <>
                          {/* The key is DERIVED, and shown the way the anchors
                              show theirs — one cell, key over label, which is
                              how the artifact draws it (aca414c7 §01). It was
                              a second bordered input, stacked on the label's,
                              and that made a spelling of the label look like a
                              separate thing to invent. It stays visible
                              because it is the value `agenfk update --status`
                              takes: derived is not the same as hidden. */}
                          {/* Announced as it is written: a screen-reader user
                              typing the label would otherwise never learn what
                              key they just created. No `uppercase` class — the
                              derivation already upcases, and a legacy key like
                              `in_review` displayed as IN_REVIEW is a lie the
                              server will not honour, since transitions match
                              the status exactly. */}
                          <p
                            data-testid={`step-name-${index}`}
                            aria-live="polite"
                            aria-label={step.name
                              ? `Step ${index + 1} key: ${step.name}`
                              : `Step ${index + 1} key, derived from the label`}
                            className={clsx(
                              'text-xs font-mono tracking-wide truncate px-2 py-1',
                              hasReservedName ? 'text-danger-text' : 'text-ink-secondary',
                            )}
                          >
                            {step.name || <span className="text-ink-tertiary">from the label</span>}
                          </p>
                          {shapeIssue && (
                            <p id={`step-name-error-${index}`} data-testid={`step-name-error-${index}`} className="text-xs text-danger-text mt-0.5 px-2">
                              {shapeIssue.message}
                            </p>
                          )}
                          {hasReservedName && (
                            <p id={`step-reserved-error-${index}`} data-testid={`step-reserved-error-${index}`} className="text-xs text-danger-text mt-0.5 px-2">
                              Reserved name
                            </p>
                          )}
                          <input
                            data-testid={`step-label-${index}`}
                            type="text"
                            value={step.label}
                            onChange={e => updateStep(index, {
                              label: e.target.value,
                              name: nextStepName({
                                storedName: step.name,
                                nextLabel: e.target.value,
                                keyIsPersisted: savedKeys.has(step.id),
                              }),
                            })}
                            aria-invalid={hasReservedName || !!shapeIssue || undefined}
                            // Both messages sit ABOVE the field, so tabbing
                            // into it announced nothing about the error it
                            // caused.
                            aria-describedby={clsx(
                              shapeIssue && `step-name-error-${index}`,
                              hasReservedName && `step-reserved-error-${index}`,
                            ) || undefined}
                            placeholder="e.g. In Progress"
                            disabled={isStepLocked}
                            aria-label={`Step ${index + 1} label (display)`}
                            className="w-full mt-1 px-2 py-1 rounded-md border border-border-soft bg-surface text-ink text-xs focus:outline-none focus:ring-1 focus:ring-brand disabled:opacity-60"
                          />
                        </>
                      )}
                    </div>

                    {/* Exit criteria — the most consequential field on the
                        screen (the gatekeeper reads it and `agenfk verify`
                        refuses without it), so it gets the width that is left
                        rather than a truncated line. CGLAB-109 keeps the popup
                        as the only place they are edited. */}
                    <div className="flex-1 min-w-0">
                      {isDoneAnchor ? (
                        <p className="text-xs italic text-ink-tertiary pt-1">
                          Anchor. Reachable only through <span className="font-mono not-italic">agenfk verify</span> on the final step.
                        </p>
                      ) : (
                        <ExitCriteriaSummary
                          index={index}
                          value={step.exitCriteria ?? ''}
                          disabled={isReadOnly}
                          warnWhenEmpty={!isAnchor}
                          onEdit={() => setExitCriteriaEditIndex(index)}
                        />
                      )}
                      {isTodoAnchor && (
                        <p className="text-[10px] text-ink-tertiary mt-0.5">
                          Anchor. Not reorderable, not deletable.
                        </p>
                      )}
                    </div>

                    {/* Reorder / delete, or the anchor badge that explains why
                        neither is offered. */}
                    <div className={clsx(STEP_COL_ACTIONS, 'shrink-0 flex items-center justify-end gap-1 pt-1')}>
                      {isAnchor ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-chip text-ink-secondary font-medium">
                          anchor
                        </span>
                      ) : (
                        <>
                          <div
                            className={clsx(
                              'shrink-0',
                              isReadOnly
                                ? 'text-ink-tertiary'
                                : 'cursor-grab active:cursor-grabbing text-ink-tertiary hover:text-ink'
                            )}
                            title={isReadOnly ? undefined : 'Drag to reorder'}
                          >
                            <GripVertical size={16} />
                          </div>
                          {!isReadOnly && (
                            <button
                              data-testid={`delete-step-${index}`}
                              type="button"
                              onClick={() => removeStep(index)}
                              title="Remove step"
                              className="p-1 rounded-lg transition-colors text-ink-tertiary hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
                            >
                              <Trash2 size={14} />
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {/* Reserved name global error */}
          {silentIssues.length > 0 && (
            <ul data-testid="flow-definition-issues" className="text-sm text-red-600 dark:text-red-400 mt-1 list-disc pl-5">
              {silentIssues.map((issue, i) => (
                <li key={i}>
                  {issue.stepIndex === undefined
                    ? issue.message
                    : `${steps[issue.stepIndex]?.label || steps[issue.stepIndex]?.name || `Step ${issue.stepIndex + 1}`}: ${issue.message}`}
                </li>
              ))}
            </ul>
          )}
          {reservedNameError && (
            <p data-testid="reserved-name-error" className="text-sm text-red-600 dark:text-red-400 mt-1">
              One or more step names use a reserved name (TODO, DONE, BLOCKED, PAUSED, IDEAS, ARCHIVED, TRASHED).
            </p>
          )}
        </div>

        {/* Error */}
        {errorMsg && (
          <p data-testid="flow-editor-error" className="text-sm text-red-600 dark:text-red-400">
            {errorMsg}
          </p>
        )}
      </div>

      {/* Footer — sticky bottom.

          ONE footer, gated per capability rather than on `isReadOnly`. The two
          variants used to be chosen by read-only-ness, which is the wrong axis:
          it left a newly created flow (no id yet, so it took the read-only
          branch) with neither Save — which lived in the editable branch — nor
          Publish, which the read-only branch gated on `flow?.id`. Each control
          now renders iff the host can perform that action, and every control
          shares one row so a button's outcome always renders beside it. */}
      <div className="px-6 py-4 border-t border-border-soft shrink-0 flex flex-col gap-3" data-testid="flow-footer">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            {canSave && (
              <button
                data-testid="save-flow-btn"
                type="button"
                disabled={isSaveDisabled}
                onClick={() => saveMutation.mutate()}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold bg-[image:var(--gradient-accent)] text-navy shadow-glow hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {saved ? <Check size={15} /> : <Save size={15} />}
                {isBusy ? 'Saving…' : saved && !isDirty ? labels.saved : labels.save}
              </button>
            )}
            {onClone && (
              <button
                data-testid="clone-to-edit-btn"
                type="button"
                onClick={onClone}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold bg-[image:var(--gradient-accent)] text-navy shadow-glow hover:opacity-90 transition-colors"
              >
                <CopyPlus size={15} />
                Clone to Edit
              </button>
            )}
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {canPublish && (
              <button
                data-testid="publish-flow-btn"
                type="button"
                disabled={publishMutation.isPending || isSaveDisabled}
                title={isSaveDisabled ? saveBlockedReason : 'Publish this flow to the registry'}
                onClick={() => { setPublishResult(null); setPublishError(null); publishMutation.mutate(); }}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold border border-border-soft text-ink-secondary hover:text-accent-text hover:border-border-brand disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {publishMutation.isPending ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}
                {publishMutation.isPending ? 'Publishing…' : 'Publish'}
              </button>
            )}
            {onUseDefault && canSelectFlow && (
              <button
                data-testid="use-default-flow-btn"
                type="button"
                onClick={onUseDefault}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold bg-brand hover:opacity-90 text-navy transition-colors shadow-sm"
              >
                <GitBranch size={15} />
                {labels.useFlow}
              </button>
            )}
            {canSelectFlow && !isReadOnly && (
              <button
                data-testid="use-flow-btn"
                type="button"
                disabled={isSaveDisabled}
                onClick={() => useFlowMutation.mutate()}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold bg-brand hover:opacity-90 text-navy disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
              >
                <GitBranch size={15} />
                {labels.useFlow}
              </button>
            )}
            <button
              data-testid="cancel-panel-btn"
              type="button"
              onClick={onClose}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold border border-border-soft text-ink-secondary hover:bg-chip transition-colors"
            >
              Close
            </button>
          </div>
        </div>
        {publishFeedback}
      </div>

      {/* Exit criteria popup (CGLAB-109) — nested above this modal's z-50. */}
      {exitCriteriaEditIndex !== null && steps[exitCriteriaEditIndex] && (
        <ExitCriteriaEditorModal
          stepLabel={steps[exitCriteriaEditIndex].label || steps[exitCriteriaEditIndex].name}
          initialValue={steps[exitCriteriaEditIndex].exitCriteria ?? ''}
          onSave={v => {
            // The popup's Save commits a step field — mark the panel dirty so
            // the footer's "Saved" badge doesn't claim a clean state (F2,
            // CGLAB-109 review: the popup button is literally labelled Save).
            updateStep(exitCriteriaEditIndex, { exitCriteria: v });
            setSaved(false);
            setExitCriteriaEditIndex(null);
          }}
          onClose={() => setExitCriteriaEditIndex(null)}
        />
      )}
    </div>
  );
};

// ── Delete confirm inline ─────────────────────────────────────────────────────

interface DeleteConfirmProps {
  onConfirm: () => void;
  onCancel: () => void;
}

const DeleteConfirm: React.FC<DeleteConfirmProps> = ({ onConfirm, onCancel }) => (
  <span className="inline-flex items-center gap-1 text-xs" data-testid="delete-confirm">
    <span className="text-ink-secondary">Delete?</span>
    <button
      data-testid="delete-confirm-yes"
      onClick={e => { e.stopPropagation(); onConfirm(); }}
      className="px-1.5 py-0.5 rounded bg-red-600 text-white hover:bg-red-700 font-semibold"
    >
      Yes
    </button>
    <button
      data-testid="delete-confirm-no"
      onClick={e => { e.stopPropagation(); onCancel(); }}
      className="px-1.5 py-0.5 rounded bg-canvas text-ink hover:bg-chip font-semibold"
    >
      No
    </button>
  </span>
);

// ── Mermaid diagram for flow steps ───────────────────────────────────────────

/* v8 ignore start */
const FlowMermaid: React.FC<{ steps: { name: string; label: string }[] }> = ({ steps }) => {
  const ref = useRef<HTMLDivElement>(null);
  const theme = useEditorTheme();

  useEffect(() => {
    if (!ref.current || steps.length === 0) return;
    const id = `mermaid-flow-${Math.random().toString(36).substring(2, 9)}`;
    /*
     * Labels come from the community registry, so they are untrusted.
     *
     * An unescaped `"` terminated the quoted label and left a blank preview;
     * a newline injected extra statements into the chart source. Neither can
     * become script at 'strict' — the URL is sanitized and the final SVG goes
     * through DOMPurify — but the diagram is data, not source, and is escaped
     * as such (F1 from the CGLAB-187 adversarial review).
     */
    const escapeLabel = (raw: string): string =>
      raw.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/[\r\n]+/g, ' ');
    const nodes = steps.map((s, i) => `  ${i}["${escapeLabel(s.label || s.name)}"]`).join('\n');
    const edges = steps.slice(1).map((_, i) => `  ${i} --> ${i + 1}`).join('\n');
    const chart = `flowchart LR\n${nodes}\n${edges}`;
    // 'strict', NEVER 'loose' (CGLAB-187): a community flow is authored by
    // someone else, and at 'loose' Mermaid skips its own URL sanitization, so a
    // `javascript:` link in a step would survive into the SVG this injects with
    // innerHTML. See ReadmeModal.tsx for the desktop-escalation detail.
    mermaid.initialize({ startOnLoad: false, theme: theme === 'dark' ? 'dark' : 'default', securityLevel: 'strict' });
    mermaid.render(id, chart).then(({ svg }) => {
      if (ref.current) ref.current.innerHTML = svg;
    }).catch(() => {});
  }, [steps, theme]);

  return <div ref={ref} data-testid="community-flow-diagram" className="overflow-x-auto py-2" />;
};
/* v8 ignore stop */

// ── Community preview panel (right panel for community flows) ─────────────────

interface CommunityPreviewPanelProps {
  flow: RegistryFlow;
  onInstalled: (flow: Flow) => void;
  onCloneToEdit: (flow: Flow) => void;
}

const CommunityPreviewPanel: React.FC<CommunityPreviewPanelProps> = ({
  flow,
  onInstalled,
  onCloneToEdit,
}) => {
  const actionRef = useRef<'install' | 'clone'>('install');
  const registryClient = useRegistryClient();

  const installMutation = useMutation({
    mutationFn: (filename: string) => registryClient.installFromRegistry(filename),
    onSuccess: (installed: Flow) => {
      if (actionRef.current === 'install') {
        onInstalled(installed);
      } else {
        onCloneToEdit(installed);
      }
    },
  });

  return (
    <div className="flex flex-col h-full" data-testid="community-preview-panel">
      <div className="px-6 pt-6 pb-4 shrink-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-chip text-accent-text">
            Community
          </span>
        </div>
        <h3 className="text-xl font-bold text-ink">{flow.name}</h3>
      </div>

      <div className="flex-1 overflow-y-auto px-6 pb-4 space-y-4">
        <div className="grid grid-cols-2 gap-3">
          {flow.author && (
            <div>
              <p className="text-xs font-semibold text-ink-secondary uppercase tracking-wide mb-1">Author</p>
              <p className="text-sm text-ink">{flow.author}</p>
            </div>
          )}
          {flow.version && (
            <div>
              <p className="text-xs font-semibold text-ink-secondary uppercase tracking-wide mb-1">Version</p>
              <p className="text-sm text-ink">{flow.version}</p>
            </div>
          )}
          <div>
            <p className="text-xs font-semibold text-ink-secondary uppercase tracking-wide mb-1">Steps</p>
            <p className="text-sm text-ink">{flow.stepCount}</p>
          </div>
        </div>

        {flow.description && (
          <div>
            <p className="text-xs font-semibold text-ink-secondary uppercase tracking-wide mb-1">Description</p>
            <p className="text-sm text-ink-secondary">{flow.description}</p>
          </div>
        )}

        {flow.steps && flow.steps.length > 0 ? (
          <div className="rounded-lg bg-canvas border border-border-soft p-3">
            <p className="text-xs font-semibold text-ink-secondary uppercase tracking-wide mb-2">Flow</p>
            <FlowMermaid steps={flow.steps} />
          </div>
        ) : (
          <div className="rounded-lg bg-canvas border border-border-soft p-3">
            <p className="text-xs text-ink-secondary italic">
              Step details will be available after installation.
            </p>
          </div>
        )}

        {installMutation.isError && (
          <p data-testid="community-install-error" className="text-sm text-red-600 dark:text-red-400">
            {(installMutation.error as Error)?.message ?? 'Installation failed'}
          </p>
        )}
      </div>

      <div className="px-6 py-4 border-t border-border-soft shrink-0 flex items-center gap-3">
        <button
          data-testid="community-install-btn"
          type="button"
          disabled={installMutation.isPending}
          onClick={() => { actionRef.current = 'install'; installMutation.mutate(flow.filename); }}
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold bg-[image:var(--gradient-accent)] text-navy shadow-glow hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {installMutation.isPending ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
          Install
        </button>
        <button
          data-testid="community-clone-btn"
          type="button"
          disabled={installMutation.isPending}
          onClick={() => { actionRef.current = 'clone'; installMutation.mutate(flow.filename); }}
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold border border-border-soft text-ink-secondary hover:bg-chip transition-colors"
        >
          <CopyPlus size={15} />
          Clone to Edit
        </button>
      </div>
    </div>
  );
};

// ── Main modal ────────────────────────────────────────────────────────────────

const FlowEditorModalInner: React.FC<Props> = (props) => {
  // Normalise legacy vs new props
  const isLegacy = isLegacyProps(props);
  const isOpen = isLegacy ? props.open : props.isOpen;
  const onClose = props.onClose;
  const projectId = props.projectId;
  const activeFlowId = isLegacy ? undefined : (props as FlowEditorModalProps).activeFlowId;
  const initialFlowId = isLegacy
    ? (props as LegacyProps).flow?.id ?? undefined
    : (props as FlowEditorModalProps).initialFlowId;
  // Selection actions default on; hosts opt out (hub-connected clients).
  const canSelectFlow = isLegacy ? true : ((props as FlowEditorModalProps).canSelectFlow ?? true);
  // Defaults false so the hub admin — which must edit hub-sourced flows — keeps
  // working without opting out; only the local agenfk UI sets it.
  const hubManagedReadOnly = isLegacy ? false : ((props as FlowEditorModalProps).hubManagedReadOnly ?? false);
  const tabLabels = useTabLabels();
  const { registryToolbar } = useHost();

  const queryClient = useQueryClient();
  const flowClient = useFlowClient();
  const registryClient = useRegistryClient();

  // ── Sidebar state ──────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<'my-flows' | 'community'>('my-flows');
  const [selectedFlowId, setSelectedFlowId] = useState<string | null>(
    initialFlowId ?? null
  );
  const [isNewFlow, setIsNewFlow] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // clonedFlow holds a not-yet-saved clone being edited
  const [clonedFlow, setClonedFlow] = useState<(Omit<Flow, 'id' | 'createdAt' | 'updatedAt'> & { id?: undefined }) | null>(null);
  // A new flow the panel has just written. `isNewFlow` has to drop after the
  // save (the row exists now), but the panel is keyed on that state — so the
  // id has to live in the parent, which survives the remount, or the freshly
  // created flow loses its identity the moment it is saved and Publish can
  // never find an id to publish.
  const [createdFlow, setCreatedFlow] = useState<Flow | null>(null);
  // Community tab state
  const [selectedRegistryFlow, setSelectedRegistryFlow] = useState<RegistryFlow | null>(null);
  const [communitySearch, setCommunitySearch] = useState('');

  // ── Query: list all flows ──────────────────────────────────────────────────
  const { data: flows = [] } = useQuery<Flow[]>({
    queryKey: ['flows'],
    queryFn: () => flowClient.listFlows(),
    enabled: isOpen,
  });

  // ── Query: builtin DEFAULT_FLOW (always the hardcoded default, never the project's active flow) ──
  const { data: builtinFlow } = useQuery<Flow>({
    queryKey: ['flow-default'],
    queryFn: () => flowClient.getDefaultFlow(),
    enabled: isOpen,
    staleTime: Infinity, // never changes
  });

  // ── Mutation: switch project back to default (builtin) flow ────────────────
  const useDefaultFlowMutation = useMutation({
    mutationFn: () => flowClient.setProjectFlow(projectId, null),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['flows'] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  // ── Query: community registry flows ───────────────────────────────────────
  const { data: registryFlows = [], isLoading: isRegistryLoading, isError: isRegistryError } = useQuery<RegistryFlow[]>({
    queryKey: ['registry-flows'],
    queryFn: () => registryClient.browseRegistry(),
    enabled: isOpen && activeTab === 'community',
    retry: 1,
  });

  const filteredRegistryFlows = registryFlows.filter(f =>
    !communitySearch ||
    f.name.toLowerCase().includes(communitySearch.toLowerCase()) ||
    (f.author ?? '').toLowerCase().includes(communitySearch.toLowerCase())
  );

  // Derive selected flow object
  const selectedFlow = isNewFlow
    ? null
    : clonedFlow
    ? (clonedFlow as unknown as Flow)
    : selectedFlowId === BUILTIN_ID
    ? (builtinFlow ?? null)
    : (createdFlow && createdFlow.id === selectedFlowId
        // A flow saved from the New Flow panel: the sidebar list will not hold
        // it until its refetch lands, and the object the save returned is
        // strictly fresher than anything the list could answer with.
        ? createdFlow
        : flows.find(f => f.id === selectedFlowId)) ?? null;

  // If this is a legacy-props invocation the passed `flow` wins as initial selection
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    // The component never unmounts (the wrapper mounts it and it self-returns
    // null when closed), so a stale delete failure would otherwise still be on
    // screen the next time the modal is opened.
    setDeleteError(null);
    if (isLegacy && (props as LegacyProps).flow?.id) {
      setSelectedFlowId((props as LegacyProps).flow!.id);
      setIsNewFlow(false);
    } else if (initialFlowId) {
      setSelectedFlowId(initialFlowId);
      setIsNewFlow(false);
    } else if (activeFlowId) {
      setSelectedFlowId(activeFlowId);
      setIsNewFlow(false);
    }
  }, [isOpen]);

  // ── Delete mutation ────────────────────────────────────────────────────────
  // The delete path had the same defect as save (BUG 269eeec8 (a)): no onError
  // and no rendering, so a refusal — e.g. the local server's 409 on a
  // hub-managed flow — vanished and the row simply stayed put.
  const deleteMutation = useMutation({
    mutationFn: (id: string) => flowClient.deleteFlow(id),
    onError: (e: unknown) => {
      setDeleteError(extractApiError(e, 'Failed to delete flow.'));
      setConfirmDeleteId(null);
    },
    onSuccess: (_, deletedId) => {
      setDeleteError(null);
      queryClient.invalidateQueries({ queryKey: ['flows'] });
      queryClient.invalidateQueries({ queryKey: ['flow', projectId] });
      if (selectedFlowId === deletedId) {
        setSelectedFlowId(null);
        setIsNewFlow(true);
      }
      setConfirmDeleteId(null);
    },
  });

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleFlowSaved = (flow: Flow) => {
    setCreatedFlow(flow);
    // The panel is keyed on the selection, so touching `isNewFlow` /
    // `selectedFlowId` REMOUNTS it — wiping the "Saved" badge, the dirty
    // baseline and any publish link the admin is looking at. When the row the
    // save just produced is already the selected one there is nothing to
    // switch to, so the state is left alone and the panel survives. It only
    // needs to change when the selection genuinely moves.
    if (isNewFlow || isEditingClone || selectedFlowId !== flow.id) {
      setSelectedFlowId(flow.id);
      setIsNewFlow(false);
      setClonedFlow(null);
    }
  };

  const handleCommunityInstall = (installed: Flow) => {
    queryClient.invalidateQueries({ queryKey: ['flows'] });
    setActiveTab('my-flows');
    setSelectedFlowId(installed.id);
    setIsNewFlow(false);
    setClonedFlow(null);
    setCreatedFlow(null);
  };

  const handleCommunityClone = (installed: Flow) => {
    queryClient.invalidateQueries({ queryKey: ['flows'] });
    const copy = cloneFlow(installed, installed.name);
    setActiveTab('my-flows');
    setClonedFlow(copy);
    setIsNewFlow(false);
    setSelectedFlowId(null);
    setCreatedFlow(null);
  };

  const effectiveActiveFlowId = activeFlowId;

  const isReadOnly = selectedFlowId === BUILTIN_ID && !clonedFlow;
  const isEditingClone = clonedFlow !== null;
  // A hub-owned flow, viewed from a host that may only read it. Hoisted because
  // the footer actions below need it too: without a Clone action the panel would
  // be a dead end, and the badge tooltip explicitly tells the user to clone.
  const isHubManagedSelected =
    hubManagedReadOnly && selectedFlow?.source === 'hub' && !isEditingClone;


  const handleClone = (source: Flow, sourceName: string) => {
    const copy = cloneFlow(source, `Copy of ${sourceName}`);
    setClonedFlow(copy);
    setIsNewFlow(false);
    setSelectedFlowId(null);
    setCreatedFlow(null);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
      data-testid="flow-editor-modal"
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-surface rounded-2xl shadow-2xl w-[calc(100vw-2rem)] h-[90vh] flex flex-row overflow-hidden">

        {/* ── LEFT SIDEBAR ──────────────────────────────────────────────────── */}
        <div
          data-testid="flow-sidebar"
          className="w-64 shrink-0 border-r border-border-soft flex flex-col overflow-hidden"
        >
          {/* Sidebar header */}
          <div className="px-4 pt-5 pb-3 flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2">
              <GitBranch size={16} className="text-accent-text" />
              <span className="text-sm font-semibold text-ink">
                Flows
              </span>
            </div>
            <button
              onClick={onClose}
              aria-label="Close"
              className="p-1 rounded-lg hover:bg-chip text-ink-tertiary hover:text-ink transition-colors"
            >
              <X size={16} />
            </button>
          </div>

          {/* Tab bar */}
          <div className="flex border-b border-border-soft shrink-0">
            <button
              data-testid="tab-my-flows"
              onClick={() => setActiveTab('my-flows')}
              className={clsx(
                'flex-1 py-2 text-xs font-semibold transition-colors border-b-2 -mb-px',
                activeTab === 'my-flows'
                  ? 'border-brand text-accent-text'
                  : 'border-transparent text-ink-secondary hover:text-ink'
              )}
            >
              {tabLabels.myFlows}
            </button>
            <button
              data-testid="tab-community"
              onClick={() => setActiveTab('community')}
              className={clsx(
                'flex-1 py-2 text-xs font-semibold transition-colors border-b-2 -mb-px',
                activeTab === 'community'
                  ? 'border-brand text-accent-text'
                  : 'border-transparent text-ink-secondary hover:text-ink'
              )}
            >
              {tabLabels.registry}
            </button>
          </div>

          {/* Community tab content */}
          {activeTab === 'community' && (
            <div className="flex-1 flex flex-col overflow-hidden">
              {registryToolbar && (
                <div className="px-3 pt-2 shrink-0" data-testid="registry-toolbar">
                  {registryToolbar}
                </div>
              )}
              <div className="px-3 py-2 shrink-0">
                <div className="relative">
                  <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-tertiary" />
                  <input
                    data-testid="community-search-input"
                    type="text"
                    placeholder="Search by name or author…"
                    value={communitySearch}
                    onChange={e => setCommunitySearch(e.target.value)}
                    className="w-full pl-7 pr-2 py-1.5 text-xs rounded-lg border border-border-soft bg-surface text-ink focus:outline-none focus:ring-1 focus:ring-brand"
                  />
                </div>
              </div>
              <div className="flex-1 overflow-y-auto px-2 pb-2" data-testid="community-flow-list">
                {isRegistryLoading ? (
                  <div className="flex flex-col items-center justify-center py-8 gap-2 text-ink-secondary">
                    <Loader2 size={20} className="animate-spin" />
                    <span className="text-xs">Loading…</span>
                  </div>
                ) : isRegistryError ? (
                  <div className="flex flex-col items-center justify-center py-8 gap-2 px-3 text-center">
                    <AlertCircle size={20} className="text-red-500" />
                    <p className="text-xs text-red-600 dark:text-red-400">Failed to load registry.</p>
                  </div>
                ) : filteredRegistryFlows.length === 0 ? (
                  <p className="text-xs text-ink-secondary text-center py-8">
                    {communitySearch ? 'No flows match.' : 'No community flows found.'}
                  </p>
                ) : (
                  filteredRegistryFlows.map((rf, idx) => (
                    <div
                      key={rf.filename}
                      data-testid={`community-flow-item-${idx}`}
                      onClick={() => setSelectedRegistryFlow(rf)}
                      className={clsx(
                        'w-full text-left px-3 py-2 rounded-lg mb-1 transition-colors cursor-pointer',
                        selectedRegistryFlow?.filename === rf.filename
                          ? 'bg-chip text-accent-text'
                          : 'text-ink hover:bg-chip'
                      )}
                    >
                      <p className="text-sm font-medium truncate">{rf.name}</p>
                      <p className="text-xs text-ink-tertiary">
                        {rf.author ? `${rf.author} · ` : ''}{rf.stepCount} step{rf.stepCount !== 1 ? 's' : ''}
                      </p>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* My Flows tab content */}
          {activeTab === 'my-flows' && (
          <>
          {/* Flow list */}
          <div className="flex-1 overflow-y-auto px-2 pb-2" data-testid="flow-list">
            {/* Built-in default flow row */}
            <div
              data-testid="flow-item-__builtin__"
              onClick={() => { setSelectedFlowId(BUILTIN_ID); setIsNewFlow(false); setClonedFlow(null); }}
              className={clsx(
                'w-full text-left px-3 py-2 rounded-lg mb-1 transition-colors group cursor-pointer',
                selectedFlowId === BUILTIN_ID && !isNewFlow && !isEditingClone
                  ? 'bg-chip text-accent-text'
                  : 'text-ink hover:bg-chip'
              )}
            >
              <div className="flex items-center justify-between gap-1">
                <span className="text-sm font-medium truncate flex-1">Default Flow</span>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    data-testid="clone-flow-btn-__builtin__"
                    type="button"
                    onClick={e => {
                      e.stopPropagation();
                      if (builtinFlow) {
                        handleClone(builtinFlow, builtinFlow.name ?? 'Default Flow');
                      }
                    }}
                    title="Clone flow"
                    className="p-1 rounded transition-colors text-ink-tertiary hover:text-accent-text hover:bg-chip"
                  >
                    <CopyPlus size={13} />
                  </button>
                  <span className="text-xs font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-chip text-ink-secondary">
                    DEFAULT
                  </span>
                </div>
              </div>
            </div>

            {deleteError && (
              <p data-testid="flow-delete-error" className="text-xs text-red-600 dark:text-red-400 px-3 py-2">
                {deleteError}
              </p>
            )}

            {flows.map(flow => {
              const isActive = flow.id === effectiveActiveFlowId;
              const isSelected = selectedFlowId === flow.id && !isNewFlow && !isEditingClone;
              const isPendingDelete = confirmDeleteId === flow.id;
              // Hosts that can only read hub flows must not offer a delete the
              // server answers with 409.
              const isRowHubManaged = hubManagedReadOnly && flow.source === 'hub';

              return (
                <div
                  key={flow.id}
                  data-testid={`flow-item-${flow.id}`}
                  className={clsx(
                    'w-full text-left px-3 py-2 rounded-lg mb-1 transition-colors cursor-pointer',
                    isSelected
                      ? 'bg-chip text-accent-text'
                      : 'text-ink hover:bg-chip'
                  )}
                  onClick={() => {
                    if (!isPendingDelete) {
                      setSelectedFlowId(flow.id);
                      setIsNewFlow(false);
                      setClonedFlow(null);
                      setCreatedFlow(null);
                    }
                  }}
                >
                  <div className="flex items-center gap-1">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-sm font-medium truncate">{flow.name}</span>
                        {isActive && (
                          <span
                            data-testid={`flow-active-badge-${flow.id}`}
                            className="text-xs font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-chip text-accent-text shrink-0"
                          >
                            Active
                          </span>
                        )}
                      </div>
                      {isPendingDelete ? (
                        <DeleteConfirm
                          onConfirm={() => deleteMutation.mutate(flow.id)}
                          onCancel={() => setConfirmDeleteId(null)}
                        />
                      ) : (
                        <span className="text-xs text-ink-tertiary">
                          {flow.steps.length} step{flow.steps.length !== 1 ? 's' : ''}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-0.5 shrink-0">
                      {/* Clone button */}
                      <button
                        data-testid={`clone-flow-btn-${flow.id}`}
                        type="button"
                        onClick={e => {
                          e.stopPropagation();
                          handleClone(flow, flow.name);
                        }}
                        title="Clone flow"
                        className="p-1 rounded transition-colors text-ink-tertiary hover:text-accent-text hover:bg-chip"
                      >
                        <CopyPlus size={13} />
                      </button>
                      {/* Delete button */}
                      <button
                        data-testid={`delete-flow-btn-${flow.id}`}
                        disabled={isActive || isRowHubManaged}
                        onClick={e => {
                          e.stopPropagation();
                          if (!isActive && !isRowHubManaged) setConfirmDeleteId(flow.id);
                        }}
                        title={
                          isRowHubManaged
                            ? "Managed by your organization's Hub — delete it there"
                            : isActive ? 'Cannot delete active flow' : 'Delete flow'
                        }
                        className={clsx(
                          'shrink-0 p-1 rounded transition-colors',
                          isActive || isRowHubManaged
                            ? 'text-ink-tertiary cursor-not-allowed'
                            : 'text-ink-tertiary hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20'
                        )}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* + New Flow button at bottom */}
          <div className="p-3 border-t border-border-soft shrink-0">
            <button
              data-testid="new-flow-btn"
              onClick={() => {
                setIsNewFlow(true);
                setSelectedFlowId(null);
                setClonedFlow(null);
              }}
              className={clsx(
                'w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-semibold transition-colors',
                isNewFlow
                  ? 'bg-chip text-accent-text'
                  : 'text-accent-text hover:bg-chip'
              )}
            >
              <Plus size={15} />
              New Flow
            </button>
          </div>
          </>
          )}
        </div>

        {/* ── RIGHT PANEL ───────────────────────────────────────────────────── */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {activeTab === 'community' ? (
            selectedRegistryFlow ? (
              <CommunityPreviewPanel
                key={selectedRegistryFlow.filename}
                flow={selectedRegistryFlow}
                onInstalled={handleCommunityInstall}
                onCloneToEdit={handleCommunityClone}
              />
            ) : (
              <div className="flex flex-col items-center justify-center flex-1 text-ink-tertiary gap-3 p-8">
                <Globe size={40} className="opacity-30" />
                <p className="text-sm">Select a community flow to preview it.</p>
              </div>
            )
          ) : selectedFlowId !== null || isNewFlow || isEditingClone ? (
            <EditorPanel
              key={isEditingClone ? '__clone__' : isNewFlow ? '__new__' : selectedFlowId}
              flow={selectedFlow}
              isReadOnly={isReadOnly}
              isHubManaged={isHubManagedSelected}
              projectId={projectId}
              activeFlowId={effectiveActiveFlowId}
              onSaved={handleFlowSaved}
              onClose={onClose}
              onClone={
                isHubManagedSelected && selectedFlow
                  ? () => handleClone(selectedFlow, selectedFlow.name)
                  : isReadOnly && builtinFlow
                    ? () => handleClone(builtinFlow, builtinFlow.name ?? 'Default Flow')
                    : undefined
              }
              onUseDefault={
                // Only the builtin default flow — on a hub flow this would set
                // the DEFAULT flow, which is not what the button says.
                isReadOnly && !isHubManagedSelected
                  ? () => useDefaultFlowMutation.mutate()
                  : undefined
              }
              canSelectFlow={canSelectFlow}
            />
          ) : (
            <div className="flex flex-col items-center justify-center flex-1 text-ink-tertiary gap-3 p-8">
              <GitBranch size={40} className="opacity-30" />
              <p className="text-sm">Select a flow from the sidebar or create a new one.</p>
              <button
                onClick={() => { setIsNewFlow(true); setClonedFlow(null); setCreatedFlow(null); }}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold bg-[image:var(--gradient-accent)] text-navy shadow-glow hover:opacity-90 transition-colors"
              >
                <Plus size={14} />
                New Flow
              </button>
            </div>
          )}
        </div>

        {/* Legacy cancel button (only shown in test / backwards compat context) — hidden, keeps test-id accessible */}
        <button
          data-testid="cancel-btn"
          type="button"
          onClick={onClose}
          className="sr-only"
        >
          Cancel
        </button>
      </div>
    </div>
  );
};

// ── Public exported wrapper ────────────────────────────────────────────────
// Consumers inject the data layer (FlowClient + RegistryClient) and theme via
// props; the wrapper plumbs them through context so every nested editor /
// community panel uses the same host without prop-drilling.

export type FlowEditorModalPublicProps = (FlowEditorModalProps | LegacyProps) & {
  flowClient: FlowClient;
  registryClient: RegistryClient;
  theme?: 'light' | 'dark';
  /**
   * Tab captions. Omit for the standalone client's wording ("My Flows" /
   * "Community"). The hub admin passes its own, because there the first tab is
   * the org catalogue and the second may be a private repo.
   */
  tabLabels?: { myFlows?: string; registry?: string };
  /**
   * Footer CTA captions. Omit for the standalone client's wording ("Save" /
   * "Use this Flow"). The hub admin passes its own, because there saving is
   * the fleet-wide publish and the selection button writes an org default.
   */
  labels?: Partial<FlowEditorLabels>;
  /** Optional host control above the registry search box (registry switcher). */
  registryToolbar?: React.ReactNode;
};

export const FlowEditorModal: React.FC<FlowEditorModalPublicProps> = ({
  flowClient, registryClient, theme = 'light', tabLabels, labels, registryToolbar, ...rest
}) => {
  const host = React.useMemo<FlowEditorHost>(
    () => ({
      flowClient,
      registryClient,
      theme,
      registryToolbar,
      tabLabels: {
        myFlows: tabLabels?.myFlows || DEFAULT_HOST_TAB_LABELS.myFlows,
        registry: tabLabels?.registry || DEFAULT_HOST_TAB_LABELS.registry,
      },
      labels: {
        save: labels?.save?.trim() || DEFAULT_EDITOR_LABELS.save,
        saved: labels?.saved?.trim() || DEFAULT_EDITOR_LABELS.saved,
        useFlow: labels?.useFlow?.trim() || DEFAULT_EDITOR_LABELS.useFlow,
      },
    }),
    [
      flowClient, registryClient, theme, registryToolbar,
      tabLabels?.myFlows, tabLabels?.registry,
      labels?.save, labels?.saved, labels?.useFlow,
    ],
  );
  return (
    <HostContext.Provider value={host}>
      <FlowEditorModalInner {...(rest as Props)} />
    </HostContext.Provider>
  );
};
