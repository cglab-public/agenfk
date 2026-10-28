/**
 * @vitest-environment jsdom
 *
 * GH-294 T5: the board's Airlock panel. A standalone installation edits the
 * local policy here (saved with the revision it read, so a stale save is a
 * visible conflict, not a silent overwrite); a hub-joined one shows the
 * policy read-only with a notice naming the hub (user decision 2026-10-27: no
 * passkeys; the hub cannot be overruled locally). Pending approvals are
 * approved or denied here, and recent decisions are listed.
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
