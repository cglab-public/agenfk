/**
 * CGLAB-384 — one step's contract, in plain words.
 *
 * What the step is for (its role) and the checks that brings, locked: a flow
 * may add requirements, never take a role's away. The checks this flow adds,
 * with their params as real controls and Block or Warn. Whether a person must
 * approve, and whether that approval is signed with a passkey. And what an
 * agent must do to leave the step, exactly as `agenfk verify` will enforce it.
 *
 * Everything shown comes from the server's contract (the same functions that
 * validate and run the flow). Edits go out as a patch to the step.
 */
import React, { useState } from 'react';
import { Lock, Plus, Search, Trash2, UserCheck, KeyRound } from 'lucide-react';
import { clsx } from 'clsx';
import { checkText, GROUP_TEXTS, RECORD_TEXTS, ROLE_TEXTS } from './checkTexts';
import type { FlowContract, FlowStep, StepCheckRef } from './types';

/** Checks with their own control, or that every step runs anyway: not offered in the gallery. */
const NOT_IN_GALLERY = new Set(['human-approval', 'tree-clean', 'on-card-branch', 'server-owned-verify']);

export interface StepContractPanelProps {
  step: FlowStep;
  stepContract: FlowContract['steps'][number] | undefined;
  contract: FlowContract;
  disabled: boolean;
  onChange: (patch: Partial<FlowStep>) => void;
}

const recordWords = (recs: readonly string[] | undefined) => (recs ?? []).map(r => RECORD_TEXTS[r] ?? r).join(', ');

