import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Database, Play, Save, Trash2, Wand2, Table2, ChevronRight, ChevronDown, AlertTriangle } from 'lucide-react';
import { api } from '../api';
import { clampRowLimit, formatCell, DEFAULT_ROW_LIMIT } from '../queryConsole';
import { buildSelectSql, BuilderFilter, FilterOp, OrderDir } from '../queryBuilder';
import { canSaveQuery, SavedQuery } from '../savedQueries';

const inputCls = 'px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500';
const cardCls = 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5';
const primaryBtnCls = 'inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-semibold transition-colors';
const ghostBtnCls = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-semibold transition-colors';

interface SchemaColumn { name: string; type: string; nullable: boolean; pk: boolean }
interface SchemaTable { name: string; columns: SchemaColumn[] }
interface SchemaResponse { backend: string; tables: SchemaTable[] }
interface QueryResult { columns: string[]; rows: Record<string, unknown>[]; rowCount: number; truncated: boolean; elapsedMs: number }

const FILTER_OPS: FilterOp[] = ['=', '!=', '<', '<=', '>', '>=', 'LIKE', 'IS NULL', 'IS NOT NULL'];

function errText(e: unknown): string {
  const anyE = e as { response?: { data?: { error?: string } }; message?: string };
  return anyE?.response?.data?.error ?? anyE?.message ?? 'Query failed.';
}

export function AdminDatabaseConsole() {
  const qc = useQueryClient();
  const schema = useQuery<SchemaResponse>({
    queryKey: ['db-console-schema'],
    queryFn: async () => (await api.get('/v1/admin/db-console/schema')).data,
  });
  const saved = useQuery<SavedQuery[]>({
    queryKey: ['saved-queries'],
    queryFn: async () => (await api.get('/v1/admin/saved-queries')).data,
  });

  const [sql, setSql] = useState('SELECT * FROM events LIMIT 50');
  const [limit, setLimit] = useState<number>(DEFAULT_ROW_LIMIT);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const run = useMutation({
    mutationFn: async () => (await api.post('/v1/admin/db-console/query', { sql, limit: clampRowLimit(limit) })).data as QueryResult,
    onSuccess: (data) => { setResult(data); setRunError(null); },
    onError: (e) => { setRunError(errText(e)); setResult(null); },
  });

  const create = useMutation({
    mutationFn: (body: { name: string; sql: string }) => api.post('/v1/admin/saved-queries', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['saved-queries'] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/v1/admin/saved-queries/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['saved-queries'] }),
  });

  const onSave = () => {
    const name = window.prompt('Name this query:')?.trim();
    if (!name) return;
    if (!canSaveQuery(name, sql)) return;
    create.mutate({ name, sql });
  };

  return (
    <div className="max-w-[1200px] mx-auto space-y-6">
      <header>
        <p className="text-[11px] uppercase tracking-[0.18em] text-indigo-600 dark:text-indigo-400 font-semibold">Admin</p>
        <h1 className="mt-1 flex items-center gap-2 text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
          <Database className="w-6 h-6" /> Query Console
        </h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Run read-only queries against the hub database{schema.data ? ` (${schema.data.backend})` : ''}. Writes are blocked.
        </p>
      </header>

      <div className="grid lg:grid-cols-[280px_1fr] gap-6 items-start">
        {/* Left rail: schema browser + saved queries */}
        <aside className="space-y-6">
          <SchemaBrowser schema={schema.data} loading={schema.isLoading} />
          <SavedQueriesPanel
            list={saved.data ?? []}
            onLoad={(q) => setSql(q.sql)}
            onDelete={(id) => remove.mutate(id)}
          />
        </aside>

        {/* Main: builder + editor + results */}
        <main className="space-y-4">
          <QueryBuilderPanel schema={schema.data} onGenerate={setSql} />

          <section className={cardCls}>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">SQL</h3>
              <div className="flex items-center gap-2">
                <label className="text-xs text-slate-500">Max rows</label>
                <input
                  type="number" min={1} max={5000} value={limit}
                  onChange={(e) => setLimit(clampRowLimit(e.target.value))}
                  className={`${inputCls} w-24`}
                />
                <button className={ghostBtnCls} onClick={onSave}><Save className="w-3.5 h-3.5" /> Save</button>
                <button className={primaryBtnCls} disabled={run.isPending} onClick={() => run.mutate()}>
                  <Play className="w-4 h-4" /> {run.isPending ? 'Running…' : 'Run'}
                </button>
              </div>
            </div>
            <textarea
              value={sql}
              onChange={(e) => setSql(e.target.value)}
              spellCheck={false}
              rows={6}
              className={`${inputCls} w-full font-mono`}
              placeholder="SELECT * FROM events LIMIT 50"
            />
          </section>

          {runError && (
            <div className="flex items-start gap-2 rounded-xl border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 p-3 text-sm text-rose-700 dark:text-rose-300">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span className="font-mono">{runError}</span>
            </div>
          )}

          {result && <ResultsGrid result={result} />}
        </main>
      </div>
    </div>
  );
}

