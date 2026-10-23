import { Worker } from 'worker_threads';
import * as os from 'os';
import bcryptjs from 'bcryptjs';

/**
 * bcrypt on a worker_threads pool: bcryptjs's async API still hogs the event loop,
 * so concurrent bad logins could freeze the hub. A saturated pool refuses work (429).
 */

const WORKER_SRC = `
const { parentPort, workerData } = require('worker_threads');
const bcrypt = require(workerData.bcryptPath);
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
interface Slot { worker: Worker; job: Job | null }

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
let spawnFailed = false;
let shuttingDown = false;

class PoolBusyError extends Error {
  status = 429;
  constructor() { super('Too many sign-in attempts are being checked right now; try again shortly.'); }
}

function spawn(): Slot | null {
  let worker: Worker;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    worker = new Worker(WORKER_SRC, { eval: true, workerData: { bcryptPath: require.resolve('bcryptjs') } });
  } catch (err) {
    // No worker threads here: fall back to bcryptjs's async API (correct, not parallel).
    spawnFailed = true;
    console.warn('[HUB] bcrypt worker threads unavailable, hashing on the request thread:', (err as Error).message);
    return null;
  }
  worker.unref();
  const slot: Slot = { worker, job: null };
  worker.on('message', (m: { id: number; result?: unknown; error?: string }) => {
    const job = slot.job;
    if (!job || job.id !== m.id) return;
    slot.job = null;
    if (m.error !== undefined) job.reject(new Error(m.error)); else job.resolve(m.result);
    pump();
  });
  const dead = (err: Error) => {
    const i = slots.indexOf(slot);
    if (i >= 0) slots.splice(i, 1);
    const job = slot.job;
    slot.job = null;
    if (job) job.reject(err);
    pump();
  };
  worker.on('error', dead);
  worker.on('exit', (code) => dead(new Error(`bcrypt worker exited (${code})`)));
  slots.push(slot);
  return slot;
}

/** Give waiting jobs to idle workers, starting one when the pool is below size. */
function pump(): void {
  while (queue.length > 0) {
    let slot = slots.find(s => !s.job) ?? (slots.length < poolSize() ? spawn() : null);
    if (!slot) {
      if (spawnFailed) for (const j of queue.splice(0)) inThread(j.msg).then(j.resolve, j.reject);
      return;
    }
    const job = queue.shift()!;
    slot.job = job;
    slot.worker.postMessage({ id: job.id, ...job.msg });
  }
}

function inThread(msg: Op): Promise<any> {
  return msg.op === 'hash' ? bcryptjs.hash(msg.plain, msg.rounds) : bcryptjs.compare(msg.plain, msg.hash);
}

function submit<T>(msg: Op): Promise<T> {
  if (shuttingDown) return Promise.reject(new Error('bcrypt pool is shut down'));
  if (spawnFailed) return inThread(msg);
  const idle = slots.some(s => !s.job);
  if (!idle && slots.length >= poolSize() && queue.length >= queueMax()) return Promise.reject(new PoolBusyError());
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
