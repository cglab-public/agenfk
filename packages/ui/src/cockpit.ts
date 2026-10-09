/**
 * The cockpit's gadgets, as the terminal header shows them (INFRA-425).
 *
 * The same rules as the pi cockpit this is ported from: a prod AWS profile or
 * kube context in red, an AWS session in red under ten minutes and EXPIRED
 * after, the context in red as it nears the window. Pure, so the rules are
 * tested without a terminal.
 */

export interface CockpitSnapshot {
  readonly git?: { branch: string; dirty: boolean; ahead: number; behind: number } | null;
  readonly tf?: string | null;
  /**
   * `source` is where the profile was read: what the shell reported, the
   * command in front, or the shell's START environment - which an `export`
   * since then does not change, so it is shown as uncertain.
   */
  readonly aws?: { profile: string; expires: string | null; source?: 'reported' | 'foreground' | 'shell' } | null;
  readonly k8s?: string | null;
  readonly usage?: { contextTokens: number | null; contextWindow: number | null; cost: number; costComplete: boolean } | null;
}

export type CockpitGadgetId = 'git' | 'aws' | 'k8s' | 'tf' | 'ctx' | 'cost';
export type CockpitTone = 'normal' | 'warn' | 'danger';

export interface CockpitGadget {
  readonly id: CockpitGadgetId;
  readonly text: string;
  readonly tone: CockpitTone;
  /** Shown beside the value when it may be stale, with the reason as its tooltip. */
  readonly caveat?: string;
}

export type CockpitToggles = Readonly<Record<CockpitGadgetId, boolean>>;

export const COCKPIT_GADGETS: readonly CockpitGadgetId[] = ['git', 'aws', 'k8s', 'tf', 'ctx', 'cost'];

/*
 * prod, production or prd, not glued to other LETTERS: cglab-prod, prd01,
 * eks-production and cluster/prod are red; "product" and "reproduce" are not.
 * Digits may follow (prod1, prd01). The pi cockpit's bare /prod|prd/ coloured
 * "product" too.
 */
const PROD = /(^|[^a-z])(prod(uction)?|prd)([^a-z]|$)/i;

/**
 * The shell integration that makes the AWS profile live (INFRA-425): the same
 * lines as ENV_REPORT_SNIPPET in the desktop's main/cockpit/envReport.ts, which
 * reads what they print. Repeated because the renderer bundle cannot import
 * from main; a desktop test asserts the two copies are identical.
 */
export const ENV_REPORT_SNIPPET = [
  '# AgEnFK cockpit: report the AWS profile and KUBECONFIG at each prompt (exit status kept).',
  'if [ "$TERM_PROGRAM" = agenfk ]; then',
  "  __agenfk_env() { local s=$?; printf '\\033]1337;AgenfkEnv=SESSION=%s\\037AWS_PROFILE=%s\\037KUBECONFIG=%s\\007' \"${AGENFK_SESSION:-}\" \"${AWS_PROFILE:-}\" \"${KUBECONFIG:-}\"; return $s; }",
  '  if [ -n "${ZSH_VERSION:-}" ]; then precmd_functions+=(__agenfk_env)',
  // A NEWLINE separates it from what is already there: valid after a command,
  // after a trailing `;` (PROMPT_COMMAND="history -a;") and after a newline,
  // where `;` would make `;;` and break the whole PROMPT_COMMAND.
  "  else __agenfk_nl='",
  "'; PROMPT_COMMAND=\"${PROMPT_COMMAND:+$PROMPT_COMMAND$__agenfk_nl}__agenfk_env\"; unset __agenfk_nl; fi",
  'fi',
].join('\n');

/** `1h30m`, `5m`, `45s`: the shape the pi cockpit uses. */
function shortDelta(seconds: number): string {
  if (seconds >= 3600) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return m ? `${h}h${m}m` : `${h}h`;
  }
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m`;
  return `${Math.max(0, Math.floor(seconds))}s`;
}

const tokens = (n: number): string =>
  (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

export function cockpitGadgets(snap: CockpitSnapshot, now: number, on: CockpitToggles): CockpitGadget[] {
  const out: CockpitGadget[] = [];

  if (on.git && snap.git) {
    const g = snap.git;
    const marks = [g.ahead ? `↑${g.ahead}` : '', g.behind ? `↓${g.behind}` : ''].filter(Boolean).join(' ');
    out.push({ id: 'git', text: `${g.branch}${g.dirty ? '*' : ''}${marks ? ` ${marks}` : ''}`, tone: 'normal' });
  }

  if (on.aws && snap.aws) {
    const { profile, expires, source } = snap.aws;
    const base: CockpitTone = PROD.test(profile) ? 'danger' : 'warn';
    const left = expires ? (Date.parse(expires) - now) / 1000 : NaN;
    const caveat = source === 'shell'
      ? "The shell's start environment: an export since then does not show without the shell integration in Settings."
      : undefined;
    const g = (text: string, tone: CockpitTone): CockpitGadget => ({ id: 'aws', text, tone, ...(caveat ? { caveat } : {}) });
    if (Number.isNaN(left)) out.push(g(profile, base));
    else if (left <= 0) out.push(g(`${profile} EXPIRED`, 'danger'));
    else out.push(g(`${profile} ↻${shortDelta(left)}`, left < 600 ? 'danger' : base));
  }

  if (on.k8s && snap.k8s) {
    out.push({ id: 'k8s', text: snap.k8s.replace(/^arn:aws:eks:[^:]+:\d+:cluster\//, ''), tone: PROD.test(snap.k8s) ? 'danger' : 'normal' });
  }

  if (on.tf && snap.tf) out.push({ id: 'tf', text: snap.tf, tone: PROD.test(snap.tf) ? 'danger' : 'normal' });

  const usage = snap.usage;
  if (on.ctx && usage && usage.contextTokens !== null) {
    if (usage.contextWindow) {
      const pct = Math.round((usage.contextTokens / usage.contextWindow) * 100);
      const tone: CockpitTone = pct >= 85 ? 'danger' : pct >= 60 ? 'warn' : 'normal';
      out.push({ id: 'ctx', text: `${pct}% · ${tokens(usage.contextTokens)}`, tone });
    } else {
      out.push({ id: 'ctx', text: tokens(usage.contextTokens), tone: 'normal' });
    }
  }

  if (on.cost && usage && (usage.cost > 0 || !usage.costComplete)) {
    out.push({ id: 'cost', text: `${usage.costComplete ? '' : '≥'}$${usage.cost.toFixed(2)}`, tone: 'normal' });
  }

  return out;
}
