/**
 * The mark for each agent (CGLAB-169).
 *
 * Drawn inline, never fetched: the renderer runs under a strict CSP with no
 * external hosts, and a packaged app has no network guarantee — a remote logo
 * would be a blank square on exactly the machines this app is for.
 *
 * Claude and Gemini use the OFFICIAL brand paths from `simple-icons`, with the
 * vendors' own brand colours. Codex and Pi do not, and not by choice:
 * simple-icons has no OpenAI icon (it was removed from that set) and none for
 * pi.dev. Rather than draw an approximation of a mark people already recognise
 * — a near-miss of the OpenAI knot reads as wrong, not as a logo — those two
 * get deliberate geometric marks in the vendor's colour. Drop a real asset in
 * and they swap out.
 *
 * Every mark differs in SHAPE as well as hue. These render at 14–18px, where
 * colour is the weakest channel, and colour alone fails outright for the ~8% of
 * men with a colour vision deficiency.
 */
import React from 'react';
import { siClaude, siGooglegemini } from 'simple-icons';

interface Mark {
  readonly color: string;
  /** A filled path (official brand marks) or stroked geometry (ours). */
  readonly node: React.ReactNode;
  readonly filled: boolean;
}

const MARKS: Record<string, Mark> = {
  claude: {
    color: `#${siClaude.hex}`,
    node: <path d={siClaude.path} />,
    filled: true,
  },
  gemini: {
    color: `#${siGooglegemini.hex}`,
    node: <path d={siGooglegemini.path} />,
    filled: true,
  },
  // OpenAI's mark is absent from simple-icons. A rounded hexagon in their green
  // is honest: it reads as "the OpenAI one" in context without pretending to be
  // their logo.
  codex: {
    color: '#10A37F',
    node: <path d="M12 2.6l8.1 4.7v9.4L12 21.4l-8.1-4.7V7.3L12 2.6z" strokeWidth="1.8" strokeLinejoin="round" />,
    filled: false,
  },
  // pi.dev publishes no icon set. A triangle, because the Greek letter's
  // silhouette is too thin to read at this size.
  pi: {
    color: '#C084FC',
    node: <path d="M12 4.5L20 19H4L12 4.5z" strokeWidth="1.8" strokeLinejoin="round" />,
    filled: false,
  },
  // Not an agent: a shell prompt.
  shell: {
    color: '#7C8496',
    node: <path d="M5 7l5 5-5 5M12.5 17h6.5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />,
    filled: false,
  },
};

export interface AgentIconProps {
  readonly agentId: string;
  readonly size?: number;
}

export function AgentIcon({ agentId, size = 16 }: AgentIconProps): React.ReactElement {
  const mark = MARKS[agentId];
  if (!mark) {
    // A dot, so an agent added without a mark still lines up with the rest
    // instead of collapsing its row's layout.
    return (
      <span
        aria-hidden="true"
        data-agent-mark="fallback"
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
      fill={mark.filled ? mark.color : 'none'}
      stroke={mark.filled ? 'none' : mark.color}
      data-agent-mark={agentId}
      // Decorative: every place this appears has the agent's name in text
      // beside it, so announcing it again is noise.
      aria-hidden="true"
      className="shrink-0"
    >
      {mark.node}
    </svg>
  );
}
