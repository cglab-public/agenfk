import { CglabSpark } from './CglabSpark';

export function Logo({ version }: { version?: string | null }) {
  return (
    <div className="flex items-start gap-2.5">
      <CglabSpark size={32} className="drop-shadow-sm shrink-0 mt-0.5" />
      <div className="leading-tight min-w-0" data-testid="logo-wordmark">
        <div className="text-sm font-sans font-extrabold tracking-tight text-ink">
          Ag<span className="text-brand">En</span>FK
        </div>
        <div className="text-[10px] font-sans font-semibold uppercase tracking-[0.18em] text-ink-tertiary">
          HUB &middot; BY <span className="text-accent-text">CG/LAB</span>
        </div>
        {version && (
          <div
            title={`Hub version ${version}`}
            className="mt-1 inline-block px-1.5 py-0.5 rounded-md font-mono text-[9px] text-ink-tertiary bg-chip border border-border-soft"
          >
            v{version}
          </div>
        )}
      </div>
    </div>
  );
}
