/**
 * GH-389 / #385: how much AI a card used, read at a glance.
 *
 * Shown where you look at ONE card (the USAGE tab beside Changed and Staged,
 * the card's own Usage tab), never on the board: token figures were taken off
 * the cards on purpose (#9, #14).
 *
 * Top to bottom it answers: what did it cost and how big was it (summary);
 * what kind of tokens were they (one stacked bar - on agent work cache reads
 * usually dwarf everything, and a bar shows that where four numbers do not);
 * where did they go (by sub-card on a parent, by step, by model), each row
 * with a bar in proportion to the largest. Steps that used nothing are folded
 * into one line rather than listed as rows of zeros.
 *
 * It must not overstate what it knows: reported cost is marked reported, the
 * board's own figure is marked estimated, a model it cannot price is named,
 * an incomplete count says so, and a card with no recorded turns says "not
 * measured" rather than showing a zero.
 */
import React from 'react';
import { clsx } from 'clsx';
import type { AgEnFKItem, UsageTotals } from '../types';
import { useCardUsage } from '../useCardUsage';
import { cardTotalOf, estimateCost, tokenMix, tokensOf, type PricesData, type TokenKind } from '../usage';
import { formatCost } from '../utils';

const n = (v: number) => v.toLocaleString('en-US');
const turnsLabel = (t: number) => `${n(t)} turn${t === 1 ? '' : 's'}`;

/** One colour per token kind, the same wherever it appears. */
const KIND_SWATCH: Record<TokenKind, string> = {
  input: 'bg-series-1',
  cacheRead: 'bg-series-2',
  cacheWrite: 'bg-series-3',
  output: 'bg-series-4',
};

const INCOMPLETE = 'Incomplete: some session logs could not be read in time, so turns may be missing.';

function Chip({ children, tone }: { children: React.ReactNode; tone: 'ok' | 'info' | 'warn' | 'muted' }) {
  return (
    <span
      className={clsx(
        'inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
        tone === 'ok' && 'bg-status-ok-bg text-status-ok-text',
        tone === 'info' && 'bg-status-info-bg text-status-info-text',
        tone === 'warn' && 'bg-status-warn-bg text-status-warn-text',
        tone === 'muted' && 'bg-canvas text-ink-secondary',
      )}
    >
      {children}
    </span>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col">
      <span className="font-mono text-base font-semibold text-ink tabular-nums">{value}</span>
      <span className="text-[10px] uppercase tracking-wide text-ink-tertiary">{label}</span>
    </div>
  );
}

function Section({ title, children, card }: { title: string; children: React.ReactNode; card?: boolean }) {
  const id = React.useId();
  return (
    <section role="region" aria-labelledby={id} className={clsx('flex flex-col gap-2', card && 'rounded-xl border border-border-soft bg-surface p-4')}>
      <h3 id={id} className="text-[10px] font-semibold uppercase tracking-wider text-ink-tertiary">{title}</h3>
      {children}
    </section>
  );
}

/** A row of a breakdown: what, how much, and a bar against the largest row. */
function BarRow({ name, marks, total, max }: { name: React.ReactNode; marks?: React.ReactNode; total: UsageTotals; max: number }) {
  const tokens = tokensOf(total);
  // A sliver for a small row so it is visibly there; none for a row with no tokens.
  const width = max > 0 && tokens > 0 ? Math.max(2, Math.round((tokens / max) * 100)) : 0;
  return (
    <li className="flex flex-col gap-1">
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 truncate text-ink-secondary">{name}</span>
        {marks}
        <span className="ml-auto shrink-0 font-mono tabular-nums text-ink">{n(tokens)}</span>
        <span className="w-16 shrink-0 text-right text-[11px] text-ink-tertiary">{turnsLabel(total.turns)}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-canvas" aria-hidden="true">
        <div className="h-full rounded-full bg-accent" style={{ width: `${width}%` }} />
      </div>
    </li>
  );
}

