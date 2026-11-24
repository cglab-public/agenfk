import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { PricesData } from './usage';

/**
 * GH-397: the price table of the local server - the one it prices turns with
 * at ingestion - for the older usage that has no stored price. The board asks
 * its server rather than the public table, so the two never price apart, and
 * an offline board still has the server's last good table.
 */
export function usePriceTable(enabled = true): PricesData | null | undefined {
  return useQuery({
    queryKey: ['prices'],
    queryFn: () => api.getPriceTable(),
    staleTime: 60 * 60 * 1000,
    retry: false,
    enabled,
  }).data;
}
