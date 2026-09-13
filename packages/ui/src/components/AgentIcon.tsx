/**
 * A mark per agent (CGLAB-169).
 *
 * Drawn inline rather than fetched. The renderer runs under a strict CSP with
 * no external hosts, and a packaged app has no network guarantee at all — a
 * remote logo would be a blank square on exactly the machines this app is for.
 *
 * These are simple geometric marks, not the vendors' trademarks: shipping
 * someone's brand asset inside a third-party app is a licensing question, and a
 * distinguishable glyph is all the picker actually needs. Each is a different
 * SHAPE, not just a different colour — colour alone fails for the ~8% of men
 * with a colour vision deficiency, and these sit at 13px where hue is weakest.
 */
import React from 'react';

export interface AgentIconProps {
  readonly agentId: string;
  readonly size?: number;
}

/** Shape plus hue, so the two are redundant rather than the colour load-bearing. */
const MARKS: Record<string, { color: string; path: React.ReactNode }> = {
  // Asterisk — many-rayed, like a starburst.
  claude: {
    color: '#D97757',
    path: <path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4" strokeWidth="2" strokeLinecap="round" />,
  },
  // Ring.
  codex: {
    color: '#10A37F',
    path: <circle cx="12" cy="12" r="7.5" strokeWidth="2" />,
  },
  // Four-pointed spark.
  gemini: {
    color: '#4285F4',
    path: <path d="M12 3c0 5 4 9 9 9-5 0-9 4-9 9 0-5-4-9-9-9 5 0 9-4 9-9z" strokeWidth="1.6" strokeLinejoin="round" />,
  },
  // Triangle.
  pi: {
    color: '#C084FC',
    path: <path d="M12 4.5L20 19H4L12 4.5z" strokeWidth="2" strokeLinejoin="round" />,
  },
  // Chevron prompt — a shell, not an agent.
  shell: {
    color: '#7C8496',
    path: <path d="M5 7l5 5-5 5M12.5 17h6.5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />,
  },
};

export function AgentIcon({ agentId, size = 14 }: AgentIconProps): React.ReactElement {
  const mark = MARKS[agentId];
  if (!mark) {
    // A dot, so an agent added without a mark still lines up in the list
    // instead of collapsing the row's layout.
    return (
      <span
        aria-hidden="true"
        className="inline-block shrink-0 rounded-full bg-ink-tertiary"
        style={{ width: size * 0.5, height: size * 0.5 }}
      />
    );
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={mark.color}
      // Decorative: every place this appears already has the agent's name in
      // text beside it, so announcing it again is noise.
      aria-hidden="true"
      className="shrink-0"
    >
      {mark.path}
    </svg>
  );
}
