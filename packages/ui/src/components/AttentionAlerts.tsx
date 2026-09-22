/**
 * The thing that actually makes the noise.
 *
 * A component rather than a hook called inside the shell, for one reason worth
 * stating: it renders nothing, so the only thing it can contribute to the shell
 * is the one line that mounts it. The shell is a 2500-line file that several
 * people edit at once, and a feature that needs a `useRef`, three queries and an
 * effect inside it is a feature that gets half-reverted by somebody rearranging
 * a sidebar.
 *
 * It is a REAL caller and not a convenience wrapper. `sessionRows` is built in
 * the shell from the open terminals and the recorded runs, and it is the only
 * place both halves exist — a run recorded by the Claude Code hook has no
 * terminal of ours, and a terminal the user just opened has no run. Anything
 * watching one of those two would be silent for exactly half the cases.
 *
 * What counts as "needs you" is `NEEDS_A_PERSON` from cardState.ts, the same
 * set the card dot and the sidebar's "N need you" count read. Writing a fourth
 * list here would be the fourth spelling of one rule; the third and fourth
 * already disagreed once, over `unverifiable`.
 */
import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type AppSettingsDto } from '../api';
import { newlyBlocked, planAttentionAlert } from '../attentionAlert';
import { playAttentionSound, browserSoundDeps } from '../attentionSound';
import { notifyAttentionOnBridge } from './agentBridge';
import type { SessionRow, SessionState } from '../sessionRow';

export function AttentionAlerts({ sessionRows }: { sessionRows: readonly SessionRow[] }): null {
  /*
   * The same query key the settings screen writes.
   *
   * Not a copy of the preference and not a prop: a switch flipped on the
   * settings screen updates this cache entry, so the two cannot disagree. A
   * second source of truth here would mean turning alerts off and still being
   * alerted until the next reload.
   */
  const { data: settings } = useQuery<AppSettingsDto>({
    queryKey: ['settings'],
    queryFn: api.getSettings,
  });

  /*
   * The RUNS query, by the same key the shell already uses.
   *
   * Not for the data - `sessionRows` carries that, and this component never
   * reads it. It is here for the STATUS, and the difference it makes is the
   * one the second test in attentionAlertWiring is about: the settings and the
   * runs both start at mount with no order between them, so priming the moment
   * the settings arrive leaves the run list still empty at the moment we decide
   * we have seen everything. A week-old failed run then lands afterwards and
   * reads as news - a banner at launch about work the user finished days ago.
   *
   * Sharing the key means react-query serves both observers from one request,
   * exactly as the settings screen shares ['settings'] and ['latestRelease'].
   */
  const runs = useQuery({ queryKey: ['runs'], queryFn: () => api.listRuns({}) });

  /** What each row was doing last time we looked. */
  const seen = React.useRef<Map<string, SessionState>>(new Map());
  /**
   * Whether the first look has happened.
   *
   * Until it has, rows are RECORDED and nothing is announced. Without it,
   * launching the app in front of last week's failed runs opens with a burst of
   * banners about work that finished days ago — which is the fastest way to
   * teach somebody to switch notifications off, and it would fire before the
   * settings query had even answered.
   */
  const primed = React.useRef(false);

  /**
   * Everything the first look needs before it can claim to have seen the board.
   *
   * The settings, because `?? default` would alert on the first pass using
   * values nobody stored. And the runs, because a list that has not arrived is
   * not an empty board - it is a board we cannot see yet, and priming against
   * it is how the thing already on screen gets announced as if it were new.
   */
  const ready = settings !== undefined && !runs.isPending;

  React.useEffect(() => {
    const rows = sessionRows.map(row => ({
      // Card AND agent, the pair sessionRows is keyed by. Keying on the card
      // alone would let a second agent blocking on the same worktree pass as a
      // repeat of the first.
      key: `${row.itemId}\u0000${row.agentId}`,
      state: row.state,
      agentLabel: row.agentLabel,
      cardTitle: row.title,
    }));
    const { alerts, seen: next } = newlyBlocked(rows, seen.current, primed.current && ready);
    seen.current = next;
    if (ready) primed.current = true;
    if (!ready || alerts.length === 0) return;

    // `settings` is narrowed by the `ready` guard above, which TypeScript
    // cannot follow through a separate const - hence the assertion. It is NOT
    // `as AttentionSettings`: casting to the narrower shape would also silence
    // a genuine mismatch if AppSettingsDto ever stopped satisfying it.
    const plan = planAttentionAlert(settings!, document.hasFocus());
    if (!plan.sound && !plan.banner) return;

    /*
     * ONE sound however many agents stopped at once.
     *
     * Two overlapping chimes read as a glitch rather than as two events, and
     * the count is not information the sound can carry anyway. The banners are
     * per agent, because those can say which.
     */
    if (plan.sound) {
      void playAttentionSound(browserSoundDeps());
    }
    if (plan.banner) {
      for (const alert of alerts) {
        void notifyAttentionOnBridge({
          agentLabel: alert.agentLabel,
          cardTitle: alert.cardTitle,
        });
      }
    }
  }, [sessionRows, settings, ready]);

  return null;
}
