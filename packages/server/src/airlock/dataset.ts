/**
 * DS-1 (story 263d328e; user decisions 2026-10-28): the Airlock dataset, as this
 * installation sends it. While the hub's switch is on (hub/airlockSync.ts
 * airlockDatasetEnabled), every tool call Airlock judges and every proxy decision
 * becomes a FULL row - the tool's arguments (a write's content included), each
 * capability whole, the verdict and mode, the card it was for, the policy revision,
 * the hosts it reached and the session's last few calls - sent through the hub
 * outbox as `airlock.dataset`. The hub keeps it in its own bounded table (DS-2).
 *
 * Nothing leaves with a secret in it: every string is redacted before the row is
 * built (a command shell-aware, other text by the stages that do not reparse it,
 * then the known secret formats and this machine's secret env values), and a
 * value under a secret-looking key is dropped whole. The session is named by a
 * hash: the local session id stays on this machine, as it does in the decision
 * log. A row is cut to fit what the hub keeps, and says so.
 *
 * A person's grant or deny of an approval is sent as a label joined to every row
 * that asked for it (`airlock.dataset-label`). Learning accepts are a hub admin's
 * on a joined installation, so the hub labels those itself.
 */
import { createHash, randomUUID } from 'node:crypto';
import { hasCredentialKey, hostsOfCapabilities, type Capability } from '@agenfk/core';

/** What the hub keeps of one row (DS-2 AIRLOCK_DATASET_LIMITS.maxRowBytes). */
export const AIRLOCK_DATASET_MAX_ROW_BYTES = 64 * 1024;
/** Earlier calls of the same session a row carries (for script-then-run). */
export const AIRLOCK_DATASET_RECENT = 5;
/** Calls one import request may carry (DS-3); the CLI batches below it. */
export const AIRLOCK_DATASET_IMPORT_MAX_CALLS = 500;
const MAX_SESSIONS = 200;
const MAX_APPROVAL_KEYS = 1000;
const MAX_ROWS_PER_KEY = 20;
const MAX_DEPTH = 6;
const MAX_ITEMS = 200;
/** Capabilities and hosts a row carries; past it, the row says it was cut. */
const MAX_LIST = 50;
/** Each step cuts every string to this, until the row fits. */
const CUTS = [16 * 1024, 4 * 1024, 1024, 256];
/** A key naming a credential, read without case or separators (X-Api-Key, accessToken, client_secret, Authorization, pass, passphrase). Over-redaction is the accepted failure. */
const SECRET_KEY = /auth|token|secret|pass|pwd|apikey|credential|cookie|privatekey|accesskey|session(?:key|id|token|secret)|signature/;
const isSecretKey = (key: string): boolean => SECRET_KEY.test(key.toLowerCase().replace(/[^a-z0-9]/g, ''));
/** Text left out of a row because it holds a credential-named key: its size only (a hash of a short secret could be guessed back). */
const omitted = (v: string): { omitted: string; bytes: number } => ({ omitted: 'holds a credential-named key', bytes: Buffer.byteLength(v, 'utf8') });
const OMITTED_TEXT = '[OMITTED: holds a credential-named key]';
/** Keys whose values are shell commands (pi's bash `command`, OpenCode's, scripts). */
const COMMAND_KEYS = new Set(['command', 'cmd', 'commands', 'script']);

export interface DatasetDeps {
  /** The hub's switch, now. Off: nothing is built or sent. */
  enabled: () => boolean;
  /** Changes when the hub configuration does: the sessions and approvals remembered under another are forgotten. */
  scope?: () => unknown;
  /** Hands an event to the hub's outbox; answering false says the outbox did not take it. */
  send: (event: { type: 'airlock.dataset' | 'airlock.dataset-label'; payload: Record<string, unknown> }) => unknown;
  /** A shell command with its secrets removed, whole (no excerpt). */
  redactCommand: (text: string) => string;
  /** Any other text with its secrets removed, its layout kept. */
  redactText: (text: string) => string;
  /**
   * Where a row that asked for an approval is linked to it until a person answers
   * (BUG 9ff092e9): the store, so a restart does not lose it. `rows` reads the
   * linked rows; `drop` removes the links, once their labels are sent - a crash in
   * between sends a label again, never loses one. Absent: kept in memory, as before.
   */
  approvalLinks?: {
    add: (approvalKey: string, rowId: string) => unknown;
    rows: (approvalKey: string) => Promise<string[]> | string[];
    drop: (approvalKey: string) => unknown;
    /** The person's decision, kept on the links before any label is sent. */
    mark: (approvalKey: string, decision: 'grant' | 'deny') => unknown;
    /** Answered links whose labels were not all sent. */
    answered: () => Promise<Array<{ key: string; rowId: string; decision: string }>> | Array<{ key: string; rowId: string; decision: string }>;
  };
}

