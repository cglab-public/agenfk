import { Activity, CheckCircle2, XCircle, Inbox, GitPullRequest } from 'lucide-react';

export interface MetricsTotals {
  events: number;
  closed: number;
  passes: number;
  fails: number;
  prsOpened: number;
}

function Tile({ label, value, icon, tone }: { label: string; value: number; icon: React.ReactNode; tone: string }) {
  return (
    <div className="bg-card-glass backdrop-blur border border-border-soft rounded-xl px-5 py-4 hover:border-border-brand hover:shadow-glow transition-all">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-tertiary">{label}</span>
        <span className={`w-7 h-7 rounded-lg flex items-center justify-center ${tone}`}>{icon}</span>
      </div>
      <div
        className="mt-2 text-xl xl:text-2xl font-extrabold tabular-nums text-ink truncate"
        title={value.toLocaleString()}
      >
        {value.toLocaleString()}
      </div>
    </div>
  );
}

export function MetricsTilesRow({ totals }: { totals: MetricsTotals }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
      <Tile label="Events"     value={totals.events}     icon={<Activity className="w-4 h-4 text-brand" />}        tone="bg-chip" />
      <Tile label="Closed"     value={totals.closed}     icon={<Inbox className="w-4 h-4 text-accent-text" />}     tone="bg-chip" />
      <Tile label="Validate ✓" value={totals.passes}     icon={<CheckCircle2 className="w-4 h-4 text-brand" />}    tone="bg-chip" />
      <Tile label="Validate ✗" value={totals.fails}      icon={<XCircle className="w-4 h-4 text-danger-muted" />}  tone="bg-danger-muted/10" />
      <Tile label="PRs"        value={totals.prsOpened}  icon={<GitPullRequest className="w-4 h-4 text-accent-text" />} tone="bg-chip" />
    </div>
  );
}
