/**
 * @vitest-environment jsdom
 *
 * Admin → Repositories and CI tokens (RFC-002, task ddac8ac3).
 *
 * The admin surface for CI receipts. What this pins is the wiring and the
 * words, because both are the feature here:
 *  - Fleet → Repositories lists each repository with its verify command, its
 *    revision, its receipts mode in words and when it last received a receipt,
 *    and says what to expect when there are none yet;
 *  - a repository's page saves a new command revision (the hub's refusal shown
 *    inline), lists the revisions naming who made each, sets the mode
 *    (Off / Shadow / Enforce, Enforce only with a Shadow threshold) with the
 *    slower-close warning, keeps the producer allowlist, and lists recent
 *    receipts as Reusable / Not reusable with the reason in words;
 *  - API keys & invites issues a read-only CI token for one repository or the
 *    whole organisation, shows it once, and lists it with a Type column next to
 *    the installation keys, each revoked through its own route;
 *  - every time is shown in UTC.
 */
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdminRepos } from '../pages/AdminRepos';
import { FILL_VIEWPORT_MIN } from '../components/ui';
import { AdminLayout, AdminKeys } from '../pages/Admin';
import { api } from '../api';
import { answerConfirm, forbidWindowConfirm, letMutationsLand } from './helpers/confirmDialog';

