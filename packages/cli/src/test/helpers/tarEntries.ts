/**
 * List the member names of a .tar.gz WITHOUT shelling out to tar.
 *
 * This exists because macOS bsdtar *transparently merges AppleDouble (`._*`)
 * members back into their parent file when listing, so `tar -tzf` reports a
 * clean archive even when half its entries are resource-fork metadata. That
 * illusion is exactly how CGLAB-94 survived several releases unnoticed — any
 * test that audits an archive via `tar -t` is testing nothing on the machine
 * that actually cuts the release.
 *
 * Scope: this walks ustar headers well enough to enumerate every member name in
 * the archives we build, including the `prefix` field for long paths. It does
 * NOT reassemble PAX/GNU extended long names — a member whose name lives in a
 * preceding `x`/`L` record is reported by its (possibly truncated) ustar name,
 * and the extended-header records themselves are reported as members. That is
 * deliberate: the PaxHeader entries are something we assert the ABSENCE of.
 */
import { gunzipSync } from 'zlib';
import { readFileSync } from 'fs';

export interface TarEntry {
  name: string;
  /** ustar typeflag: '0'/'\0' file, '5' dir, 'x'/'g' PAX, 'L'/'K' GNU long name */
  typeflag: string;
}

export function listTarEntries(tgzPath: string): TarEntry[] {
  const buf = gunzipSync(readFileSync(tgzPath));
  const str = (start: number, len: number): string => {
    const field = buf.subarray(start, start + len);
    const nul = field.indexOf(0);
    return field.subarray(0, nul === -1 ? len : nul).toString('utf8');
  };
  const entries: TarEntry[] = [];
  for (let off = 0; off + 512 <= buf.length; ) {
    const name = str(off, 100);
    if (name === '') { off += 512; continue; }          // padding / end-of-archive
    const prefix = str(off + 345, 155);                 // ustar long-path prefix
    const size = parseInt(
      buf.subarray(off + 124, off + 136).toString('ascii').replace(/\0.*$/, '').trim(),
      8
    ) || 0;
    entries.push({ name: prefix ? `${prefix}/${name}` : name, typeflag: str(off + 156, 1) });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

export function tarEntryNames(tgzPath: string): string[] {
  return listTarEntries(tgzPath).map((e) => e.name);
}

/** Member names that are macOS AppleDouble resource-fork metadata. */
export function appleDoubleEntries(tgzPath: string): string[] {
  return tarEntryNames(tgzPath).filter((n) => {
    const base = n.replace(/\/$/, '').split('/').pop() || '';
    return base.startsWith('._');
  });
}
