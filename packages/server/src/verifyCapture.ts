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
}

export interface OutputCapture {
  /** A chunk from stdout or stderr. */
  write(chunk: Buffer): void;
  /** A line from the server itself — the timeout kill, say — recorded like output. */
  note(text: string): void;
  /** The head so far, for a live run follower. */
  live(): string;
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

  const toFile = (buf: Buffer) => {
    if (opts.fd === null || logTruncated) return;
    const room = maxLogBytes - writtenBytes;
    if (room <= 0) return;
    try {
      if (buf.length <= room) {
        fs.writeSync(opts.fd, buf);
        writtenBytes += buf.length;
        return;
      }
      fs.writeSync(opts.fd, buf.subarray(0, room));
      writtenBytes += room;
      logTruncated = true;
      // The file admits to its own ceiling. A silently short log is worse than
      // a short one, because it reads as "the command stopped there".
      fs.writeSync(opts.fd, Buffer.from(
        `\n[agenfk] log truncated at ${formatBytes(maxLogBytes)} (AGENFK_VERIFY_MAX_LOG_BYTES). ` +
        `The command kept printing; the rest was discarded.\n`,
      ));
    } catch {
      // A failed log write must not cost the run its outcome. Diagnostics are
      // best-effort; the transition is not.
      logTruncated = true;
    }
  };

  const remember = (text: string) => {
    if (!text) return;
    if (head.length < CAPTURE_HEAD_BYTES) head += text.slice(0, CAPTURE_HEAD_BYTES - head.length);
    tail += text;
    if (tail.length > CAPTURE_TAIL_BYTES) tail = tail.slice(tail.length - CAPTURE_TAIL_BYTES);
  };

  return {
    write(chunk: Buffer) {
      totalBytes += chunk.length;
      toFile(chunk);
      remember(decoder.write(chunk));
    },
    note(text: string) {
      const buf = Buffer.from(text);
      totalBytes += buf.length;
      toFile(buf);
      remember(text);
    },
    live() { return head; },
    end() {
      remember(decoder.end());
      return { head, tail, totalBytes, logTruncated };
    },
  };
}
