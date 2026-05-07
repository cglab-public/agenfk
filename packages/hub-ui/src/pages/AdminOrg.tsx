import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Building2, Copy, Check, AlertTriangle } from 'lucide-react';
import { api, MeResponse } from '../api';
import { validateOrgIdInput, spokeRepointCommand } from './adminOrgRename';

const inputCls = 'w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500';
const cardCls = 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5';
const primaryBtnCls = 'px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-semibold transition-colors';
const ghostBtnCls = 'px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 text-sm font-semibold hover:bg-slate-50 dark:hover:bg-slate-800';

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
            <Building2 className="w-4 h-4 text-indigo-500" />
            <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Organization</h3>
          </div>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Rename the org id this hub serves. The id is referenced from spoke installations and embedded in queued events; renaming repoints them all in a single transaction.
          </p>
        </header>

        <dl className="mt-4 grid grid-cols-[7rem_1fr] gap-y-1 text-sm">
          <dt className="text-slate-500 dark:text-slate-400">Current id</dt>
          <dd className="font-mono text-slate-800 dark:text-slate-100">{currentOrgId || '—'}</dd>
        </dl>

        <details className="mt-4 text-xs text-slate-600 dark:text-slate-400">
          <summary className="cursor-pointer select-none font-semibold text-slate-700 dark:text-slate-200">What this does</summary>
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
            <h3 className="mt-1 text-sm font-semibold text-slate-800 dark:text-slate-100">Now repoint your spoke installations</h3>
            <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
              Send this command to anyone running an <code className="font-mono">agenfk</code> installation against this hub (or run it on every machine via your fleet tool):
            </p>
          </header>
          <pre className="mt-3 px-3 py-2.5 rounded-lg bg-slate-900 text-slate-100 text-xs font-mono overflow-x-auto select-all">{spokeCmd}</pre>
          <div className="mt-2 flex items-center gap-3">
            <button
              onClick={async () => { try { await navigator.clipboard.writeText(spokeCmd); setCopied(true); } catch { /* ignore */ } }}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
            >
              {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? 'Copied' : 'Copy command'}
            </button>
            <button onClick={() => setSuccess(null)} className="text-xs font-medium text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">Dismiss</button>
          </div>
          <p className="mt-3 text-[11px] text-slate-500 dark:text-slate-400">
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-5 space-y-3">
        <div className="flex items-start gap-2">
          <AlertTriangle className="w-5 h-5 text-amber-500 mt-0.5" />
          <div>
            <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Rename org id</h3>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
              This will rename <code className="font-mono">{props.from}</code> → <code className="font-mono">{props.to}</code> across the hub database in a single transaction.
            </p>
          </div>
        </div>
        <ul className="text-xs text-slate-600 dark:text-slate-400 list-disc pl-5 space-y-1">
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