function SchemaBrowser({ schema, loading }: { schema?: SchemaResponse; loading: boolean }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  return (
    <section className={cardCls}>
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-800 dark:text-slate-100 mb-2">
        <Table2 className="w-4 h-4" /> Schema
      </h3>
      {loading && <p className="text-xs text-slate-500">Loading…</p>}
      <ul className="space-y-0.5 max-h-[360px] overflow-auto">
        {schema?.tables.map((t) => (
          <li key={t.name}>
            <button
              className="w-full flex items-center gap-1 text-left text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded px-1.5 py-1"
              onClick={() => setOpen((o) => ({ ...o, [t.name]: !o[t.name] }))}
            >
              {open[t.name] ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />}
              <span className="truncate">{t.name}</span>
              <span className="ml-auto text-[10px] text-slate-400">{t.columns.length}</span>
            </button>
            {open[t.name] && (
              <ul className="ml-5 mt-0.5 mb-1 space-y-0.5">
                {t.columns.map((c) => (
                  <li key={c.name} className="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                    <span className={c.pk ? 'font-semibold text-indigo-600 dark:text-indigo-400' : ''}>{c.name}</span>
                    <span className="text-slate-400">{c.type}</span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function QueryBuilderPanel({ schema, onGenerate }: { schema?: SchemaResponse; onGenerate: (sql: string) => void }) {
  const [open, setOpen] = useState(false);
  const [table, setTable] = useState('');
  const [cols, setCols] = useState<string[]>([]);
  const [filters, setFilters] = useState<BuilderFilter[]>([]);
  const [orderCol, setOrderCol] = useState('');
  const [orderDir, setOrderDir] = useState<OrderDir>('ASC');
  const [limit, setLimit] = useState<number | ''>(50);
  const [err, setErr] = useState<string | null>(null);

  const tableCols = useMemo(
    () => schema?.tables.find((t) => t.name === table)?.columns ?? [],
    [schema, table],
  );

  const generate = () => {
    try {
      if (!table) { setErr('Pick a table first.'); return; }
      const sql = buildSelectSql({
        table,
        columns: cols,
        filters: filters.filter((f) => f.column),
        orderBy: orderCol ? { column: orderCol, dir: orderDir } : undefined,
        limit: typeof limit === 'number' ? limit : undefined,
      });
      setErr(null);
      onGenerate(sql);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <section className={cardCls}>
      <button className="w-full flex items-center gap-1.5 text-sm font-semibold text-slate-800 dark:text-slate-100" onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        <Wand2 className="w-4 h-4" /> Visual query builder
      </button>
      {open && (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-xs text-slate-500 w-16">Table</label>
            <select className={`${inputCls} min-w-[180px]`} value={table} onChange={(e) => { setTable(e.target.value); setCols([]); setFilters([]); setOrderCol(''); }}>
              <option value="">— select —</option>
              {schema?.tables.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
            </select>
          </div>

          {table && (
            <>
              <div className="flex items-start gap-2">
                <label className="text-xs text-slate-500 w-16 pt-1.5">Columns</label>
                <div className="flex flex-wrap gap-2">
                  {tableCols.map((c) => (
                    <label key={c.name} className="inline-flex items-center gap-1 text-xs text-slate-600 dark:text-slate-300">
                      <input
                        type="checkbox"
                        checked={cols.includes(c.name)}
                        onChange={(e) => setCols((prev) => e.target.checked ? [...prev, c.name] : prev.filter((x) => x !== c.name))}
                      />
                      {c.name}
                    </label>
                  ))}
                  <span className="text-[11px] text-slate-400">(none = all)</span>
                </div>
              </div>

              <div className="space-y-2">
                {filters.map((f, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2">
                    <label className="text-xs text-slate-500 w-16">{i === 0 ? 'Where' : 'And'}</label>
                    <select className={inputCls} value={f.column} onChange={(e) => setFilters((p) => p.map((x, j) => j === i ? { ...x, column: e.target.value } : x))}>
                      <option value="">— column —</option>
                      {tableCols.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                    </select>
                    <select className={inputCls} value={f.op} onChange={(e) => setFilters((p) => p.map((x, j) => j === i ? { ...x, op: e.target.value as FilterOp } : x))}>
                      {FILTER_OPS.map((op) => <option key={op} value={op}>{op}</option>)}
                    </select>
                    {f.op !== 'IS NULL' && f.op !== 'IS NOT NULL' && (
                      <input className={inputCls} placeholder="value" value={String(f.value ?? '')} onChange={(e) => setFilters((p) => p.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} />
                    )}
                    <button className={ghostBtnCls} onClick={() => setFilters((p) => p.filter((_, j) => j !== i))}><Trash2 className="w-3 h-3" /></button>
                  </div>
                ))}
                <button className={ghostBtnCls} onClick={() => setFilters((p) => [...p, { column: '', op: '=', value: '' }])}>+ Add filter</button>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <label className="text-xs text-slate-500 w-16">Order by</label>
                <select className={inputCls} value={orderCol} onChange={(e) => setOrderCol(e.target.value)}>
                  <option value="">— none —</option>
                  {tableCols.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                </select>
                <select className={inputCls} value={orderDir} onChange={(e) => setOrderDir(e.target.value as OrderDir)}>
                  <option value="ASC">ASC</option>
                  <option value="DESC">DESC</option>
                </select>
                <label className="text-xs text-slate-500 ml-2">Limit</label>
                <input type="number" className={`${inputCls} w-24`} value={limit} onChange={(e) => setLimit(e.target.value === '' ? '' : Number(e.target.value))} />
              </div>

              {err && <p className="text-xs text-rose-600">{err}</p>}
              <button className={primaryBtnCls} onClick={generate}><Wand2 className="w-4 h-4" /> Generate SQL</button>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function SavedQueriesPanel({ list, onLoad, onDelete }: { list: SavedQuery[]; onLoad: (q: SavedQuery) => void; onDelete: (id: string) => void }) {
  return (
    <section className={cardCls}>
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-800 dark:text-slate-100 mb-2">
        <Save className="w-4 h-4" /> Saved queries
      </h3>
      {list.length === 0 && <p className="text-xs text-slate-500">No saved queries yet. Run a query and click Save.</p>}
      <ul className="space-y-1">
        {list.map((q) => (
          <li key={q.id} className="flex items-center gap-1.5 group">
            <button className="flex-1 text-left text-xs text-slate-700 dark:text-slate-200 hover:text-indigo-600 dark:hover:text-indigo-400 truncate" title={q.sql} onClick={() => onLoad(q)}>
              {q.name}
            </button>
            <button className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-rose-600" onClick={() => onDelete(q.id)} aria-label={`Delete ${q.name}`}>
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ResultsGrid({ result }: { result: QueryResult }) {
  return (
    <section className={cardCls}>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
          {result.rowCount} row{result.rowCount === 1 ? '' : 's'}
          {result.truncated && <span className="ml-2 text-xs font-normal text-amber-600">(truncated)</span>}
        </h3>
        <span className="text-xs text-slate-400">{result.elapsedMs} ms</span>
      </div>
      {result.columns.length === 0 ? (
        <p className="text-xs text-slate-500">No columns returned.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-700">
                {result.columns.map((c) => (
                  <th key={c} className="text-left font-semibold text-slate-600 dark:text-slate-300 px-2 py-1.5 whitespace-nowrap">{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, i) => (
                <tr key={i} className="border-b border-slate-100 dark:border-slate-800">
                  {result.columns.map((c) => (
                    <td key={c} className="px-2 py-1.5 font-mono text-slate-700 dark:text-slate-300 whitespace-nowrap max-w-[320px] truncate" title={formatCell(row[c])}>
                      {formatCell(row[c])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
