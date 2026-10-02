import { fmtDate, fmtDateTime, parseAsUtc, utcTitle } from '../../dates';

/**
 * A timestamp shown by the hub's one rule: in the viewer's local zone, with the
 * UTC instant on hover. `format="date"` drops the time of day. Something that is
 * not a time renders as plain text rather than "Invalid Date".
 */
export function LocalTime({ value, format = 'datetime', className }: {
  value: string | number | Date;
  format?: 'date' | 'datetime';
  className?: string;
}) {
  const d = parseAsUtc(value);
  if (Number.isNaN(d.getTime())) return <span className={className}>{String(value)}</span>;
  return (
    <time dateTime={d.toISOString()} title={utcTitle(d)} className={className}>
      {format === 'date' ? fmtDate(d) : fmtDateTime(d)}
    </time>
  );
}
