import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * A dashboard's filters, with the URL as their only source of truth: a reload
 * or a shared link shows the same view (PR overview's rule, now every page's).
 *
 * localStorage only seeds a URL that carries NONE of the page's filter keys, a
 * first visit or a bare link, so the page opens as this browser left it. It is
 * rewritten on every change for that purpose, and never read otherwise: a link
 * that names a filter always wins.
 */
const NOTHING: readonly string[] = [];

export function useUrlFilters({ keys, storageKey, legacy = {}, forget = NOTHING }: {
  /** The query-string keys this page owns. Others (childHubId…) are left alone. */
  keys: readonly string[];
  storageKey: string;
  /** Old per-facet localStorage keys (JSON arrays), read once when nothing newer is stored. */
  legacy?: Record<string, string>;
  /**
   * Keys that live in a link but are never remembered for a bare visit: an
   * absolute date range chosen for one person must not follow you to the next.
   */
  forget?: readonly string[];
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const fromUrl = keys.some(k => searchParams.has(k));

  const params = useMemo(() => {
    if (fromUrl) return searchParams;
    const stored = readStored(storageKey, legacy) ?? new URLSearchParams();
    for (const k of forget) stored.delete(k);
    return stored;
    // `legacy` is a literal at every call site; its identity is irrelevant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromUrl, searchParams, storageKey]);
  // Read through a ref so `write` keeps one identity: a writer effect that
  // depended on it would otherwise re-run on every navigation, including a
  // Back, while the selections are still the view being left.
  const seed = useRef(params);
  seed.current = params;

  /**
   * Set (string) or remove (null) keys, in place. Call it from ONE effect per
   * page: React Router hands every setSearchParams in a commit the same
   * render-time `prev`, so two writers in one tick lose the first write.
   */
  const write = useCallback((changes: Record<string, string | null>) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      // A bare URL is showing the seeded view: put all of it in the link
      // first, so a change to one key does not drop the others.
      if (!keys.some(k => prev.has(k))) {
        for (const [k, v] of seed.current) if (keys.includes(k)) next.set(k, v);
      }
      for (const [k, v] of Object.entries(changes)) {
        if (v === null) next.delete(k); else next.set(k, v);
      }
      return next.toString() === prev.toString() ? prev : next;
    }, { replace: true });
  }, [keys, setSearchParams]);

  // Remember the view for the next bare visit.
  useEffect(() => {
    if (!fromUrl) return;
    const own = new URLSearchParams();
    for (const k of keys) {
      if (searchParams.has(k) && !forget.includes(k)) own.set(k, searchParams.get(k) ?? '');
    }
    try { window.localStorage.setItem(storageKey, own.toString()); } catch { /* storage blocked */ }
  }, [fromUrl, keys, forget, searchParams, storageKey]);

  return { params, write };
}

function readStored(storageKey: string, legacy: Record<string, string>): URLSearchParams | null {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (raw !== null) return new URLSearchParams(raw);
    const migrated = new URLSearchParams();
    for (const [param, key] of Object.entries(legacy)) {
      const old = window.localStorage.getItem(key);
      if (old === null) continue;
      const values = JSON.parse(old);
      if (Array.isArray(values)) migrated.set(param, values.map(String).join(','));
    }
    return [...migrated.keys()].length ? migrated : null;
  } catch {
    return null;
  }
}
