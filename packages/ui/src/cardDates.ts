// When a card was created and last touched, as the board shows them: a
// compact form on the card face, and the full local timestamp for hover and
// the detail modal. `locale` defaults to the viewer's own.

const parse = (iso: string | Date | undefined): Date | null => {
  if (iso === undefined || iso === null) return null;
  const d = iso instanceof Date ? iso : new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** "12 Sep" (or "Sep 12", by locale); the year only when it isn't this year. */
export function cardShortDate(iso: string | Date | undefined, now: Date = new Date(), locale?: string): string {
  const d = parse(iso);
  if (!d) return '';
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(locale, opts);
}

/** "just now", "5m ago", "2h ago", "3d ago"; past 30 days, the short date. */
export function cardAgo(iso: string | Date | undefined, now: Date = new Date(), locale?: string): string {
  const d = parse(iso);
  if (!d) return '';
  const secs = Math.max(0, (now.getTime() - d.getTime()) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return cardShortDate(d, now, locale);
}

/** The full local date and time. */
export function cardFullTimestamp(iso: string | Date | undefined, locale?: string): string {
  const d = parse(iso);
  return d ? d.toLocaleString(locale) : '';
}
