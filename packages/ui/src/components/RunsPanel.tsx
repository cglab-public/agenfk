import React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { io } from 'socket.io-client';
import { api } from '../api';
import { API_URL } from '../apiUrl';

export interface AgentRun {
  id: string;
  itemId: string;
  step: string;
  actor: 'orchestrator' | 'worker' | 'reviewer';
  harness: string;
  model: string;
  sessionId?: string;
  status: 'running' | 'done' | 'failed';
  verdict?: string;
  startedAt: string;
  endedAt?: string;
}

export interface RunEvent {
  id: string;
  runId: string;
  seq: number;
  ts: string;
  lane: 'orchestrator' | 'worker' | 'reviewer';
  kind: 'dispatch' | 'think' | 'tool' | 'result' | 'diff' | 'verdict' | 'note';
  tool?: string;
  text?: string;
  payload?: string;
  tokens?: number;
}

const LANE = {
  orchestrator: { label: 'orchestrator', ini: 'C', avatar: 'bg-indigo-500/60', tag: 'text-indigo-600 dark:text-indigo-300' },
  worker: { label: 'pi · worker', ini: 'π', avatar: 'bg-amber-500/60', tag: 'text-amber-600 dark:text-amber-300' },
  reviewer: { label: 'reviewer', ini: 'R', avatar: 'bg-teal-500/60', tag: 'text-teal-600 dark:text-teal-300' },
} as const;

function fmtTokens(n?: number): string {
  return typeof n === 'number' ? n.toLocaleString('en-US') : '';
}

// Short, human display name for a model id: the first meaningful alphabetic
// family token (>=3 letters, so version bits like "v1"/"27b" are skipped),
// title-cased. "qwen3.6:27b" -> "Qwen", "claude-opus-4-8" -> "Claude",
// "3.5-sonnet" -> "Sonnet". Falls back to the raw id if no such token exists,
// so it never emits a meaningless single letter.
function prettyModel(model?: string): string {
  if (!model) return '';
  const family = model.match(/[a-zA-Z]{3,}/)?.[0];
  if (!family) return model;
  return family.charAt(0).toUpperCase() + family.slice(1);
}

