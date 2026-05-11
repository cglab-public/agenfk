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
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl px-5 py-4 hover:border-indigo-300 dark:hover:border-indigo-700 hover:shadow-sm transition-all">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">{label}</span>
        <span className={`w-7 h-7 rounded-lg flex items-center justify-center ${tone}`}>{icon}</span>
      </div>
      <div 
        className="mt-2 text-xl xl:text-2xl font-bold tabular-nums text-slate-900 dark:text-slate-100 truncate"
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
      <Tile label="Events"     value={totals.events}     icon={<Activity className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />}        tone="bg-indigo-50 dark:bg-indigo-900/30" />
      <Tile label="Closed"     value={totals.closed}     icon={<Inbox className="w-4 h-4 text-violet-600 dark:text-violet-400" />}           tone="bg-violet-50 dark:bg-violet-900/30" />
      <Tile label="Validate ✓" value={totals.passes}     icon={<CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />}  tone="bg-emerald-50 dark:bg-emerald-900/30" />
      <Tile label="Validate ✗" value={totals.fails}      icon={<XCircle className="w-4 h-4 text-rose-600 dark:text-rose-400" />}             tone="bg-rose-50 dark:bg-rose-900/30" />
      <Tile label="PRs"        value={totals.prsOpened}  icon={<GitPullRequest className="w-4 h-4 text-fuchsia-600 dark:text-fuchsia-400" />} tone="bg-fuchsia-50 dark:bg-fuchsia-900/30" />
    </div>
  );
}