export interface ToolCallRow {
  client: string;
  model: string | null;
  sessionId: string | null;
  tool: string;
  args: unknown;
  capabilities: Capability[];
  verdict: { decision: string; rule?: string | null; why?: string };
  mode: string;
  revision: number;
  card: { itemId: string; title: string | null; description: string | null; step: string | null } | null;
  /** A needs-human-approval request's key and generation (`key#generation`): the label for a person's answer joins this row. */
  approvalKey?: string;
}

/** A tool call of a past session (DS-3), judged under the current policy by the caller. */
export interface ImportedCall {
  client: string;
  model: string | null;
  sessionId: string;
  callId: string;
  tool: string;
  args: unknown;
  at: string;
  capabilities: Capability[];
  verdict: { decision: string; rule?: string | null; why?: string };
  mode: string;
  revision: number;
  card: ToolCallRow['card'];
}

/** The same call of the same session always has the same row id, so importing it again adds nothing. */
export const importedRowId = (client: string, sessionId: string, callId: string): string =>
  createHash('sha256').update(`airlock-import:${client}:${sessionId}:${callId}`).digest('hex').slice(0, 32);

export interface ProxyRow {
  client: string;
  model: string | null;
  sessionId: string | null;
  host: string;
  port: number | null;
  decision: string;
  rule: string;
  mode: string;
  revision: number;
  card: ToolCallRow['card'];
}

type Summary = { tool: string; capabilities: Array<{ kind: string; value: string }>; decision: string };

const sessionHash = (sessionId: string | null): string | null =>
  sessionId ? createHash('sha256').update(`airlock-session:${sessionId}`).digest('hex').slice(0, 16) : null;

/** A bounded map that forgets the oldest entry first. */
function remember<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value as string);
}

