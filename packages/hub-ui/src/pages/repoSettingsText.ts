// Words for the Repositories page (RFC-002). Every state is said in words, not
// colour alone, and every time in UTC: a receipt is evidence an admin compares
// with CI logs, which are in UTC too.

export type ReceiptsMode = 'off' | 'shadow' | 'enforce';

/** Who may produce receipts (RFC-002 Amendment 1): the list, or every live installation. */
export type ProducerMode = 'listed' | 'all';

export interface RepoView {
  remoteUrl: string;
  verifyCommand: string;
  revision: number;
  receiptsMode: ReceiptsMode;
  shadowThreshold: number | null;
  /** Absent from a hub older than the mode: that hub only has the list. */
  producerMode?: ProducerMode;
  producers: string[];
  createdAt: string;
  updatedAt: string;
  lastReceiptAt?: string | null;
}

export interface RevisionView {
  revision: number;
  verifyCommand: string;
  source: 'init' | 'admin';
  actorEmail: string | null;
  installationId: string | null;
  createdAt: string;
}

export interface ReceiptView {
  id: string;
  kind: 'verification' | 'review';
  cardId: string | null;
  cardTitle: string | null;
  contentTree: string | null;
  commit: string | null;
  commandRevision: number | null;
  reusable: boolean;
  notReusableReason: string | null;
  installationId: string;
  /** Is the producer on the allowlist NOW? `reusable` was decided when the receipt arrived. */
  producerAllowed?: boolean;
  receivedAt: string;
  lenses?: string[];
}

export const MODE_LABEL: Record<ReceiptsMode, string> = { off: 'Off', shadow: 'Shadow', enforce: 'Enforce' };

export const MODE_HELP: Record<ReceiptsMode, string> = {
  off: 'Nothing changes: cards close as today and CI runs every step.',
  shadow: 'Root cards publish receipts; CI checks them but still runs every step, and says whether it would have reused one.',
  enforce: 'CI skips the steps a matching receipt covers.',
};

/** The mode a repository is on; a hub that sends none is on the list. */
export const producerModeOf = (r: Pick<RepoView, 'producerMode'>): ProducerMode =>
  r.producerMode === 'all' ? 'all' : 'listed';

export const PRODUCER_MODE_LABEL: Record<ProducerMode, string> = {
  all: 'All joined installations',
  listed: 'Only these installations',
};

export const PRODUCER_MODE_HELP: Record<ProducerMode, string> = {
  all: 'Every installation in the organization that is not retired, including ones that join later. Retiring one stops its receipts counting.',
  listed: 'Only the installations listed below.',
};

/** The trust trade-off of "all", in one line. */
export const PRODUCER_ALL_TRADE_OFF =
  'Under All, any machine that joins the organization can produce a receipt that lets CI skip a job in Enforce. Use it only where joining the hub already requires a managed machine.';

const REASON_WORDS: Record<string, string> = {
  producer_removed: 'the machine is no longer an allowed producer',
  producer_not_allowed: 'the machine is not an allowed producer',
  report_over_cap: 'the report is bigger than the hub keeps',
  not_reusable_by_producer: 'the machine that sent it did not offer it for reuse',
};

/** Why a receipt cannot be reused, in words; an unknown code is shown as it is. */
export const notReusableWords = (reason: string | null): string =>
  reason ? (REASON_WORDS[reason] ?? reason.replace(/_/g, ' ')) : 'no reason recorded';

/** `2026-06-03 10:15 UTC`, or the input as given when it is not a time. */
export function utc(ts: string | null | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

/** Who made a command revision, in words. */
export const revisionAuthor = (r: RevisionView): string =>
  r.source === 'init'
    ? `Initialized by installation ${r.installationId ?? 'unknown'}`
    : `Revised by ${r.actorEmail ?? 'an admin'}`;

export const repoQuery = (repo: string) => `repo=${encodeURIComponent(repo)}`;

/**
 * Whether CI would reuse a receipt today, and if not why: the hub's verdict
 * when it arrived, then the allowlist as it stands now.
 */
export function receiptStanding(r: ReceiptView): { reusable: boolean; reason: string | null } {
  if (!r.reusable) return { reusable: false, reason: r.notReusableReason };
  if (r.producerAllowed === false) return { reusable: false, reason: 'producer_removed' };
  return { reusable: true, reason: null };
}
