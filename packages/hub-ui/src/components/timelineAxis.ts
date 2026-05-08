export type RangeKey = 'today' | '7d' | '30d' | '90d';
export type Bucket = 'day' | 'hour';

export function rangeToDays(key: RangeKey): number {
  switch (key) {
    case 'today': return 0;
    case '7d': return 7;
    case '30d': return 30;
    case '90d': return 90;
  }
}

function pad2(n: number) { return String(n).padStart(2, '0'); }

export function fmtBucketKey(d: Date, bucket: Bucket): string {
  const yyyy = d.getFullYear();
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  if (bucket === 'day') return `${yyyy}-${mm}-${dd}`;
  return `${yyyy}-${mm}-${dd}T${pad2(d.getHours())}:00`;
}

export function startOfLocalDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

export function effectiveBucket(range: RangeKey, bucket: Bucket): Bucket {
  return range === 'today' ? 'hour' : bucket;
}

export function fromIsoForRange(now: Date, range: RangeKey): string {
  if (range === 'today') return startOfLocalDay(now).toISOString();
  return new Date(now.getTime() - rangeToDays(range) * 86400_000).toISOString();
}

export function buildAxis(now: Date, range: RangeKey, bucket: Bucket): string[] {
  const out: string[] = [];
  if (range === 'today') {
    const d = startOfLocalDay(now);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours());
    while (d <= end) { out.push(fmtBucketKey(d, 'hour')); d.setHours(d.getHours() + 1); }
    return out;
  }
  const eff = effectiveBucket(range, bucket);
  const days = rangeToDays(range);
  const start = new Date(now.getTime() - days * 86400_000);
  if (eff === 'day') {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    while (d <= end) { out.push(fmtBucketKey(d, 'day')); d.setDate(d.getDate() + 1); }
  } else {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate(), start.getHours());
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours());
    while (d <= end) { out.push(fmtBucketKey(d, 'hour')); d.setHours(d.getHours() + 1); }
  }
  return out;
}

export function shortLabel(time: string, bucket: Bucket, _range: RangeKey): string {
  if (bucket === 'day') {
    const [, m, d] = time.split('-');
    return `${m}/${d}`;
  }
  const parts = time.split('T');
  return parts[1] ?? time;
}
