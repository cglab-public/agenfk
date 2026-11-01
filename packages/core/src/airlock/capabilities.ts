/**
 * What a tool call can do, read from its ARGUMENT KEYS — never from the tool's
 * name, so a plugin tool nobody registered is judged by what it carries.
 */
import type { Capability, SessionModel } from './types';

const COMMAND_KEYS = ['command', 'cmd', 'commands'] as const;
const PATH_KEYS = ['path', 'file_path', 'filePath', 'notebook_path'] as const;
const URL_KEYS = ['url', 'uri', 'href'] as const;
/** Keys that mean the call writes to the path it names. */
const WRITE_KEYS = ['content', 'new_string', 'old_string', 'edits', 'new_source', 'patch'] as const;

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** `xd://` paths are not on this machine; `local://x` is `x`. */
function localPath(p: string): string | null {
  if (p.startsWith('xd://')) return null;
  if (p.startsWith('local://')) return p.slice('local://'.length) || null;
  return p;
}

export function capabilitiesOf(args: Record<string, unknown>): Capability[] {
  if (!args || typeof args !== 'object') return [];
  const out: Capability[] = [];
  for (const k of COMMAND_KEYS) {
    const v = args[k];
    for (const c of Array.isArray(v) ? v : [v]) {
      if (nonEmpty(c)) out.push({ kind: 'command', command: c });
    }
  }
  const access = WRITE_KEYS.some((k) => k in args) ? 'write' : 'read';
  const paths: unknown[] = PATH_KEYS.map((k) => args[k]);
  if (Array.isArray(args.paths)) for (const p of args.paths) paths.push(p);
  for (const p of paths) {
    if (!nonEmpty(p)) continue;
    const local = localPath(p);
    if (local) out.push({ kind: 'path', path: local, access });
  }
  for (const k of URL_KEYS) {
    if (nonEmpty(args[k])) out.push({ kind: 'url', url: args[k] as string });
  }
  return out;
}

function part(v: string | null | undefined): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** pi reports `provider/model` joined, or the two parts. */
export function modelFromPi(joined: string | null, parts?: { provider?: string; model?: string }): SessionModel {
  const provider = part(parts?.provider);
  const model = part(parts?.model);
  if (model) return { provider, id: model };
  const j = part(joined);
  if (!j) return { provider, id: null };
  const slash = j.indexOf('/');
  if (slash <= 0) return { provider, id: j };
  return { provider: provider ?? j.slice(0, slash), id: j.slice(slash + 1) || null };
}

export function modelFromOpenCode(providerID?: string, modelID?: string): SessionModel {
  return { provider: part(providerID), id: part(modelID) };
}
