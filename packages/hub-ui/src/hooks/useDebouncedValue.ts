import { useEffect, useState } from 'react';

/**
 * `value`, delayed by `ms` of quiet — for the case where the UI should react
 * immediately but the network should not.
 *
 * The mount value is returned straight away rather than after one delay, so a
 * cold load (a shared `?pr=57` link) is no slower than it was. Only subsequent
 * changes are debounced.
 *
 * PR Overview uses this for the PR-number search: the box and the URL follow
 * every keystroke, but the request waits for a pause. Typing `1234` would
 * otherwise commit four query keys and fire four searches, and a PR search reads
 * the org's entire PR event stream with no time bound — so four keystrokes is
 * four full scans to answer one question.
 *
 * `immediateFor` names a value that must NOT wait. A navigation is not typing:
 * when Back lands on ?pr=57 the whole point is that the page already knows the
 * answer, and 350ms of "not yet" is long enough for the page's own URL
 * write-back to publish an address bar with no `pr` in it — and to make that
 * permanent if the reader navigates again inside the window.
 */
export function useDebouncedValue<T>(value: T, ms: number, immediateFor?: T): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    if (immediateFor !== undefined && Object.is(value, immediateFor)) {
      setDebounced(value);
      return;
    }
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms, immediateFor]);

  return debounced;
}
