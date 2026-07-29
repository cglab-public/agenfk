import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Building2, Copy, Check, AlertTriangle } from 'lucide-react';
import { api, MeResponse } from '../api';
import { validateOrgIdInput, spokeRepointCommand } from './adminOrgRename';

const inputCls = 'w-full px-3 py-2 rounded-lg border border-border-soft bg-chip text-ink dark:text-white text-sm placeholder:text-ink-tertiary focus:outline-none focus:ring-2 focus:ring-brand';
const cardCls = 'bg-card-glass backdrop-blur border border-border-soft rounded-2xl p-5';
const primaryBtnCls = 'px-4 py-2 rounded-lg bg-[image:var(--gradient-accent)] text-navy shadow-glow disabled:opacity-50 text-sm font-bold transition-colors';
const ghostBtnCls = 'px-4 py-2 rounded-lg border border-border-soft text-ink-secondary text-sm font-semibold hover:bg-chip';

interface RenameResponse {
  ok: boolean;
  orgId: string;
  requiresEnvUpdate: boolean;
  envVar: string;
}

export function AdminOrg() {
  const qc = useQueryClient();
  const me = useQuery<MeResponse>({ queryKey: ['me'], queryFn: async () => (await api.get('/auth/me')).data });
  const currentOrgId = me.data?.orgId ?? '';

  const [draft, setDraft] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [success, setSuccess] = useState<RenameResponse | null>(null);
  const [copied, setCopied] = useState(false);

  const rename = useMutation({
    mutationFn: async (to: string) => {
      const r = await api.post('/v1/admin/orgs/rename', { from: currentOrgId, to });
      return r.data as RenameResponse;
    },
    onSuccess: (data) => {
      setSuccess(data);
      setConfirmOpen(false);
      setDraft('');
      // Refresh /auth/me + the pending banner so the rest of the UI catches up.
      qc.invalidateQueries({ queryKey: ['me'] });
      qc.invalidateQueries({ queryKey: ['system-pending'] });
    },
  });

  const inputError = draft.length > 0 ? validateOrgIdInput(draft, currentOrgId) : null;
  const canSubmit = !inputError && draft.length > 0 && currentOrgId !== '' && !rename.isPending;

  const hubUrl = (typeof window !== 'undefined' ? window.location.origin : '');
  const spokeCmd = success ? spokeRepointCommand({ hubUrl, orgId: success.orgId }) : '';

  return (
    <div className="max-w-2xl space-y-4">
      <section className={cardCls}>
        <header>
          <div className="flex items-center gap-2">
            <Building2 className="w-4 h-4 text-accent-text" />
            <h3 className="text-sm font-semibold text-ink">Organization</h3>
          </div>
          <p className="mt-1 text-xs text-ink-tertiary">
            Rename the org id this hub serves. The id is referenced from spoke installations and embedded in queued events; renaming repoints them all in a single transaction.
          </p>
        </header>

        <dl className="mt-4 grid grid-cols-[7rem_1fr] gap-y-1 text-sm">
          <dt className="text-ink-tertiary">Current id</dt>
          <dd className="font-mono text-ink">{currentOrgId || '—'}</dd>
        </dl>

        <details className="mt-4 text-xs text-ink-secondary">
          <summary className="cursor-pointer select-none font-semibold text-ink-secondary">What this does</summary>
          <ul className="mt-2 list-disc pl-5 space-y-1">
            <li>Logical rename only — no event/installation/api-key/user data is lost.</li>
            <li>Repoints rows across <code className="font-mono">events</code>, <code className="font-mono">installations</code>, <code className="font-mono">users</code>, <code className="font-mono">api_keys</code>, <code className="font-mono">flows</code>, and 6 other <code className="font-mono">org_id</code>-bearing tables in one transaction.</li>
            <li>Re-issues your admin session so the next request doesn't 401 against a deleted org.</li>
            <li>Spoke installations need to be repointed afterward — copy the command we generate below into your fleet runner or share it with each developer.</li>
            <li>You will need to update <code className="font-mono">AGENFK_HUB_ORG_ID</code> in your hub deployment manifest before the next restart, otherwise the hub will start in maintenance mode on the wrong env.</li>
          </ul>
        </details>

        <form
          className="mt-4 flex flex-col sm:flex-row gap-2 items-start"
          onSubmit={(e) => { e.preventDefault(); if (canSubmit) setConfirmOpen(true); }}
        >
          <div className="flex-1 w-full">
            <input
              className={inputCls}
              placeholder="New org id (e.g. cglab)"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            {inputError && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{inputError}</p>}
          </div>
          <button type="submit" className={primaryBtnCls} disabled={!canSubmit}>
            Rename
          </button>
        </form>
      </section>

      {confirmOpen && (
        <ConfirmRenameModal
          from={currentOrgId}
          to={draft}
          pending={rename.isPending}
          error={rename.error ? (rename.error as any)?.response?.data?.error ?? String(rename.error) : null}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => rename.mutate(draft)}
        />
      )}

      {success && (
        <section className={`${cardCls} border-emerald-200 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-900/10`}>
          <header>
            <div className="text-[11px] uppercase tracking-[0.14em] text-emerald-700 dark:text-emerald-300 font-semibold">Rename complete</div>
            <h3 className="mt-1 text-sm font-semibold text-ink">Now repoint your spoke installations</h3>
            <p className="mt-1 text-xs text-ink-secondary">
              Send this command to anyone running an <code className="font-mono">agenfk</code> installation against this hub (or run it on every machine via your fleet tool):
            </p>
          </header>
          <pre className="mt-3 px-3 py-2.5 rounded-lg bg-card-glass text-ink text-xs font-mono overflow-x-auto select-all">{spokeCmd}</pre>
          <div className="mt-2 flex items-center gap-3">
            <button
              onClick={async () => { try { await navigator.clipboard.writeText(spokeCmd); setCopied(true); } catch { /* ignore */ } }}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-accent-text hover:underline"
            >
              {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? 'Copied' : 'Copy command'}
            </button>
            <button onClick={() => setSuccess(null)} className="text-xs font-medium text-ink-tertiary hover:text-ink">Dismiss</button>
          </div>
          <p className="mt-3 text-[11px] text-ink-tertiary">
            Don't forget to also set <code className="font-mono">AGENFK_HUB_ORG_ID={success.orgId}</code> in your hub deployment manifest before the next restart. The persistent banner above will keep reminding you until you click "I've updated my deployment".
          </p>
        </section>
      )}
    </div>
  );
}

