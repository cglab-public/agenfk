/**
 * CGLAB-382 — the human gates of a card's current step, on the board.
 *
 * Shows the last verify's check results for this step, a go-ahead button when
 * the step waits for a person's approval, and an override - which needs a
 * written reason - on each check that blocks the card. Both are a person's
 * acts: the agent has no command for either.
 */
import React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, XCircle, AlertTriangle, MinusCircle, FastForward, Unlock, ShieldCheck } from 'lucide-react';
import { api, type StepCheckResult } from '../api';
import { useSocketEvent } from '../SocketContext';
import { canSignHere, createPasskey, handoffUrl, signAct } from '../webauthn';
import { approveCommand, argvHash, listCommandApprovals } from '../commandApprovals';

const errorText = (e: unknown): string => {
  const err = e as { response?: { data?: { error?: string } }; message?: string } | null;
  return err?.response?.data?.error ?? err?.message ?? String(e);
};

function ResultIcon({ r }: { r: StepCheckResult }) {
  if (r.overridden) return <Unlock size={14} className="text-amber-500 shrink-0" aria-label="overridden" />;
  if (r.outcome === 'pass') return <CheckCircle2 size={14} className="text-emerald-500 shrink-0" aria-label="passed" />;
  if (r.outcome === 'n/a') return <MinusCircle size={14} className="text-slate-400 shrink-0" aria-label="not applicable" />;
  if (r.outcome === 'deferred') return <FastForward size={14} className="text-slate-400 shrink-0" aria-label="deferred" />;
  if (r.blocking) return <XCircle size={14} className="text-rose-500 shrink-0" aria-label="blocking" />;
  return <AlertTriangle size={14} className="text-amber-500 shrink-0" aria-label="warning" />;
}

