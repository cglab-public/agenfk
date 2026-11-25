/**
 * GH-294 TEL-2: the board's Airlock alerts. The server raises socket.io
 * `airlock_alert` once for each logged decision that is an alert (a cloud
 * metadata endpoint, an IOC host, a denied cloud-storage upload); each shows
 * here as its own banner, newest first, until a person dismisses it.
 *
 * Mounted once in App, inside the SocketProvider, so it is on screen in the
 * browser and the desktop shell alike. Alerts live in this window only: the
 * record of them is the decision log (Settings > Airlock, a card's Airlock
 * section), not this list.
 */
import React from 'react';
import { ShieldAlert, X } from 'lucide-react';
import type { AirlockAlertDto } from '../api';
import { useSocketEvent } from '../SocketContext';
import { AIRLOCK_ALERT_LABEL, isAirlockAlert } from '../airlockAlerts';

interface AirlockAlertEvent {
  alert: AirlockAlertDto;
  target?: string | null;
  decision?: string;
  rule?: string | null;
  source?: string;
  client?: string;
  itemId?: string | null;
  mode?: string;
  ts?: string;
}

/** Banners kept at once; past it the oldest goes, so a flood cannot bury the board. */
const MAX_SHOWN = 20;
/** A target shows this much in the banner (the whole redacted target is its tooltip and in the decision log). */
const TARGET_PREVIEW = 160;
const preview = (t: string): string => (t.length > TARGET_PREVIEW ? `${t.slice(0, TARGET_PREVIEW)}…` : t);

export function AirlockAlertBanner(): React.ReactElement | null {
  const [alerts, setAlerts] = React.useState<Array<AirlockAlertEvent & { key: number }>>([]);
  const nextKey = React.useRef(0);

  useSocketEvent<unknown>('airlock_alert', payload => {
    if (!payload || typeof payload !== 'object' || !isAirlockAlert((payload as { alert?: unknown }).alert)) return;
    const key = nextKey.current++;
    setAlerts(list => [{ ...(payload as AirlockAlertEvent), key }, ...list].slice(0, MAX_SHOWN));
  });

  if (alerts.length === 0) return null;
  const dismiss = (key: number) => setAlerts(list => list.filter(a => a.key !== key));

  return (
    <div className="fixed right-4 top-4 z-[60] flex max-h-[calc(100vh-2rem)] w-96 max-w-[calc(100vw-2rem)] flex-col gap-2 overflow-y-auto" data-testid="airlock-alerts">
      {alerts.map(a => (
        <div
          key={a.key}
          role="alert"
          data-alert={a.alert}
          className="rounded-xl border border-status-danger-text/40 bg-status-danger-bg p-3 text-xs text-status-danger-text shadow-2xl"
        >
          <div className="flex items-start gap-2">
            <ShieldAlert size={16} className="mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="font-bold">{`Airlock alert: ${AIRLOCK_ALERT_LABEL[a.alert]}`}</p>
              <p className="mt-0.5 text-ink-secondary">
                {[a.decision === 'deny' ? 'denied' : a.decision, a.mode === 'observe' ? 'observed, not stopped' : null, a.rule, a.client, a.source, a.itemId ? `card ${a.itemId.slice(0, 8)}` : null]
                  .filter(Boolean).join(' · ')}
              </p>
              {a.target && <code title={a.target} className="mt-1 block max-h-16 overflow-hidden break-all text-ink-secondary">{preview(a.target)}</code>}
            </div>
            <button type="button" onClick={() => dismiss(a.key)} aria-label="Dismiss Airlock alert" className="text-ink-tertiary hover:text-ink">
              <X size={14} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
