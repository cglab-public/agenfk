import { Worker } from 'worker_threads';
import * as os from 'os';

/**
 * bcrypt on a worker_threads pool: bcryptjs's async API still hogs the event loop,
 * so concurrent bad logins could freeze the hub. A saturated pool refuses work (429); a pool
 * that cannot start a worker refuses it too (503) and tries again after SPAWN_RETRY_MS.
 * A worker takes jobs only once it has said it is ready, so one that fails while loading
 * (bcryptjs missing) counts as not started, like one whose constructor threw.
 */

const WORKER_SRC = `
const { parentPort, workerData } = require('worker_threads');
const bcrypt = require(workerData.bcryptPath);
parentPort.postMessage({ ready: true });
parentPort.on('message', (m) => {
  try {
    parentPort.postMessage({ id: m.id, result: m.op === 'hash' ? bcrypt.hashSync(m.plain, m.rounds) : bcrypt.compareSync(m.plain, m.hash) });
  } catch (e) {
    parentPort.postMessage({ id: m.id, error: String((e && e.message) || e) });
  }
});
`;

type Op = { op: 'hash'; plain: string; rounds: number } | { op: 'compare'; plain: string; hash: string };
interface Job { id: number; msg: Op; resolve: (v: any) => void; reject: (e: Error) => void }
interface Slot { worker: Worker; job: Job | null; ready: boolean }

/** Worker count: AGENFK_HUB_BCRYPT_WORKERS, else cores - 1 (1 to 4). */
function poolSize(): number {
  const n = Number.parseInt(process.env.AGENFK_HUB_BCRYPT_WORKERS ?? '', 10);
  if (Number.isFinite(n) && n >= 1) return Math.min(n, 32);
  return Math.max(1, Math.min(4, os.availableParallelism() - 1));
}

/** Max queued jobs (AGENFK_HUB_BCRYPT_QUEUE_MAX); 16 per worker keeps the wait under ~2 s. */
function queueMax(): number {
  const n = Number.parseInt(process.env.AGENFK_HUB_BCRYPT_QUEUE_MAX ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : poolSize() * 16;
}

const slots: Slot[] = [];
const queue: Job[] = [];
let nextId = 1;
/** After a failed spawn, no new worker is attempted before this time (ms since epoch). */
let spawnRetryAt = 0;
let shuttingDown = false;

const SPAWN_RETRY_MS = 5_000;

class PoolBusyError extends Error {
  status = 429;
  constructor() { super('Too many sign-in attempts are being checked right now; try again shortly.'); }
}

/** No worker could be started: retryable, and never answered by hashing on the request thread. */
export class PoolUnavailableError extends Error {
  status = 503;
  retryAfterSeconds = Math.ceil(SPAWN_RETRY_MS / 1000);
  constructor() { super('Password checking is temporarily unavailable; try again shortly.'); }
}

const spawnBackedOff = (): boolean => Date.now() < spawnRetryAt;

function spawnFailed(err: Error): void {
  spawnRetryAt = Date.now() + SPAWN_RETRY_MS;
  console.warn(`[HUB] could not start a bcrypt worker, retrying in ${SPAWN_RETRY_MS / 1000}s:`, err.message);
}

function spawn(): Slot | undefined {
  let worker: Worker;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    worker = new Worker(WORKER_SRC, { eval: true, workerData: { bcryptPath: require.resolve('bcryptjs') } });
  } catch (err) {
    spawnFailed(err as Error);
    return undefined;
  }
  const slot: Slot = { worker, job: null, ready: false };
  worker.on('message', (m: { ready?: boolean; id: number; result?: unknown; error?: string }) => {
    if (m.ready) { slot.ready = true; pump(); return; }
    const job = slot.job;
    if (!job || job.id !== m.id) return;
    slot.job = null;
    if (m.error !== undefined) job.reject(new Error(m.error)); else job.resolve(m.result);
    pump();
  });
  let gone = false;
  // 'error' and 'exit' both fire for one death: only the first counts.
  const dead = (err: Error) => {
    if (gone) return;
    gone = true;
    const i = slots.indexOf(slot);
    if (i >= 0) slots.splice(i, 1);
    const job = slot.job;
    slot.job = null;
    if (job) job.reject(err);
    // Died before it was ready: starting another at once would only repeat it, once per waiting job.
    if (!slot.ready && !shuttingDown) spawnFailed(err);
    pump();
  };
  worker.on('error', dead);
  worker.on('exit', (code) => dead(new Error(`bcrypt worker exited (${code})`)));
  worker.unref();   // after the listeners: adding a 'message' listener to an unref'd worker refs it again
  slots.push(slot);
  return slot;
}

const starting = (): number => slots.filter(s => !s.ready).length;

/** Give waiting jobs to idle workers, starting one per job still unserved while the pool is below size. */
function pump(): void {
  while (queue.length > 0) {
    const slot = slots.find(s => s.ready && !s.job);
    if (slot) {
      const job = queue.shift()!;
      slot.job = job;
      slot.worker.postMessage({ id: job.id, ...job.msg });
      continue;
    }
    if (starting() < queue.length && slots.length < poolSize() && !spawnBackedOff() && spawn()) continue;
    break;
  }
  // With no worker at all nothing will take these before the retry: refuse them rather than let them wait.
  if (slots.length === 0) for (const j of queue.splice(0)) j.reject(new PoolUnavailableError());
}

function submit<T>(msg: Op): Promise<T> {
  if (shuttingDown) return Promise.reject(new Error('bcrypt pool is shut down'));
  if (slots.length === 0 && spawnBackedOff()) return Promise.reject(new PoolUnavailableError());
  const idle = slots.some(s => s.ready && !s.job);
  const canGrow = slots.length < poolSize() && !spawnBackedOff();
  // A job a starting worker will take is not waiting behind the others.
  if (!idle && !canGrow && queue.length - starting() >= queueMax()) return Promise.reject(new PoolBusyError());
  return new Promise<T>((resolve, reject) => {
    queue.push({ id: nextId++, msg, resolve, reject });
    pump();
  });
}

export function bcryptHash(plain: string, rounds: number): Promise<string> {
  return submit<string>({ op: 'hash', plain, rounds });
}

export function bcryptCompare(plain: string, hash: string): Promise<boolean> {
  return submit<boolean>({ op: 'compare', plain, hash });
}

/** Stops the workers and refuses further work. Tests and a graceful shutdown. */
export async function shutdownBcryptPool(): Promise<void> {
  shuttingDown = true;
  const err = new Error('bcrypt pool is shut down');
  for (const job of queue.splice(0)) job.reject(err);
  await Promise.all(slots.splice(0).map(s => s.worker.terminate()));
}

/** Test hook: kill every worker, as a crash would; the next job starts a fresh one. */
export async function __killWorkersForTest(): Promise<void> {
  await Promise.all([...slots].map(s => s.worker.terminate()));
}

/** Test hook: how many workers exist, how many hold a job, and how many jobs wait. */
export function __poolStatsForTest(): { workers: number; busy: number; queued: number } {
  return { workers: slots.length, busy: slots.filter(s => s.job).length, queued: queue.length };
}
