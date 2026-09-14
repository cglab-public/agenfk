/**
 * Admin → Child hubs (CGLAB-181).
 *
 * A parent hub's roster of enrolled child hubs: who is enrolled, whether they
 * are still checking in, and the two destructive-ish actions — renaming one,
 * and detaching one, which revokes its credential and takes it off the air.
 *
 * Detach is behind a confirmation because it is not undoable from here: the
 * credential is revoked, so a child hub comes back only by enrolling again
 * with a fresh invite.
 */
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Network, Clock, AlertTriangle } from 'lucide-react';
import { api } from '../api';
import { apiErrorText as errText } from '../apiError';
import { fmtDateTime } from '../dates';

const cardCls = 'bg-card-glass backdrop-blur border border-border-soft rounded-2xl p-5';

export interface ChildHubRow {
  id: string;
  name: string;
  hubVersion: string | null;
  firstSeen: string | null;
  lastSeen: string | null;
  live: boolean;
  detached: boolean;
  detachedAt: string | null;
  detachedByEmail?: string | null;
  releaseRequested?: boolean;
  releaseRequestedAt?: string | null;
  releaseReason?: string | null;
}

interface ListResponse {
  isParent: boolean;
  childHubs: ChildHubRow[];
}

interface Invite {
  inviteToken: string;
  parentUrl: string;
  expiresAt: string;
}

// Locale-converted and NaN-guarded, like every other admin table — a bespoke
// UTC formatter here would have admins in other zones misjudging staleness.
const fmt = (iso: string | null) => (iso ? fmtDateTime(iso) : '—');


/**
 * Detach confirmation. A real dialog rather than a panel appended below the
 * table: this revokes a credential, and on a long roster a panel off the bottom
 * of the page reads as "nothing happened" — which invites a second click at the
 * one control where a double-fire is least welcome. Focus moves in, Escape and
 * the backdrop cancel, and focus returns to whatever opened it.
 */