vi.mock('../api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;
const put = api.put as unknown as ReturnType<typeof vi.fn>;
const post = api.post as unknown as ReturnType<typeof vi.fn>;
const del = api.delete as unknown as ReturnType<typeof vi.fn>;

const REPO = 'git@github.com:acme/app.git';
const REPO2 = 'git@github.com:acme/widget.git';

const repoRow = (over: Record<string, unknown> = {}) => ({
  remoteUrl: REPO, verifyCommand: 'npm test', revision: 3, receiptsMode: 'shadow', shadowThreshold: null,
  producers: ['inst-alice'], createdAt: '2026-06-01T09:00:00.000Z', updatedAt: '2026-06-02T09:00:00.000Z',
  lastReceiptAt: '2026-06-03T10:15:00.000Z', ...over,
});

const REVISIONS = [
  { revision: 3, verifyCommand: 'npm test', source: 'admin', actorEmail: 'admin@acme.test', installationId: null, createdAt: '2026-06-02T09:00:00.000Z' },
  { revision: 1, verifyCommand: 'npm run verify', source: 'init', actorEmail: null, installationId: 'inst-alice', createdAt: '2026-06-01T09:00:00.000Z' },
];

const RECEIPTS = [
  { id: 'rcpt-ok', kind: 'verification', cardId: 'card-1', cardTitle: 'Ship receipts', contentTree: 'a'.repeat(40), commit: 'b'.repeat(40), commandRevision: 3, reusable: true, notReusableReason: null, installationId: 'inst-alice', receivedAt: '2026-06-03T10:15:00.000Z' },
  { id: 'rcpt-no', kind: 'review', cardId: 'card-2', cardTitle: 'Review it', contentTree: 'c'.repeat(40), commit: 'd'.repeat(40), commandRevision: null, reusable: false, notReusableReason: 'producer_not_allowed', installationId: 'inst-bob', lenses: ['security'], receivedAt: '2026-06-03T09:00:00.000Z' },
];

const INSTALLATIONS = [
  { id: 'inst-alice', gitEmail: 'alice@acme.test', osUser: 'alice', gitName: 'Alice', agenfkVersion: null, agenfkVersionUpdatedAt: null, firstSeen: null, lastSeen: null },
  { id: 'inst-bob', gitEmail: 'bob@acme.test', osUser: 'bob', gitName: 'Bob', agenfkVersion: null, agenfkVersionUpdatedAt: null, firstSeen: null, lastSeen: null },
];

/** Answer each GET by its path, the way the hub would. */
function hubAnswers(over: Record<string, unknown> = {}) {
  const table: Record<string, unknown> = {
    '/v1/admin/repos': { repos: [repoRow(), repoRow({ remoteUrl: REPO2, receiptsMode: 'off', lastReceiptAt: null, revision: 1 })] },
    '/v1/admin/repos/revisions': { revisions: REVISIONS },
    '/v1/admin/repos/receipts': { receipts: RECEIPTS },
    '/v1/admin/installations': INSTALLATIONS,
    '/v1/admin/api-keys': [{ tokenHashPreview: 'aaaa1111', label: 'alice-laptop', createdAt: '2026-06-01T00:00:00.000Z', revokedAt: null, installationId: 'inst-alice', gitEmail: 'alice@acme.test' }],
    '/v1/admin/ci-tokens': { tokens: [{ tokenHashPreview: 'cccc2222', label: 'github-actions', scope: 'repo', repo: REPO, createdAt: '2026-06-02T00:00:00.000Z', createdByEmail: 'admin@acme.test', revokedAt: null }] },
    ...over,
  };
  get.mockImplementation(async (url: string) => {
    const path = url.split('?')[0];
    if (!(path in table)) throw new Error(`unexpected GET ${url}`);
    return { data: table[path] };
  });
}

const renderAt = (entry: string) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/admin" element={<AdminLayout />}>
            <Route path="repos" element={<AdminRepos />} />
            <Route path="keys" element={<AdminKeys />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

const detailUrl = `/admin/repos?repo=${encodeURIComponent(REPO)}`;

beforeEach(() => {
  get.mockReset(); put.mockReset(); post.mockReset(); del.mockReset();
  forbidWindowConfirm();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Admin → Repositories: the list', () => {
  it('is reachable from the admin nav, under Fleet', async () => {
    hubAnswers();
    renderAt('/admin/repos');
    const nav = screen.getByRole('navigation', { name: /admin sections/i });
    const fleet = within(nav).getByRole('group', { name: 'Fleet' });
    expect(within(fleet).getByRole('link', { name: /repositories/i })).toHaveAttribute('href', '/admin/repos');
  });

  it('lists each repository with its command, revision, mode in words and last receipt in UTC', async () => {
    hubAnswers();
    renderAt('/admin/repos');
    const row = (await screen.findByText(REPO)).closest('tr')!;
    expect(within(row).getByText('npm test')).toBeInTheDocument();
    expect(within(row).getByText(/revision 3/i)).toBeInTheDocument();
    expect(within(row).getByText('Shadow')).toBeInTheDocument();
    expect(within(row).getByText('2026-06-03 10:15 UTC')).toBeInTheDocument();
    const other = screen.getByText(REPO2).closest('tr')!;
    expect(within(other).getByText('Off')).toBeInTheDocument();
    expect(within(other).getByText(/no receipts yet/i)).toBeInTheDocument();
  });

  it('says where repositories come from when there are none', async () => {
    hubAnswers({ '/v1/admin/repos': { repos: [] } });
    renderAt('/admin/repos');
    expect(await screen.findByText(/no repositories yet/i)).toBeInTheDocument();
    expect(screen.getByText(/first agenfk installation/i)).toBeInTheDocument();
  });

  it('opens a repository from the list', async () => {
    hubAnswers();
    renderAt('/admin/repos');
    fireEvent.click(await screen.findByRole('link', { name: `Open ${REPO}` }));
    expect(await screen.findByRole('heading', { name: REPO })).toBeInTheDocument();
    await waitFor(() => expect(get).toHaveBeenCalledWith(`/v1/admin/repos/revisions?repo=${encodeURIComponent(REPO)}`));
    expect(get).toHaveBeenCalledWith(`/v1/admin/repos/receipts?repo=${encodeURIComponent(REPO)}`);
  });
});

// GH-273: an org with many repositories got a page as long as the list, and no
// way to find one by name.
describe('Admin → Repositories: finding a repository', () => {
  const rowsShown = () => within(screen.getByRole('table', { name: 'Repositories' })).getAllByRole('row').slice(1);
  const search = () => screen.getByRole('searchbox', { name: /search repositories/i });

  it('filters by part of the name, ignoring case', async () => {
    hubAnswers();
    renderAt('/admin/repos');
    await screen.findByText(REPO);
    fireEvent.change(search(), { target: { value: 'WIDG' } });
    expect(rowsShown()).toHaveLength(1);
    expect(screen.getByText(REPO2)).toBeInTheDocument();
    expect(screen.queryByText(REPO)).not.toBeInTheDocument();
  });

  it('keeps every repository that contains the text', async () => {
    hubAnswers();
    renderAt('/admin/repos');
    await screen.findByText(REPO);
    fireEvent.change(search(), { target: { value: 'acme/' } });
    expect(rowsShown()).toHaveLength(2);
  });

  it('says so when nothing matches', async () => {
    hubAnswers();
    renderAt('/admin/repos');
    await screen.findByText(REPO);
    fireEvent.change(search(), { target: { value: 'nothing-like-it' } });
    expect(screen.getByText(/no rows match/i)).toBeInTheDocument();
  });
});

describe('Admin → Repositories: the list ends at the bottom of the window', () => {
  const setWindowHeight = (h: number) => Object.defineProperty(window, 'innerHeight', { configurable: true, value: h });
  /** The box the rows scroll in: the table's own parent. */
  const scrollBox = () => screen.getByRole('table', { name: 'Repositories' }).parentElement as HTMLElement;
  let realHeight: number;
  beforeEach(() => {
    realHeight = window.innerHeight;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ top: 300 } as DOMRect);
  });
  afterEach(() => setWindowHeight(realHeight));

  // Outside the app shell (no scrolling pane, no layout CSS in jsdom) the box
  // reaches the bottom of the window itself.
  it('scrolls the rows inside a box that reaches the bottom of the window', async () => {
    setWindowHeight(900);
    hubAnswers();
    renderAt('/admin/repos');
    await screen.findByText(REPO);
    expect(scrollBox().style.maxHeight).toBe(`${900 - 300}px`);
    expect(scrollBox().style.overflowY).toBe('auto');
  });

  it('follows the window when it is resized', async () => {
    setWindowHeight(900);
    hubAnswers();
    renderAt('/admin/repos');
    await screen.findByText(REPO);
    setWindowHeight(1200);
    fireEvent(window, new Event('resize'));
    await waitFor(() => expect(scrollBox().style.maxHeight).toBe(`${1200 - 300}px`));
  });

  it('keeps a usable height in a very short window', async () => {
    setWindowHeight(350);
    hubAnswers();
    renderAt('/admin/repos');
    await screen.findByText(REPO);
    expect(scrollBox().style.maxHeight).toBe(`${FILL_VIEWPORT_MIN}px`);
  });
});

