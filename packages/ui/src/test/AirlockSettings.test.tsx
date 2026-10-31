/**
 * @vitest-environment jsdom
 *
 * GH-294 T5: the board's Airlock panel. A standalone installation edits the
 * local policy here (saved with the revision it read, so a stale save is a
 * visible conflict, not a silent overwrite); a hub-joined one shows the
 * policy read-only with a notice naming the hub (user decision 2026-10-27: no
 * passkeys; the hub cannot be overruled locally). Pending approvals are
 * approved or denied here, and recent decisions are listed. Per-project
 * overrides (PO-2) are edited with the policy on a standalone install, and shown
 * read-only when the hub delivers them.
 */
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AirlockSettings } from '../components/AirlockSettings';
import { settingsSectionFromSearch } from '../airlockForm';
import { api } from '../api';
import { guardTokens } from './helpers/tokenGuard';

const POLICY = vi.hoisted(() => ({
  schemaVersion: 1,
  mode: 'observe',
  models: [{ client: 'pi', provider: 'cloudflare-workers-ai', model: '@cf/*' }],
  appliesWhenModelUnknown: true,
  hosts: { allow: ['api.github.com'], deny: ['evil.example'] },
  iocHosts: { revision: '7', hosts: ['bad.example'], updatedAt: null },
  rules: { uploadToUnlistedHost: 'deny', credentialReadWithNetwork: 'deny', namespaceEscape: 'deny', cloudMutation: 'needs-human-approval' },
}));

const view = (over: Record<string, unknown> = {}) => ({
  effective: POLICY, source: 'local', revision: 3, hubManaged: false, local: null, hub: null, ...over,
});

vi.mock('../api', () => ({
  api: {
    getAirlockPolicy: vi.fn(),
    saveAirlockPolicy: vi.fn(),
    getAirlockApprovals: vi.fn(),
    grantAirlockApproval: vi.fn(async () => ({})),
    denyAirlockApproval: vi.fn(async () => ({})),
    getAirlockDecisions: vi.fn(),
  },
}));

beforeEach(() => {
  vi.mocked(api.getAirlockPolicy).mockResolvedValue(view() as never);
  vi.mocked(api.saveAirlockPolicy).mockImplementation(async (body: { policy: unknown; expectedRevision: number }) => view({ effective: body.policy, revision: body.expectedRevision + 1 }) as never);
  vi.mocked(api.getAirlockApprovals).mockResolvedValue({ pending: [], recent: [] } as never);
  vi.mocked(api.getAirlockDecisions).mockResolvedValue({ decisions: [] } as never);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });
guardTokens();

const renderPanel = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><AirlockSettings /></QueryClientProvider>);
  return qc;
};
const modeReady = async (value = 'observe') => {
  const mode = await screen.findByLabelText('Mode') as HTMLSelectElement;
  await waitFor(() => expect(mode.value).toBe(value));
  return mode;
};