function ConfirmRenameModal(props: {
  from: string; to: string; pending: boolean; error: string | null;
  onCancel: () => void; onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-card-glass p-4">
      <div className="w-full max-w-md rounded-2xl bg-surface border border-border-soft p-5 space-y-3">
        <div className="flex items-start gap-2">
          <AlertTriangle className="w-5 h-5 text-amber-500 mt-0.5" />
          <div>
            <h3 className="text-sm font-semibold text-ink">Rename org id</h3>
            <p className="mt-1 text-sm text-ink-secondary">
              This will rename <code className="font-mono">{props.from}</code> → <code className="font-mono">{props.to}</code> across the hub database in a single transaction.
            </p>
          </div>
        </div>
        <ul className="text-xs text-ink-secondary list-disc pl-5 space-y-1">
          <li>Events, installations, users, api keys, flows, flow assignments are all repointed.</li>
          <li>Your admin session is re-issued — no logout required.</li>
          <li>You must update <code className="font-mono">AGENFK_HUB_ORG_ID</code> in your hub deployment to <code className="font-mono">{props.to}</code> before the next restart.</li>
          <li>Spoke installations must run <code className="font-mono">agenfk hub repoint</code> afterward (we'll show you the command).</li>
        </ul>
        {props.error && (
          <p className="text-xs text-red-600 dark:text-red-400 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/30">{props.error}</p>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <button className={ghostBtnCls} disabled={props.pending} onClick={props.onCancel}>Cancel</button>
          <button className={primaryBtnCls} disabled={props.pending} onClick={props.onConfirm}>
            {props.pending ? 'Renaming…' : `Rename to ${props.to}`}
          </button>
        </div>
      </div>
    </div>
  );
}
