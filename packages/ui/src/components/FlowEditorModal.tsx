/**
 * Thin re-export of the shared FlowEditorModal, wired with the agenfk client's
 * axios api and ThemeContext. The component itself lives in
 * packages/flow-editor and is also consumed by packages/hub-ui with a different
 * client routing to the corp Hub admin endpoints.
 */
import React from 'react';
import {
  FlowEditorModal as SharedFlowEditorModal,
  renderStepIcon as sharedRenderStepIcon,
  type FlowClient,
  type RegistryClient,
} from '@agenfk/flow-editor';
import { api } from '../api';
import { useTheme } from '../ThemeContext';

const flowClient: FlowClient = {
  listFlows: () => api.listFlows(),
  getDefaultFlow: () => api.getDefaultFlow(),
  createFlow: (payload) => api.createFlow(payload),
  updateFlow: (id, payload) => api.updateFlow(id, payload),
  deleteFlow: (id) => api.deleteFlow(id),
  setProjectFlow: (projectId, flowId) => api.setProjectFlow(projectId, flowId),
};

const registryClient: RegistryClient = {
  browseRegistry: () => api.browseRegistry(),
  installFromRegistry: (filename) => api.installFromRegistry(filename),
  publishToRegistry: (flowId) => api.publishToRegistry(flowId),
};

interface FlowEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  activeFlowId?: string;
  initialFlowId?: string;
}

interface LegacyProps {
  open: boolean;
  onClose: () => void;
  flow?: { id?: string } | null;
  projectId: string;
}

export const FlowEditorModal: React.FC<FlowEditorModalProps | LegacyProps> = (props) => {
  const { theme } = useTheme();
  return (
    <SharedFlowEditorModal
      {...(props as any)}
      flowClient={flowClient}
      registryClient={registryClient}
      theme={theme === 'dark' ? 'dark' : 'light'}
    />
  );
};

export const renderStepIcon = sharedRenderStepIcon;