function DetachDialog(props: {
  name: string; pending: boolean; error: string | null; releaseRequested?: boolean;
  onConfirm: () => void; onCancel: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<Element | null>(null);

  useEffect(() => {
    openerRef.current = document.activeElement;
    confirmRef.current?.focus();
    return () => { (openerRef.current as HTMLElement | null)?.focus?.(); };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={e => { if (e.target === e.currentTarget) props.onCancel(); }}
      onKeyDown={e => { if (e.key === 'Escape') props.onCancel(); }}
    >
      <div role="dialog" aria-modal="true" aria-label={`Detach ${props.name}`} className={`${cardCls} max-w-md`}>
        <h3 className="text-sm font-semibold text-ink inline-flex items-center gap-1.5">
          <AlertTriangle className="w-4 h-4 text-amber-500" /> Detach “{props.name}”?
        </h3>
        <p className="mt-2 text-xs text-ink-tertiary">
          This revokes its credential immediately and stops all dispatch to it. Nothing it already
          sent is deleted. It can only rejoin with a new join token.
        </p>
        {props.releaseRequested && (
          <p className="mt-2 text-xs text-ink-tertiary">
            This hub has asked to be released, so detaching it is how you agree.
          </p>
        )}
        {props.error && (
          <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">{props.error}</p>
        )}
        <div className="mt-3 flex items-center gap-2">
          <button
            ref={confirmRef}
            type="button"
            onClick={props.onConfirm}
            disabled={props.pending}
            className="rounded-lg border border-red-500/40 px-3 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-chip disabled:opacity-50"
          >
            Yes, detach
          </button>
          <button
            type="button"
            onClick={props.onCancel}
            className="rounded-lg px-3 py-1.5 text-xs text-ink-tertiary hover:bg-chip"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export function AdminChildHubs() {
  const qc = useQueryClient();
  const [showDetached, setShowDetached] = useState(false);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [renaming, setRenaming] = useState<ChildHubRow | null>(null);
  const [newName, setNewName] = useState('');
  const [detaching, setDetaching] = useState<ChildHubRow | null>(null);

  const list = useQuery<ListResponse>({
    queryKey: ['admin-child-hubs', showDetached],
    queryFn: async () =>
      (await api.get(`/v1/admin/child-hubs${showDetached ? '?includeDetached=1' : ''}`)).data,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['admin-child-hubs'] });

  // An invite is a credential, so it is minted only when asked for — never
  // fetched alongside the list where it would sit on screen unrequested.
  const mint = useMutation({
    mutationFn: async () => (await api.post('/v1/admin/child-hubs/invite')).data as Invite,
    onSuccess: setInvite,
  });
  const rename = useMutation({
    mutationFn: (v: { id: string; name: string }) => api.put(`/v1/admin/child-hubs/${v.id}`, { name: v.name }),
    onSuccess: () => { setRenaming(null); setNewName(''); invalidate(); },
  });
  const detach = useMutation({
    mutationFn: (id: string) => api.post(`/v1/admin/child-hubs/${id}/detach`),
    onSuccess: () => { setDetaching(null); invalidate(); },
  });

  const data = list.data;
  const rows = data?.childHubs ?? [];
  const listError = list.isError ? errText(list.error) : null;

  return (
    <div className="space-y-5">
      <section className={cardCls}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-ink inline-flex items-center gap-1.5">
              <Network className="w-4 h-4" /> Child hubs
            </h2>
            <p className="mt-1 text-xs text-ink-tertiary">
              Hubs enrolled with this one. Hand a join token to a hub you want to add to the group.
            </p>
          </div>
          <button
            type="button"
            onClick={() => mint.mutate()}
            disabled={mint.isPending}
            className="shrink-0 rounded-lg border border-border-soft bg-surface px-3 py-1.5 text-xs font-medium text-ink hover:bg-chip disabled:opacity-50"
          >
            Generate join token
          </button>
        </div>

        {mint.isError && (
          <p role="alert" className="mt-3 text-xs text-red-600 dark:text-red-400">{errText(mint.error)}</p>
        )}

        {invite && (
          <div className="mt-4 rounded-xl border border-border-brand bg-mint/20 dark:bg-brand/10 p-3">
            <p className="text-xs text-ink-tertiary">
              Hand this to the child hub — it expires {fmt(invite.expiresAt)} and can be redeemed once.
            </p>
            <code className="mt-2 block break-all font-mono text-[11px] text-ink">{invite.parentUrl}</code>
            <code className="mt-1 block break-all font-mono text-[11px] text-ink">{invite.inviteToken}</code>
          </div>
        )}
      </section>

      <section className={cardCls}>
        <div className="flex items-center justify-between gap-4">
          <h3 className="text-sm font-semibold text-ink">Enrolled</h3>
          <label className="inline-flex items-center gap-1.5 text-xs text-ink-tertiary">
            <input
              type="checkbox"
              aria-label="Show detached"
              checked={showDetached}
              onChange={e => setShowDetached(e.target.checked)}
            />
            Show detached
          </label>
        </div>

        {list.isLoading ? (
          <p className="mt-4 text-xs text-ink-tertiary">Loading…</p>
        ) : listError ? (
          // Before the isParent branch on purpose: a failed request leaves
          // `data` undefined, and falling through would tell the admin of a
          // real parent hub that it has no children.
          <p role="alert" className="mt-4 text-sm text-red-600 dark:text-red-400">
            Could not load child hubs: {listError}
          </p>
        ) : !data?.isParent ? (
          <p className="mt-4 text-sm text-ink-tertiary">
            This hub has no child hubs. Generate a join token above to add one.
          </p>
        ) : rows.length === 0 ? (
          <p className="mt-4 text-sm text-ink-tertiary">
            No child hubs to show. Every child hub of this one has been detached.
          </p>
        ) : (
          <table className="mt-4 w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-ink-tertiary">
                <th className="px-2 py-2">Name</th>
                <th className="px-2 py-2">Version</th>
                <th className="px-2 py-2">Last contact</th>
                <th className="px-2 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(c => (
                <tr key={c.id} className="border-t border-border-soft">
                  <td className="px-2 py-2.5 font-medium text-ink">
                    {c.name}
                    {c.releaseRequested && !c.detached && (
                      <span className="ml-2 inline-flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400">
                        <AlertTriangle className="w-3 h-3" /> release requested
                        {c.releaseReason ? `: ${c.releaseReason}` : ''}
                      </span>
                    )}
                    {c.detached && (
                      <span className="ml-2 text-[11px] text-ink-tertiary">
                        detached{c.detachedByEmail ? ` by ${c.detachedByEmail}` : ''}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-2.5 font-mono text-xs text-ink-tertiary">{c.hubVersion ?? '—'}</td>
                  <td className="px-2 py-2.5 text-xs text-ink-tertiary tabular-nums">
                    {fmt(c.lastSeen)}
                    {!c.live && !c.detached && (
                      <span className="ml-2 inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                        <Clock className="w-3 h-3" /> not checking in
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-2.5 text-right">
                    <button
                      type="button"
                      aria-label={`Rename ${c.name}`}
                      onClick={() => { setRenaming(c); setNewName(c.name); }}
                      className="rounded-lg border border-border-soft px-2 py-1 text-xs text-ink hover:bg-chip"
                    >
                      Rename
                    </button>
                    {!c.detached && (
                      <button
                        type="button"
                        aria-label={`Detach ${c.name}`}
                        onClick={() => setDetaching(c)}
                        className="ml-2 rounded-lg border border-border-soft px-2 py-1 text-xs text-red-600 dark:text-red-400 hover:bg-chip"
                      >
                        Detach
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {renaming && (
        <section className={cardCls}>
          <h3 className="text-sm font-semibold text-ink">Rename “{renaming.name}”</h3>
          <div className="mt-3 flex items-center gap-2">
            <input
              aria-label="New name"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              className="rounded-lg border border-border-soft bg-surface px-2 py-1.5 text-sm text-ink"
            />
            <button
              type="button"
              onClick={() => rename.mutate({ id: renaming.id, name: newName.trim() })}
              disabled={!newName.trim() || rename.isPending}
              className="rounded-lg border border-border-soft px-3 py-1.5 text-xs font-medium text-ink hover:bg-chip disabled:opacity-50"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => { setRenaming(null); setNewName(''); }}
              className="rounded-lg px-3 py-1.5 text-xs text-ink-tertiary hover:bg-chip"
            >
              Cancel
            </button>
          </div>
          {rename.isError && (
            <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">{errText(rename.error)}</p>
          )}
        </section>
      )}

      {detaching && (
        <DetachDialog
          name={detaching.name}
          pending={detach.isPending}
          error={detach.isError ? errText(detach.error) : null}
          releaseRequested={!!detaching.releaseRequested}
          onConfirm={() => detach.mutate(detaching.id)}
          onCancel={() => setDetaching(null)}
        />
      )}

    </div>
  );
}