export function airlockDataset(deps: DatasetDeps) {
  const sessions = new Map<string, Summary[]>();
  const byApprovalKey = new Map<string, string[]>();
  /** A label, queued - or thrown, so its link stays: `send` answering false means the outbox did not take it. */
  const sendLabel = async (payload: Record<string, unknown>): Promise<void> => {
    if ((await deps.send({ type: 'airlock.dataset-label', payload })) === false) {
      throw new Error('the hub outbox did not take an Airlock dataset label');
    }
  };
  let scope: unknown = deps.scope?.();
  /** A new hub configuration: nothing remembered under the last one goes to the next. */
  const rescope = (): void => {
    const now = deps.scope?.();
    if (now === scope) return;
    scope = now;
    sessions.clear();
    byApprovalKey.clear();
  };

  /**
   * Every string redacted (a `command` shell-aware), keys too; a secret-named key's
   * value dropped whole, whatever its type; depth and breadth bounded, and a cut
   * recorded in `cut.truncated`.
   */
  const clean = (v: unknown, cut: { truncated: boolean }, key = '', depth = 0): unknown => {
    if (key && isSecretKey(key) && v !== null && v !== undefined) return '[REDACTED]';
    if (typeof v === 'string') {
      const command = COMMAND_KEYS.has(key.toLowerCase());
      // Content holding a credential-named key is left out whole, its size kept (user decision
      // 2026-10-28): no redactor follows every file syntax. A command too - one line can write a
      // credential document (printf '{"tokens":[...]}' > f) as well as a heredoc can.
      if (hasCredentialKey(v)) return omitted(v);
      return command ? deps.redactCommand(v) : deps.redactText(v);
    }
    if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
    if (depth >= MAX_DEPTH) { cut.truncated = true; return '[…]'; }
    if (Array.isArray(v)) {
      if (v.length > MAX_ITEMS) cut.truncated = true;
      return v.slice(0, MAX_ITEMS).map(x => clean(x, cut, key, depth + 1));
    }
    if (typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>);
      if (entries.length > MAX_ITEMS) cut.truncated = true;
      const out: Record<string, unknown> = {};
      for (const [k, x] of entries.slice(0, MAX_ITEMS)) out[deps.redactText(k)] = clean(x, cut, k, depth + 1);
      return out;
    }
    return null;
  };

  /** A list cut to MAX_LIST, recorded. */
  const bounded = <T,>(list: T[], cut: { truncated: boolean }): T[] => {
    if (list.length > MAX_LIST) cut.truncated = true;
    return list.slice(0, MAX_LIST);
  };

  const capabilityOf = (c: Capability): { kind: string; value: string; access?: 'read' | 'write' } =>
    c.kind === 'command' ? { kind: 'command', value: hasCredentialKey(c.command) ? OMITTED_TEXT : deps.redactCommand(c.command) }
      : c.kind === 'path' ? { kind: 'path', value: deps.redactText(c.path), access: c.access }
        : { kind: 'url', value: deps.redactText(c.url) };

  /** Every string cut to `max`, in place of a copy. */
  const cutStrings = (v: unknown, max: number): unknown => {
    if (typeof v === 'string') return v.length > max ? `${v.slice(0, max)}…` : v;
    if (Array.isArray(v)) return v.map(x => cutStrings(x, max));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cutStrings(x, max)]));
    return v;
  };

  const fits = (row: Record<string, unknown>) => Buffer.byteLength(JSON.stringify(row), 'utf8') <= AIRLOCK_DATASET_MAX_ROW_BYTES;

  /** The row as it may be sent: cut step by step until it fits, `truncated` when anything was. */
  const fitted = (row: Record<string, unknown>): Record<string, unknown> => {
    if (fits(row)) return row;
    for (const max of CUTS) {
      const cut = { ...(cutStrings(row, max) as Record<string, unknown>), rowId: row.rowId, truncated: true };
      if (fits(cut)) return cut;
    }
    // Still too large: the arguments, the window and the lists go. What is left is a few
    // fields of bounded depth and breadth, every string at most 256: it fits.
    return { ...(cutStrings({ ...row, args: '[…]', recent: [], capabilities: [], hosts: [] }, 256) as Record<string, unknown>), rowId: row.rowId, truncated: true };
  };

  const send = (session: string | null, base: Record<string, unknown>, summary: Summary, rowId: string = randomUUID()): string => {
    const recent = session ? sessions.get(session) ?? [] : [];
    // The window is trimmed as it is stored: at most AIRLOCK_DATASET_RECENT.
    const row = fitted({ rowId, ...base, session, recent });
    deps.send({ type: 'airlock.dataset', payload: row });
    if (session) remember(sessions, session, [...recent, summary].slice(-AIRLOCK_DATASET_RECENT), MAX_SESSIONS);
    return rowId;
  };

  return {
    /** A judged tool call; null when the switch is off (nothing is built). */
    tool(r: ToolCallRow): string | null {
      rescope();
      if (!deps.enabled()) return null;
      const cut = { truncated: false };
      const capabilities = bounded(r.capabilities, cut).map(capabilityOf);
      const tool = deps.redactText(r.tool);
      const session = sessionHash(r.sessionId);
      const rowId = send(session, {
        source: 'tool',
        client: deps.redactText(r.client),
        model: r.model === null ? null : deps.redactText(r.model),
        tool,
        args: clean(r.args, cut),
        capabilities,
        hosts: bounded(hostsOfCapabilities(r.capabilities), cut).map(deps.redactText),
        verdict: clean(r.verdict, cut),
        mode: r.mode,
        revision: r.revision,
        card: r.card && (clean(r.card, cut) as ToolCallRow['card']),
        ...(cut.truncated ? { truncated: true } : {}),
      }, { tool, capabilities: capabilities.map(c => ({ kind: c.kind, value: c.value.slice(0, 512) })), decision: r.verdict.decision });
      if (r.approvalKey && deps.approvalLinks) {
        const key = r.approvalKey;
        // A link that cannot be kept costs that row's label, never the call.
        Promise.resolve().then(() => deps.approvalLinks!.add(key, rowId))
          .catch((e) => console.warn('[AIRLOCK] could not keep a dataset row\'s approval link: %s', (e as Error)?.message ?? e));
      } else if (r.approvalKey) {
        const rows = byApprovalKey.get(r.approvalKey) ?? [];
        remember(byApprovalKey, r.approvalKey, [...rows, rowId].slice(-MAX_ROWS_PER_KEY), MAX_APPROVAL_KEYS);
      }
      return rowId;
    },

    /**
     * A call of a past session (DS-3): built like a live row, marked imported, with its
     * own time and a row id derived from the call. The window is that session's earlier
     * imported calls (kept apart from live sessions). Null when the switch is off.
     */
    imported(r: ImportedCall): string | null {
      rescope();
      if (!deps.enabled()) return null;
      const cut = { truncated: false };
      const capabilities = bounded(r.capabilities, cut).map(capabilityOf);
      const tool = deps.redactText(r.tool);
      const session = sessionHash(`import:${r.client}:${r.sessionId}`);
      return send(session, {
        source: 'import',
        imported: true,
        at: r.at,
        client: deps.redactText(r.client),
        model: r.model === null ? null : deps.redactText(r.model),
        tool,
        args: clean(r.args, cut),
        capabilities,
        hosts: bounded(hostsOfCapabilities(r.capabilities), cut).map(deps.redactText),
        verdict: clean(r.verdict, cut),
        mode: r.mode,
        revision: r.revision,
        card: r.card && (clean(r.card, cut) as ToolCallRow['card']),
        ...(cut.truncated ? { truncated: true } : {}),
      }, { tool, capabilities: capabilities.map(c => ({ kind: c.kind, value: c.value.slice(0, 512) })), decision: r.verdict.decision },
      importedRowId(r.client, r.sessionId, r.callId));
    },

    /** A decision of the sandbox proxy; null when the switch is off. */
    proxy(r: ProxyRow): string | null {
      rescope();
      if (!deps.enabled()) return null;
      const target = deps.redactText(r.port === null ? r.host : `${r.host}:${r.port}`);
      const cut = { truncated: false };
      return send(sessionHash(r.sessionId), {
        source: 'proxy',
        client: deps.redactText(r.client),
        model: r.model === null ? null : deps.redactText(r.model),
        tool: 'proxy',
        args: null,
        capabilities: [{ kind: 'url', value: target }],
        hosts: [deps.redactText(r.host)],
        verdict: { decision: r.decision, rule: deps.redactText(r.rule) },
        mode: r.mode,
        revision: r.revision,
        card: r.card && (clean(r.card, cut) as ToolCallRow['card']),
        ...(cut.truncated ? { truncated: true } : {}),
      }, { tool: 'proxy', capabilities: [{ kind: 'url', value: target }], decision: r.decision });
    },

    /** A person's answer to an approval: a label on every row that asked for it. */
    async answered(approvalKey: string, decision: 'grant' | 'deny'): Promise<void> {
      rescope();
      // The decision first: if the labels below are not all sent, replayAnswered sends them.
      if (deps.approvalLinks && deps.enabled()) await deps.approvalLinks.mark(approvalKey, decision);
      // Answered: these rows are done with. A later request under the same key is new rows.
      const rows = deps.approvalLinks ? await deps.approvalLinks.rows(approvalKey) : byApprovalKey.get(approvalKey) ?? [];
      byApprovalKey.delete(approvalKey);
      if (deps.enabled()) {
        for (const rowId of rows) await sendLabel({ rowId, label: { kind: 'approval', decision } });
      }
      if (deps.approvalLinks) await deps.approvalLinks.drop(approvalKey);
    },

    /**
     * Labels of answers that were not all sent - the server stopped, or a send failed -
     * sent now, then their links dropped (BUG 9ff092e9 review). Kept while the switch is off.
     */
    async replayAnswered(): Promise<void> {
      rescope();
      if (!deps.approvalLinks || !deps.enabled()) return;
      const pending = await deps.approvalLinks.answered();
      const keys = [...new Set(pending.map(p => p.key))];
      for (const key of keys) {
        for (const p of pending.filter(x => x.key === key)) {
          if (p.decision !== 'grant' && p.decision !== 'deny') continue;
          await sendLabel({ rowId: p.rowId, label: { kind: 'approval', decision: p.decision } });
        }
        await deps.approvalLinks.drop(key);
      }
    },
  };
}
