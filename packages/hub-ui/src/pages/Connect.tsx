import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { Check, Cpu, AlertTriangle } from 'lucide-react';
import { api } from '../api';

export function ConnectPage() {
  const [params] = useSearchParams();
  const initial = (params.get('code') ?? '').toUpperCase();
  const [code, setCode] = useState(initial);

  const approve = useMutation({
    mutationFn: async (userCode: string) => (await api.post('/hub/device/approve', { userCode })).data,
  });

  useEffect(() => {
    if (initial && /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(initial)) setCode(initial);
  }, [initial]);

  const formatted = code.replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 8);
  const display = formatted.length > 4 ? `${formatted.slice(0, 4)}-${formatted.slice(4)}` : formatted;
  const ready = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(display);

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-100 dark:bg-slate-950 p-6">
      <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-sm p-7">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-500 text-white flex items-center justify-center">
            <Cpu className="w-5 h-5" />
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-[0.18em] text-indigo-600 dark:text-indigo-400 font-semibold">Connect a device</p>
            <h1 className="text-lg font-bold text-slate-900 dark:text-slate-100">Authorise this installation</h1>
          </div>
        </div>

        {approve.isSuccess ? (
          <div className="mt-5 p-4 rounded-xl bg-emerald-50 dark:bg-emerald-900/30 border border-emerald-200 dark:border-emerald-800 flex items-start gap-3">
            <Check className="w-5 h-5 text-emerald-600 dark:text-emerald-400 mt-0.5 shrink-0" />
            <div>
              <div className="text-sm font-semibold text-emerald-800 dark:text-emerald-200">Device connected</div>
              <p className="mt-0.5 text-xs text-emerald-700 dark:text-emerald-300">Return to your terminal — the agenfk CLI will pick up the new credentials within a few seconds.</p>
            </div>
          </div>
        ) : (
          <>
            <p className="mt-4 text-sm text-slate-600 dark:text-slate-300">
              Enter the code shown by your <span className="font-mono">agenfk hub login</span> command, then approve the connection. The token will be bound to your current org.
            </p>
            <label className="block mt-5">
              <span className="text-[11px] uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400 font-semibold">Device code</span>
              <input
                value={display}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="ABCD-EFGH"
                spellCheck={false}
                autoComplete="off"
                className="mt-1.5 w-full px-3 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white font-mono tracking-[0.2em] text-center uppercase text-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </label>
            {approve.isError && (
              <div className="mt-3 p-3 rounded-xl bg-rose-50 dark:bg-rose-900/30 border border-rose-200 dark:border-rose-800 text-xs text-rose-700 dark:text-rose-300 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{(approve.error as any)?.response?.data?.error ?? 'Could not approve. Re-check the code.'}</span>
              </div>
            )}
            <button
              disabled={!ready || approve.isPending}
              onClick={() => approve.mutate(display)}
              className="mt-5 w-full py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-semibold transition-colors"
            >
              {approve.isPending ? 'Approving…' : 'Approve & connect'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
