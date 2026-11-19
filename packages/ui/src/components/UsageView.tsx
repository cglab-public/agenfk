/**
 * GH-389 / #385: how much AI a card used - cost, the four kinds of tokens, and
 * which steps used them. Shown where you look at ONE card (the USAGE tab beside
 * Changed and Staged, the card's own Usage tab), never on the board: token
 * figures were taken off the cards on purpose (#9, #14).
 *
 * It must not overstate what it knows. Cost a harness reported is shown as
 * cost; cost the board worked out from its price table is shown as an
 * estimate; a model it cannot price is named rather than counted as free; and a
 * card with no recorded turns says "not measured" rather than showing a zero.
 */
import React from 'react';
import { clsx } from 'clsx';
import type { AgEnFKItem } from '../types';
import { useCardUsage } from '../useCardUsage';
import { estimateCost, tokensOf, type PricesData } from '../usage';
import { formatCost } from '../utils';

const n = (v: number) => v.toLocaleString('en-US');

export function UsageView({ itemId, item, prices }: {
  itemId: string | null;
  /** The card, when the caller already has it (the card modal). */
  item?: AgEnFKItem | null;
  /** The board's price table, for estimating turns no harness priced. */
  prices?: PricesData | null;
}): React.ReactElement {
  const { summary, isPending, isError } = useCardUsage(itemId, item);

  if (isError) {
    return <p role="alert" className="px-3 py-4 text-[11px] text-status-warn-text">Could not read this card&apos;s usage.</p>;
  }
  // Nothing claimed while still asking: "not measured" before the answer is in would be a guess.
  if (isPending || !summary) return <div aria-busy="true" className="px-3 py-4" />;

  if (!summary.measured) {
    return (
      <div className="px-3 py-4 text-[11px] text-ink-tertiary">
        <p className="text-ink-secondary">No usage recorded for this card.</p>
        <p className="mt-1">Usage is measured for Claude Code, Codex and pi sessions; other harnesses are not measured.</p>
      </div>
    );
  }

  const cost = estimateCost(summary.byModel, prices);
  const t = summary.total;
  const kinds: Array<[string, number]> = [['Input', t.input], ['Cache read', t.cacheRead], ['Cache write', t.cacheWrite], ['Output', t.output]];

  return (
    <div className="flex flex-col gap-3 px-3 py-3 text-[11px]">
      <section aria-label="Cost">
        <div className="flex items-baseline gap-2">
          {cost.estimated > 0
            ? <span className="font-mono text-lg font-bold text-ink">≈ {formatCost(cost.reported + cost.estimated)}</span>
            : <span className="font-mono text-lg font-bold text-ink">{formatCost(cost.reported)}</span>}
          <span className="text-ink-tertiary">{n(t.turns)} turn{t.turns === 1 ? '' : 's'}</span>
        </div>
        {cost.estimated > 0 && (
          <p className="text-[10px] text-ink-tertiary">
            Includes an estimate from the board&apos;s price table for turns no harness priced.
          </p>
        )}
        {cost.unpricedModels.length > 0 && (
          <p className="text-[10px] text-status-warn-text">
            Not priced: {cost.unpricedModels.join(', ')}.
          </p>
        )}
        {summary.subCards > 0 && (
          <p className="text-[10px] text-ink-tertiary">Includes {summary.subCards} sub-card{summary.subCards === 1 ? '' : 's'}.</p>
        )}
      </section>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
        {kinds.map(([label, value]) => (
          <div key={label} className="flex flex-col">
            <dt className="text-[10px] uppercase tracking-wide text-ink-tertiary">{label}</dt>
            <dd className="font-mono text-ink-secondary">{n(value)}</dd>
          </div>
        ))}
      </dl>

      <table className="w-full text-left">
        <caption className="sr-only">Usage by step</caption>
        <thead>
          <tr className="text-[10px] uppercase text-ink-tertiary">
            <th className="py-1 font-medium">Step</th>
            <th className="py-1 text-right font-medium">Turns</th>
            <th className="py-1 text-right font-medium">Tokens</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-soft">
          {summary.steps.map((row, i) => (
            <tr key={`${row.step}-${i}`} className={clsx(row.live && 'text-accent-ink')}>
              <td className="py-1 font-mono">{row.live ? `${row.step} (now)` : row.step}</td>
              <td className="py-1 text-right font-mono">{n(row.total.turns)}</td>
              <td className="py-1 text-right font-mono">{n(tokensOf(row.total))}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <ul aria-label="Models" className="flex flex-col gap-0.5">
        {summary.byModel.map((m) => (
          <li key={`${m.client}-${m.model}`} className="flex justify-between gap-2 text-ink-secondary">
            <span className="truncate font-mono" title={`${m.client} · ${m.model}`}>{m.model}</span>
            <span className="shrink-0 text-ink-tertiary">{m.client} · {n(m.turns)} turn{m.turns === 1 ? '' : 's'}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