export const RunsPanel: React.FC<{ itemId: string }> = ({ itemId }) => {
  const queryClient = useQueryClient();
  const [selectedRunId, setSelectedRunId] = React.useState<string | null>(null);
  const logRef = React.useRef<HTMLDivElement>(null);

  const { data: runsData } = useQuery<AgentRun[]>({
    queryKey: ['agent-runs', itemId],
    queryFn: () => api.listAgentRuns(itemId),
  });
  // Never trust the response shape: a mis-proxied route can return the SPA
  // index.html (a string), which would blow up runs.map / runs.find below.
  const runs = Array.isArray(runsData) ? runsData : [];

  // Follow the newest run: select it initially and auto-advance whenever a new
  // run appears (e.g. when the next phase like IN_PROGRESS starts), so the panel
  // tracks the live phase instead of staying pinned to the first run.
  const newestRunId = runs.length ? runs[runs.length - 1].id : null;
  React.useEffect(() => {
    if (newestRunId) setSelectedRunId(newestRunId);
  }, [newestRunId]);

  const { data: eventsData } = useQuery<RunEvent[]>({
    queryKey: ['run-events', selectedRunId],
    queryFn: () => api.listRunEvents(selectedRunId as string),
    enabled: !!selectedRunId,
  });
  const events = Array.isArray(eventsData) ? eventsData : [];

  // Live: append streamed events into the cache; refresh the run list on updates.
  React.useEffect(() => {
    const socket = io(API_URL || undefined);
    socket.on('run:event', (b: { itemId: string; runId: string; event: RunEvent }) => {
      if (b.itemId !== itemId) return;
      queryClient.setQueryData<RunEvent[]>(['run-events', b.runId], (old) => {
        const prev = Array.isArray(old) ? old : [];
        return prev.some(e => e.seq === b.event.seq) ? prev : [...prev, b.event].sort((a, z) => a.seq - z.seq);
      });
      queryClient.invalidateQueries({ queryKey: ['agent-runs', itemId] });
    });
    socket.on('run:updated', (b: { itemId: string }) => {
      if (b.itemId === itemId) queryClient.invalidateQueries({ queryKey: ['agent-runs', itemId] });
    });
    return () => { socket.disconnect(); };
  }, [itemId, queryClient]);

  // Autoscroll the transcript as events arrive.
  React.useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [events.length]);

  if (!runs.length) {
    return <div className="text-sm text-slate-400 dark:text-slate-500 py-8 text-center">No agent runs recorded for this item.</div>;
  }

  const selected = runs.find(r => r.id === selectedRunId) || null;

  return (
    <div className="flex gap-4 h-full min-h-0" data-testid="runs-panel">
      {/* Run list */}
      <div className="w-56 shrink-0 space-y-2 overflow-y-auto">
        {runs.map(run => {
          const lane = LANE[run.actor];
          const isSel = run.id === selectedRunId;
          return (
            <button
              key={run.id}
              onClick={() => setSelectedRunId(run.id)}
              className={
                'w-full text-left rounded-lg border p-2.5 transition-colors ' +
                (isSel
                  ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/20'
                  : 'border-slate-200 dark:border-slate-700 hover:border-indigo-400')
              }
            >
              <div className="flex items-center gap-2">
                <span className={
                  'w-2 h-2 rounded-full shrink-0 ' +
                  (run.status === 'running' ? 'bg-indigo-500 animate-pulse' : run.status === 'failed' ? 'bg-red-500' : 'bg-emerald-500')
                } />
                <span className="font-mono text-xs font-bold text-slate-700 dark:text-slate-200 truncate">{run.step}</span>
              </div>
              <div className={'mt-1 font-mono text-[10px] ' + lane.tag}>{lane.ini} {lane.label}</div>
              <div className="mt-0.5 font-mono text-[10px] text-slate-400 dark:text-slate-500 truncate">{run.model}</div>
            </button>
          );
        })}
      </div>

      {/* Transcript */}
      <div className="flex-1 min-w-0 flex flex-col border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
          <span className="font-mono text-xs font-bold text-slate-700 dark:text-slate-200 truncate">
            {selected ? selected.step : ''} {selected?.sessionId && <span className="text-slate-400 dark:text-slate-500">· {selected.sessionId}</span>}
          </span>
          {selected && (
            <span className={
              'font-mono text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 ' +
              (selected.status === 'running'
                ? 'text-indigo-600 dark:text-indigo-300 bg-indigo-100 dark:bg-indigo-900/30 animate-pulse'
                : 'text-emerald-600 dark:text-emerald-300 bg-emerald-100 dark:bg-emerald-900/30')
            }>
              {selected.status === 'running' ? '● LIVE' : ('● ' + (selected.verdict || selected.status.toUpperCase()))}
            </span>
          )}
        </div>
        <div ref={logRef} className="flex-1 overflow-y-auto p-3" data-testid="runs-transcript">
          {events.map((ev, i) => {
            const lane = LANE[ev.lane] || LANE.worker;
            // Identity caption: for the lane that matches this run's own actor
            // (the agent that ran it — pi worker, or the reviewer/orchestrator),
            // show "<harness> · <model>" from the run (omitting the separator
            // when the model is unknown). Cross-lane events (e.g. the
            // orchestrator's dispatch inside a worker run) show their role label.
            const who = ev.lane === selected?.actor
              ? [selected?.harness, prettyModel(selected?.model)].filter(Boolean).join(' · ')
              : lane.label;
            const isLast = i === events.length - 1;
            return (
              // The left gutter's border-r forms a faint, continuous timeline
              // rail; each row stretches so the rail connects across events. The
              // last row omits the bottom padding so the rail ends at the event.
              <div key={ev.id} className="flex gap-3">
                <div className="flex flex-col items-start shrink-0 w-24 pr-3 border-r border-slate-200/70 dark:border-slate-700/50">
                  <span className={'w-6 h-6 rounded-md grid place-items-center font-mono text-xs font-bold text-white ' + lane.avatar}>{lane.ini}</span>
                  <span className={'mt-1 font-mono text-[10px] leading-tight break-words ' + lane.tag}>{who}</span>
                </div>
                <div className={'min-w-0 flex-1 ' + (isLast ? '' : 'pb-4')}>
                  <span className={
                    'font-mono text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ' +
                    'bg-slate-100 dark:bg-slate-800 ' + lane.tag
                  }>{ev.kind}{ev.tool ? ' · ' + ev.tool : ''}</span>
                  {ev.kind === 'tool' && ev.text && (
                    <pre className="mt-1 font-mono text-[11px] bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded px-2 py-1 overflow-x-auto whitespace-pre-wrap break-words text-slate-700 dark:text-slate-200">{ev.text}</pre>
                  )}
                  {ev.kind !== 'tool' && ev.text && (
                    <div className={'mt-1 text-[13px] break-words ' + (ev.kind === 'think' ? 'italic text-slate-500 dark:text-slate-400' : 'text-slate-700 dark:text-slate-200')}>{ev.text}</div>
                  )}
                  {typeof ev.tokens === 'number' && (
                    <span className="inline-block mt-1 font-mono text-[10px] text-slate-400 dark:text-slate-500">{fmtTokens(ev.tokens)} tok</span>
                  )}
                </div>
              </div>
            );
          })}
          {!events.length && <div className="text-xs text-slate-400 dark:text-slate-500 py-6 text-center">No events yet.</div>}
        </div>
      </div>
    </div>
  );
};
