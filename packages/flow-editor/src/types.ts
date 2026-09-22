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