export const StepChecksPanel: React.FC<{ itemId: string; projectId?: string }> = ({ itemId, projectId }) => {
  const qc = useQueryClient();
  const key = ['gates', itemId];
  const { data: gates } = useQuery({ queryKey: key, queryFn: () => api.getGates(itemId) });
  // A step that asks for a passkey (CGLAB-383): is one enrolled on this board?
  // A command check waiting for a person's approval of its exact command (efcacdeb): approved with a passkey.
  const awaitingCommand = (r: StepCheckResult) => r.id.startsWith('command-check:') && r.blocking && r.params?.approval === 'person' && /waiting for a person to approve the command/.test(r.detail);
  const commandWaits = (gates?.lastChecks?.results ?? []).some(awaitingCommand);
  const { data: passkeyStatus } = useQuery({ queryKey: ['passkeys'], queryFn: () => api.getPasskeyStatus(), enabled: !!gates?.passkeyRequired || commandWaits });
  // A command approved since the last verify: say so until the next verify runs it (83e4e956).
  const { data: approvedCommands } = useQuery({ queryKey: ['command-approvals', projectId], queryFn: () => listCommandApprovals(projectId!), enabled: commandWaits && !!projectId });
  const commandApproved = (r: StepCheckResult) => (approvedCommands ?? []).some(a => JSON.stringify(a.argv) === r.params.argv);
  useSocketEvent('items_updated', () => { void qc.invalidateQueries({ queryKey: key }); });

  const [note, setNote] = React.useState('');
  const [overriding, setOverriding] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  if (!gates) return null;
  // The go-ahead box stands for the human-approval check; blocking checks first.
  const rank = (r: StepCheckResult) => (r.blocking ? 0 : r.outcome === 'fail' || r.outcome === 'unavailable' ? 1 : 2);
  const results = (gates.lastChecks?.results ?? [])
    .filter(r => !(gates.approvalRequired && r.id === 'human-approval'))
    .sort((a, b) => rank(a) - rank(b));
  const approval = gates.approvals[gates.approvals.length - 1];
  if (!gates.approvalRequired && !results.length) return null;

  const signed = !!gates.passkeyRequired;
  const signHere = canSignHere();
  const needsEnrollment = signed && signHere && passkeyStatus !== undefined && !passkeyStatus.enrolled;
  /** Sign one act with an enrolled passkey: the server binds the challenge to exactly these fields. */
  const assertionFor = async (a: Record<string, string>) => {
    const { challenge, allowCredentials } = await api.passkeyChallenge(a);
    return signAct(challenge, allowCredentials);
  };
  /** The desktop app (127.0.0.1) cannot sign: open the card where the browser can. */
  const handOff = () => { window.open(handoffUrl(window.location, itemId, projectId), '_blank'); };
  const enroll = () => act(async () => {
    const { challenge } = await api.passkeyChallenge({ purpose: 'enroll' });
    await api.enrollPasskey(await createPasskey(challenge));
    await qc.invalidateQueries({ queryKey: ['passkeys'] });
  });
  const approveNow = () => {
    if (signed && !signHere) return handOff();
    const n = note.trim();
    return act(async () => {
      const body = { step: gates.step, ...(n ? { note: n } : {}) };
      const assertion = signed ? await assertionFor({ purpose: 'approval', itemId, ...body }) : undefined;
      await api.approveStep(itemId, { ...body, ...(assertion ? { assertion } : {}) });
    });
  };
  const overrideNow = (checkId: string) => {
    if (signed && !signHere) return handOff();
    const r = reason.trim();
    return act(async () => {
      const body = { step: gates.step, checkId, reason: r };
      const assertion = signed ? await assertionFor({ purpose: 'override', itemId, ...body }) : undefined;
      await api.overrideCheck(itemId, { ...body, ...(assertion ? { assertion } : {}) });
    });
  };

  const approveCommandNow = (r: StepCheckResult) => {
    if (!signHere) return handOff();
    return act(async () => {
      if (!projectId) throw new Error('This card has no project to approve the command for.');
      const argv = JSON.parse(r.params.argv) as string[];
      const assertion = await assertionFor({ purpose: 'command', itemId: projectId, checkId: await argvHash(argv) });
      await approveCommand(projectId, argv, assertion);
      await qc.invalidateQueries({ queryKey: ['command-approvals', projectId] });
    });
  };

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setOverriding(null);
      setReason('');
      setNote('');
      await qc.invalidateQueries({ queryKey: key });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="step-checks" className="space-y-3">
      <h4 className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Step checks — {gates.step}</h4>

      {gates.approvalRequired && (
        approval ? (
          <div className="flex items-start gap-2 text-sm rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 px-4 py-3 text-emerald-800 dark:text-emerald-200">
            <ShieldCheck size={16} className="shrink-0 mt-0.5" />
            <span>
              Approved on the board {new Date(approval.at).toLocaleString()}{approval.note ? ` — ${approval.note}` : ''}
              {approval.authority === 'passkey' && <span className="ml-1 font-semibold">· signed with a passkey</span>}
            </span>
          </div>
        ) : (
          <div className="space-y-2 rounded-xl border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 px-4 py-3">
            <p className="text-sm text-amber-900 dark:text-amber-100">
              This step waits for your go-ahead before the card can move on. An agent cannot give it.
              {signed && ' It is signed with your passkey (fingerprint, face or PIN).'}
            </p>
{!(signed && !signHere) && (
            <label className="block text-xs text-amber-800 dark:text-amber-200">
              Note (optional)
              <input
                type="text"
                value={note}
                onChange={e => setNote(e.target.value)}
                className="mt-1 w-full text-sm bg-white dark:bg-slate-950 border border-amber-200 dark:border-amber-800 rounded-lg px-3 py-1.5 text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-brand"
              />
            </label>
            )}
            {needsEnrollment ? (
              <div className="space-y-1">
                <p className="text-xs text-amber-800 dark:text-amber-200">No passkey is enrolled on this board yet. Enroll one to sign approvals.</p>
                <button type="button" disabled={busy} onClick={enroll}
                  className="text-xs font-bold px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-900 dark:bg-slate-200 dark:hover:bg-slate-300 dark:text-slate-900 text-white disabled:opacity-50">
                  Enroll a passkey
                </button>
              </div>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={approveNow}
                className="text-xs font-bold px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50"
              >
                {signed && !signHere ? `Approve in the browser` : `Approve ${gates.step}`}
              </button>
            )}
          </div>
        )
      )}

      {results.length > 0 && (
        <ul className="space-y-1.5">
          {results.map(r => {
            const given = gates.overrides[r.id] ?? r.overridden;
            return (
              <li key={`${r.id}-${JSON.stringify(r.params)}`} className="text-sm">
                <div className="flex items-start gap-2">
                  <ResultIcon r={given && r.blocking ? { ...r, overridden: given } : r} />
                  <div className="min-w-0 flex-1">
                    <span className="font-mono text-xs text-slate-700 dark:text-slate-200">{r.id}</span>
                    <span className="text-xs text-slate-400 dark:text-slate-500"> · {r.severity}{r.source === 'flow' ? ' · added by the flow' : ''}</span>
                    {(r as StepCheckResult & { agentReported?: boolean }).agentReported && (
                      <span className="ml-1 text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300" title="The coding agent reported this; the server did not check it.">agent-reported</span>
                    )}
                    {r.detail && <p className="text-xs text-slate-500 dark:text-slate-400 break-words">{r.detail}</p>}
                    {given && <p className="text-xs text-amber-700 dark:text-amber-300">Overridden: {given.reason}</p>}
                    {awaitingCommand(r) && (
                      <div className="mt-1 space-y-1">
                        <code className="block text-xs bg-slate-100 dark:bg-slate-800 rounded px-2 py-1 break-all">{(JSON.parse(r.params.argv) as string[]).join(' ')}</code>
                        {commandApproved(r) ? (
                          <p className="text-xs text-emerald-700 dark:text-emerald-300 flex items-center gap-1"><ShieldCheck size={13} /> Approved with a passkey — it runs on the next verify.</p>
                        ) : passkeyStatus && !passkeyStatus.enrolled && signHere ? (
                          <button type="button" disabled={busy} onClick={enroll}
                            className="text-xs font-bold px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-900 dark:bg-slate-200 dark:hover:bg-slate-300 dark:text-slate-900 text-white disabled:opacity-50">
                            Enroll a passkey to approve commands
                          </button>
                        ) : (
                          <button type="button" disabled={busy} onClick={() => approveCommandNow(r)}
                            className="text-xs font-bold px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50">
                            {signHere ? 'Approve this command' : 'Approve this command in the browser'}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  {r.blocking && !given && overriding !== r.id && (
                    <button
                      type="button"
                      aria-label={`Override ${r.id}`}
                      onClick={() => { setOverriding(r.id); setReason(''); setError(null); }}
                      className="text-xs font-bold px-2 py-1 rounded-md border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                      Override…
                    </button>
                  )}
                </div>
                {overriding === r.id && (
                  <div className="mt-2 ml-6 space-y-2">
                    <label className="block text-xs text-slate-600 dark:text-slate-300">
                      Reason (required — it is recorded on the card and the PR)
                      <textarea
                        value={reason}
                        onChange={e => setReason(e.target.value)}
                        rows={2}
                        className="mt-1 w-full text-sm bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-1.5 text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-brand"
                      />
                    </label>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={busy || !reason.trim()}
                        onClick={() => overrideNow(r.id)}
                        className="text-xs font-bold px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-50"
                      >
                        Pass this check
                      </button>
                      <button type="button" onClick={() => setOverriding(null)} className="text-xs px-3 py-1.5 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {error && <p role="alert" className="text-xs text-rose-600 dark:text-rose-400">{error}</p>}
    </div>
  );
};
