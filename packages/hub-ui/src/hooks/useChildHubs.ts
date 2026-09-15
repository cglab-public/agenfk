import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

/**
 * The hubs whose data this hub is showing (CGLAB-184).
 *
 * A parent hub accumulates its own events and every enrolled child's in one
 * store, told apart by originating hub. `/v1/child-hubs` lists the children that
 * actually carry data in the current window — not every hub ever enrolled, since
 * an enrolled-but-silent hub is an option that returns an empty board.
 *
 * `LOCAL_HUB` is the reserved id for this hub's own rows. Child hub ids are
 * UUIDs, so a bare word cannot collide with one. The same spelling goes in the
 * URL and in the request, so there is no translation layer between what a link
 * says and what the server reads.
 */
export const LOCAL_HUB = 'local';

export interface ChildHub {
  id: string;
  name: string;
  detached: boolean;
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

export function useChildHubs(): ChildHubFacet {
  const q = useQuery<ChildHubsResponse>({
    queryKey: ['child-hubs'],
    queryFn: async () => (await api.get('/v1/child-hubs')).data,
    // A hub does not gain or lose children while someone reads a dashboard, and
    // every page that shows the facet would otherwise refetch this on mount.
    staleTime: 5 * 60 * 1000,
    // On a standalone hub this endpoint is uninteresting and a failure must not
    // surface as a broken page — it simply means no facet.
    retry: false,
  });

  const children = q.data?.childHubs ?? [];
  const names = new Map(children.map(c => [c.id, c.name]));

  // `options` is built unconditionally, INCLUDING on a standalone hub, where it
  // is just [LOCAL_HUB]. That is deliberate: `show` is then the only thing
  // deciding whether the facet appears, so a test can hold it. Filtering the
  // options down to nothing instead would hide the facet too — FacetMultiselect
  // renders null with no visible options — and two guards for one guarantee
  // means no single mutation can prove either.
  return {
    options: [...(q.data?.hasLocal ? [LOCAL_HUB] : []), ...children.map(c => c.id)],
    label: (id) => (id === LOCAL_HUB ? 'This hub' : names.get(id) ?? id),
    show: children.length > 0,
  };
}
