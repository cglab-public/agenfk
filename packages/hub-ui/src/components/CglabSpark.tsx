/**
 * CG/lab "spark" mark — the official 4-pointed lens-flare glyph from
 * cglab.com's logo, normalized to a 164x164 viewBox.
 *
 * Sibling copy: packages/ui/src/components/CglabSpark.tsx. packages/brand
 * currently only ships CSS tokens (no build setup for a shared component
 * package), so this is intentionally duplicated rather than imported across
 * the workspace — keep both copies in sync if the mark ever changes.
 */
import { useId } from 'react';

export interface CglabSparkProps {
  size?: number;
  className?: string;
}

export function CglabSpark({ size = 32, className = '' }: CglabSparkProps) {
  // useId() can contain colons; strip them so the id is safe to reference
  // via `url(#...)` in every environment (and to query in tests).
  const gradientId = `cglab-spark-${useId().replace(/:/g, '')}`;

  return (
    <svg
      viewBox="0 0 164 164"
      width={size}
      height={size}
      aria-hidden="true"
      className={className}
    >
      <defs>
        <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0" stopColor="#7fe5ca" />
          <stop offset=".45" stopColor="#04cc98" />
          <stop offset=".8" stopColor="#056f71" />
          <stop offset="1" stopColor="#081049" />
        </linearGradient>
      </defs>
      <path
        fill="none"
        stroke={`url(#${gradientId})`}
        strokeWidth={20}
        strokeMiterlimit={10}
        d="M17.97,11.04h0c38.1,27.93,89.92,27.93,128.02,0h0c4.7-3.45,10.58,2.42,7.13,7.13h0c-27.93,38.1-27.93,89.92,0,128.02h0c3.45,4.7-2.42,10.58-7.13,7.13h0c-38.1-27.93-89.92-27.93-128.02,0h0c-4.7,3.45-10.58-2.42-7.13-7.13h0c27.93-38.1,27.93-89.92,0-128.02h0c-3.45-4.7,2.42-10.58,7.13-7.13Z"
      />
    </svg>
  );
}
