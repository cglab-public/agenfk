import React from 'react';
import { CglabSpark } from './CglabSpark';

interface LogoProps {
  size?: number;
  className?: string;
}

export const Logo: React.FC<LogoProps> = ({ size = 32, className = '' }) => {
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <CglabSpark size={size} className="shrink-0 drop-shadow-sm" />
      <div className="leading-tight min-w-0" data-testid="logo-wordmark">
        <div
          className="font-sans font-extrabold tracking-tight text-ink"
          style={{ fontSize: Math.max(14, Math.round(size * 0.5)) }}
        >
          Ag<span className="text-brand">En</span>FK
        </div>
        <div className="text-[9px] font-sans font-semibold uppercase tracking-[0.18em] text-ink-tertiary">
          BY <span className="text-accent-text">CG/LAB</span>
        </div>
      </div>
    </div>
  );
};
