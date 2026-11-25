/**
 * What `agenfk airlock codex` reads of Codex's config.toml (GH-356): the model, the provider, the
 * profile and each provider's base_url and env_key. A reader for that much TOML - tables, dotted and
 * quoted table names, `key = value` with basic or literal strings and bare scalars - not a parser:
 * arrays, inline tables and multi-line strings (instructions, prompts) are skipped, and a line it
 * cannot read makes the whole file unreadable, so the launcher falls back to Codex's defaults and says so.
 */

export type TomlTables = Map<string, Map<string, string>>;

export class TomlReadError extends Error {}

/** `a.b."c.d"` -> ['a', 'b', 'c.d'] */
function tableName(raw: string, line: number): string[] {
  const parts: string[] = [];
  let i = 0;
  const s = raw.trim();
  while (i < s.length) {
    while (s[i] === ' ' || s[i] === '\t') i++;
    if (s[i] === '"' || s[i] === "'") {
      const q = s[i];
      const end = s.indexOf(q, i + 1);
      if (end < 0) throw new TomlReadError(`line ${line}: unterminated table name`);
      parts.push(s.slice(i + 1, end));
      i = end + 1;
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(s.slice(i));
      if (!m) throw new TomlReadError(`line ${line}: bad table name`);
      parts.push(m[0]);
      i += m[0].length;
    }
    while (s[i] === ' ' || s[i] === '\t') i++;
    if (i < s.length && s[i] !== '.') throw new TomlReadError(`line ${line}: bad table name`);
    i++;
  }
  return parts;
}

/** A value as a string; null for one this reader does not take (an array, an inline table). */
export function tomlScalar(raw: string, line = 0): string | null {
  const v = raw.trim();
  if (v.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"\s*(#.*)?$/.exec(v);
    if (!m) throw new TomlReadError(`line ${line}: unterminated string`);
    return m[1].replace(/\\(["\\nt])/g, (_x, c: string) => ({ n: '\n', t: '\t' }[c] ?? c));
  }
  if (v.startsWith("'")) {
    const m = /^'([^']*)'\s*(#.*)?$/.exec(v);
    if (!m) throw new TomlReadError(`line ${line}: unterminated string`);
    return m[1];
  }
  if (v.startsWith('[') || v.startsWith('{')) return null;
  const bare = v.replace(/\s*#.*$/, '');
  return bare || null;
}

/** Every table's string and scalar keys, `''` for the top level. */
export function readTomlTables(text: string): TomlTables {
  const tables: TomlTables = new Map([['', new Map()]]);
  let current = tables.get('')!;
  let skipping = 0; // depth of a multi-line array or inline table being skipped
  let inString: string | null = null; // the delimiter of a multi-line string being skipped
  const lines = text.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n].trim();
    if (inString) { if (line.includes(inString)) inString = null; continue; }
    if (skipping) { skipping += (line.match(/[[{]/g) ?? []).length - (line.match(/[\]}]/g) ?? []).length; if (skipping < 0) skipping = 0; continue; }
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[[')) {
      // An array of tables: nothing this reader needs is in one; its keys are kept out of the last table.
      current = new Map();
      continue;
    }
    if (line.startsWith('[')) {
      const end = line.lastIndexOf(']');
      if (end < 0) throw new TomlReadError(`line ${n + 1}: unterminated table header`);
      const name = tableName(line.slice(1, end), n + 1).join('.');
      current = tables.get(name) ?? new Map();
      tables.set(name, current);
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) throw new TomlReadError(`line ${n + 1}: not a key = value`);
    const key = line.slice(0, eq).trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    const raw = line.slice(eq + 1).trim();
    if (raw.startsWith('"""') || raw.startsWith("'''")) {
      // A multi-line string (Codex's instructions): skipped, to its closing delimiter.
      const delim = raw.slice(0, 3);
      if (!raw.slice(3).includes(delim)) inString = delim;
      continue;
    }
    const value = tomlScalar(raw, n + 1);
    if (value === null) {
      const open = (raw.match(/[[{]/g) ?? []).length - (raw.match(/[\]}]/g) ?? []).length;
      if (open > 0) skipping = open;
      continue;
    }
    current.set(key, value);
  }
  return tables;
}

/** The value of `-c key=value` as Codex reads it: TOML when it parses as a string, else the raw text. */
export function overrideValue(raw: string): string {
  try { return tomlScalar(raw) ?? raw; } catch { return raw; }
}
