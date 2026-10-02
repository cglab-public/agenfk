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
    <div className="min-h-screen flex items-center justify-center bg-canvas p-6">
      <div className="w-full max-w-md bg-card-glass backdrop-blur border border-border-soft rounded-2xl shadow-sm p-7">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-accent-fill text-accent-ink flex items-center justify-center">
            <Cpu className="w-5 h-5" />
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-[0.18em] text-accent-ink font-semibold">Connect a device</p>
            <h1 className="text-lg font-bold text-ink">Authorize this installation</h1>
          </div>
        </div>

        {approve.isSuccess ? (
          <div className="mt-5 p-4 rounded-xl bg-status-ok-bg border border-status-ok-text/40 flex items-start gap-3">
            <Check className="w-5 h-5 text-status-ok-text mt-0.5 shrink-0" />
            <div>
              <div className="text-sm font-semibold text-status-ok-text">Device connected</div>
              <p className="mt-0.5 text-xs text-status-ok-text">Return to your terminal — the agenfk CLI will pick up the new credentials within a few seconds.</p>
            </div>
          </div>
        ) : (
          <>
            <p className="mt-4 text-sm text-ink-secondary">
              Enter the code shown by your <span className="font-mono">agenfk hub login</span> command, then approve the connection. The token will be bound to your current org.
            </p>
            <label className="block mt-5">
              <span className="text-[11px] uppercase tracking-[0.14em] text-ink-tertiary font-semibold">Device code</span>
              <input
                value={display}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="ABCD-EFGH"
                spellCheck={false}
                autoComplete="off"
                className="mt-1.5 w-full px-3 py-2.5 rounded-xl border border-border-soft bg-canvas text-ink font-mono tracking-[0.2em] text-center uppercase text-lg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
              />
            </label>
            {approve.isError && (
              <div className="mt-3 p-3 rounded-xl bg-status-danger-bg border border-status-danger-text/40 text-xs text-status-danger-text flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{(approve.error as any)?.response?.data?.error ?? 'Could not approve. Re-check the code.'}</span>
              </div>
            )}
            <button
              disabled={!ready || approve.isPending}
              onClick={() => approve.mutate(display)}
              className="mt-5 w-full py-2.5 rounded-xl bg-brand text-navy disabled:opacity-50 font-bold transition-colors"
            >
              {approve.isPending ? 'Approving…' : 'Approve & connect'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
