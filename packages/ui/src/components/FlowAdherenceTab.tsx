/**
 * CGLAB-610 — the card's Flow Adherence tab: how consistently the card moved
 * through the flow, scored ONLY from transitions that carry the flow version
 * they happened under (CGLAB-608/609). Unstamped events are not failures —
 * they are simply not scoreable, so the panel says so instead of implying 100%.
 */
import React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Gauge, Info } from 'lucide-react';
import { api, type FlowAdherence } from '../api';
import { useSocketEvent } from '../SocketContext';

const pct = (s: number) => `${Math.round(s * 100)}%`;

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border-soft bg-surface p-3">
      <div className="text-2xl font-semibold text-ink">{value}</div>
      <div className="mt-0.5 text-xs text-ink-secondary">{label}</div>
    </div>
  );
}

export function FlowAdherenceTab({ itemId }: { itemId: string }) {
  const queryClient = useQueryClient();
  const key = ['flow-adherence', itemId];
  const { data, isLoading, isError } = useQuery<FlowAdherence>({
    queryKey: key,
    queryFn: () => api.getFlowAdherence(itemId),
  });
  useSocketEvent('items_updated', () => { void queryClient.invalidateQueries({ queryKey: key }); });

  if (isError) {
    return (
      <div role="status" className="space-y-4 p-5 text-sm text-ink-secondary">
        <div className="flex items-start gap-2 rounded-lg border border-border-soft bg-surface p-4">
          <Info size={16} className="mt-0.5 shrink-0" />
          <div>Could not load this card's flow adherence. It may have been deleted — reopen the card and try again.</div>
        </div>
      </div>
    );
  }

  if (isLoading || !data) {
    return <div role="status" aria-busy="true" className="p-5 text-sm text-ink-secondary">Loading adherence…</div>;
  }

  return (
    <div className="space-y-4">
      {data.score === null ? (
        <div className="flex items-start gap-2 rounded-lg border border-border-soft bg-surface p-4 text-sm text-ink-secondary">
          <Info size={16} className="mt-0.5 shrink-0" />
          <div>
            <div className="font-medium text-ink">No versioned transitions to score yet</div>
            {data.unstamped > 0 && (
              <div className="mt-1">
                {data.unstamped} transition{data.unstamped === 1 ? '' : 's'} without a flow version
                cannot be judged and are excluded — this is not a failure.
              </div>
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-3">
            <Gauge size={20} className="text-ink-secondary shrink-0" />
            <div>
              <div className="text-3xl font-semibold text-ink" data-testid="adherence-score">{pct(data.score)}</div>
              <div className="text-xs text-ink-secondary">
                {data.judged} versioned transition{data.judged === 1 ? '' : 's'} judged —{' '}
                {data.compliant} consistent with their own flow revision
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Judged transitions" value={data.judged} />
            <Stat label="Consistent" value={data.compliant} />
          </div>
          {data.unresolved > 0 && (
            <div className="text-xs text-ink-secondary">
              {data.unresolved} transition{data.unresolved === 1 ? '' : 's'} name{data.unresolved === 1 ? 's' : ''} a
              flow revision that no longer exists and {data.unresolved === 1 ? 'is' : 'are'} excluded from the score.
            </div>
          )}
        </>
      )}
    </div>
  );
}
