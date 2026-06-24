/**
 * Minimal TOON (Token-Oriented Object Notation) encoder.
 *
 * TOON is a compact, indentation-based serialization that trims the repeated
 * keys JSON spends tokens on. Its headline feature is the *tabular* form for
 * arrays of uniform scalar objects:
 *
 *   users[2]{id,name,role}:
 *     1,Alice,admin
 *     2,Bob,user
 *
 * This encoder covers the shapes the AgEnFK CLI emits (items, projects, flows,
 * token events): scalars, nested objects, arrays of primitives, tabular arrays
 * of uniform scalar objects, and a YAML-ish list fallback for everything else.
 * It is self-contained (no runtime dependency) and deterministic.
 */

const INDENT = '  ';

type Scalar = string | number | boolean | null;

function isScalar(v: unknown): v is Scalar {
  return v === null || v === undefined || ['string', 'number', 'boolean'].includes(typeof v);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function needsQuote(s: string): boolean {
  if (s === '') return true;
  if (/[,:\n"]/.test(s)) return true;          // delimiters / structural chars
  if (s !== s.trim()) return true;             // leading/trailing whitespace
  if (/^(true|false|null)$/.test(s)) return true; // boolean/null ambiguity
  if (/^-?\d+(\.\d+)?$/.test(s)) return true;  // numeric ambiguity
  if (/^[[{]/.test(s) || s.startsWith('- ')) return true; // structural prefixes
  return false;
}

function scalarToToon(v: Scalar | undefined): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null';
  return needsQuote(v) ? JSON.stringify(v) : v;
}

/** A field name is table-safe only if it round-trips without quoting. */
function keyNeedsQuote(k: string): boolean {
  return needsQuote(k);
}

function isUniformScalarObjectArray(arr: unknown[]): arr is Record<string, Scalar>[] {
  if (!arr.every(isPlainObject)) return false;
  const keys = Object.keys(arr[0] as Record<string, unknown>);
  if (keys.length === 0) return false;
  // Keys must be table-safe (no delimiters) or the header/rows become ambiguous.
  if (keys.some(keyNeedsQuote)) return false;
  return arr.every((o) => {
    const obj = o as Record<string, unknown>;
    const ks = Object.keys(obj);
    return ks.length === keys.length && keys.every((k) => k in obj && isScalar(obj[k]));
  });
}

/** Encode an array. `key` is null for a top-level / list-item array. */
function encodeArray(key: string | null, arr: unknown[], indent: number): string[] {
  const pad = INDENT.repeat(indent);
  const prefix = key === null ? '' : key;
  const n = arr.length;

  if (n === 0) return [`${pad}${prefix}[0]:`];

  if (arr.every(isScalar)) {
    return [`${pad}${prefix}[${n}]: ${arr.map(scalarToToon).join(',')}`];
  }

  if (isUniformScalarObjectArray(arr)) {
    const keys = Object.keys(arr[0]);
    const lines = [`${pad}${prefix}[${n}]{${keys.join(',')}}:`];
    const rowPad = INDENT.repeat(indent + 1);
    for (const row of arr) {
      lines.push(`${rowPad}${keys.map((k) => scalarToToon(row[k])).join(',')}`);
    }
    return lines;
  }

  // Fallback: YAML-ish list, one `- ` per element, nested recursively.
  const lines = [`${pad}${prefix}[${n}]:`];
  const itemPad = INDENT.repeat(indent + 1);
  for (const el of arr) {
    const block = encodeBlock(el, 0);
    lines.push(`${itemPad}- ${block[0]}`);
    for (let i = 1; i < block.length; i++) {
      lines.push(`${itemPad}${INDENT}${block[i]}`);
    }
  }
  return lines;
}

function encodeKeyValue(key: string, value: unknown, indent: number): string[] {
  const pad = INDENT.repeat(indent);
  if (isScalar(value)) return [`${pad}${key}: ${scalarToToon(value as Scalar)}`];
  if (Array.isArray(value)) return encodeArray(key, value, indent);
  // object
  const obj = value as Record<string, unknown>;
  const entries = Object.keys(obj);
  if (entries.length === 0) return [`${pad}${key}:`];
  const lines = [`${pad}${key}:`];
  for (const k of entries) lines.push(...encodeKeyValue(k, obj[k], indent + 1));
  return lines;
}

/** Encode any value as a standalone block of lines at the given indent. */
function encodeBlock(value: unknown, indent: number): string[] {
  const pad = INDENT.repeat(indent);
  if (isScalar(value)) return [`${pad}${scalarToToon(value as Scalar)}`];
  if (Array.isArray(value)) return encodeArray(null, value, indent);
  const obj = value as Record<string, unknown>;
  const lines: string[] = [];
  for (const k of Object.keys(obj)) lines.push(...encodeKeyValue(k, obj[k], indent));
  return lines;
}

/** Encode a JSON-compatible value into a TOON string (no trailing newline). */
export function toonEncode(value: unknown): string {
  return encodeBlock(value, 0).join('\n');
}
