import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { apiErrorText } from '../apiError';
import { Callout, QueryError, buttonClass, cardClass, controlClass } from '../components/ui';

/**
 * Admin → Airlock (GH-294). The org's Airlock policy: what a coding agent's
 * tool calls may reach, and which sessions it applies to. Every installation
 * joined to this hub adopts it on its next sync and cannot overrule it.
 *
 * The policy and the IOC host list are saved separately: the list changes more
 * often, and saving it does not make a new policy revision.
 */

type Mode = 'off' | 'observe' | 'enforce';
type RuleAction = 'deny' | 'needs-human-approval' | 'off';
type RuleKey = 'uploadToUnlistedHost' | 'credentialReadWithNetwork' | 'namespaceEscape' | 'cloudMutation';
interface ModelSelector { client?: string; provider?: string; model?: string }

interface AirlockPolicy {
  schemaVersion: 1;
  mode: Mode;
  models: ModelSelector[];
  appliesWhenModelUnknown: boolean;
  hosts: { allow: string[]; deny: string[] };
  iocHosts: { revision: string; hosts: string[]; updatedAt: string | null };
  rules: Record<RuleKey, RuleAction>;
}

export interface AirlockView {
  policy: AirlockPolicy | null;
  revision: number;
  iocRevision: number;
  updatedAt: string | null;
  updatedByEmail: string | null;
}

const MODES: { value: Mode; label: string; help: string }[] = [
  { value: 'off', label: 'Off', help: 'Nothing is checked.' },
  { value: 'observe', label: 'Observe', help: 'Every tool call is allowed; what Enforce would have stopped is logged.' },
  { value: 'enforce', label: 'Enforce', help: 'Tool calls the rules deny are blocked.' },
];

const RULES: { key: RuleKey; label: string }[] = [
  { key: 'uploadToUnlistedHost', label: 'Upload to a host not on the allowed list' },
  { key: 'credentialReadWithNetwork', label: 'Read a credential and use the network in one command' },
  { key: 'namespaceEscape', label: 'Enter another namespace (unshare, nsenter)' },
  { key: 'cloudMutation', label: 'Change cloud resources (aws, gcloud, az, kubectl, terraform, pulumi)' },
];

const ACTIONS: { value: RuleAction; label: string }[] = [
  { value: 'deny', label: 'Deny' },
  { value: 'needs-human-approval', label: 'Needs a person to approve' },
  { value: 'off', label: 'Allow' },
];

const DEFAULT_RULES: Record<RuleKey, RuleAction> = {
  uploadToUnlistedHost: 'deny',
  credentialReadWithNetwork: 'deny',
  namespaceEscape: 'deny',
  cloudMutation: 'needs-human-approval',
};

/** One entry per line; blank lines and surrounding spaces dropped. */
export const linesOf = (text: string): string[] => text.split('\n').map(l => l.trim()).filter(Boolean);

/** A model selector as one line: `client provider model`, `*` for any. */
export function selectorLine(s: ModelSelector): string {
  const parts = [s.client ?? '*', s.provider ?? '*', s.model ?? '*'];
  while (parts.length > 1 && parts[parts.length - 1] === '*') parts.pop();
  return parts.join(' ');
}

export function parseSelector(line: string): ModelSelector {
  const [client, provider, model] = line.split(/\s+/);
  const out: ModelSelector = {};
  if (client && client !== '*') out.client = client;
  if (provider && provider !== '*') out.provider = provider;
  if (model && model !== '*') out.model = model;
  return out;
}

const utc = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

function SaveError({ error }: { error: unknown }) {
  const errors: unknown = (error as any)?.response?.data?.errors;
  return (
    <Callout tone="danger" live="assertive" className="mt-3">
      {apiErrorText(error)}
      {Array.isArray(errors) && errors.length > 0 && (
        <ul className="mt-1 list-disc pl-5">
          {errors.map((e, i) => <li key={i}>{String(e)}</li>)}
        </ul>
      )}
    </Callout>
  );
}

const useAirlock = () => useQuery<AirlockView>({
  queryKey: ['admin-airlock'],
  queryFn: async () => (await api.get('/v1/admin/airlock')).data as AirlockView,
});

export function AdminAirlock() {
  const airlock = useAirlock();
  if (airlock.isError && !airlock.data) return <QueryError error={airlock.error} onRetry={() => airlock.refetch()} />;
  if (!airlock.data) return <p role="status" className="text-body text-ink-tertiary">Loading…</p>;
  const view = airlock.data;
  return (
    <div className="space-y-4">
      {/* Keyed by revision: a save reloads the form from what the hub stored. */}
      <PolicyCard key={`policy-${view.revision}`} view={view} />
      <IocCard key={`ioc-${view.iocRevision}`} view={view} />
    </div>
  );
}

