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
  /** Origin of the flow row. 'local'/'hub'/'community'. */
  source?: 'local' | 'hub' | 'community';
  hubFlowId?: string;
  hubVersion?: number;
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
  publishToRegistry(flowId: string): Promise<{ url: string; kind: 'pr' | 'existing' | 'direct'; note?: string }>;
}
