/**
 * 5ee2c3b1 — a card's Checks tab: every verify, approval and override on the
 * card, newest first, each with its date; a verify lists each check's status.
 * The go-ahead itself stays on Overview (StepChecksPanel), where it is seen at
 * once; this is the record of what happened.
 */
import React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, XCircle, AlertTriangle, MinusCircle, FastForward, Unlock, ShieldCheck, ListChecks } from 'lucide-react';
import { api, type CheckHistoryEntry } from '../api';
import { useSocketEvent } from '../SocketContext';

type Result = Extract<CheckHistoryEntry, { kind: 'verify' }>['results'][number];

/** A check's status in words, and its icon. */
function status(r: Result): { label: string; icon: React.ReactNode } {
  if (r.overridden) return { label: 'overridden', icon: <Unlock size={14} className="text-amber-500 shrink-0" /> };
  if (r.outcome === 'pass') return { label: 'passed', icon: <CheckCircle2 size={14} className="text-emerald-500 shrink-0" /> };
  if (r.outcome === 'n/a') return { label: 'not applicable', icon: <MinusCircle size={14} className="text-slate-400 shrink-0" /> };
  if (r.outcome === 'deferred') return { label: 'run by the verify command', icon: <FastForward size={14} className="text-slate-400 shrink-0" /> };
  if (r.blocking) return { label: r.outcome === 'unavailable' ? 'blocked: could not judge' : 'blocked', icon: <XCircle size={14} className="text-rose-500 shrink-0" /> };
  return { label: r.outcome === 'unavailable' ? 'warning: could not judge' : 'warning', icon: <AlertTriangle size={14} className="text-amber-500 shrink-0" /> };
}

const when = (at: string) => new Date(at).toLocaleString();
const signedBy = (authority?: string) => (authority === 'passkey' ? 'signed with a passkey' : 'on the board');

/** One check of a verify: its status, its summary, and a command's output behind a toggle (open when it failed). */
function ResultRow({ r }: { r: Result }) {
  const s = status(r);
  const agent = !!(r as Result & { agentReported?: boolean }).agentReported;
  const [first, ...rest] = String(r.detail ?? '').split('\n');
  // An agent check says agent-reported in its status; its note is what the agent wrote.
  const summary = agent ? first.replace(/^agent-reported:?\s*/, '') : first;
  const output = rest.join('\n').trim();
  const failed = r.outcome !== 'pass';
  const [open, setOpen] = React.useState(failed);
  return (
    <li className="flex items-start gap-2 text-xs">
      {s.icon}
      <div className="min-w-0 flex-1">
        <span className="font-mono text-slate-700 dark:text-slate-200">{r.id}</span>
        <span className="text-slate-400"> · {s.label}{agent ? ', agent-reported' : ''}</span>
        {summary && <p className="text-slate-500 dark:text-slate-400 break-words">{summary}</p>}
        {output && !open && (
          <button type="button" onClick={() => setOpen(true)} className="text-[11px] text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 underline">Show output</button>
        )}
        {output && open && (
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-50 dark:bg-slate-900 px-2 py-1 text-[11px] text-slate-600 dark:text-slate-300">{output}</pre>
        )}
      </div>
    </li>
  );
}

/** A check that passed with nothing to add: the built-ins, not a custom or agent check. */
const quiet = (r: Result) => r.outcome === 'pass' && !r.id.includes(':') && !(r as Result & { agentReported?: boolean }).agentReported;

function VerifyEntry({ e }: { e: Extract<CheckHistoryEntry, { kind: 'verify' }> }) {
  const [showQuiet, setShowQuiet] = React.useState(false);
  const loud = e.results.filter(r => !quiet(r));
  const calm = e.results.filter(quiet);
  return (
    <li data-testid="check-history-entry" className="rounded-xl border border-slate-200 dark:border-slate-800 px-4 py-3">
      <div className="flex items-center gap-2 text-sm">
        <ListChecks size={14} className="text-slate-400 shrink-0" />
        <span className="font-semibold text-slate-700 dark:text-slate-200">Verify on {e.step}</span>
        <span className={e.blocked ? 'text-rose-600 dark:text-rose-400 text-xs font-bold' : 'text-emerald-600 dark:text-emerald-400 text-xs font-bold'}>
          {e.blocked ? 'Refused' : 'Passed'}
        </span>
        <span className="ml-auto text-xs text-slate-400">{when(e.at)}</span>
      </div>
      {e.results.length > 0 && (
        <ul className="mt-2 space-y-1">
          {loud.map((r, i) => <ResultRow key={`${r.id}-${i}`} r={r} />)}
          {showQuiet && calm.map((r, i) => <ResultRow key={`q-${r.id}-${i}`} r={r} />)}
          {calm.length > 0 && !showQuiet && (
            <li>
              <button type="button" onClick={() => setShowQuiet(true)} className="text-[11px] text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 underline">
                {calm.length} other {calm.length === 1 ? 'check' : 'checks'} passed
              </button>
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

function Entry({ e }: { e: CheckHistoryEntry }) {
  if (e.kind === 'verify') return <VerifyEntry e={e} />;
  if (e.kind === 'approval') {
    return (
      <li data-testid="check-history-entry" className="rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50/50 dark:bg-emerald-950/30 px-4 py-3 text-sm">
        <div className="flex items-center gap-2">
          <ShieldCheck size={14} className="text-emerald-600 shrink-0" />
          <span className="font-semibold text-emerald-800 dark:text-emerald-200">Approved {e.step}</span>
          <span className="text-xs text-emerald-700 dark:text-emerald-300">{signedBy(e.authority)}</span>
          <span className="ml-auto text-xs text-slate-400">{when(e.at)}</span>
        </div>
        {e.note && <p className="mt-1 text-xs text-emerald-800 dark:text-emerald-200">{e.note}</p>}
      </li>
    );
  }
  return (
    <li data-testid="check-history-entry" className="rounded-xl border border-amber-200 dark:border-amber-900 bg-amber-50/50 dark:bg-amber-950/30 px-4 py-3 text-sm">
      <div className="flex items-center gap-2">
        <Unlock size={14} className="text-amber-600 shrink-0" />
        <span className="font-semibold text-amber-900 dark:text-amber-100">Overrode {e.check} on {e.step}</span>
        <span className="text-xs text-amber-700 dark:text-amber-300">{signedBy(e.authority)}</span>
        <span className="ml-auto text-xs text-slate-400">{when(e.at)}</span>
      </div>
      <p className="mt-1 text-xs text-amber-900 dark:text-amber-100">Reason: {e.reason}</p>
    </li>
  );
}

export const CheckHistoryTab: React.FC<{ itemId: string }> = ({ itemId }) => {
  const qc = useQueryClient();
  const key = ['check-history', itemId];
  const { data } = useQuery({ queryKey: key, queryFn: () => api.getCheckHistory(itemId) });
  useSocketEvent('items_updated', () => { void qc.invalidateQueries({ queryKey: key }); });
  if (!data) return null;
  if (!data.length) {
    return (
      <div className="text-center py-12 bg-slate-50 dark:bg-slate-950 rounded-xl border border-dashed border-slate-200 dark:border-slate-800">
        <p className="text-slate-400 text-sm italic">No checks have run on this card yet.</p>
      </div>
    );
  }
  return (
    <div className="animate-in slide-in-from-bottom-2 duration-300">
      <h4 className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-3">Checks and approvals — newest first</h4>
      <ul className="space-y-2">{data.map((e, i) => <Entry key={`${e.kind}-${e.at}-${i}`} e={e} />)}</ul>
    </div>
  );
};
