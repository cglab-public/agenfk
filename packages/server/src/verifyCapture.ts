import * as fs from 'fs';
import { StringDecoder } from 'string_decoder';

/**
 * Bounded capture of a verifyCommand's output (BUG 24c679df).
 *
 * The command is arbitrary and user-configured, and the server that runs it is
 * the single writer of state for every client — CLI, MCP and UI. Accumulating
 * its whole stdout+stderr in a JS string meant one `npm install --loglevel
 * silly`, one build with a runaway progress loop, or one suite dumping diffs
 * pushed the server's RSS up by the output size (doubled by concatenation
 * churn) and took down everybody's session.
 *
 * So: every byte goes straight to the log file, and memory holds only a fixed
 * budget — a head for the preview, a tail for the failure message — whatever
 * the command prints. The true total is counted rather than inferred from what
 * was kept, because "the last 64KB of 900MB" and "all 64KB" must not read the
 * same to whoever is debugging.
 */

/**
 * Head budget. Also what a run follower sees live, so it matches the old
 * LIVE_CAP exactly: the live view is unchanged, it is merely no longer a slice
 * of an unbounded string.
 */
export const CAPTURE_HEAD_BYTES = 1024 * 1024;

/**
 * Tail budget. Comfortably above FAILURE_TAIL_LINES × a long line and above
 * PREVIEW_TAIL_BYTES, so both consumers are served from it and neither has to
 * reach for the file.
 */
export const CAPTURE_TAIL_BYTES = 64 * 1024;

/**
 * Disk ceiling. Streaming solves memory but hands the runaway command the disk
 * instead, and the log root is a shared temp directory. Overridable because the
 * right answer depends on the box, not on us.
 */
export const DEFAULT_MAX_LOG_BYTES = 64 * 1024 * 1024;

export function maxLogBytesFromEnv(): number {
  const raw = Number.parseInt(process.env.AGENFK_VERIFY_MAX_LOG_BYTES ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_LOG_BYTES;
}

export interface CapturedOutput {
  /** First CAPTURE_HEAD_BYTES of output, decoded. */
  head: string;
  /** Last CAPTURE_TAIL_BYTES of output, decoded. */
  tail: string;
  /** Every byte the command emitted, including what the log file refused. */
  totalBytes: number;
  /** The log file hit its ceiling and says so in its last line. */
  logTruncated: boolean;
  /**
   * The log stopped early for a reason that is NOT the ceiling — a full disk, a
   * vanished directory. Reporting it as the ceiling sends the operator to tune
   * an env var that is not the problem.
   */
  logWriteError?: string;
  /** The head holds the ENTIRE output, so a preview need not stitch a tail on. */
  headIsComplete: boolean;
}

export interface OutputCapture {
  /** A chunk from stdout or stderr. */
  write(chunk: Buffer): void;
  /** A line from the server itself — the timeout kill, say — recorded like output. */
  note(text: string): void;
  /** The head so far, for a live run follower. */
  live(): string;
  /**
   * Snapshot, close the log, and refuse everything after.
   *
   * Closing here rather than in the caller is deliberate: the capture owns the
   * fd, so write-eligibility and fd ownership cannot drift apart. They did — a
   * cap-killed command resolves on 'exit', which fires BEFORE stdio drains, and
   * surviving grandchildren keep printing into a handler nobody detached. Those
   * bytes reached fs.writeSync on a CLOSED fd number, which the OS had already
   * reissued: measured, an orphan's stdout landed in the next file this process
   * opened. Idempotent.
   */
  end(): CapturedOutput;
}

/** `1.0 MB`, `12.3 KB`, `907 bytes` — enough to tell 8MB from 800MB at a glance. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function createOutputCapture(opts: { fd: number | null; maxLogBytes?: number }): OutputCapture {
  const maxLogBytes = opts.maxLogBytes ?? maxLogBytesFromEnv();
  // One decoder across every chunk. Per-chunk toString() mangles any character
  // whose bytes straddle a boundary, and a suite printing a check mark or an em
  // dash is ordinary.
  const decoder = new StringDecoder('utf8');
  let head = '';
  let tail = '';
  let totalBytes = 0;
  let writtenBytes = 0;
  let logTruncated = false;
  let headIsComplete = true;
  let logWriteError: string | undefined;
  let finished = false;
  let fd: number | null = opts.fd;

  /** writeSync can return short. Ignoring that overstates writtenBytes, which
   *  trips the ceiling early and then blames it for the wrong thing. */
  const writeAll = (buf: Buffer): number => {
    let off = 0;
    while (off < buf.length) {
      const n = fs.writeSync(fd as number, buf, off, buf.length - off);
      if (n <= 0) break;
      off += n;
    }
    return off;
  };

  const toFile = (buf: Buffer) => {
    if (fd === null || logTruncated || logWriteError) return;
    // No early return when room is 0: a chunk that exactly filled the ceiling
    // leaves room 0, and the NEXT chunk is precisely the one whose loss the
    // file must admit to - it falls through to the truncation branch below.
    const room = maxLogBytes - writtenBytes;
    try {
      if (buf.length <= room) {
        writtenBytes += writeAll(buf);
        return;
      }
      writtenBytes += writeAll(buf.subarray(0, room));
      logTruncated = true;
      // The file admits to its own ceiling. A silently short log is worse than
      // a short one, because it reads as "the command stopped there".
      writeAll(Buffer.from(
        `\n[agenfk] log truncated at ${formatBytes(maxLogBytes)} (AGENFK_VERIFY_MAX_LOG_BYTES). ` +
        `The command kept printing; the rest was discarded.\n`,
      ));
    } catch (err: any) {
      // A failed log write must not cost the run its outcome — diagnostics are
      // best-effort, the transition is not. But it must not be reported as the
      // ceiling either: a full disk and a deliberate cap are different problems
      // with different fixes.
      logWriteError = err?.code || err?.message || 'log write failed';
    }
  };

  const remember = (text: string) => {
    if (!text) return;
    if (head.length < CAPTURE_HEAD_BYTES) {
      const room = CAPTURE_HEAD_BYTES - head.length;
      head += text.slice(0, room);
      if (text.length > room) headIsComplete = false;
    } else {
      headIsComplete = false;
    }
    tail += text;
    if (tail.length > CAPTURE_TAIL_BYTES) tail = tail.slice(tail.length - CAPTURE_TAIL_BYTES);
  };

  return {
    write(chunk: Buffer) {
      // Everything after end() is dropped. An orphaned grandchild still holding
      // the inherited pipe keeps firing this handler long after the run was
      // answered, and by then the fd number belongs to somebody else's file.
      if (finished) return;
      totalBytes += chunk.length;
      toFile(chunk);
      remember(decoder.write(chunk));
    },
    note(text: string) {
      if (finished) return;
      const buf = Buffer.from(text);
      totalBytes += buf.length;
      toFile(buf);
      remember(text);
    },
    live() { return head; },
    end() {
      if (!finished) {
        remember(decoder.end());
        finished = true;
        if (fd !== null) {
          try { fs.closeSync(fd); } catch { /* already gone */ }
          fd = null;
        }
      }
      return { head, tail, totalBytes, logTruncated, logWriteError, headIsComplete };
    },
  };
}
