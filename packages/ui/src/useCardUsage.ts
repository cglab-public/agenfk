/**
 * GH-389: a card's usage, asked once for everyone who shows it - the USAGE tab
 * label beside Changed/Staged needs the total while the tab is closed, and the
 * view needs the rows. React Query's keys make that one request each.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { AgEnFKItem } from './types';
import { closeTotalOf, currentStepSince, summarizeCardUsage, type CardUsageSummary } from './usage';

/** Live turns land within a poll of the ingester (30 s); no need to ask faster. */
const REFRESH_MS = 15_000;

export function useCardUsage(itemId: string | null, given?: AgEnFKItem | null): {
  item: AgEnFKItem | null;
  summary: CardUsageSummary | null;
  isPending: boolean;
  isError: boolean;
} {
  const fetched = useQuery({
    queryKey: ['usage-item', itemId],
    queryFn: () => api.getItem(itemId!),
    enabled: !given && Boolean(itemId),
    refetchInterval: REFRESH_MS,
  });
  const item: AgEnFKItem | null = given ?? (fetched.data as AgEnFKItem | undefined) ?? null;
  // A closed card's total was recorded at close; only an open one has a current step to count.
  const since = item && !closeTotalOf(item) ? currentStepSince(item) : null;
  const live = useQuery({
    queryKey: ['token-events', itemId, since],
    queryFn: () => api.getTokenEvents({ itemId: itemId!, since: since! }),
    enabled: Boolean(itemId && since),
    refetchInterval: REFRESH_MS,
  });
  return {
    item,
    summary: item ? summarizeCardUsage(item, live.data ?? []) : null,
    isPending: !item && fetched.isPending,
    isError: fetched.isError,
  };
}
