/**
 * What an audit row's before -> after shows (STORY a89af514): the fields that
 * changed, each by its path ("google.clientId", "steps[0].label"), with its
 * value on both sides. A field that appeared has no before; one that went has
 * no after. A creation (before null) lists every field arriving; a deletion
 * every field going.
 */
export interface AuditChange { path: string; before: unknown; after: unknown }

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function auditDiff(before: unknown, after: unknown): AuditChange[] {
  const out: AuditChange[] = [];
  const walk = (b: unknown, a: unknown, path: string) => {
    if (Array.isArray(b) && Array.isArray(a)) {
      for (let i = 0; i < Math.max(b.length, a.length); i++) walk(i < b.length ? b[i] : undefined, i < a.length ? a[i] : undefined, `${path}[${i}]`);
      return;
    }
    const bo = isObject(b), ao = isObject(a);
    if (bo || ao) {
      // Nothing on one side: every field of the other arrives, or goes.
      if ((bo || b === null || b === undefined) && (ao || a === null || a === undefined)) {
        const bb = bo ? b : {}, aa = ao ? a : {};
        for (const k of [...new Set([...Object.keys(bb), ...Object.keys(aa)])]) walk(bb[k], aa[k], path ? `${path}.${k}` : k);
        return;
      }
    }
    if (JSON.stringify(b) !== JSON.stringify(a)) out.push({ path, before: b, after: a });
  };
  if ((before === null || before === undefined) && (after === null || after === undefined)) return [];
  walk(before ?? undefined, after ?? undefined, '');
  return out;
}
