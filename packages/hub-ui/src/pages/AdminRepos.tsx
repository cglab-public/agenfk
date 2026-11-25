import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Trash2 } from 'lucide-react';
import { api } from '../api';
import { apiErrorText } from '../apiError';
import { Badge, Callout, DataTable, QueryError, buttonClass, cardClass, controlClass, useConfirm, type DataColumn } from '../components/ui';
import {
  MODE_HELP, MODE_LABEL, PRODUCER_ALL_TRADE_OFF, PRODUCER_MODE_HELP, PRODUCER_MODE_LABEL,
  notReusableWords, producerModeOf, receiptStanding, repoQuery, revisionAuthor, utc,
  type ProducerMode, type ReceiptView, type ReceiptsMode, type RepoView, type RevisionView,
} from './repoSettingsText';

/**
 * Admin → Repositories (RFC-002). The hub's record of each repository the org
 * verifies: the command every installation runs, its revisions, how CI treats
 * receipts, which machines may produce them, and the receipts that came in.
 * The list and one repository share the route; `?repo=` picks the repository.
 */

interface InstallationOption { id: string; gitEmail: string | null; osUser: string | null }

const MODES: ReceiptsMode[] = ['off', 'shadow', 'enforce'];
const PRODUCER_MODES: ProducerMode[] = ['all', 'listed'];
const MODE_TONE = { off: 'neutral', shadow: 'info', enforce: 'ok' } as const;

const useInstallations = () => useQuery<InstallationOption[]>({
  queryKey: ['admin-installations', false, false],
  queryFn: async () => (await api.get('/v1/admin/installations')).data,
});

/** Who an installation belongs to, by git email, else OS user; null when the hub does not list it. */
const installationName = (installations: InstallationOption[] | undefined, id: string): string | null => {
  const i = (Array.isArray(installations) ? installations : []).find(x => x.id === id);
  return i?.gitEmail ?? i?.osUser ?? null;
};

const useRepos = () => useQuery<RepoView[]>({
  queryKey: ['admin-repos'],
  queryFn: async () => ((await api.get('/v1/admin/repos')).data?.repos ?? []) as RepoView[],
});

export function AdminRepos() {
  const [params] = useSearchParams();
  const repo = params.get('repo');
  return repo ? <RepoDetail repo={repo} /> : <RepoList />;
}

const REPO_COLUMNS: DataColumn<RepoView>[] = [
  {
    key: 'repo', header: 'Repository', className: 'font-mono text-small',
    render: r => (
      <Link to={`/admin/repos?${repoQuery(r.remoteUrl)}`} aria-label={`Open ${r.remoteUrl}`} className="text-accent-ink hover:underline">
        {r.remoteUrl}
      </Link>
    ),
  },
  { key: 'command', header: 'Verify command', className: 'font-mono text-small text-ink-secondary', render: r => r.verifyCommand },
  { key: 'revision', header: 'Revision', className: 'text-small text-ink-secondary tabular-nums', render: r => `revision ${r.revision}` },
  {
    key: 'mode', header: 'CI receipts',
    render: r => <Badge tone={MODE_TONE[r.receiptsMode] ?? 'neutral'}>{MODE_LABEL[r.receiptsMode] ?? r.receiptsMode}</Badge>,
  },
  {
    key: 'producers', header: 'Producers', className: 'text-small text-ink-secondary',
    render: r => PRODUCER_MODE_LABEL[producerModeOf(r)],
  },
  {
    key: 'last', header: 'Last receipt', className: 'text-small text-ink-tertiary tabular-nums',
    render: r => (r.lastReceiptAt ? utc(r.lastReceiptAt) : 'No receipts yet'),
  },
];

