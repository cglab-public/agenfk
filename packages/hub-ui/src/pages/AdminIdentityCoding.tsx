import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { api } from '../api';
import { apiErrorText as errText } from '../apiError';
import { cardClass, cn, controlClass, ConfirmDialog } from '../components/ui';

type FieldCoding = 'as-written' | 'coded';
type Field = 'person' | 'installation';
type Setting = Record<Field, FieldCoding | null>;
type Coding = Record<Field, FieldCoding>;

interface ChildRow { id: string; name: string; override: Setting; effective: Coding }
interface Settings { group: Setting; effective: Coding; childHubs: ChildRow[] }

const FIELDS: Array<{ field: Field; label: string; coded: string }> = [
  {
    field: 'person',
    label: 'Person',
    coded: 'Coded: the user key is replaced by a code for this hub, and the user key, git name, git email and OS user, item titles and free-form payload are not sent. Usage numbers still are.',
  },
  {
    field: 'installation',
    label: 'Installation',
    coded: 'Coded: the installation id is replaced by a code for this hub.',
  },
];

const words = (v: FieldCoding) => (v === 'coded' ? 'coded' : 'as written');
const codingLine = (c: Coding) => `person ${words(c.person)}, installation ${words(c.installation)}`;
const selectCls = cn(controlClass, 'px-2 py-1');

/** A change waiting for the admin's go-ahead, because it would send more. */
interface Pending { target: 'group' | ChildRow; field: Field; value: FieldCoding | null }

/**
 * Admin → Organization → Identities forwarded to this hub (GH-395).
 *
 * A parent hub decides what its child hubs code before they forward events:
 * the person and the installation, each sent as written or coded. A group
 * default per field, and per child hub an optional override per field.
 *
 * A change that sends MORE is confirmed first: whatever the parent has
 * already received as written cannot be taken back. Coding a field sends
 * less, so it applies at once.
 */
export function AdminIdentityCoding() {
  const qc = useQueryClient();
  const [pending, setPending] = useState<Pending | null>(null);

  const settings = useQuery<Settings>({
    queryKey: ['admin-identity-coding'],
    queryFn: async () => (await api.get('/v1/admin/federation/identity')).data,
  });
  const save = useMutation({
    mutationFn: (p: Pending) => (p.target === 'group'
      ? api.put('/v1/admin/federation/identity', { [p.field]: p.value })
      : api.put(`/v1/admin/child-hubs/${p.target.id}/identity`, { [p.field]: p.value })),
    onSuccess: () => { setPending(null); qc.invalidateQueries({ queryKey: ['admin-identity-coding'] }); },
  });

  const change = (p: Pending) => {
    if (p.value === 'coded') save.mutate(p);
    else setPending(p);
  };

  const d = settings.data;
  const group: Setting = d?.group ?? { person: null, installation: null };
  const children = Array.isArray(d?.childHubs) ? d!.childHubs : [];

  return (
    <section className={cardClass}>
      <h2 className="text-body font-semibold text-ink inline-flex items-center gap-1.5">
        <ShieldCheck className="w-4 h-4" /> Identities forwarded to this hub
      </h2>
      <p className="mt-1 text-small text-ink-tertiary">
        Child hubs forward their events to this hub. Choose, field by field, whether each is sent as
        written or coded. Model, harness, step names, repository and ticket are always sent as written.
      </p>

      {settings.isLoading ? (
        <p className="mt-4 text-small text-ink-tertiary">Loading…</p>
      ) : settings.isError ? (
        <p role="alert" className="mt-4 text-body text-status-danger-text">
          Could not load the identity settings: {errText(settings.error)}
        </p>
      ) : (
        <>
          <dl className="mt-4 grid gap-3 max-w-prose">
            {FIELDS.map(({ field, label, coded }) => (
              <div key={field}>
                <dt className="flex items-center gap-3">
                  <span className="text-body font-medium text-ink w-28">{label}</span>
                  <select aria-label={`Group default: ${label}`} className={selectCls}
                    value={group[field] ?? 'as-written'}
                    onChange={e => change({ target: 'group', field, value: e.target.value as FieldCoding })}>
                    <option value="as-written">as written</option>
                    <option value="coded">coded</option>
                  </select>
                </dt>
                <dd className="mt-1 text-small text-ink-tertiary">{coded}</dd>
              </div>
            ))}
          </dl>

          {children.length > 0 && (
            <table className="mt-5 w-full text-body">
              <thead>
                <tr className="eyebrow text-left text-ink-tertiary">
                  <th className="px-2 py-2">Child hub</th>
                  <th className="px-2 py-2">Person</th>
                  <th className="px-2 py-2">Installation</th>
                  <th className="px-2 py-2">In force</th>
                </tr>
              </thead>
              <tbody>
                {children.map(c => (
                  <tr key={c.id} className="border-t border-border-soft">
                    <td className="px-2 py-2.5 font-medium text-ink">{c.name}</td>
                    {FIELDS.map(({ field, label }) => (
                      <td key={field} className="px-2 py-2.5">
                        <select aria-label={`${label} for ${c.name}`} className={selectCls}
                          value={c.override?.[field] ?? 'inherit'}
                          onChange={e => change({
                            target: c, field,
                            value: e.target.value === 'inherit' ? null : e.target.value as FieldCoding,
                          })}>
                          <option value="inherit">follow the group</option>
                          <option value="as-written">as written</option>
                          <option value="coded">coded</option>
                        </select>
                      </td>
                    ))}
                    <td className="px-2 py-2.5 text-small text-ink-tertiary">{c.effective ? codingLine(c.effective) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {save.isError && !pending && (
            <p role="alert" className="mt-3 text-small text-status-danger-text">{errText(save.error)}</p>
          )}
        </>
      )}

      {pending && (
        <ConfirmDialog
          title={pending.value === null
            ? `Let ${(pending.target as ChildRow).name} follow the group for the ${pending.field}?`
            : `Send the ${pending.field} as written${pending.target === 'group' ? ' from every child hub that follows the group' : ` from ${(pending.target as ChildRow).name}`}?`}
          body={(pending.value === null
            ? 'If the group default is as written, this hub will then receive it as written. '
            : 'This hub will then receive it as written. ')
            + 'What it receives as written cannot be taken back.'}
          confirmLabel={pending.value === null ? 'Follow the group' : 'Send as written'}
          tone="danger"
          pending={save.isPending}
          error={save.isError ? errText(save.error) : null}
          onConfirm={() => save.mutate(pending)}
          onCancel={() => { setPending(null); save.reset(); }}
        />
      )}
    </section>
  );
}
