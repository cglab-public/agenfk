import { CglabSpark } from './CglabSpark';

export function Logo({ version }: { version?: string | null }) {
  return (
    <div className="flex items-start gap-2.5">
      <span data-brand-mark className="shrink-0 mt-0.5"><CglabSpark size={32} className="drop-shadow-sm" /></span>
      <div className="leading-tight min-w-0" data-testid="logo-wordmark">
        <div className="text-body font-sans font-extrabold tracking-tight text-ink">
          Ag<span data-brand-mark className="text-brand">En</span>FK
        </div>
        <div className="eyebrow font-sans text-ink-tertiary">
          HUB &middot; BY <span data-brand-mark className="text-accent-text">CG/LAB</span>
        </div>
        {version && (
          <div
            title={`Hub version ${version}`}
            className="mt-1 inline-block px-1.5 py-0.5 rounded-md font-mono text-caption text-ink-tertiary bg-canvas border border-border-soft"
          >
            v{version}
          </div>
        )}
      </div>
    </div>
  );
}
