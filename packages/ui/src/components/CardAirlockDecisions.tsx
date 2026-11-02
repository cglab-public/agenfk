/**
 * GH-294 TEL-2: a card's Airlock section, on the card details' Overview: the
 * decisions logged while this card was the session's active work (GET
 * /airlock/decisions?itemId=), newest first, alerts marked. A card with no
 * decision, or a server that cannot answer, shows no section: an empty box on
 * every card would be noise. Refreshed when the server says a decision was logged.
 */
import React from 'react';
import { clsx } from 'clsx';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldAlert } from 'lucide-react';
import { api } from '../api';
import { useSocketEvent } from '../SocketContext';
import { AIRLOCK_ALERT_LABEL, isAirlockAlert } from '../airlockAlerts';

/** Decisions a card shows; the log itself is capped server-side. */
const CARD_DECISIONS = 50;

const DECISION_TONE: Record<string, string> = {
  deny: 'text-status-danger-text',
  'needs-human-approval': 'text-status-warn-text',
  allow: 'text-status-ok-text',
};

export function CardAirlockDecisions({ itemId }: { itemId: string }): React.ReactElement | null {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ['airlock-decisions', { itemId }],
    // Wrapped, not passed by reference: a spec whose api mock lacks it fails the query (no section) instead of crashing.
    queryFn: () => api.getAirlockDecisions(CARD_DECISIONS, { itemId }),
    retry: false,
  });
  useSocketEvent('airlock_decision', () => { void queryClient.invalidateQueries({ queryKey: ['airlock-decisions'] }); });

  const decisions = data?.decisions ?? [];
  if (decisions.length === 0) return null;

  return (
    <section aria-label="Airlock" className="pt-4 border-t border-border-soft">
      <h4 className="text-xs font-bold text-ink-tertiary uppercase tracking-widest mb-3 flex items-center gap-2">
        <ShieldAlert size={14} />
        Airlock ({decisions.length})
      </h4>
      <ul className="space-y-1.5">
        {decisions.map((d, i) => (
          <li key={d.id ?? i} className="text-xs" data-alert={isAirlockAlert(d.alert) ? d.alert : undefined}>
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className={clsx('font-semibold', DECISION_TONE[d.decision] ?? 'text-ink')}>{d.decision}</span>
              {d.rule && <span className="text-ink-secondary">{d.rule}</span>}
              {isAirlockAlert(d.alert) && <span className="font-semibold text-status-danger-text">{AIRLOCK_ALERT_LABEL[d.alert]}</span>}
              <span className="text-ink-tertiary">
                {`${new Date(d.ts).toLocaleString()} · ${d.client} · ${d.source ?? 'tool'}${d.mode === 'observe' ? ' · observed' : ''}`}
              </span>
            </div>
            {d.target && <code className="block break-all text-ink-tertiary">{d.target}</code>}
          </li>
        ))}
      </ul>
    </section>
  );
}