describe('Admin → Repositories: one repository', () => {
  it('saves the verify command as a new revision', async () => {
    hubAnswers();
    put.mockResolvedValue({ data: repoRow({ verifyCommand: './scripts/verify.sh', revision: 4 }) });
    renderAt(detailUrl);
    const input = await screen.findByLabelText(/verify command/i);
    expect(input).toHaveValue('npm test');
    fireEvent.change(input, { target: { value: '  ./scripts/verify.sh  ' } });
    fireEvent.click(screen.getByRole('button', { name: /save as new revision/i }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/v1/admin/repos/command', { repo: REPO, verifyCommand: './scripts/verify.sh' }));
  });

  it('shows the hub\'s refusal of a command inline', async () => {
    hubAnswers();
    put.mockRejectedValue({ response: { status: 400, data: { error: 'the command names /Users/ana/x.sh, a path on one machine', code: 'machine_specific_path' } } });
    renderAt(detailUrl);
    fireEvent.change(await screen.findByLabelText(/verify command/i), { target: { value: '/Users/ana/x.sh' } });
    fireEvent.click(screen.getByRole('button', { name: /save as new revision/i }));
    expect(await screen.findByText(/a path on one machine/)).toBeInTheDocument();
  });

  it('lists the revisions, naming the installation that initialized the first one and the admin of each later one', async () => {
    hubAnswers();
    renderAt(detailUrl);
    const history = await screen.findByRole('table', { name: /revision history/i });
    const rev1 = (await within(history).findByText('1')).closest('tr')!;
    expect(within(rev1).getByText(/initialized by installation/i)).toBeInTheDocument();
    expect(within(rev1).getByText(/inst-alice/)).toBeInTheDocument();
    expect(within(rev1).getByText('npm run verify')).toBeInTheDocument();
    expect(within(rev1).getByText('2026-06-01 09:00 UTC')).toBeInTheDocument();
    const rev3 = within(history).getByText('3').closest('tr')!;
    expect(within(rev3).getByText(/admin@acme.test/)).toBeInTheDocument();
  });

  it('sets the receipts mode, and says closing a root card gets slower', async () => {
    hubAnswers({ '/v1/admin/repos': { repos: [repoRow({ receiptsMode: 'off' })] } });
    put.mockResolvedValue({ data: repoRow({ receiptsMode: 'shadow' }) });
    renderAt(detailUrl);
    const group = await screen.findByRole('radiogroup', { name: /ci receipts mode/i });
    expect(within(group).getByRole('radio', { name: /off/i })).toBeChecked();
    expect(screen.queryByText(/runs the verify command fresh/i)).not.toBeInTheDocument();
    fireEvent.click(within(group).getByRole('radio', { name: /shadow/i }));
    expect(screen.getByText(/runs the verify command fresh/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /save mode/i }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/v1/admin/repos/mode', { repo: REPO, mode: 'shadow' }));
  });

  it('allows Enforce only with a Shadow threshold, and sends the threshold', async () => {
    hubAnswers();
    put.mockResolvedValue({ data: repoRow({ receiptsMode: 'enforce', shadowThreshold: 10 }) });
    renderAt(detailUrl);
    const group = await screen.findByRole('radiogroup', { name: /ci receipts mode/i });
    const enforce = within(group).getByRole('radio', { name: /enforce/i });
    expect(enforce).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/shadow threshold/i), { target: { value: '10' } });
    expect(enforce).toBeEnabled();
    fireEvent.click(enforce);
    fireEvent.click(screen.getByRole('button', { name: /save mode/i }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/v1/admin/repos/mode', { repo: REPO, mode: 'enforce', shadowThreshold: 10 }));
  });

  it('keeps the producer allowlist: add an installation, remove one', async () => {
    hubAnswers();
    put.mockResolvedValue({ data: repoRow({ producers: ['inst-alice', 'inst-bob'] }) });
    renderAt(detailUrl);
    const producers = await screen.findByRole('region', { name: /producers/i });
    expect(await within(producers).findByText(/alice@acme.test/)).toBeInTheDocument();
    fireEvent.change(within(producers).getByLabelText(/add a producer/i), { target: { value: 'inst-bob' } });
    fireEvent.click(within(producers).getByRole('button', { name: /^allow$/i }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/v1/admin/repos/producers', { repo: REPO, installationId: 'inst-bob', allowed: true }));
    put.mockClear();
    fireEvent.click(within(producers).getByRole('button', { name: /remove producer alice@acme.test/i }));
    await answerConfirm(true);
    await waitFor(() => expect(put).toHaveBeenCalledWith('/v1/admin/repos/producers', { repo: REPO, installationId: 'inst-alice', allowed: false }));
  });

  it('lists recent receipts as Reusable or Not reusable, with the reason in words', async () => {
    hubAnswers();
    renderAt(detailUrl);
    const table = await screen.findByRole('table', { name: /recent receipts/i });
    const ok = (await within(table).findByText('Ship receipts')).closest('tr')!;
    expect(within(ok).getByText('Reusable')).toBeInTheDocument();
    expect(within(ok).getByText('2026-06-03 10:15 UTC')).toBeInTheDocument();
    const no = within(table).getByText('Review it').closest('tr')!;
    expect(within(no).getByText('Not reusable')).toBeInTheDocument();
    expect(within(no).getByText(/machine is not an allowed producer/i)).toBeInTheDocument();
    expect(within(no).getByText(/security/)).toBeInTheDocument();
  });
});

// GH-276: the Producer column showed the installation's uuid; an admin reads
// receipts by who made them.
describe('Admin → Repositories: who produced each receipt', () => {
  const producerCell = async (cardTitle: string) => {
    const table = await screen.findByRole('table', { name: /recent receipts/i });
    const row = (await within(table).findByText(cardTitle)).closest('tr')!;
    // Columns: Received, Card, Kind, Producer, Status.
    return within(row).getAllByRole('cell')[3];
  };

  it('names the producer by its git email, keeping the id beside it', async () => {
    hubAnswers();
    renderAt(detailUrl);
    const cell = await producerCell('Ship receipts');
    expect(within(cell).getByText('alice@acme.test')).toBeInTheDocument();
    expect(within(cell).getByText('inst-alice')).toBeInTheDocument();
  });

  it('falls back to the OS user when the installation has no git email', async () => {
    hubAnswers({ '/v1/admin/installations': [{ ...INSTALLATIONS[0], gitEmail: null }, INSTALLATIONS[1]] });
    renderAt(detailUrl);
    expect(within(await producerCell('Ship receipts')).getByText('alice')).toBeInTheDocument();
  });

  it('still lists the receipts, by id, when the installations cannot be read', async () => {
    hubAnswers();
    const answer = get.getMockImplementation()!;
    get.mockImplementation(async (url: string) => {
      if (url.startsWith('/v1/admin/installations')) throw new Error('hub down');
      return answer(url);
    });
    renderAt(detailUrl);
    expect(await producerCell('Ship receipts')).toHaveTextContent(/^inst-alice$/);
  });

  it('shows the id alone for an installation the hub no longer lists', async () => {
    hubAnswers({ '/v1/admin/installations': [INSTALLATIONS[1]] });
    renderAt(detailUrl);
    const cell = await producerCell('Ship receipts');
    expect(cell).toHaveTextContent(/^inst-alice$/);
  });
});

// Codex review: `reusable` is decided when a receipt arrives; the allowlist is
// read NOW. A receipt from a producer removed since is one CI refuses.
describe('Admin → Repositories: a producer removed since', () => {
  it('shows its receipts as not reusable, saying why', async () => {
    hubAnswers({ '/v1/admin/repos/receipts': { receipts: [{ ...RECEIPTS[0], producerAllowed: false }] } });
    renderAt(detailUrl);
    const table = await screen.findByRole('table', { name: /recent receipts/i });
    const row = (await within(table).findByText('Ship receipts')).closest('tr')!;
    expect(within(row).queryByText('Reusable')).not.toBeInTheDocument();
    expect(within(row).getByText('Not reusable')).toBeInTheDocument();
    expect(within(row).getByText(/no longer an allowed producer/i)).toBeInTheDocument();
  });

  it('refreshes the receipts after the allowlist changes', async () => {
    hubAnswers();
    put.mockResolvedValue({ data: repoRow({ producers: [] }) });
    renderAt(detailUrl);
    const producers = await screen.findByRole('region', { name: /producers/i });
    await within(producers).findByText(/alice@acme.test/);
    const receiptReads = () => get.mock.calls.filter(([u]) => String(u).startsWith('/v1/admin/repos/receipts')).length;
    await waitFor(() => expect(receiptReads()).toBe(1));
    fireEvent.click(within(producers).getByRole('button', { name: /remove producer alice@acme.test/i }));
    await answerConfirm(true);
    await waitFor(() => expect(receiptReads()).toBe(2));
  });
});

// RFC-002 Amendment 1 (GH #289): who may produce receipts is a mode, the
// explicit list one of its two answers.
describe('Admin → Repositories: producer mode', () => {
  const modeGroup = async () => {
    const producers = await screen.findByRole('region', { name: /producers/i });
    return { producers, group: within(producers).getByRole('radiogroup', { name: /who may produce receipts/i }) };
  };

  it('shows "Only these installations" for a repository the hub sends no mode for, with the trust trade-off in one line', async () => {
    hubAnswers();
    renderAt(detailUrl);
    const { producers, group } = await modeGroup();
    expect(within(group).getByRole('radio', { name: /only these installations/i })).toBeChecked();
    expect(within(group).getByRole('radio', { name: /all joined installations/i })).not.toBeChecked();
    expect(within(producers).getByText(/any machine that joins the organization can produce/i)).toBeInTheDocument();
    // The list is the one that applies: it is shown and editable.
    expect(await within(producers).findByText(/alice@acme.test/)).toBeInTheDocument();
    expect(within(producers).getByLabelText(/add a producer/i)).toBeEnabled();
  });

  it('switches to all joined installations after the admin confirms the trade-off, and refreshes the receipts', async () => {
    hubAnswers();
    put.mockResolvedValue({ data: repoRow({ producerMode: 'all' }) });
    renderAt(detailUrl);
    const { group } = await modeGroup();
    const receiptReads = () => get.mock.calls.filter(([u]) => String(u).startsWith('/v1/admin/repos/receipts')).length;
    await waitFor(() => expect(receiptReads()).toBe(1));
    fireEvent.click(within(group).getByRole('radio', { name: /all joined installations/i }));
    await answerConfirm(true);
    await waitFor(() => expect(put).toHaveBeenCalledWith('/v1/admin/repos/producer-mode', { repo: REPO, producerMode: 'all' }));
    await waitFor(() => expect(receiptReads()).toBe(2));
  });

  it('changes nothing when the admin backs out of the confirmation', async () => {
    hubAnswers();
    renderAt(detailUrl);
    const { group } = await modeGroup();
    fireEvent.click(within(group).getByRole('radio', { name: /all joined installations/i }));
    await answerConfirm(false);
    await letMutationsLand();
    expect(put).not.toHaveBeenCalled();
    expect(within(group).getByRole('radio', { name: /only these installations/i })).toBeChecked();
  });

  it('under all, says the list is kept for when the repository is switched back, and switches back without asking', async () => {
    hubAnswers({ '/v1/admin/repos': { repos: [repoRow({ producerMode: 'all' })] } });
    put.mockResolvedValue({ data: repoRow({ producerMode: 'listed' }) });
    renderAt(detailUrl);
    const { producers, group } = await modeGroup();
    expect(within(group).getByRole('radio', { name: /all joined installations/i })).toBeChecked();
    expect(within(producers).getByText(/kept.*applies again/i)).toBeInTheDocument();
    expect(await within(producers).findByText(/alice@acme.test/)).toBeInTheDocument();
    fireEvent.click(within(group).getByRole('radio', { name: /only these installations/i }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/v1/admin/repos/producer-mode', { repo: REPO, producerMode: 'listed' }));
  });

  // Codex review: under all, removing a listed installation revokes nothing.
  it('under all, removing an installation from the list says it changes nothing until the switch back', async () => {
    hubAnswers({ '/v1/admin/repos': { repos: [repoRow({ producerMode: 'all' })] } });
    put.mockResolvedValue({ data: repoRow({ producerMode: 'all', producers: [] }) });
    renderAt(detailUrl);
    const { producers } = await modeGroup();
    await within(producers).findByText(/alice@acme.test/);
    fireEvent.click(within(producers).getByRole('button', { name: /remove producer alice@acme.test/i }));
    const said = await answerConfirm(true);
    expect(said).toMatch(/changes nothing/i);
    expect(said).toMatch(/until it is retired/i);
    expect(said).not.toMatch(/CI stops reusing/i);
    await waitFor(() => expect(put).toHaveBeenCalledWith('/v1/admin/repos/producers', { repo: REPO, installationId: 'inst-alice', allowed: false }));
  });

  it('under listed, removing an installation still warns that CI stops reusing its receipts', async () => {
    hubAnswers();
    renderAt(detailUrl);
    const { producers } = await modeGroup();
    await within(producers).findByText(/alice@acme.test/);
    fireEvent.click(within(producers).getByRole('button', { name: /remove producer alice@acme.test/i }));
    expect(await answerConfirm(false)).toMatch(/CI stops reusing every receipt/i);
  });

  it('an empty list under all does not claim no receipt can be reused', async () => {
    hubAnswers({ '/v1/admin/repos': { repos: [repoRow({ producerMode: 'all', producers: [] })] } });
    renderAt(detailUrl);
    const { producers } = await modeGroup();
    expect(within(producers).queryByText(/no receipt from this repository can be reused/i)).not.toBeInTheDocument();
    expect(within(producers).getByText(/no installations listed/i)).toBeInTheDocument();
  });

  it('an empty list under listed says no receipt can be reused', async () => {
    hubAnswers({ '/v1/admin/repos': { repos: [repoRow({ producers: [] })] } });
    renderAt(detailUrl);
    const { producers } = await modeGroup();
    expect(within(producers).getByText(/no receipt from this repository can be reused/i)).toBeInTheDocument();
  });

  it('shows the hub\'s refusal inline', async () => {
    hubAnswers({ '/v1/admin/repos': { repos: [repoRow({ producerMode: 'all' })] } });
    put.mockRejectedValue({ response: { status: 404, data: { error: 'this repository has no settings yet', code: 'not_found' } } });
    renderAt(detailUrl);
    const { producers, group } = await modeGroup();
    fireEvent.click(within(group).getByRole('radio', { name: /only these installations/i }));
    expect(await within(producers).findByRole('alert')).toHaveTextContent(/no settings yet/i);
  });

  it('says which mode each repository is on in the list', async () => {
    hubAnswers({ '/v1/admin/repos': { repos: [repoRow({ producerMode: 'all' }), repoRow({ remoteUrl: REPO2 })] } });
    renderAt('/admin/repos');
    const row = (await screen.findByText(REPO)).closest('tr')!;
    expect(within(row).getByText(/all joined installations/i)).toBeInTheDocument();
    const other = screen.getByText(REPO2).closest('tr')!;
    expect(within(other).getByText(/only these installations/i)).toBeInTheDocument();
  });
});

describe('Admin → API keys: CI tokens', () => {
  it('issues a read-only CI token for one repository, and shows it once', async () => {
    hubAnswers();
    post.mockResolvedValue({ data: { token: 'ci_' + 'f'.repeat(64), tokenHashPreview: 'ffff0000', label: 'gha', scope: 'repo', repo: REPO } });
    renderAt('/admin/keys');
    const card = await screen.findByRole('region', { name: /issue a ci token/i });
    expect(within(card).getByText(/read-only/i)).toBeInTheDocument();
    fireEvent.change(within(card).getByLabelText(/token label/i), { target: { value: 'gha' } });
    await within(card).findByRole('option', { name: REPO });
    fireEvent.change(within(card).getByLabelText(/what it can read/i), { target: { value: REPO } });
    fireEvent.click(within(card).getByRole('button', { name: /issue ci token/i }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/v1/admin/ci-tokens', { label: 'gha', repo: REPO }));
    expect(await within(card).findByText('ci_' + 'f'.repeat(64))).toBeInTheDocument();
    expect(within(card).getByText(/won't be shown again/i)).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: /i've saved it/i }));
    expect(within(card).queryByText('ci_' + 'f'.repeat(64))).not.toBeInTheDocument();
  });

  it('issues an org-wide token only when the whole organisation is chosen', async () => {
    hubAnswers();
    post.mockResolvedValue({ data: { token: 'ci_x', tokenHashPreview: 'x', label: null, scope: 'org', repo: null } });
    renderAt('/admin/keys');
    const card = await screen.findByRole('region', { name: /issue a ci token/i });
    await within(card).findByRole('option', { name: REPO });
    fireEvent.change(within(card).getByLabelText(/what it can read/i), { target: { value: '__org__' } });
    fireEvent.click(within(card).getByRole('button', { name: /issue ci token/i }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/v1/admin/ci-tokens', { scope: 'org' }));
  });

  it('lists installation keys and CI tokens with a Type column, and revokes each through its own route', async () => {
    hubAnswers();
    del.mockResolvedValue({ data: { revoked: 1 } });
    renderAt('/admin/keys');
    const table = await screen.findByRole('table', { name: /keys and tokens/i });
    expect(within(table).getByRole('columnheader', { name: 'Type' })).toBeInTheDocument();
    const key = (await within(table).findByText('alice-laptop')).closest('tr')!;
    expect(within(key).getByText('Installation')).toBeInTheDocument();
    const ci = (await within(table).findByText('github-actions')).closest('tr')!;
    expect(within(ci).getByText('CI read-only')).toBeInTheDocument();
    expect(within(ci).getByText(REPO)).toBeInTheDocument();
    fireEvent.click(within(ci).getByRole('button', { name: /revoke ci token github-actions/i }));
    await answerConfirm(true);
    await waitFor(() => expect(del).toHaveBeenCalledWith('/v1/admin/ci-tokens/cccc2222'));
    expect(del).not.toHaveBeenCalledWith('/v1/admin/api-keys/cccc2222');
  });
});