function RepoList() {
  const repos = useRepos();
  if (repos.isError && !repos.data) return <QueryError error={repos.error} onRetry={() => repos.refetch()} />;
  if (!repos.data) return <p role="status" className="text-body text-ink-tertiary">Loading…</p>;
  if (repos.data.length === 0) {
    return (
      <section className={`${cardClass} max-w-form`}>
        <h3 className="text-body font-semibold text-ink">No repositories yet</h3>
        <p className="mt-1 text-body text-ink-tertiary">
          A repository appears here when the first AgEnFK installation working in it connects to this hub, and claims its
          verify command.
        </p>
      </section>
    );
  }
  return (
    <section className={cardClass}>
      <h3 className="text-body font-semibold text-ink">Repositories</h3>
      <p className="mt-1 text-small text-ink-tertiary">The verify command each repository runs, and how CI treats its receipts.</p>
      <div className="mt-3 -mx-5">
        <DataTable
          caption="Repositories"
          columns={REPO_COLUMNS}
          rows={repos.data}
          rowKey={r => r.remoteUrl}
          search={{
            label: 'Search repositories',
            placeholder: 'Search by repository name',
            matches: (r, q) => r.remoteUrl.toLowerCase().includes(q.toLowerCase()),
          }}
          rowHover
          fillViewport
        />
      </div>
    </section>
  );
}

function RepoDetail({ repo }: { repo: string }) {
  const repos = useRepos();
  const settings = repos.data?.find(r => r.remoteUrl === repo);
  return (
    <div className="space-y-4">
      <Link to="/admin/repos" className="inline-flex items-center gap-1 text-small font-medium text-ink-tertiary hover:text-ink">
        <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" /> All repositories
      </Link>
      <h2 className="text-title font-semibold text-ink font-mono break-all">{repo}</h2>
      {repos.isError && !repos.data && <QueryError error={repos.error} onRetry={() => repos.refetch()} />}
      {!repos.data && !repos.isError && <p role="status" className="text-body text-ink-tertiary">Loading…</p>}
      {repos.data && !settings && <p className="text-body text-ink-tertiary">This organisation has no settings for this repository.</p>}
      {settings && (
        <>
          <CommandCard settings={settings} />
          <RevisionHistory repo={repo} />
          <ModeCard settings={settings} />
          <ProducersCard settings={settings} />
          <RecentReceipts repo={repo} />
        </>
      )}
    </div>
  );
}

function CommandCard({ settings }: { settings: RepoView }) {
  const qc = useQueryClient();
  const [command, setCommand] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: async (verifyCommand: string) =>
      (await api.put('/v1/admin/repos/command', { repo: settings.remoteUrl, verifyCommand })).data as RepoView,
    onSuccess: () => {
      setCommand(null);
      qc.invalidateQueries({ queryKey: ['admin-repos'] });
      qc.invalidateQueries({ queryKey: ['admin-repo-revisions', settings.remoteUrl] });
    },
  });
  const value = command ?? settings.verifyCommand;
  return (
    <form
      className={`${cardClass} max-w-form`}
      onSubmit={(e) => { e.preventDefault(); save.mutate(value.trim()); }}
    >
      <h3 className="text-body font-semibold text-ink">Verify command</h3>
      <p className="mt-1 text-small text-ink-tertiary">
        Runs from the repository root on every installation, and on the root card's close. Saving makes a new revision;
        installations pick it up on their next sync, and receipts of an older revision stop counting.
      </p>
      <label className="block mt-3">
        <span className="eyebrow text-ink-tertiary">Verify command</span>
        <input className={`${controlClass} mt-1.5 font-mono`} value={value} onChange={(e) => { save.reset(); setCommand(e.target.value); }} />
      </label>
      <div className="mt-3 flex items-center gap-3">
        <button type="submit" className={buttonClass('primary')} disabled={save.isPending || !value.trim()}>
          {save.isPending ? 'Saving…' : 'Save as new revision'}
        </button>
        <span className="text-small text-ink-tertiary">Now on revision {settings.revision}</span>
      </div>
      {save.isError && <p role="alert" className="mt-2 text-small text-status-danger-text">{apiErrorText(save.error)}</p>}
    </form>
  );
}

