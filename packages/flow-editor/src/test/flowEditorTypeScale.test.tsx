/**
 * @vitest-environment jsdom
 *
 * The flow editor renders on the shared five-step type scale (story 12f3921a,
 * follow-up to hub story 7073be87): caption / small / body / title / display
 * only, in every view it opens in both apps — the step list, the step's checks
 * dialog, the exit-criteria editor and a community flow's preview.
 */
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describeFlowContract } from '@agenfk/core';
import { FlowEditorModal } from '../FlowEditorModal';
import type { Flow, FlowClient, FlowStep, RegistryClient, RegistryFlow } from '../types';
import { expectOnTypeScale } from './helpers/typeScale';

const s = (name: string, order: number, extra: Partial<FlowStep> = {}): FlowStep => ({ id: `id-${name}`, name, label: name, order, ...extra });
const FLOW: Flow = {
  id: 'f1', name: 'My flow', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  steps: [
    s('TODO', 0, { isAnchor: true }),
    // An orphan check, so the contract problems banner renders and is checked too.
    s('LOOSE', 1, { checks: [{ id: 'red-set-passes-by-name' }] }),
    s('SPECS', 2, { role: 'test-authoring', exitCriteria: 'Tests exist and fail.' }),
    s('BUILD', 3, { role: 'coding', checks: [{ id: 'human-approval' }] }),
    s('DONE', 4, { isAnchor: true }),
  ],
};
const COMMUNITY: RegistryFlow = {
  filename: 'tdd.json', name: 'Community TDD', author: 'someone', version: '1.0.0', stepCount: 2,
  description: 'A shared flow.', steps: [{ name: 'SPECS', label: 'Specs' }, { name: 'BUILD', label: 'Build' }],
};

function mount(opts: { deleteFails?: boolean } = {}) {
  const flowClient: FlowClient = {
    listFlows: async () => [FLOW],
    getDefaultFlow: async () => ({ ...FLOW, id: 'default', name: 'Default', steps: [] }),
    createFlow: async p => ({ ...FLOW, ...p } as Flow),
    updateFlow: async (_id, p) => ({ ...FLOW, ...p } as Flow),
    deleteFlow: async () => { if (opts.deleteFails) throw new Error('Flow is in use by a project.'); },
    setProjectFlow: async () => {},
    getFlowContract: vi.fn(async (steps: FlowStep[]) => describeFlowContract(steps) as any),
  };
  const registryClient: RegistryClient = { browseRegistry: async () => [COMMUNITY], installFromRegistry: async () => FLOW };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <FlowEditorModal isOpen onClose={() => {}} projectId="p1" initialFlowId="f1" flowClient={flowClient} registryClient={registryClient} canDisableChecks />
    </QueryClientProvider>,
  );
}

const loaded = () => waitFor(() => expect(screen.getAllByDisplayValue('BUILD').length).toBeGreaterThan(0));

afterEach(() => cleanup());

describe('flow editor type scale', () => {
  it('the step list, with a step checks dialog open, is on the scale', async () => {
    mount();
    await loaded();
    fireEvent.click(await screen.findByTestId('step-contract-btn-3'));
    await screen.findByRole('dialog', { name: /Checks for BUILD/i });
    expectOnTypeScale(document.body);
  });

  it('the exit-criteria editor is on the scale', async () => {
    mount();
    await loaded();
    fireEvent.click(screen.getByTestId('step-exit-criteria-2'));
    await screen.findByTestId('exit-criteria-editor-modal');
    expectOnTypeScale(document.body);
  });

  it('the exit-criteria preview, with markdown in it, is on the scale', async () => {
    mount();
    await loaded();
    fireEvent.click(screen.getByTestId('step-exit-criteria-2'));
    fireEvent.change(await screen.findByTestId('exit-criteria-editor'), { target: { value: '# Leave when\n\n- tests `fail`' } });
    // The rendered markdown is styled by `prose` (typography plugin), not by
    // the editor's own size classes; the guard covers the editor's chrome.
    await waitFor(() => expect(screen.getByTestId('exit-criteria-preview').querySelector('h1')).toBeTruthy());
    expectOnTypeScale(document.body);
  });

  it('the built-in flow, shown read-only, is on the scale', async () => {
    mount();
    await loaded();
    fireEvent.click(screen.getByTestId('flow-item-__builtin__'));
    await screen.findByTestId('flow-name-heading');
    await screen.findByTestId('clone-to-edit-btn');
    expectOnTypeScale(document.body);
  });

  it('a step renamed to a reserved name, with its errors showing, is on the scale', async () => {
    mount();
    await loaded();
    fireEvent.change(screen.getByTestId('step-name-1'), { target: { value: 'BLOCKED' } });
    await screen.findByTestId('reserved-name-error');
    expectOnTypeScale(document.body);
  });

  it('a new flow is on the scale', async () => {
    mount();
    await loaded();
    fireEvent.click(screen.getByTestId('new-flow-btn'));
    await waitFor(() => expect(screen.queryByDisplayValue('My flow')).toBeNull());
    expectOnTypeScale(document.body);
  });

  it('a failed delete, after its confirm, is on the scale', async () => {
    mount({ deleteFails: true });
    await loaded();
    fireEvent.click(screen.getByTestId('delete-flow-btn-f1'));
    await screen.findByTestId('delete-confirm');
    expectOnTypeScale(document.body);
    fireEvent.click(screen.getByTestId('delete-confirm-yes'));
    await screen.findByTestId('flow-delete-error');
    expectOnTypeScale(document.body);
  });

  it("a community flow's preview is on the scale", async () => {
    mount();
    await loaded();
    fireEvent.click(screen.getByTestId('tab-community'));
    fireEvent.click(await screen.findByTestId('community-flow-item-0'));
    await screen.findByTestId('community-preview-panel');
    expectOnTypeScale(document.body);
  });
});