describe('Airlock panel: standalone', () => {
  it('shows the policy in labelled, editable fields', async () => {
    renderPanel();
    const mode = await screen.findByLabelText('Mode') as HTMLSelectElement;
    await waitFor(() => expect(mode.value).toBe('observe'));
    expect(mode.disabled).toBe(false);
    expect((screen.getByLabelText('Allowed hosts') as HTMLTextAreaElement).value).toBe('api.github.com');
    expect((screen.getByLabelText('Denied hosts') as HTMLTextAreaElement).value).toBe('evil.example');
    expect((screen.getByLabelText('Client, selector 1') as HTMLSelectElement).value).toBe('pi');
    expect((screen.getByLabelText('Provider, selector 1') as HTMLInputElement).value).toBe('cloudflare-workers-ai');
    expect((screen.getByLabelText('Model, selector 1') as HTMLInputElement).value).toBe('@cf/*');
    expect((screen.getByLabelText('Cloud mutation') as HTMLSelectElement).value).toBe('needs-human-approval');
    expect(screen.queryByText(/managed by your organization's hub/i)).toBeNull();
  });

  it('Save sends the edited policy with the revision it read', async () => {
    renderPanel();
    const mode = await screen.findByLabelText('Mode') as HTMLSelectElement;
    await waitFor(() => expect(mode.value).toBe('observe'));
    fireEvent.change(mode, { target: { value: 'enforce' } });
    fireEvent.change(screen.getByLabelText('Allowed hosts'), { target: { value: 'api.github.com\n*.npmjs.org\n\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add a model selector' }));
    fireEvent.change(screen.getByLabelText('Client, selector 2'), { target: { value: 'opencode' } });
    fireEvent.change(screen.getByLabelText('Cloud mutation'), { target: { value: 'deny' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    await waitFor(() => expect(api.saveAirlockPolicy).toHaveBeenCalledTimes(1));
    const body = vi.mocked(api.saveAirlockPolicy).mock.calls[0][0];
    expect(body.expectedRevision).toBe(3);
    expect(body.policy.mode).toBe('enforce');
    expect(body.policy.hosts).toEqual({ allow: ['api.github.com', '*.npmjs.org'], deny: ['evil.example'] });
    expect(body.policy.models).toEqual([
      { client: 'pi', provider: 'cloudflare-workers-ai', model: '@cf/*' },
      { client: 'opencode' },
    ]);
    expect(body.policy.rules.cloudMutation).toBe('deny');
    // What the hub's IOC list says is not the board's to change.
    expect(body.policy.iocHosts).toEqual(POLICY.iocHosts);
    expect(await screen.findByText(/Saved \(revision 4\)/)).toBeTruthy();
  });

  it('the publish rule is editable; a policy stored before it existed shows its default (c9bdbe61)', async () => {
    renderPanel();
    const publish = await screen.findByLabelText('Publishing through an allowed host') as HTMLSelectElement;
    await waitFor(() => expect(publish.value).toBe('needs-human-approval'));
    fireEvent.change(publish, { target: { value: 'off' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    await waitFor(() => expect(api.saveAirlockPolicy).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.saveAirlockPolicy).mock.calls[0][0].policy.rules.publishThroughAllowedHost).toBe('off');
  });

  it('a stale revision shows the conflict and offers a reload', async () => {
    vi.mocked(api.saveAirlockPolicy).mockRejectedValue({
      response: { status: 409, data: { error: 'AIRLOCK_REVISION_CONFLICT', message: 'The policy changed since it was read: it is at revision 5, not 3. Reload and apply the change again.', currentRevision: 5 } },
    });
    renderPanel();
    const mode = await screen.findByLabelText('Mode') as HTMLSelectElement;
    await waitFor(() => expect(mode.value).toBe('observe'));
    fireEvent.change(mode, { target: { value: 'enforce' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/changed since it was read/);
    vi.mocked(api.getAirlockPolicy).mockResolvedValue(view({ revision: 5 }) as never);
    fireEvent.click(within(alert).getByRole('button', { name: /Reload/ }));
    await waitFor(() => expect(api.getAirlockPolicy).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('a policy the server refuses as invalid shows its errors', async () => {
    vi.mocked(api.saveAirlockPolicy).mockRejectedValue({
      response: { status: 400, data: { error: 'INVALID_AIRLOCK_POLICY', errors: ['hosts.allow: 169.254.169.254 is a built-in deny host'] } },
    });
    renderPanel();
    await waitFor(() => expect((screen.getByLabelText('Mode') as HTMLSelectElement).value).toBe('observe'));
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/built-in deny host/);
  });
});

describe('model selectors', () => {
  // Every shape the server accepts (each part optional, any string), including
  // ones a delimited one-line form cannot say: a provider holding a slash, an
  // empty model, a '*' client.
  const SHAPES = [
    {},
    { client: '*' },
    { client: 'pi' },
    { provider: 'team/proxy', model: 'glm' },
    { provider: 'vendor', model: '' },
    { client: 'opencode', provider: 'p', model: 'm*' },
    { model: 'only-model' },
    { provider: 'a b', model: 'c d' },
  ];

  it('every server-valid selector survives a save of an unrelated field unchanged', async () => {
    vi.mocked(api.getAirlockPolicy).mockResolvedValue(view({ effective: { ...POLICY, models: SHAPES } }) as never);
    renderPanel();
    const mode = await modeReady();
    fireEvent.change(mode, { target: { value: 'enforce' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    await waitFor(() => expect(api.saveAirlockPolicy).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.saveAirlockPolicy).mock.calls[0][0].policy.models).toEqual(SHAPES);
  });

  it('edits one field of one selector, and Remove drops one', async () => {
    renderPanel();
    await modeReady();
    fireEvent.change(screen.getByLabelText('Model, selector 1'), { target: { value: '@cf/zai-org/glm-5.2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add a model selector' }));
    fireEvent.change(screen.getByLabelText('Provider, selector 2'), { target: { value: 'team/proxy' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove selector 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    await waitFor(() => expect(api.saveAirlockPolicy).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.saveAirlockPolicy).mock.calls[0][0].policy.models).toEqual([{ provider: 'team/proxy' }]);
  });
});

describe('a policy changed elsewhere while editing', () => {
  it('with no edits, the new policy is shown', async () => {
    const qc = renderPanel();
    await modeReady();
    vi.mocked(api.getAirlockPolicy).mockResolvedValue(view({ revision: 4, effective: { ...POLICY, mode: 'enforce' } }) as never);
    await qc.invalidateQueries({ queryKey: ['airlock-policy'] });
    await modeReady('enforce');
  });

  it('keeps unsaved edits, says so, and offers both a reload and keeping them', async () => {
    const qc = renderPanel();
    const mode = await modeReady();
    fireEvent.change(mode, { target: { value: 'off' } });
    vi.mocked(api.getAirlockPolicy).mockResolvedValue(view({ revision: 4, effective: { ...POLICY, mode: 'enforce' } }) as never);
    await qc.invalidateQueries({ queryKey: ['airlock-policy'] });
    const notice = await screen.findByText(/changed elsewhere/i);
    expect(notice.textContent).toMatch(/revision 4/);
    expect((screen.getByLabelText('Mode') as HTMLSelectElement).value).toBe('off');
    // Saving the draft still names the revision it was made against: the server answers 409.
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    await waitFor(() => expect(api.saveAirlockPolicy).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.saveAirlockPolicy).mock.calls[0][0].expectedRevision).toBe(3);
  });

  it('Discard my edits loads the new policy', async () => {
    const qc = renderPanel();
    const mode = await modeReady();
    fireEvent.change(mode, { target: { value: 'off' } });
    vi.mocked(api.getAirlockPolicy).mockResolvedValue(view({ revision: 4, effective: { ...POLICY, mode: 'enforce' } }) as never);
    await qc.invalidateQueries({ queryKey: ['airlock-policy'] });
    fireEvent.click(await screen.findByRole('button', { name: /Discard my edits/ }));
    await modeReady('enforce');
    expect(screen.queryByText(/changed elsewhere/i)).toBeNull();
  });

  it('Keep my edits saves them over the new revision', async () => {
    const qc = renderPanel();
    const mode = await modeReady();
    fireEvent.change(mode, { target: { value: 'off' } });
    vi.mocked(api.getAirlockPolicy).mockResolvedValue(view({ revision: 4, effective: { ...POLICY, mode: 'enforce' } }) as never);
    await qc.invalidateQueries({ queryKey: ['airlock-policy'] });
    fireEvent.click(await screen.findByRole('button', { name: /Keep my edits/ }));
    expect((screen.getByLabelText('Mode') as HTMLSelectElement).value).toBe('off');
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    await waitFor(() => expect(api.saveAirlockPolicy).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.saveAirlockPolicy).mock.calls[0][0]).toMatchObject({ expectedRevision: 4, policy: { mode: 'off' } });
  });
});

describe('Airlock panel: hub-joined', () => {
  it('renders read-only with a notice naming the hub, and offers no save', async () => {
    vi.mocked(api.getAirlockPolicy).mockResolvedValue(view({ source: 'hub', hubManaged: true, revision: 9 }) as never);
    renderPanel();
    expect(await screen.findByText(/managed by your organization's hub/i)).toBeTruthy();
    const mode = screen.getByLabelText('Mode') as HTMLSelectElement;
    await waitFor(() => expect(mode.value).toBe('observe'));
    expect(mode.disabled).toBe(true);
    expect((screen.getByLabelText('Allowed hosts') as HTMLTextAreaElement).readOnly).toBe(true);
    expect((screen.getByLabelText('Cloud mutation') as HTMLSelectElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save policy' })).toBeNull();
  });

  it('shows the machine image the hub set, read-only (CGLAB-696)', async () => {
    vi.mocked(api.getAirlockPolicy).mockResolvedValue(view({
      source: 'hub', hubManaged: true, revision: 9, effective: { ...POLICY, machineImage: 'ghcr.io/acme/airlock:1.2' },
    }) as never);
    renderPanel();
    const image = await screen.findByLabelText('Machine image') as HTMLInputElement;
    await waitFor(() => expect(image.value).toBe('ghcr.io/acme/airlock:1.2'));
    expect(image.readOnly).toBe(true);
  });
});

describe('Airlock panel: machine image (CGLAB-696)', () => {
  it('is empty when the policy names none, and says what runs then', async () => {
    renderPanel();
    await modeReady();
    expect((screen.getByLabelText('Machine image') as HTMLInputElement).value).toBe('');
    expect(screen.getByText(/AgEnFK base image/i)).toBeTruthy();
  });

  it('saves the image typed, trimmed', async () => {
    renderPanel();
    await modeReady();
    fireEvent.change(screen.getByLabelText('Machine image'), { target: { value: ' ghcr.io/acme/airlock:1.3 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    await waitFor(() => expect(api.saveAirlockPolicy).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.saveAirlockPolicy).mock.calls[0][0].policy.machineImage).toBe('ghcr.io/acme/airlock:1.3');
  });

  it('a cleared image saves none', async () => {
    vi.mocked(api.getAirlockPolicy).mockResolvedValue(view({ effective: { ...POLICY, machineImage: 'ghcr.io/acme/airlock:1.2' } }) as never);
    renderPanel();
    await modeReady();
    const image = screen.getByLabelText('Machine image') as HTMLInputElement;
    await waitFor(() => expect(image.value).toBe('ghcr.io/acme/airlock:1.2'));
    fireEvent.change(image, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    await waitFor(() => expect(api.saveAirlockPolicy).toHaveBeenCalledTimes(1));
    expect('machineImage' in vi.mocked(api.saveAirlockPolicy).mock.calls[0][0].policy).toBe(false);
  });

  it('a policy without one saves none when the field is left alone', async () => {
    renderPanel();
    await modeReady();
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    await waitFor(() => expect(api.saveAirlockPolicy).toHaveBeenCalledTimes(1));
    expect('machineImage' in vi.mocked(api.saveAirlockPolicy).mock.calls[0][0].policy).toBe(false);
  });
});

describe('Airlock panel: per-project overrides (PO-2)', () => {
  const withOverrides = (over: Record<string, unknown> = {}) => view({
    effective: { ...POLICY, projects: { 'github.com/acme/api': { hosts: { allow: ['pypi.org'], deny: [] }, rules: { cloudMutation: 'deny' } } } },
    ...over,
  });

  it('shows each override with the policy: key, hosts, and the rules it sets', async () => {
    vi.mocked(api.getAirlockPolicy).mockResolvedValue(withOverrides() as never);
    renderPanel();
    await modeReady();
    expect((screen.getByLabelText('Repository or project, override 1') as HTMLInputElement).value).toBe('github.com/acme/api');
    expect((screen.getByLabelText('Allowed hosts, override 1') as HTMLTextAreaElement).value).toBe('pypi.org');
    expect((screen.getByLabelText('Cloud mutation, override 1') as HTMLSelectElement).value).toBe('deny');
    expect((screen.getByLabelText('Namespace escape, override 1') as HTMLSelectElement).value).toBe('');
  });

  it('an override added here is saved with the policy, and one nobody touched goes back exactly as stored', async () => {
    vi.mocked(api.getAirlockPolicy).mockResolvedValue(withOverrides() as never);
    renderPanel();
    await modeReady();
    fireEvent.click(screen.getByRole('button', { name: 'Add a project override' }));
    fireEvent.change(screen.getByLabelText('Repository or project, override 2'), { target: { value: 'project:local-1' } });
    fireEvent.change(screen.getByLabelText('Allowed hosts, override 2'), { target: { value: 'localonly.example\n' } });
    fireEvent.change(screen.getByLabelText('Publishing through an allowed host, override 2'), { target: { value: 'deny' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    await waitFor(() => expect(api.saveAirlockPolicy).toHaveBeenCalledTimes(1));
    const body = vi.mocked(api.saveAirlockPolicy).mock.calls[0][0] as any;
    expect(body.expectedRevision).toBe(3);
    expect(body.policy.projects).toEqual({
      'github.com/acme/api': { hosts: { allow: ['pypi.org'], deny: [] }, rules: { cloudMutation: 'deny' } },
      'project:local-1': { hosts: { allow: ['localonly.example'], deny: [] }, rules: { publishThroughAllowedHost: 'deny' } },
    });
  });

  it('shows and saves a project\'s own machine image, trimmed (CGLAB-696)', async () => {
    vi.mocked(api.getAirlockPolicy).mockResolvedValue(withOverrides() as never);
    renderPanel();
    await modeReady();
    const image = screen.getByLabelText('Machine image, override 1') as HTMLInputElement;
    expect(image.value).toBe('');
    fireEvent.change(image, { target: { value: ' ghcr.io/acme/api-airlock:2 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    await waitFor(() => expect(api.saveAirlockPolicy).toHaveBeenCalledTimes(1));
    expect((vi.mocked(api.saveAirlockPolicy).mock.calls[0][0] as any).policy.projects['github.com/acme/api'].machineImage).toBe('ghcr.io/acme/api-airlock:2');
  });

  it('a project\'s machine image cleared saves none for it', async () => {
    vi.mocked(api.getAirlockPolicy).mockResolvedValue(view({
      effective: { ...POLICY, projects: { 'github.com/acme/api': { machineImage: 'ghcr.io/acme/api-airlock:2', rules: { cloudMutation: 'deny' } } } },
    }) as never);
    renderPanel();
    await modeReady();
    const image = screen.getByLabelText('Machine image, override 1') as HTMLInputElement;
    await waitFor(() => expect(image.value).toBe('ghcr.io/acme/api-airlock:2'));
    fireEvent.change(image, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    await waitFor(() => expect(api.saveAirlockPolicy).toHaveBeenCalledTimes(1));
    expect((vi.mocked(api.saveAirlockPolicy).mock.calls[0][0] as any).policy.projects).toEqual({ 'github.com/acme/api': { rules: { cloudMutation: 'deny' } } });
  });

  it('an override that sets only rules saves no hosts; a rule set back to the policy\'s is left out', async () => {
    vi.mocked(api.getAirlockPolicy).mockResolvedValue(withOverrides() as never);
    renderPanel();
    await modeReady();
    fireEvent.change(screen.getByLabelText('Allowed hosts, override 1'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Namespace escape, override 1'), { target: { value: 'off' } });
    fireEvent.change(screen.getByLabelText('Cloud mutation, override 1'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    await waitFor(() => expect(api.saveAirlockPolicy).toHaveBeenCalledTimes(1));
    expect((vi.mocked(api.saveAirlockPolicy).mock.calls[0][0] as any).policy.projects).toEqual({ 'github.com/acme/api': { rules: { namespaceEscape: 'off' } } });
  });

  it('removing the last override saves a policy without any', async () => {
    vi.mocked(api.getAirlockPolicy).mockResolvedValue(withOverrides() as never);
    renderPanel();
    await modeReady();
    fireEvent.click(screen.getByRole('button', { name: 'Remove override 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    await waitFor(() => expect(api.saveAirlockPolicy).toHaveBeenCalledTimes(1));
    expect((vi.mocked(api.saveAirlockPolicy).mock.calls[0][0] as any).policy.projects).toBeUndefined();
  });

  it('an edited override makes the form dirty, so a change elsewhere does not discard it', async () => {
    vi.mocked(api.getAirlockPolicy).mockResolvedValue(withOverrides() as never);
    const qc = renderPanel();
    await modeReady();
    fireEvent.change(screen.getByLabelText('Denied hosts, override 1'), { target: { value: 'tracker.example' } });
    qc.setQueryData(['airlock-policy'], withOverrides({ revision: 4 }));
    expect(await screen.findByText(/your unsaved edits are against revision 3/)).toBeTruthy();
    expect((screen.getByLabelText('Denied hosts, override 1') as HTMLTextAreaElement).value).toBe('tracker.example');
  });

  it('two overrides naming one key are refused before anything is sent, saying which', async () => {
    vi.mocked(api.getAirlockPolicy).mockResolvedValue(withOverrides() as never);
    renderPanel();
    await modeReady();
    fireEvent.click(screen.getByRole('button', { name: 'Add a project override' }));
    fireEvent.change(screen.getByLabelText('Repository or project, override 2'), { target: { value: 'github.com/acme/api ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Overrides 1 and 2 both name github.com/acme/api');
    expect(api.saveAirlockPolicy).not.toHaveBeenCalled();
  });

  it('hub-joined: the hub\'s overrides are shown read-only, with nothing to add or remove', async () => {
    vi.mocked(api.getAirlockPolicy).mockResolvedValue(withOverrides({ source: 'hub', hubManaged: true, revision: 9 }) as never);
    renderPanel();
    await modeReady();
    expect((screen.getByLabelText('Repository or project, override 1') as HTMLInputElement).readOnly).toBe(true);
    expect((screen.getByLabelText('Allowed hosts, override 1') as HTMLTextAreaElement).readOnly).toBe(true);
    expect((screen.getByLabelText('Cloud mutation, override 1') as HTMLSelectElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Add a project override' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove override 1' })).toBeNull();
  });
});

describe('Airlock panel: approvals and decisions', () => {
  const pending = {
    key: 'airlock-v1:cloud-mutation:abc', rule: 'cloud-mutation', summary: 'aws s3 rm s3://acme/x', generation: 2,
    capabilities: [{ kind: 'command', value: 'aws s3 rm s3://acme/x' }],
    projectId: 'p1', itemId: 'card-1', sessionId: 's1', requestedAt: '2026-10-27T12:00:00.000Z',
    grantedAt: null, grantedBy: null, authority: null, expiresAt: null, consumedAt: null, deniedAt: null, status: 'pending',
  };

  it('lists a pending approval and Approve grants it', async () => {
    vi.mocked(api.getAirlockApprovals).mockResolvedValue({ pending: [pending], recent: [] } as never);
    renderPanel();
    const row = (await screen.findByText('aws s3 rm s3://acme/x')).closest('li') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: /Approve/ }));
    await waitFor(() => expect(api.grantAirlockApproval).toHaveBeenCalledWith(pending.key, 2));
  });

  it('Deny denies it', async () => {
    vi.mocked(api.getAirlockApprovals).mockResolvedValue({ pending: [pending], recent: [] } as never);
    renderPanel();
    const row = (await screen.findByText('aws s3 rm s3://acme/x')).closest('li') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: /Deny/ }));
    await waitFor(() => expect(api.denyAirlockApproval).toHaveBeenCalledWith(pending.key, 2));
  });

  it('approvals stay available when the hub manages the policy', async () => {
    vi.mocked(api.getAirlockPolicy).mockResolvedValue(view({ source: 'hub', hubManaged: true }) as never);
    vi.mocked(api.getAirlockApprovals).mockResolvedValue({ pending: [pending], recent: [] } as never);
    renderPanel();
    const row = (await screen.findByText('aws s3 rm s3://acme/x')).closest('li') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: /Approve/ }));
    await waitFor(() => expect(api.grantAirlockApproval).toHaveBeenCalledWith(pending.key, 2));
  });

  it('shows every capability an approval authorises', async () => {
    const both = { ...pending, key: 'airlock-v1:credential-read-with-network:def', rule: 'credential-read-with-network', summary: '~/.aws/credentials',
      capabilities: [{ kind: 'path', value: '~/.aws/credentials', access: 'read' }, { kind: 'url', value: 'https://attacker.example/upload' }] };
    vi.mocked(api.getAirlockApprovals).mockResolvedValue({ pending: [both], recent: [], denied: [] } as never);
    renderPanel();
    const list = await screen.findByRole('list', { name: 'Pending approvals' });
    expect(within(list).getByText('~/.aws/credentials')).toBeTruthy();
    expect(within(list).getByText('https://attacker.example/upload')).toBeTruthy();
  });

  it('shows a long capability whole, never cut with an ellipsis', async () => {
    const full = `printf '${'a'.repeat(600)}'; aws s3 rm s3://production --recursive`;
    const long = { ...pending, summary: full, capabilities: [{ kind: 'command', value: full }] };
    vi.mocked(api.getAirlockApprovals).mockResolvedValue({ pending: [long], recent: [], denied: [] } as never);
    renderPanel();
    const list = await screen.findByRole('list', { name: 'Pending approvals' });
    expect(within(list).getByText(full)).toBeTruthy();
    expect(list.textContent).not.toContain('…');
  });

  it('a request whose capabilities could not be stored whole offers no Approve, and says why', async () => {
    const cut = { ...pending, capabilities: [{ kind: 'command', value: 'printf bbbb', complete: false }] };
    vi.mocked(api.getAirlockApprovals).mockResolvedValue({ pending: [cut], recent: [], denied: [] } as never);
    renderPanel();
    const list = await screen.findByRole('list', { name: 'Pending approvals' });
    expect(within(list).queryByRole('button', { name: /Approve/ })).toBeNull();
    expect(within(list).getByText(/too long to show in full/i)).toBeTruthy();
    expect(within(list).getByRole('button', { name: /Deny/ })).toBeTruthy();
  });

  it('a request whose redaction would hide code that runs offers no Approve, and says why', async () => {
    const hidden = { ...pending, capabilities: [{ kind: 'command', value: 'aws secretsmanager put-secret-value --secret-string [REDACTED]', concealed: true }] };
    vi.mocked(api.getAirlockApprovals).mockResolvedValue({ pending: [hidden], recent: [], denied: [hidden] } as never);
    renderPanel();
    const list = await screen.findByRole('list', { name: 'Pending approvals' });
    expect(within(list).queryByRole('button', { name: /Approve/ })).toBeNull();
    expect(within(list).getByText(/redaction would hide code that runs/i)).toBeTruthy();
    const denied = screen.getByRole('list', { name: 'Denied requests' });
    expect(within(denied).queryByRole('button', { name: /Approve/ })).toBeNull();
  });

  it('a denied request stays listed and can still be approved', async () => {
    const denied = { ...pending, status: 'denied', deniedAt: '2026-10-27T12:01:00.000Z', generation: 5 };
    vi.mocked(api.getAirlockApprovals).mockResolvedValue({ pending: [], recent: [], denied: [denied] } as never);
    renderPanel();
    const list = await screen.findByRole('list', { name: 'Denied requests' });
    fireEvent.click(within(list).getByRole('button', { name: /Approve/ }));
    await waitFor(() => expect(api.grantAirlockApproval).toHaveBeenCalledWith(pending.key, 5));
  });

  it('a failed load is said, not shown as an empty queue, and Retry asks again', async () => {
    vi.mocked(api.getAirlockApprovals).mockRejectedValue(new Error('offline'));
    renderPanel();
    const alert = await screen.findByText(/Could not load the approvals/);
    expect(screen.queryByText('Nothing is waiting.')).toBeNull();
    vi.mocked(api.getAirlockApprovals).mockResolvedValue({ pending: [pending], recent: [], denied: [] } as never);
    fireEvent.click(within(alert.closest('[role="alert"]') as HTMLElement).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('aws s3 rm s3://acme/x')).toBeTruthy();
  });

  it('lists recent decisions', async () => {
    vi.mocked(api.getAirlockDecisions).mockResolvedValue({ decisions: [
      { id: 1, ts: '2026-10-27T12:00:00.000Z', client: 'pi', model: 'p/m', tool: 'bash', capabilityKind: 'url', target: 'http://169.254.169.254/', decision: 'deny', rule: 'builtin-metadata-deny', mode: 'enforce', itemId: null },
    ] } as never);
    renderPanel();
    expect(await screen.findByText('http://169.254.169.254/')).toBeTruthy();
    expect(screen.getByText('builtin-metadata-deny')).toBeTruthy();
  });
});

describe('the ?settings= deep link', () => {
  it('names the section `agenfk airlock edit` opens', () => {
    expect(settingsSectionFromSearch('?settings=airlock')).toBe('airlock');
    expect(settingsSectionFromSearch('?project=p1&settings=airlock')).toBe('airlock');
    expect(settingsSectionFromSearch('?project=p1')).toBeNull();
    expect(settingsSectionFromSearch('')).toBeNull();
  });
});