export const StepContractPanel: React.FC<StepContractPanelProps> = ({ step, stepContract, contract, disabled, onChange }) => {
  const [pickingRole, setPickingRole] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState<string>('all');

  const catalogue = new Map(contract.catalogue.map(c => [c.id, c]));
  const added: StepCheckRef[] = Array.isArray(step.checks) ? step.checks : [];
  const extras = added.filter(c => c.id !== 'human-approval');
  const approval = added.find(c => c.id === 'human-approval');
  const role = typeof step.role === 'string' ? step.role : null;
  const roleText = role ? ROLE_TEXTS[role] : null;
  const builtins = (stepContract?.checks ?? []).filter(c => c.source === 'role');
  const titleOf = (id: string) => checkText(id, catalogue.get(id)?.description).title;

  const setChecks = (checks: StepCheckRef[]) => onChange({ checks });
  const replace = (id: string, next: StepCheckRef | null) =>
    setChecks(added.flatMap(c => (c.id === id ? (next ? [next] : []) : [c])));
  /** A param at its default is left out, so the stored step stays minimal. */
  const withParam = (ref: StepCheckRef, key: string, value: string): StepCheckRef => {
    const def = catalogue.get(ref.id)?.params[key]?.default;
    const params = { ...(ref.params ?? {}) };
    if (value === def) delete params[key]; else params[key] = value;
    const { params: _drop, ...rest } = ref;
    return Object.keys(params).length ? { ...rest, params } : rest;
  };

  const gallery = contract.catalogue
    .filter(c => !NOT_IN_GALLERY.has(c.id) && !c.unavailable && !added.some(a => a.id === c.id))
    .filter(c => group === 'all' || c.group === group)
    .filter(c => {
      const q = query.trim().toLowerCase();
      if (!q) return true;
      const t = checkText(c.id, c.description);
      return [t.title, t.stops, c.description].some(x => x.toLowerCase().includes(q));
    });

  // What an agent must do: the applicable blocking checks, then the warnings.
  const preview = (stepContract?.checks ?? []).filter(c => c.applicable);
  const musts = preview.filter(c => c.severity === 'block').map(c => {
    const must = checkText(c.id, catalogue.get(c.id)?.description).must;
    return c.id === 'human-approval' && c.params.signature === 'passkey' ? `${must}, signed with a passkey` : must;
  }).filter(Boolean);
  const warns = preview.filter(c => c.severity === 'warn').map(c => titleOf(c.id));

  const section = 'text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest';
  const chip = 'rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2';

  return (
    <div data-testid="step-contract" className="space-y-4 text-sm text-slate-700 dark:text-slate-200">
      {/* Role */}
      <div data-testid="contract-role" className="space-y-1">
        <div className={section}>Role</div>
        <div className="flex items-start gap-2">
          <span className="mt-1 w-3 h-3 rounded shrink-0" style={{ background: roleText?.color ?? 'transparent', border: roleText ? 'none' : '1px dashed #94a3b8' }} />
          <div className="flex-1">
            <div className="font-semibold">{roleText?.name ?? 'No role'}</div>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              {roleText?.desc ?? 'Only the basic checks run (clean tree, right branch). Good for docs-only or custom steps.'}
            </div>
          </div>
          {!disabled && (
            <button type="button" onClick={() => setPickingRole(v => !v)} aria-label="Change role"
              className="text-xs font-semibold px-2 py-1 rounded-md border border-slate-200 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700">
              Change
            </button>
          )}
        </div>
        {pickingRole && !disabled && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-2">
            {contract.roles.map(r => {
              const t = ROLE_TEXTS[r.id];
              return (
                <button key={r.id} type="button" onClick={() => { onChange({ role: r.id }); setPickingRole(false); }}
                  className={clsx('text-left', chip, role === r.id ? 'border-emerald-600 bg-emerald-50 dark:bg-emerald-950/40' : 'hover:bg-slate-50 dark:hover:bg-slate-800')}>
                  <span className="font-semibold">{t?.name ?? r.id}</span>
                  <span className="block text-xs text-slate-500 dark:text-slate-400">{t?.desc}</span>
                  <span className="block text-xs text-slate-400 mt-1">Brings: {r.builtins.map(b => titleOf(b.id)).join(', ') || 'no checks'}</span>
                </button>
              );
            })}
            <button type="button" onClick={() => { onChange({ role: null }); setPickingRole(false); }}
              className={clsx('text-left border-dashed', chip)}>
              <span className="font-semibold">No role</span>
              <span className="block text-xs text-slate-500 dark:text-slate-400">Only the basic checks run.</span>
            </button>
          </div>
        )}
      </div>

      {/* Built-ins */}
      {builtins.length > 0 && (
        <div data-testid="contract-builtins" className="space-y-1">
          <div className={section}>Checks from this role · always on</div>
          {builtins.map(c => {
            const t = checkText(c.id, catalogue.get(c.id)?.description);
            return (
              <div key={`${c.id}-${JSON.stringify(c.params)}`} className={clsx('flex items-start gap-2', chip, !c.applicable && 'opacity-60')}>
                <Lock size={13} className="mt-0.5 shrink-0 text-slate-400" aria-hidden />
                <div className="flex-1">
                  <div className="font-medium">{t.title}</div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    {c.applicable ? `Stops: ${t.stops}` : `Nothing to check here: it needs the ${recordWords(c.missing)}, which no earlier step makes.`}
                  </div>
                </div>
                <span className="text-xs font-semibold text-slate-500">{c.severity === 'block' ? 'Block' : 'Warn'}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Added by the flow */}
      <div data-testid="contract-extras" className="space-y-1">
        <div className={section}>Added by this flow</div>
        {extras.length === 0 && <div className="text-xs text-slate-400">None.</div>}
        {extras.map(ref => {
          const d = catalogue.get(ref.id);
          const t = checkText(ref.id, d?.description);
          const warn = ref.severity === 'warn';
          return (
            <div key={ref.id} className={clsx('space-y-2', chip)}>
              <div className="flex items-start gap-2">
                <div className="flex-1">
                  <div className="font-medium">{t.title}</div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">Stops: {t.stops}</div>
                </div>
                {!disabled && (
                  <button type="button" aria-label={`Remove ${t.title}`} onClick={() => replace(ref.id, null)}
                    className="p-1 rounded text-slate-400 hover:text-red-500">
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
              {Object.entries(d?.params ?? {}).map(([k, p]) => (
                <label key={k} className="block text-xs">
                  <span className="text-slate-500 dark:text-slate-400">{p.description}</span>
                  <select aria-label={p.description} disabled={disabled} value={ref.params?.[k] ?? p.default}
                    onChange={e => replace(ref.id, withParam(ref, k, e.target.value))}
                    className="mt-1 block w-full rounded-md border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1">
                    {p.values.map(v => <option key={v} value={v}>{v}</option>)}
                  </select>
                </label>
              ))}
              <div className="flex gap-1 text-xs" role="group" aria-label={`If ${t.title} fails`}>
                <button type="button" disabled={disabled} aria-pressed={!warn} aria-label={`Block the step: ${t.title}`}
                  onClick={() => { const { severity: _s, ...rest } = ref; replace(ref.id, rest); }}
                  className={clsx('px-2 py-1 rounded-md border', !warn ? 'bg-slate-800 text-white dark:bg-slate-200 dark:text-slate-900' : 'border-slate-200 dark:border-slate-600')}>
                  Block the step
                </button>
                <button type="button" disabled={disabled} aria-pressed={warn} aria-label={`Only warn: ${t.title}`}
                  onClick={() => replace(ref.id, { ...ref, severity: 'warn' })}
                  className={clsx('px-2 py-1 rounded-md border', warn ? 'bg-slate-800 text-white dark:bg-slate-200 dark:text-slate-900' : 'border-slate-200 dark:border-slate-600')}>
                  Only warn
                </button>
              </div>
            </div>
          );
        })}
        {!disabled && (
          <button type="button" onClick={() => setBrowsing(v => !v)}
            className="flex items-center gap-1 text-xs font-semibold px-2 py-1 rounded-md border border-dashed border-slate-300 dark:border-slate-600 hover:bg-slate-50 dark:hover:bg-slate-800">
            <Plus size={13} /> Add a check
          </button>
        )}
        {browsing && !disabled && (
          <div data-testid="check-gallery" className="space-y-2 pt-1">
            <div className="flex gap-2 flex-wrap items-center">
              <label className="flex items-center gap-1 flex-1 min-w-[12rem] rounded-md border border-slate-200 dark:border-slate-600 px-2">
                <Search size={13} className="text-slate-400" aria-hidden />
                <input aria-label="Search checks" value={query} onChange={e => setQuery(e.target.value)}
                  placeholder='e.g. "deleted test" or "JIRA"' className="flex-1 bg-transparent py-1 text-xs outline-none" />
              </label>
              <select aria-label="Group" value={group} onChange={e => setGroup(e.target.value)}
                className="text-xs rounded-md border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1">
                <option value="all">All</option>
                {Object.entries(GROUP_TEXTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            {gallery.length === 0 && <div className="text-xs text-slate-400">No check matches.</div>}
            {gallery.map(c => {
              const t = checkText(c.id, c.description);
              return (
                <div key={c.id} className={clsx('flex items-start gap-2', chip)}>
                  <div className="flex-1">
                    <div className="font-medium">{t.title} <span className="text-xs font-normal text-slate-400">· {GROUP_TEXTS[c.group] ?? c.group}</span></div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">Stops: {t.stops}</div>
                  </div>
                  <button type="button" aria-label={`Add ${t.title}`} onClick={() => { setChecks([...added, { id: c.id }]); setBrowsing(false); setQuery(''); }}
                    className="text-xs font-semibold px-2 py-1 rounded-md border border-slate-200 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700">
                    Add
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* A person's go-ahead */}
      <div data-testid="contract-approval" className={clsx('space-y-2', chip)}>
        <label className="flex items-start gap-2">
          <input type="checkbox" checked={!!approval} disabled={disabled}
            onChange={e => setChecks(e.target.checked ? [...added, { id: 'human-approval' }] : added.filter(c => c.id !== 'human-approval'))}
            className="mt-1" />
          <span>
            <span className="flex items-center gap-1 font-medium"><UserCheck size={14} aria-hidden /> A person must approve before a card leaves this step</span>
            <span className="block text-xs text-slate-500 dark:text-slate-400">They approve on the board. Agents can't.</span>
          </span>
        </label>
        {approval && (
          <div className="pl-6 space-y-2">
            <label className="block text-xs">
              <span className="text-slate-500 dark:text-slate-400">Who needs a go-ahead</span>
              <select aria-label="Who needs a go-ahead" disabled={disabled} value={approval.params?.appliesTo ?? 'parent'}
                onChange={e => replace('human-approval', withParam(approval, 'appliesTo', e.target.value))}
                className="mt-1 block w-full rounded-md border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1">
                <option value="parent">This card, or its parent: approving a breakdown approves its children</option>
                <option value="every-card">Every card, each on its own</option>
              </select>
            </label>
            <label className="flex items-start gap-2 text-xs">
              <input type="checkbox" disabled={disabled} checked={approval.params?.signature === 'passkey'}
                onChange={e => replace('human-approval', withParam(approval, 'signature', e.target.checked ? 'passkey' : 'none'))}
                className="mt-0.5" />
              <span>
                <span className="flex items-center gap-1 font-medium"><KeyRound size={13} aria-hidden /> Sign with a passkey</span>
                <span className="block text-slate-500 dark:text-slate-400">The approval, and any override on this step, needs a fingerprint, face or PIN at the board.</span>
              </span>
            </label>
          </div>
        )}
      </div>

      {/* What an agent must do */}
      <div data-testid="contract-preview" className="space-y-1 rounded-lg bg-slate-50 dark:bg-slate-900 px-3 py-2">
        <div className={section}>What an agent must do to leave this step</div>
        {musts.length === 0 && warns.length === 0 && <div className="text-xs text-slate-400">Nothing is checked here.</div>}
        <ul className="list-disc pl-5 text-xs space-y-0.5">
          {musts.map((m, i) => <li key={`m${i}`}>{m}</li>)}
          {warns.map((w, i) => <li key={`w${i}`} className="text-slate-500">Warning only: {w}</li>)}
        </ul>
      </div>
    </div>
  );
};
