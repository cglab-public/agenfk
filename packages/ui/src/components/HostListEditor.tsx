/**
 * An Airlock host list, edited as a list (user request 2026-11-02): one row per
 * host with a Download and an Upload box, a remove button, and a field that
 * adds what is typed (Enter) or pasted (every line). A row keeps at least one
 * direction. On the deny side the boxes say which way the host is blocked.
 *
 * The value stays the lines the policy is saved from (airlockHostText.ts:
 * "download"/"upload" after a one-way entry), so the editor changes how a
 * person writes a list, never what is saved.
 */
import React from 'react';
import { clsx } from 'clsx';
import { hostRowsOf, hostTextOfRows, type HostRow } from '../airlockHostText';

const BOX = 'h-3.5 w-3.5 accent-current disabled:cursor-not-allowed';

export function HostListEditor({ label, value, onChange, readOnly = false, blocking = false, className }: {
  /** The list's accessible name: "Allowed hosts", "Denied hosts, override 2"... */
  label: string;
  value: string;
  onChange: (text: string) => void;
  readOnly?: boolean;
  /** The deny side: the boxes say which way a host is blocked. */
  blocking?: boolean;
  className?: string;
}): React.ReactElement {
  const rows = hostRowsOf(value);
  const [draft, setDraft] = React.useState('');
  const save = (next: HostRow[]) => onChange(hostTextOfRows(next));
  const add = (text: string) => {
    if (text.trim()) save(hostRowsOf(text, rows));
    setDraft('');
  };
  const toggle = (i: number, dir: 'download' | 'upload') => {
    const r = rows[i];
    // Unticking one way leaves the other; ticking it back makes the row both ways.
    const way = r.way === 'both' ? (dir === 'download' ? 'upload' : 'download') : 'both';
    save(rows.map((x, j) => (j === i ? { ...x, way } : x)));
  };
  return (
    <div className={className}>
      <ul aria-label={label} className={clsx('divide-y divide-border-soft', rows.length > 0 && 'rounded-lg border border-border-soft')}>
        {rows.map((r, i) => (
          <li key={r.pattern} data-entry={hostTextOfRows([r])} className="flex items-center gap-3 px-2.5 py-1.5 text-[12px]">
            <span className="min-w-0 flex-1">
              <code className="break-all font-mono text-ink">{r.pattern}</code>
              {r.pattern === '*' && <span className="ml-2 text-ink-tertiary">every host, except the denied ones</span>}
            </span>
            {(['download', 'upload'] as const).map(dir => {
              const on = r.way === 'both' || r.way === dir;
              return (
                <label key={dir} className="flex shrink-0 items-center gap-1 text-ink-secondary">
                  <input
                    type="checkbox"
                    aria-label={`${dir === 'download' ? 'Download' : 'Upload'}: ${r.pattern}`}
                    checked={on}
                    // The last ticked box stays: a row is at least one way.
                    disabled={readOnly || r.way === dir}
                    onChange={() => toggle(i, dir)}
                    className={BOX}
                  />
                  {blocking ? (dir === 'download' ? 'Blocks downloads' : 'Blocks uploads') : (dir === 'download' ? 'Download' : 'Upload')}
                </label>
              );
            })}
            {!readOnly && (
              <button
                type="button"
                aria-label={`Remove ${r.pattern}`}
                onClick={() => save(rows.filter((_, j) => j !== i))}
                className="shrink-0 rounded px-1 text-ink-tertiary hover:text-ink"
              >
                ×
              </button>
            )}
          </li>
        ))}
      </ul>
      {!readOnly && (
        <textarea
          aria-label={`Add to ${label}`}
          rows={1}
          value={draft}
          placeholder="Add a host (Enter), or paste several, one per line"
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); add(draft); } }}
          // The paste goes where the cursor is, over any selection, and then every line is added.
          onPaste={e => {
            e.preventDefault();
            const t = e.currentTarget;
            const start = t.selectionStart ?? draft.length;
            const end = t.selectionEnd ?? draft.length;
            add(draft.slice(0, start) + e.clipboardData.getData('text') + draft.slice(end));
          }}
          className={clsx('mt-1.5 w-full resize-none rounded-lg border border-border-soft bg-canvas px-2.5 py-1.5 font-mono text-[13px] text-ink-secondary')}
        />
      )}
    </div>
  );
}
