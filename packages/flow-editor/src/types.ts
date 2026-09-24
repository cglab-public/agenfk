// Local copies of the Flow types used by the editor. These mirror the shapes
// exposed by the local agenfk server (see packages/ui/src/types.ts) and the
// hub admin endpoints. Kept here so the package is self-contained — consumers
// don't need to import a particular host type module.

export interface FlowStep {
  id: string;
  name: string;
  label: string;
  order: number;
  exitCriteria?: string;
  color?: string;
  icon?: string;
  isAnchor?: boolean;
  /** @deprecated Use isAnchor instead. */
  isSpecial?: boolean;
  /** CGLAB-380: what the step is for; brings its built-in checks. */
  role?: string | null;
  /** CGLAB-380: checks this flow adds to the step. */
  checks?: StepCheckRef[] | null;
  /** CGLAB-388: commit the card's work when it leaves the step, and whether that is required. */
  autoCommit?: boolean | null;
  requireCommit?: boolean | null;
}

/** A check as a flow step lists it (CGLAB-380). */
export interface StepCheckRef {
  id: string;
  params?: Record<string, string>;
  severity?: 'block' | 'warn';
}

/** One check a step runs, as the server resolves it (core's ResolvedCheck). */
export interface ResolvedCheck {
  id: string;
  params: Record<string, string>;
  severity: 'block' | 'warn';
  source: 'universal' | 'role' | 'flow';
  step: string;
  applicable: boolean;
  missing?: string[];
}

/**
 * What a draft flow's steps mean, computed by the server with the functions
 * that validate and enforce it (CGLAB-384). The browser cannot import core,
 * so the editor never re-implements this.
 */
export interface FlowContract {
  valid: boolean;
  errors: string[];
  /** `onLeave`: what verify runs to leave the step (absent from an older server: use `checks`). */
  steps: Array<{ name: string; role: string | null; checks: ResolvedCheck[]; onLeave?: ResolvedCheck[]; terminal?: boolean; produces: string[]; consumes?: string[]; /** Leaving the step makes a step commit (absent from an older server). */ commitsOnLeave?: 'auto' | 'required' | null }>;
  roles: Array<{ id: string; builtins: StepCheckRef[] }>;
  catalogue: Array<{
    id: string;
    group: 'git' | 'tests' | 'review' | 'approvals' | string;
    description: string;
    defaultSeverity: 'block' | 'warn';
    params: Record<string, { values: readonly string[]; default: string; description: string; kind?: 'enum' | 'name' | 'argv' | 'text'; required?: boolean }>;
    needsCapture: boolean;
    unavailable?: string;
  }>;
}

export interface Flow {
  id: string;
  name: string;
  description?: string;
  version?: string;
  steps: FlowStep[];
  createdAt: string;
  updatedAt: string;
  /** Origin of the flow row. 'parent' is a flow a parent hub dispatched to this hub (read-only here). */
  source?: 'local' | 'hub' | 'community' | 'parent';
  hubFlowId?: string;
  hubVersion?: number;
  /** Hub-only: whether the flow is offered in the org-wide flow picker. */
  orgAvailable?: boolean;
}

export interface RegistryFlow {
  filename: string;
  name: string;
  author?: string;
  version?: string;
  stepCount: number;
  description?: string;
  steps?: { name: string; label: string }[];
}

/** Read+write surface the FlowEditorModal needs from its host environment. */
export interface FlowClient {
  listFlows(): Promise<Flow[]>;
  getDefaultFlow(): Promise<Flow>;
  createFlow(payload: Partial<Flow>): Promise<Flow>;
  updateFlow(id: string, payload: Partial<Flow>): Promise<Flow>;
  deleteFlow(id: string): Promise<void>;
  /**
   * Activate (or clear) a flow at the binding point appropriate for the host.
   * - In the agenfk client this binds to a project's active flow.
   * - In the hub admin UI this binds the org-default assignment.
   * The `projectId` argument is forwarded as-is; the hub client may ignore it.
   */
  setProjectFlow(projectId: string, flowId: string | null): Promise<void>;
  /**
   * What a draft's steps mean (CGLAB-384). Optional: a host whose server has
   * no contract route (an older one) omits it, and the editor then hides the
   * roles-and-checks controls and saves steps as before.
   */
  getFlowContract?(steps: FlowStep[]): Promise<FlowContract>;
}

export interface RegistryClient {
  browseRegistry(): Promise<RegistryFlow[]>;
  installFromRegistry(filename: string): Promise<Flow>;
  /**
   * Push a saved flow to the registry. **Optional because not every host can
   * do it.**
   *
   * The agenfk client can. Standalone, or in an org on the public community
   * registry, its local server shells out to `gh` on the author's machine
   * (fork + PR, or a direct push for a repo owner). In a hub-connected org
   * with its own registry, the local server forwards the flow to the hub,
   * which opens the pull request on the org's repo with the token it holds
   * (CGLAB-367) - and the result carries `repo`, so the editor can say which.
   *
   * The Hub ADMIN's own editor does not publish: an admin manages the org's
   * flows directly, and review happens on the pull requests installations
   * open. Its client simply omits this method and the editor hides the button,
   * rather than rendering a control wired to a function that can only reject.
   */
  publishToRegistry?(flowId: string): Promise<{
    url: string;
    kind: 'pr' | 'existing' | 'direct';
    note?: string;
    /** The registry repo it went to. A hub-connected org's own repo is not the public one, and the editor says which. */
    repo?: string;
  }>;
}
