import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Building2, AlertTriangle } from 'lucide-react';
import { api, MeResponse } from '../api';
import { validateOrgIdInput, spokeRepointCommand } from './adminOrgRename';
import { AdminFederation } from './AdminFederation';
import { AdminChildHubs } from './AdminChildHubs';
import { buttonClass, cardClass, cn, controlClass, CopyButton } from '../components/ui';

const inputCls = controlClass;
const cardCls = cardClass;
const primaryBtnCls = buttonClass('primary');
const ghostBtnCls = buttonClass('secondary');

interface RenameResponse {
  ok: boolean;
  orgId: string;
  requiresEnvUpdate: boolean;
  envVar: string;
}

/**
 * Admin → Organization: everything about this hub's place in the world.
 *
 * Three questions that used to live in three tabs — what this org is called,
 * who this hub reports to, and who reports to it — are one page, because they
 * are one subject and an admin arriving with any of them had to guess which
 * tab held it.
 */
export function AdminOrg() {
  return (
    <div className="space-y-5">
      <OrgIdentity />
      {/*
        Anchors, not decoration: /admin/child-hubs and /admin/parent-hub used to
        be addresses, and the child-hub roster in particular is an operational
        list people link to. The redirects target these.
      */}
      <div id="parent-hub"><AdminFederation /></div>
      <div id="child-hubs"><AdminChildHubs /></div>
    </div>
  );
}

function OrgIdentity() {
  const qc = useQueryClient();
  const me = useQuery<MeResponse>({ queryKey: ['me'], queryFn: async () => (await api.get('/auth/me')).data });
  const currentOrgId = me.data?.orgId ?? '';

  const [draft, setDraft] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [success, setSuccess] = useState<RenameResponse | null>(null);

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
    <div className="max-w-form space-y-4">
      <section className={cardCls}>
        <header>
          <div className="flex items-center gap-2">
            <Building2 className="w-4 h-4 text-accent-ink" />
            <h2 className="text-body font-semibold text-ink">Organization</h2>
          </div>
          <p className="mt-1 text-small text-ink-tertiary">
            Rename the org id this hub serves. The id is referenced from connected installations and embedded in queued events; renaming repoints them all in a single transaction.
          </p>
        </header>

        <dl className="mt-4 grid grid-cols-[7rem_1fr] gap-y-1 text-body">
          <dt className="text-ink-tertiary">Current id</dt>
          <dd className="font-mono text-ink">{currentOrgId || '—'}</dd>
        </dl>

        <details className="mt-4 text-small text-ink-secondary">
          <summary className="cursor-pointer select-none font-semibold text-ink-secondary">What this does</summary>
          <ul className="mt-2 list-disc pl-5 space-y-1">
            <li>Logical rename only — no event/installation/api-key/user data is lost.</li>
            <li>Moves everything the org owns (events, installations, users, API keys, flows and the rest) to the new id in one transaction.</li>
            <li>Re-issues your admin session so the next request doesn't 401 against a deleted org.</li>
            <li>Connected installations need to be repointed afterward — copy the command we generate below into your fleet runner or share it with each developer. It includes <code className="font-mono">--carry-over</code> so queued events move with the org; on a non-interactive runner append <code className="font-mono">--yes</code>, since the carry-over rewrite asks for a typed confirmation interactively.</li>
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
              aria-label="New org id"
              aria-invalid={inputError ? true : undefined}
              aria-describedby={inputError ? 'org-rename-error' : undefined}
              placeholder="New org id (e.g. cglab)"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            {inputError && <p id="org-rename-error" className="mt-1 text-small text-status-danger-text">{inputError}</p>}
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
        <section className={cn(cardCls, 'border-status-ok-text/40 bg-status-ok-bg')}>
          <header>
            <div className="eyebrow text-status-ok-text">Rename complete</div>
            <h3 className="mt-1 text-body font-semibold text-ink">Now repoint your connected installations</h3>
            <p className="mt-1 text-small text-ink-secondary">
              Send this command to anyone running an <code className="font-mono">agenfk</code> installation against this hub (or run it on every machine via your fleet tool):
            </p>
          </header>
          <pre className="mt-3 px-3 py-2.5 rounded-lg bg-canvas text-ink text-small font-mono relative overflow-x-auto select-all">{spokeCmd}</pre>
          <div className="mt-2 flex items-center gap-3">
            <CopyButton value={spokeCmd} label="Copy command" copiedLabel="Copied command" />
            <button onClick={() => setSuccess(null)} className="text-small font-medium text-ink-tertiary hover:text-ink">Dismiss</button>
          </div>
          <p className="mt-3 text-caption text-ink-tertiary">
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
          <AlertTriangle className="w-5 h-5 text-status-warn-text mt-0.5" />
          <div>
            <h3 className="text-body font-semibold text-ink">Rename org id</h3>
            <p className="mt-1 text-body text-ink-secondary">
              This will rename <code className="font-mono">{props.from}</code> → <code className="font-mono">{props.to}</code> across the hub database in a single transaction.
            </p>
          </div>
        </div>
        <ul className="text-small text-ink-secondary list-disc pl-5 space-y-1">
          <li>Events, installations, users, api keys, flows, flow assignments are all repointed.</li>
          <li>Your admin session is re-issued — no logout required.</li>
          <li>You must update <code className="font-mono">AGENFK_HUB_ORG_ID</code> in your hub deployment to <code className="font-mono">{props.to}</code> before the next restart.</li>
          <li>Connected installations must run <code className="font-mono">agenfk hub repoint</code> afterward (we'll show you the command).</li>
        </ul>
        {props.error && (
          <p className="text-small text-status-danger-text px-3 py-2 rounded-lg bg-status-danger-bg">{props.error}</p>
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
