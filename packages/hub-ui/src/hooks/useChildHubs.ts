import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

/**
 * The hubs whose data this hub is showing (CGLAB-184).
 *
 * A parent hub accumulates its own events and every enrolled child's in one
 * store, told apart by originating hub. `/v1/child-hubs` lists the children that
 * carry data — not every hub ever enrolled, since an enrolled-but-silent hub is
 * an option that returns an empty board.
 *
 * This caller sends no from/to, so the list is all-time and deliberately does
 * NOT track the page's range picker: a hub dropping out of the picker because
 * you narrowed the dates is the stranding the server already guards against
 * from the other side.
 *
 * `LOCAL_HUB` is the reserved id for this hub's own rows. Child hub ids are
 * UUIDs, so a bare word cannot collide with one. The same spelling goes in the
 * URL and in the request, so there is no translation layer between what a link
 * says and what the server reads.
 *
 * The caller passes its current selection in. Two reasons, both about not
 * hiding a filter that is still applied:
 *  - the selection is threaded into every query REGARDLESS of this request, so
 *    if this one fails the facet must still render or the board shows one hub's
 *    data with no control to clear it and nothing saying it is filtered;
 *  - the server re-adds a selected hub that has no events in the window
 *    ("the selection stays selectable"), but only if we tell it what is
 *    selected. Without that the chip degrades to a raw UUID.
 */
export const LOCAL_HUB = 'local';

export interface ChildHub {
  id: string;
  name: string;
  /** Released from the group by the parent. Its events stay, so it stays listed. */
  detached: boolean;
  /** Events in the window. Part of the response; this client does not render it
   *  yet — kept so the shape documents what the endpoint returns. */
  events: number;
}

interface ChildHubsResponse {
  childHubs: ChildHub[];
  /** Whether this hub has events of its own in the window. */
  hasLocal: boolean;
}

export interface ChildHubFacet {
  /** Values for the facet: LOCAL_HUB first when present, then each child id. */
  options: string[];
  /** id -> display name; LOCAL_HUB reads as "This hub". */
  label: (id: string) => string;
  /**
   * Whether to render the facet at all.
   *
   * False on every standalone hub, which is most of them. Federation is opt-in
   * and a filter that can only ever have one value is clutter, so the control is
   * absent rather than disabled — that is an acceptance criterion of this work,
   * not a nicety.
   */
  show: boolean;
}

export function useChildHubs(selected: Set<string> = new Set()): ChildHubFacet {
  // Sorted so an equivalent selection is one cache key, not a permutation of them.
  const selectedKey = [...selected].sort().join(',');
  const q = useQuery<ChildHubsResponse>({
    queryKey: ['child-hubs', selectedKey],
    queryFn: async () => {
      const qs = selectedKey ? `?childHubId=${encodeURIComponent(selectedKey)}` : '';
      return (await api.get(`/v1/child-hubs${qs}`)).data;
    },
    // A hub does not gain or lose children while someone reads a dashboard, and
    // every page that shows the facet would otherwise refetch this on mount.
    staleTime: 5 * 60 * 1000,
    // The selection is part of the key, so every toggle is a COLD fetch and
    // `data` would be undefined until it lands — long enough for the picker to
    // lose its names (chips falling back to raw UUIDs) and, when clearing the
    // last selection, for the whole facet to unmount and reappear. Keeping the
    // previous answer makes the list stable across a selection change; the only
    // thing that actually changes between these responses is which hubs the
    // server re-adds for having none of their own events in the window.
    placeholderData: (prev) => prev,
    // On a standalone hub this endpoint is uninteresting and a failure must not
    // surface as a broken page — it simply means no facet.
    retry: false,
  });

  const children = q.data?.childHubs ?? [];
  const names = new Map(children.map(c => [c.id, c.name]));
  const detached = new Set(children.filter(c => c.detached).map(c => c.id));

  // `options` is whatever the server offers, built unconditionally — INCLUDING
  // on a standalone hub, where it is just [LOCAL_HUB]. That leaves `show` as the
  // only thing deciding whether the facet appears, so a test can hold it;
  // emptying the options instead would ALSO hide it (FacetMultiselect renders
  // null with nothing visible) and no single mutation could say which guard was
  // doing the work.
  //
  // For the same reason a selected id the response does not mention — a failed
  // request, or a hub removed since the link was made — is deliberately NOT
  // added here. FacetMultiselect renders the union of `options` and `selected`,
  // so it stays visible and clearable already.
  return {
    options: [
      ...(q.data?.hasLocal ? [LOCAL_HUB] : []),
      ...children.map(c => c.id),
    ],
    label: (id) => {
      if (id === LOCAL_HUB) return 'This hub';
      const name = names.get(id);
      if (!name) return id; // unknown to the server — show what the link asked for
      return detached.has(id) ? `${name} (detached)` : name;
    },
    // A live selection keeps the facet on screen even with no hub list, so the
    // filter is never applied invisibly. A standalone hub with nothing selected
    // still gets no facet, which is the acceptance criterion.
    show: children.length > 0 || selected.size > 0,
  };
}
