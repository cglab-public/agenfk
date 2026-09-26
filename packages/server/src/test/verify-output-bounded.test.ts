/**
 * @file BUG 24c679df — a verbose verifyCommand must not be buffered whole.
 *
 * `runCommandAndFinalize` accumulated the ENTIRE stdout+stderr of an arbitrary
 * user-configured command in one JS string. `LIVE_CAP` bounded only the copy
 * handed to run followers; the string itself was unbounded, and then
 * `writeValidationLog` needed all of it again to write the file and
 * `buildOutputPreview` sliced it. The server is the single writer of state for
 * every client — CLI, MCP and UI — so one `npm install --loglevel silly`, one
 * build with a runaway progress loop, or one suite dumping diffs took down
 * everybody's session, and left the async run `running` with no outcome.
 *
 * The contract: stream to the log file, keep only a bounded head and tail in
 * memory, report the true total, and bound the FILE as well so a runaway
 * command cannot fill the disk either.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createOutputCapture, CAPTURE_HEAD_BYTES, CAPTURE_TAIL_BYTES } from '../verifyCapture';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-capture-'));

describe('bounded output capture', () => {
  it('keeps memory bounded no matter how much the command prints', () => {
    const dir = tmp();
    const file = path.join(dir, 'out.log');
    const fd = fs.openSync(file, 'w');
    const cap = createOutputCapture({ fd });

    // 64 MB in 64 KB chunks. The old code held every byte of this, twice.
    const chunk = Buffer.alloc(64 * 1024, 0x61); // 'a'
    for (let i = 0; i < 1024; i++) cap.write(chunk);
    const out = cap.end();

    expect(out.totalBytes).toBe(64 * 1024 * 1024);
    // The whole point: what is retained is a fixed budget, not a fraction.
    expect(out.head.length).toBeLessThanOrEqual(CAPTURE_HEAD_BYTES);
    expect(out.tail.length).toBeLessThanOrEqual(CAPTURE_TAIL_BYTES);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the FIRST bytes in the head and the LAST bytes in the tail', () => {
    const dir = tmp();
    const fd = fs.openSync(path.join(dir, 'out.log'), 'w');
    const cap = createOutputCapture({ fd });
    cap.write(Buffer.from('FIRST\n'));
    cap.write(Buffer.alloc(200_000, 0x62));
    cap.write(Buffer.from('\nLAST\n'));
    const out = cap.end();

    expect(out.head.startsWith('FIRST')).toBe(true);
    expect(out.tail.endsWith('LAST\n')).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes the whole output to the log file when it is under the ceiling', () => {
    const dir = tmp();
    const file = path.join(dir, 'out.log');
    const fd = fs.openSync(file, 'w');
    const cap = createOutputCapture({ fd });
    for (let i = 0; i < 100; i++) cap.write(Buffer.from(`line ${i}\n`));
    const out = cap.end();

    expect(out.logTruncated).toBe(false);
    const written = fs.readFileSync(file, 'utf8');
    expect(written.split('\n').filter(Boolean)).toHaveLength(100);
    expect(written).toContain('line 99');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('bounds the disk too, and SAYS it did', () => {
    // Streaming to the file fixes memory but hands the runaway command the
    // disk instead. The ceiling is explicit and the file admits to it, rather
    // than being silently short.
    const dir = tmp();
    const file = path.join(dir, 'out.log');
    const fd = fs.openSync(file, 'w');
    const cap = createOutputCapture({ fd, maxLogBytes: 4096 });
    cap.write(Buffer.alloc(100_000, 0x63));
    const out = cap.end();

    expect(out.logTruncated).toBe(true);
    expect(out.totalBytes).toBe(100_000); // the TRUE total, not what fit
    const size = fs.statSync(file).size;
    expect(size).toBeLessThan(8192);
    expect(fs.readFileSync(file, 'utf8')).toMatch(/truncated/i);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('says so when one chunk exactly fills the ceiling and the next is dropped', () => {
    // Under load a pipe coalesces into exact 64 KiB reads, so a chunk landing
    // precisely on the cap is common - and the next chunk used to be dropped by
    // an early return that never set the flag or wrote the notice. The log was
    // silently short, which reads as "the command stopped there".
    const dir = tmp();
    const file = path.join(dir, 'out.log');
    const fd = fs.openSync(file, 'w');
    const cap = createOutputCapture({ fd, maxLogBytes: 65_536 });
    cap.write(Buffer.alloc(65_536, 0x61));
    cap.write(Buffer.from('b'));
    const out = cap.end();

    expect(out.logTruncated).toBe(true);
    expect(out.totalBytes).toBe(65_537);
    expect(fs.readFileSync(file, 'utf8')).toMatch(/log truncated at .*AGENFK_VERIFY_MAX_LOG_BYTES/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not claim truncation when the output is exactly the ceiling and nothing more', () => {
    const dir = tmp();
    const file = path.join(dir, 'out.log');
    const fd = fs.openSync(file, 'w');
    const cap = createOutputCapture({ fd, maxLogBytes: 65_536 });
    cap.write(Buffer.alloc(65_536, 0x61));
    const out = cap.end();

    expect(out.logTruncated).toBe(false);
    expect(fs.statSync(file).size).toBe(65_536);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not split a multi-byte character across chunk boundaries', () => {
    // toString() per chunk mangles any character whose bytes straddle the
    // boundary, and a test suite printing a check mark or an em dash is
    // ordinary.
    const dir = tmp();
    const fd = fs.openSync(path.join(dir, 'out.log'), 'w');
    const cap = createOutputCapture({ fd });
    const bytes = Buffer.from('héllo — wörld ✓');
    cap.write(bytes.subarray(0, 2));
    cap.write(bytes.subarray(2));
    const out = cap.end();

    expect(out.head).toBe('héllo — wörld ✓');
    expect(out.head).not.toContain('�');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('still works with no log file at all', () => {
    // The log root can be refused (foreign-owned, unwritable). That must cost
    // the diagnostics, never the run.
    const cap = createOutputCapture({ fd: null });
    cap.write(Buffer.from('no file for this one\n'));
    const out = cap.end();
    expect(out.totalBytes).toBe(21);
    expect(out.head).toContain('no file for this one');
  });

  it('writes to the file AS IT GOES, rather than at the end', () => {
    // The whole claim. Every other assertion here reads the file after end(),
    // and a buffer-it-all-then-write-once implementation satisfies all of them.
    const dir = tmp();
    const file = path.join(dir, 'out.log');
    const fd = fs.openSync(file, 'w');
    const cap = createOutputCapture({ fd });

    cap.write(Buffer.from('arrived early\n'));
    expect(fs.statSync(file).size).toBeGreaterThan(0);

    cap.end();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses everything after end(), and closes the fd itself', () => {
    // An orphaned grandchild still holds the inherited pipe and keeps firing
    // the data handler long after a cap-killed run was answered — resolution
    // happens on 'exit', which fires BEFORE stdio drains. Writing then goes to
    // a CLOSED fd number, which the OS has already reissued: measured, the
    // orphan's output landed in the next file this process opened.
    const dir = tmp();
    const logFile = path.join(dir, 'out.log');
    const fd = fs.openSync(logFile, 'w');
    const cap = createOutputCapture({ fd });
    cap.write(Buffer.from('during the run\n'));
    const out = cap.end();

    // The fd number is now free, so claim it for something else.
    const victimFile = path.join(dir, 'victim.txt');
    const victimFd = fs.openSync(victimFile, 'w');

    cap.write(Buffer.from('ORPHAN GRANDCHILD OUTPUT\n'));
    cap.note('and a note too\n');
    fs.closeSync(victimFd);

    expect(fs.readFileSync(victimFile, 'utf8')).toBe('');
    expect(fs.readFileSync(logFile, 'utf8')).toBe('during the run\n');
    // The snapshot is frozen too — the late bytes are not counted.
    expect(cap.end().totalBytes).toBe(out.totalBytes);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('end() is idempotent, so a second close cannot hit a reused descriptor', () => {
    const dir = tmp();
    const fd = fs.openSync(path.join(dir, 'out.log'), 'w');
    const cap = createOutputCapture({ fd });
    cap.write(Buffer.from('once\n'));
    expect(() => { cap.end(); cap.end(); cap.end(); }).not.toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a failed write is reported as a failed write, not as the ceiling', () => {
    // ENOSPC and a deliberate cap are different problems with different fixes.
    // Reporting both as the ceiling sends the operator to tune an env var that
    // is not the answer.
    const dir = tmp();
    const fd = fs.openSync(path.join(dir, 'out.log'), 'w');
    const cap = createOutputCapture({ fd });
    fs.closeSync(fd); // the write will now fail with EBADF
    cap.write(Buffer.from('this cannot land\n'));
    const out = cap.end();

    expect(out.logWriteError).toBeTruthy();
    expect(out.logTruncated).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('says the head is complete when it holds everything, multi-byte included', () => {
    // The budgets are counted in UTF-16 code units and the total in bytes, so
    // for multi-byte output the head can already hold the lot while totalBytes
    // says otherwise. A preview that stitches head+tail then duplicates the
    // whole output and claims it truncated something.
    const cap = createOutputCapture({ fd: null });
    cap.write(Buffer.from('日本語のテスト'));
    const out = cap.end();
    expect(out.headIsComplete).toBe(true);
    expect(out.totalBytes).toBeGreaterThan(out.head.length);
  });
});