function RevisionHistory({ repo }: { repo: string }) {
  const revisions = useQuery<RevisionView[]>({
    queryKey: ['admin-repo-revisions', repo],
    queryFn: async () => ((await api.get(`/v1/admin/repos/revisions?${repoQuery(repo)}`)).data?.revisions ?? []) as RevisionView[],
  });
  return (
    <section className={cardClass}>
      <h3 className="text-body font-semibold text-ink">Revision history</h3>
      {revisions.isError && <QueryError error={revisions.error} onRetry={() => revisions.refetch()} />}
      <div className="mt-3 -mx-5 relative overflow-x-auto">
        <table className="w-full text-body" aria-label="Revision history">
          <thead>
            <tr className="eyebrow text-ink-tertiary">
              <th className="text-left px-5 py-2">Revision</th>
              <th className="text-left px-2 py-2">Command</th>
              <th className="text-left px-2 py-2">By</th>
              <th className="text-left px-5 py-2">When</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-soft">
            {(revisions.data ?? []).map(r => (
              <tr key={r.revision}>
                <td className="px-5 py-2.5 tabular-nums">{r.revision}</td>
                <td className="px-2 py-2.5 font-mono text-small text-ink-secondary">{r.verifyCommand}</td>
                <td className="px-2 py-2.5 text-small text-ink-secondary">{revisionAuthor(r)}</td>
                <td className="px-5 py-2.5 text-small text-ink-tertiary tabular-nums">{utc(r.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ModeCard({ settings }: { settings: RepoView }) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<ReceiptsMode>(settings.receiptsMode);
  const [threshold, setThreshold] = useState('');
  const typed = threshold.trim() === '' ? null : Number(threshold);
  const thresholdValid = typed === null || (Number.isInteger(typed) && typed > 0);
  const hasThreshold = (typed !== null && thresholdValid) || settings.shadowThreshold !== null;
  const save = useMutation({
    mutationFn: async () => (await api.put('/v1/admin/repos/mode', {
      repo: settings.remoteUrl, mode,
      ...(typed !== null ? { shadowThreshold: typed } : {}),
    })).data as RepoView,
    onSuccess: () => { setThreshold(''); qc.invalidateQueries({ queryKey: ['admin-repos'] }); },
  });
  const helpId = (m: ReceiptsMode) => `mode-help-${m}`;
  return (
    <form className={`${cardClass} max-w-form`} onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <h3 className="text-body font-semibold text-ink">CI receipts</h3>
      <div role="radiogroup" aria-label="CI receipts mode" className="mt-3 space-y-2">
        {MODES.map(m => {
          const disabled = m === 'enforce' && !hasThreshold;
          return (
            <div key={m} className="flex items-start gap-2">
              <input
                type="radio" id={`mode-${m}`} name="receipts-mode" value={m}
                checked={mode === m} disabled={disabled}
                aria-describedby={helpId(m)}
                onChange={() => { save.reset(); setMode(m); }}
                className="mt-1"
              />
              <div>
                <label htmlFor={`mode-${m}`} className="text-body font-medium text-ink">{MODE_LABEL[m]}</label>
                <p id={helpId(m)} className="text-small text-ink-tertiary">
                  {MODE_HELP[m]}{disabled ? ' Set a Shadow threshold first.' : ''}
                </p>
              </div>
            </div>
          );
        })}
      </div>
      <label className="block mt-3">
        <span className="eyebrow text-ink-tertiary">Shadow threshold (pull requests)</span>
        <input
          type="number" min={1} inputMode="numeric"
          className={`${controlClass} mt-1.5 max-w-[12rem]`}
          placeholder={settings.shadowThreshold !== null ? String(settings.shadowThreshold) : 'not set'}
          value={threshold}
          onChange={(e) => { save.reset(); setThreshold(e.target.value); }}
        />
      </label>
      <p className="mt-1 text-small text-ink-tertiary">
        {settings.shadowThreshold !== null
          ? `Currently ${settings.shadowThreshold} pull requests in Shadow before Enforce.`
          : 'Not set: Enforce stays unavailable until it is.'}
      </p>
      {!thresholdValid && <p role="alert" className="mt-1 text-small text-status-danger-text">The threshold is a whole number of pull requests, 1 or more.</p>}
      {mode !== 'off' && (
        <Callout tone="warn" className="mt-3">
          In Shadow and Enforce the root card runs the verify command fresh when it closes, even when a green run of the
          same content is on record, so closing a root card is slower.
        </Callout>
      )}
      <div className="mt-3 flex items-center gap-3">
        <button type="submit" className={buttonClass('primary')} disabled={save.isPending || !thresholdValid}>
          {save.isPending ? 'Saving…' : 'Save mode'}
        </button>
        {save.isSuccess && <span className="text-small text-status-ok-text font-medium">✓ Saved</span>}
      </div>
      {save.isError && <p role="alert" className="mt-2 text-small text-status-danger-text">{apiErrorText(save.error)}</p>}
    </form>
  );
}

function ProducersCard({ settings }: { settings: RepoView }) {
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirm();
  const installations = useInstallations();
  const [adding, setAdding] = useState('');
  const set = useMutation({
    mutationFn: async (v: { installationId: string; allowed: boolean }) =>
      (await api.put('/v1/admin/repos/producers', { repo: settings.remoteUrl, ...v })).data as RepoView,
    onSuccess: () => {
      setAdding('');
      qc.invalidateQueries({ queryKey: ['admin-repos'] });
      // Whether a receipt can be reused depends on the allowlist NOW.
      qc.invalidateQueries({ queryKey: ['admin-repo-receipts', settings.remoteUrl] });
    },
  });
  const switchMode = useMutation({
    mutationFn: async (producerMode: ProducerMode) =>
      (await api.put('/v1/admin/repos/producer-mode', { repo: settings.remoteUrl, producerMode })).data as RepoView,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-repos'] });
      // Whether a receipt can be reused depends on who may produce them NOW.
      qc.invalidateQueries({ queryKey: ['admin-repo-receipts', settings.remoteUrl] });
    },
  });
  const mode = producerModeOf(settings);
  const chooseMode = async (next: ProducerMode) => {
    if (next === mode || switchMode.isPending) return;
    switchMode.reset();
    // Widening who may produce receipts is the trust decision; narrowing it back is not.
    if (next === 'all' && !(await confirm({
      title: 'Let every installation produce receipts?',
      body: PRODUCER_ALL_TRADE_OFF,
      confirmLabel: 'Allow all installations',
    }))) return;
    switchMode.mutate(next);
  };
  const nameOf = (id: string) => installationName(installations.data, id) ?? id;
  const candidates = (Array.isArray(installations.data) ? installations.data : []).filter(i => !settings.producers.includes(i.id));
  const helpId = (m: ProducerMode) => `producer-mode-help-${m}`;
  return (
    <section aria-label="Producers" className={`${cardClass} max-w-form`}>
      {dialog}
      <h3 className="text-body font-semibold text-ink">Producers</h3>
      <div role="radiogroup" aria-label="Who may produce receipts" className="mt-3 space-y-2">
        {PRODUCER_MODES.map(m => (
          <div key={m} className="flex items-start gap-2">
            <input
              type="radio" id={`producer-mode-${m}`} name="producer-mode" value={m}
              checked={mode === m} disabled={switchMode.isPending}
              aria-describedby={helpId(m)}
              onChange={() => { void chooseMode(m); }}
              className="mt-1"
            />
            <div>
              <label htmlFor={`producer-mode-${m}`} className="text-body font-medium text-ink">{PRODUCER_MODE_LABEL[m]}</label>
              <p id={helpId(m)} className="text-small text-ink-tertiary">{PRODUCER_MODE_HELP[m]}</p>
            </div>
          </div>
        ))}
      </div>
      <p className="mt-2 text-small text-ink-tertiary">{PRODUCER_ALL_TRADE_OFF}</p>
      {switchMode.isError && <p role="alert" className="mt-2 text-small text-status-danger-text">{apiErrorText(switchMode.error)}</p>}
      <p className="mt-3 text-small text-ink-tertiary">
        {mode === 'all'
          ? 'This list is kept while All is on, and applies again when the repository is switched back to Only these installations.'
          : 'Only these installations publish receipts CI may reuse. Removing one stops its earlier receipts from counting too.'}
      </p>
      <ul className="mt-3 divide-y divide-border-soft">
        {settings.producers.length === 0 && (
          <li className="py-2 text-body text-ink-tertiary">
            {mode === 'all'
              ? 'No installations listed. This takes effect only if the repository is switched back to Only these installations.'
              : 'No producers: no receipt from this repository can be reused.'}
          </li>
        )}
        {settings.producers.map(id => (
          <li key={id} className="py-2 flex items-center justify-between gap-3">
            <span className="text-body text-ink">{nameOf(id)} <span className="font-mono text-small text-ink-tertiary">{id}</span></span>
            <button
              type="button"
              aria-label={`Remove producer ${nameOf(id)}`}
              className="inline-flex items-center gap-1 text-small font-semibold text-ink-tertiary hover:text-status-danger-text"
              onClick={async () => {
                if (await confirm({
                  title: `Remove ${nameOf(id)} as a producer?`,
                  body: mode === 'all'
                    ? 'While All joined installations is on, this changes nothing: the installation still produces receipts until it is retired. It takes effect if the repository is switched back to Only these installations.'
                    : 'CI stops reusing every receipt this installation sent for this repository, including earlier ones.',
                  confirmLabel: 'Remove producer',
                })) set.mutate({ installationId: id, allowed: false });
              }}
            >
              <Trash2 className="w-3 h-3" aria-hidden="true" /> Remove
            </button>
          </li>
        ))}
      </ul>
      <form className="mt-3 flex flex-col sm:flex-row gap-2" onSubmit={(e) => { e.preventDefault(); if (adding) set.mutate({ installationId: adding, allowed: true }); }}>
        <select aria-label="Add a producer" className={`${controlClass} flex-1`} value={adding} onChange={(e) => setAdding(e.target.value)}>
          <option value="">Choose an installation…</option>
          {candidates.map(i => <option key={i.id} value={i.id}>{i.gitEmail ?? i.osUser ?? i.id}</option>)}
        </select>
        <button type="submit" className={buttonClass('secondary')} disabled={!adding || set.isPending}>Allow</button>
      </form>
      {set.isError && <p role="alert" className="mt-2 text-small text-status-danger-text">{apiErrorText(set.error)}</p>}
    </section>
  );
}

function RecentReceipts({ repo }: { repo: string }) {
  const receipts = useQuery<ReceiptView[]>({
    queryKey: ['admin-repo-receipts', repo],
    queryFn: async () => ((await api.get(`/v1/admin/repos/receipts?${repoQuery(repo)}`)).data?.receipts ?? []) as ReceiptView[],
  });
  const installations = useInstallations();
  return (
    <section className={cardClass}>
      <h3 className="text-body font-semibold text-ink">Recent receipts</h3>
      {receipts.isError && <QueryError error={receipts.error} onRetry={() => receipts.refetch()} />}
      <div className="mt-3 -mx-5 relative overflow-x-auto">
        <table className="w-full text-body" aria-label="Recent receipts">
          <thead>
            <tr className="eyebrow text-ink-tertiary">
              <th className="text-left px-5 py-2">Received</th>
              <th className="text-left px-2 py-2">Card</th>
              <th className="text-left px-2 py-2">Kind</th>
              <th className="text-left px-2 py-2">Producer</th>
              <th className="text-left px-5 py-2">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-soft">
            {(receipts.data ?? []).map(r => {
              const standing = receiptStanding(r);
              const producer = installationName(installations.data, r.installationId);
              return (
              <tr key={r.id}>
                <td className="px-5 py-2.5 text-small text-ink-tertiary tabular-nums">{utc(r.receivedAt)}</td>
                <td className="px-2 py-2.5 text-small">
                  <span className="text-ink">{r.cardTitle ?? r.cardId ?? '—'}</span>
                  {r.cardId && <span className="ml-1 font-mono text-ink-tertiary">{r.cardId.slice(0, 8)}</span>}
                </td>
                <td className="px-2 py-2.5 text-small text-ink-secondary">
                  {r.kind === 'review' ? `Review (${(r.lenses ?? []).join(', ') || 'general'})` : `Verification, revision ${r.commandRevision ?? '?'}`}
                </td>
                <td className="px-2 py-2.5 text-small">
                  {producer
                    ? <>
                        <span className="text-ink-secondary">{producer}</span>
                        <span className="ml-1 font-mono text-ink-tertiary">{r.installationId}</span>
                      </>
                    : <span className="font-mono text-ink-tertiary">{r.installationId}</span>}
                </td>
                <td className="px-5 py-2.5 text-small">
                  {standing.reusable
                    ? <Badge tone="ok">Reusable</Badge>
                    : (
                      <span className="inline-flex flex-wrap items-center gap-1.5">
                        <Badge tone="danger">Not reusable</Badge>
                        <span className="text-ink-secondary">{notReusableWords(standing.reason)}</span>
                      </span>
                    )}
                </td>
              </tr>
              );
            })}
            {receipts.data?.length === 0 && (
              <tr><td colSpan={5} className="px-5 py-6 text-center text-body text-ink-tertiary">No receipts yet. They arrive when a root card closes in Shadow or Enforce.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
