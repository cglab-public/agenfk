/**
 * The sheet you read before spending anything (CGLAB-207).
 *
 * Choosing an epic and dispatching its children is what the claims mechanism
 * was built for. This is where it is cashed in: every collision, every
 * unreadable claim and the depth ceiling are shown BEFORE a single agent
 * starts, because discovering them afterwards costs money to learn what the
 * gate already knew.
 *
 * THE BUTTON COUNTS WHAT WILL RUN. "Launch 3", never "Launch 4" with one
 * quietly held. It is the one number on this screen a person trusts without
 * checking, so it is the one that must never be generous.
 *
 * NOTHING HAPPENS ON ITS OWN. The sheet computes and shows; the person
 * launches. Held rows are not errors and are not hidden - they are the design
 * working, and hiding them would turn a visible wait into an invisible one.
 */
import React from 'react';
import { clsx } from 'clsx';
import { Zap, X } from 'lucide-react';
import { planFleet, launchLabel, type FleetChild } from '../fleetPlan';
import type { ClaimCard } from '../claimState';

export interface FleetSheetItem extends ClaimCard {
  readonly title: string;
  readonly parentId?: string | null;
  /** Consecutive failed attempts, when the item carries one (CGLAB-202). */
  readonly failureCount?: number;
}

export interface FleetSheetProps {
  /** The card whose children would be dispatched. */
  readonly parent: FleetSheetItem;
  /** Every item in the project: holders can be anywhere, not just siblings. */
  readonly all: readonly FleetSheetItem[];
  /** Whether the parent may fan out at all, and why not. From `mayFanOut`. */
  readonly depth: { readonly allowed: boolean; readonly reason: string | null };
  /**
   * Cards that already have a terminal open.
   *
   * Required rather than optional, on purpose: optional is how the breaker's
   * `failures` ended up never being passed, leaving a whole hold reason dead in
   * the shipped app while its tests constructed the input by hand. A promise
   * about the count cannot depend on a caller remembering.
   */
  readonly running: ReadonlySet<string>;
  /** The project flow's own exit step name(s), when known (fae59deb). */
  readonly terminalStatuses?: ReadonlySet<string>;
  /** Launch these, in this order. Only ever the ones the plan cleared. */
  readonly onLaunch: (ids: readonly string[]) => void;
  readonly onClose: () => void;
}

/** Amber for waiting, never red: a held child is the mechanism working. */
const HOLD_TONE = 'bg-amber-500/10 text-amber-700 dark:text-amber-300';

function HoldRow({ child }: { readonly child: FleetChild }): React.ReactElement {
  return (
    <li data-testid="fleet-row" data-launch="false" className="border-b border-border-soft last:border-b-0">
      <div className="flex items-start gap-3 px-4 py-3">
        <span className={clsx('mt-0.5 shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide', HOLD_TONE)}>
          held
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-ink">{child.title}</span>
          {/* The sentence names the MOVE, and differs by who holds it: a
              sibling finishes and releases, an outsider may sit for days.
              Absent rather than empty when the reason belongs to the whole
              fan-out - the ceiling says it once at the top, and an empty
              element here is a thing a screen reader still walks into. */}
          {child.holdText ? (
            <span data-testid="fleet-hold-reason" className="mt-1 block text-xs text-ink-secondary">
              {child.holdText}
            </span>
          ) : null}
          {child.claims?.length ? (
            <span className="mt-1 block truncate font-mono text-[10px] text-ink-tertiary">
              {child.claims.join(' · ')}
            </span>
          ) : null}
        </span>
      </div>
    </li>
  );
}

function LaunchRow({ child }: { readonly child: FleetChild }): React.ReactElement {
  return (
    <li data-testid="fleet-row" data-launch="true" className="border-b border-border-soft last:border-b-0">
      <div className="flex items-start gap-3 px-4 py-3">
        <span className="mt-0.5 shrink-0 rounded bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
          ready
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-ink">{child.title}</span>
          <span className="mt-1 block truncate font-mono text-[10px] text-ink-tertiary">
            {child.claims?.length ? child.claims.join(' · ') : 'claims nothing'}
          </span>
        </span>
      </div>
    </li>
  );
}

export function FleetSheet({ parent, all, depth, running, terminalStatuses, onLaunch, onClose }: FleetSheetProps): React.ReactElement {
  const plan = React.useMemo(() => {
    /*
     * Built HERE from the items rather than taken as a prop. The sheet already
     * holds every item, and a caller that has to remember to pass the count is
     * exactly how this wire stayed dead: `FleetInputs.failures` was optional,
     * nothing filled it, and the `circuit-broken` hold could never appear in
     * the shipped app while fleetPlan's own tests built the input by hand
     * (BUG b0bccf90).
     */
    const failures = new Map(all.map(i => [i.id, i.failureCount ?? 0]));
    return planFleet({ parentId: parent.id, all, depth, running, failures, terminalStatuses });
    // `running` in the deps, not only in the call. A memo that reads a prop it
    // does not depend on keeps answering with the set it was built with, which
    // is the count going stale the moment a terminal opens.
  }, [parent.id, all, depth, running, terminalStatuses]);
  const launchable = plan.children.filter(c => c.launch).map(c => c.id);

  return (
    <div data-testid="fleet-sheet" className="flex max-h-[70vh] w-[520px] flex-col rounded-lg border border-border-soft bg-nav-surface shadow-xl">
      <div className="flex items-start gap-3 border-b border-border-soft px-4 py-3">
        <span className="min-w-0 flex-1">
          <span className="block font-mono text-[10px] uppercase tracking-widest text-ink-tertiary">
            Launch fleet
          </span>
          <span className="mt-0.5 block truncate text-sm text-ink">{parent.title}</span>
        </span>
        <button type="button" onClick={onClose} aria-label="Close" className="shrink-0 rounded p-1 text-ink-tertiary hover:text-ink">
          <X size={14} />
        </button>
      </div>

      {/*
        The ceiling refuses the whole fan-out, so it is said ONCE at the top
        rather than repeated down every row - four rows carrying one reason
        reads as four problems.
      */}
      {plan.blocked ? (
        <p data-testid="fleet-blocked" className={clsx('border-b border-border-soft px-4 py-3 text-xs', HOLD_TONE)}>
          {plan.blocked}
        </p>
      ) : null}

      {plan.children.length === 0 ? (
        <p className="px-4 py-8 text-center text-xs text-ink-tertiary">
          This card has no children to dispatch.
        </p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto scrollbar-slim">
          {plan.children.map(child =>
            child.launch ? <LaunchRow key={child.id} child={child} /> : <HoldRow key={child.id} child={child} />,
          )}
        </ul>
      )}

      <div className="flex items-center gap-3 border-t border-border-soft px-4 py-3">
        <span data-testid="fleet-summary" className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-tertiary">
          {plan.heldCount > 0
            ? `${plan.launchCount} ready · ${plan.heldCount} waiting on a path`
            : `${plan.launchCount} ready`}
        </span>
        <button
          type="button"
          data-testid="fleet-launch"
          disabled={plan.launchCount === 0}
          onClick={() => onLaunch(launchable)}
          className={clsx(
            'flex shrink-0 items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium transition-colors',
            plan.launchCount === 0
              ? 'cursor-not-allowed bg-surface-2 text-ink-tertiary opacity-60'
              : 'bg-brand text-canvas hover:opacity-90',
          )}
        >
          <Zap size={12} />
          {launchLabel(plan)}
        </button>
      </div>
    </div>
  );
}