function PolicyCard({ view }: { view: AirlockView }) {
  const qc = useQueryClient();
  const p = view.policy;
  const [mode, setMode] = useState<Mode>(p?.mode ?? 'off');
  const [models, setModels] = useState((p?.models ?? []).map(selectorLine).join('\n'));
  const [unknown, setUnknown] = useState(p?.appliesWhenModelUnknown ?? true);
  const [allow, setAllow] = useState((p?.hosts.allow ?? []).join('\n'));
  const [deny, setDeny] = useState((p?.hosts.deny ?? []).join('\n'));
  const [rules, setRules] = useState<Record<RuleKey, RuleAction>>({ ...DEFAULT_RULES, ...(p?.rules ?? {}) });

  const save = useMutation({
    mutationFn: async () => (await api.put('/v1/admin/airlock', {
      expectedRevision: view.revision,
      policy: {
        schemaVersion: 1,
        mode,
        models: linesOf(models).map(parseSelector),
        appliesWhenModelUnknown: unknown,
        hosts: { allow: linesOf(allow), deny: linesOf(deny) },
        rules,
      },
    })).data as AirlockView,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-airlock'] }),
  });
  const edit = <T,>(set: (v: T) => void) => (v: T) => { save.reset(); set(v); };

  return (
    <form className={`${cardClass} max-w-form`} onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <h3 className="text-body font-semibold text-ink">Airlock policy</h3>
      {p ? (
        <p className="mt-1 text-small text-ink-tertiary">
          Revision {view.revision}{view.updatedByEmail ? `, saved by ${view.updatedByEmail}` : ''}
          {view.updatedAt ? ` on ${utc(view.updatedAt)}` : ''}. Every installation joined to this hub adopts it and cannot
          change it locally.
        </p>
      ) : (
        <p className="mt-1 text-small text-ink-tertiary">
          No Airlock policy yet: each installation keeps its own. Saving one here makes it the policy of every installation
          joined to this hub.
        </p>
      )}

      <label className="block mt-3">
        <span className="eyebrow text-ink-tertiary">Mode</span>
        <select aria-label="Mode" className={`${controlClass} mt-1.5`} value={mode} onChange={(e) => edit(setMode)(e.target.value as Mode)}>
          {MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
      </label>
      <p className="mt-1 text-small text-ink-tertiary">{MODES.find(m => m.value === mode)?.help}</p>

      <label className="block mt-3">
        <span className="eyebrow text-ink-tertiary">Models</span>
        <textarea
          aria-label="Models" rows={3} className={`${controlClass} mt-1.5 font-mono`}
          value={models} onChange={(e) => edit(setModels)(e.target.value)}
          placeholder="pi cloudflare-workers-ai"
        />
      </label>
      <p className="mt-1 text-small text-ink-tertiary">
        One per line: client (pi, opencode or *), then provider, then model; leave out what does not matter. Empty means
        every session.
      </p>
      <label className="mt-2 flex items-center gap-2 text-body text-ink">
        <input type="checkbox" checked={unknown} onChange={(e) => edit(setUnknown)(e.target.checked)} />
        Apply when a session's model cannot be told
      </label>

      <label className="block mt-3">
        <span className="eyebrow text-ink-tertiary">Allowed hosts</span>
        <textarea aria-label="Allowed hosts" rows={4} className={`${controlClass} mt-1.5 font-mono`} value={allow} onChange={(e) => edit(setAllow)(e.target.value)} />
      </label>
      <label className="block mt-3">
        <span className="eyebrow text-ink-tertiary">Denied hosts</span>
        <textarea aria-label="Denied hosts" rows={3} className={`${controlClass} mt-1.5 font-mono`} value={deny} onChange={(e) => edit(setDeny)(e.target.value)} />
      </label>
      <p className="mt-1 text-small text-ink-tertiary">
        One host per line: a name, *.wildcard or a CIDR range. Cloud metadata endpoints are always denied and cannot be
        allowed.
      </p>

      <fieldset className="mt-3 space-y-2">
        <legend className="eyebrow text-ink-tertiary">Rules</legend>
        {RULES.map(r => (
          <label key={r.key} className="flex items-center justify-between gap-3 text-body text-ink">
            <span>{r.label}</span>
            <select
              aria-label={r.label} className={`${controlClass} max-w-[16rem]`} value={rules[r.key]}
              onChange={(e) => edit(setRules)({ ...rules, [r.key]: e.target.value as RuleAction })}
            >
              {ACTIONS.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
            </select>
          </label>
        ))}
      </fieldset>

      <div className="mt-3">
        <button type="submit" className={buttonClass('primary')} disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save policy'}
        </button>
      </div>
      {save.isError && <SaveError error={save.error} />}
    </form>
  );
}

function IocCard({ view }: { view: AirlockView }) {
  const qc = useQueryClient();
  const [hosts, setHosts] = useState((view.policy?.iocHosts.hosts ?? []).join('\n'));
  const save = useMutation({
    mutationFn: async () => (await api.put('/v1/admin/airlock/ioc', { hosts: linesOf(hosts) })).data as AirlockView,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-airlock'] }),
  });
  return (
    <form className={`${cardClass} max-w-form`} onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <h3 className="text-body font-semibold text-ink">Indicators of compromise</h3>
      {!view.policy ? (
        <p className="mt-1 text-small text-ink-tertiary">Save a policy first: the IOC host list is part of it.</p>
      ) : (
        <>
          <p className="mt-1 text-small text-ink-tertiary">
            Hosts known to be malicious, denied whatever else the policy allows. Saving the list does not make a new policy
            revision; installations still pick it up on their next sync.
          </p>
          <label className="block mt-3">
            <span className="eyebrow text-ink-tertiary">IOC hosts</span>
            <textarea
              aria-label="IOC hosts" rows={4} className={`${controlClass} mt-1.5 font-mono`}
              value={hosts} onChange={(e) => { save.reset(); setHosts(e.target.value); }}
            />
          </label>
          <div className="mt-3">
            <button type="submit" className={buttonClass('primary')} disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save IOC list'}
            </button>
          </div>
          {save.isError && <SaveError error={save.error} />}
        </>
      )}
    </form>
  );
}
