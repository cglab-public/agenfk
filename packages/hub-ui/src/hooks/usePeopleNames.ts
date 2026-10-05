import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

/**
 * user_key → display name, from the hub's installations (GET /v1/people/names).
 * A key with no entry has no known name: show the key. Names change rarely, so
 * one fetch serves every page for a few minutes.
 */
export function usePeopleNames(): (userKey: string) => string | undefined {
  const q = useQuery<{ names: Record<string, string> }>({
    queryKey: ['people-names'],
    queryFn: async () => (await api.get('/v1/people/names')).data,
    staleTime: 5 * 60 * 1000,
  });
  const names = q.data?.names;
  // Stable per answer, so callers can memoise on it.
  return useCallback((userKey: string) => {
    const name = names?.[userKey];
    return typeof name === 'string' && name.trim() ? name : undefined;
  }, [names]);
}
