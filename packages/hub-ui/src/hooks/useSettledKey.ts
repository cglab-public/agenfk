import { useEffect, useState } from 'react';

/**
 * The last `key` whose result has actually ARRIVED, as opposed to the key being
 * asked for right now.
 *
 * These two are the same thing until a query adds `placeholderData`, which keeps
 * the PREVIOUS answer on screen while the next one loads. From then on `data`
 * describes one request and the live query string describes another — so any copy
 * or logic that makes a claim about the ROWS has to be pinned to the key the rows
 * came from, not the key currently in flight.
 *
 * PR Overview uses this for its PR-number search, where the gap is not a blink:
 * the search deliberately has no time bound, so a scan can take seconds. Without
 * it the page spends that whole window reading "Showing PR #58 only" over PR
 * #57's table, and — worse — treats a one-row search answer as the option
 * universe for the Developer and Model facets.
 *
 * `pending` is the caller's "the data I am holding is not mine yet" signal;
 * react-query exposes it as `isPlaceholderData`.
 */
export function useSettledKey(key: string, pending: boolean): string {
  const [settled, setSettled] = useState(key);

  useEffect(() => {
    if (!pending) setSettled(key);
  }, [key, pending]);

  return settled;
}