export function UsageView({ itemId, item, prices }: {
  itemId: string | null;
  /** The card, when the caller already has it (the card modal). */
  item?: AgEnFKItem | null;
  /** The board's price table, for estimating turns no harness priced. */
  prices?: PricesData | null;
}): React.ReactElement {
  const { summary, children, isPending, isError } = useCardUsage(itemId, item);

  if (isError) {
    return <p role="alert" className="px-3 py-4 text-[11px] text-status-warn-text">Could not read this card&apos;s usage.</p>;
  }
  // Nothing claimed while still asking: "not measured" before the answer is in would be a guess.
  if (isPending || !summary) return <div aria-busy="true" className="px-3 py-4" />;

  if (!summary.measured) {
    return (
      <div className="w-full max-w-md py-2">
        <div className="rounded-xl border border-border-soft bg-surface p-4 text-[12px] text-ink-tertiary">
          <p className="font-medium text-ink-secondary">No usage recorded for this card.</p>
          <p className="mt-1">Usage is measured for Claude Code, Codex and pi sessions; other harnesses are not measured.</p>
          {!summary.complete && <p className="mt-2 text-status-warn-text">{INCOMPLETE}</p>}
        </div>
      </div>
    );
  }

  const t = summary.total;
  const cost = estimateCost(summary.byModel, prices);
  const estimated = cost.estimated > 0;
  const costText = estimated ? `≈ ${formatCost(cost.reported + cost.estimated)}` : formatCost(cost.reported);
  const mix = tokenMix(t);

  const usedSteps = summary.steps.filter((r) => r.live || r.total.turns > 0);
  const idleSteps = summary.steps.filter((r) => !r.live && r.total.turns === 0).map((r) => r.step);
  const stepMax = Math.max(0, ...usedSteps.map((r) => tokensOf(r.total)));

  const subCards = children
    .map((c) => ({ id: c.id, title: c.title, total: cardTotalOf(c) }))
    .filter((c) => c.total.turns > 0)
    .sort((a, b) => tokensOf(b.total) - tokensOf(a.total));
  const subMax = Math.max(0, ...subCards.map((c) => tokensOf(c.total)));

  const models = [...summary.byModel].sort((a, b) => tokensOf(b) - tokensOf(a));
  const modelMax = Math.max(0, ...models.map((m) => tokensOf(m)));

  return (
    // Two columns by the room the view HAS, not the screen's: inside the 288px
    // worktree panel it stays one column on any screen (review finding).
    <div className="@container w-full">
    <div className="grid w-full grid-cols-1 items-start gap-6 py-2 text-[12px] @3xl:grid-cols-[minmax(260px,340px)_minmax(0,1fr)]">
      <div className="flex flex-col gap-4">
        <section role="region" aria-label="Usage summary" className="rounded-xl border border-border-soft bg-surface p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-2xl font-semibold text-ink tabular-nums">{costText}</span>
            {estimated ? <Chip tone="info">estimated</Chip> : <Chip tone="ok">reported</Chip>}
          </div>
          {estimated && (
            <p className="mt-1 text-[11px] text-ink-tertiary">
              Estimated for {cost.estimatedModels.join(', ')} from public per-token prices — {cost.estimatedModels.length === 1 ? 'its logs record' : 'their logs record'} tokens, not cost.
            </p>
          )}
          {cost.unpricedModels.length > 0 && (
            <p className="mt-1 text-[11px] text-status-warn-text">Not priced: {cost.unpricedModels.join(', ')}.</p>
          )}
          <div className="mt-4 flex flex-wrap gap-x-8 gap-y-3">
            <Stat value={n(tokensOf(t))} label="tokens" />
            <Stat value={n(t.turns)} label="turns" />
          </div>
          {summary.subCards > 0 && (
            <p className="mt-3 text-[11px] text-ink-tertiary">Includes {summary.subCards} sub-card{summary.subCards === 1 ? '' : 's'}.</p>
          )}
        </section>

        {!summary.complete && (
          <p role="status" className="rounded-lg bg-status-warn-bg px-3 py-2 text-[11px] text-status-warn-text">{INCOMPLETE}</p>
        )}

        <Section title="Token mix" card>
          <div className="flex h-2.5 overflow-hidden rounded-full bg-canvas" aria-hidden="true">
            {mix.filter((m) => m.value > 0).map((m) => (
              <div key={m.kind} className={KIND_SWATCH[m.kind]} style={{ width: `${m.share * 100}%` }} />
            ))}
          </div>
          <ul className="flex flex-wrap gap-x-5 gap-y-1.5">
            {mix.map((m) => (
              <li key={m.kind} className="flex items-center gap-1.5 whitespace-nowrap">
                <span className={clsx('h-2 w-2 shrink-0 rounded-sm', KIND_SWATCH[m.kind])} aria-hidden="true" />
                <span className="text-ink-secondary">{m.label}</span>
                <span className="font-mono tabular-nums text-ink">{n(m.value)}</span>
                <span className="text-[11px] text-ink-tertiary">{Math.round(m.share * 100)}%</span>
              </li>
            ))}
          </ul>
        </Section>
      </div>

      <div className="flex flex-col gap-5">
        {subCards.length > 0 && (
          <Section title="Usage by sub-card">
            <ul className="flex flex-col gap-2.5">
              {subCards.map((c) => <BarRow key={c.id} name={c.title} total={c.total} max={subMax} />)}
            </ul>
          </Section>
        )}

        <Section title="Usage by step">
          <ul className="flex flex-col gap-2.5">
            {usedSteps.map((r, i) => (
              <BarRow
                key={`${r.step}-${i}`}
                name={<span className="font-mono">{r.step}</span>}
                marks={<>
                  {r.live && <Chip tone="info">now</Chip>}
                  {!r.complete && <Chip tone="warn">incomplete</Chip>}
                </>}
                total={r.total}
                max={stepMax}
              />
            ))}
          </ul>
          {idleSteps.length > 0 && (
            <p className="text-[11px] text-ink-tertiary">
              {idleSteps.length} step{idleSteps.length === 1 ? '' : 's'} with no usage: {idleSteps.join(', ')}
            </p>
          )}
        </Section>

        <Section title="Usage by model">
          <ul aria-label="Models" className="flex flex-col gap-2.5">
            {models.map((m) => (
              <BarRow
                key={`${m.client}-${m.model}`}
                name={<span className="font-mono" title={`${m.client} · ${m.model}`}>{m.model}</span>}
                marks={<Chip tone="muted">{m.client}</Chip>}
                total={m}
                max={modelMax}
              />
            ))}
          </ul>
        </Section>
      </div>
    </div>
    </div>
  );
}
