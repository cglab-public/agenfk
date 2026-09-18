/**
 * The server process actually starts.
 *
 * THE SUITE IMPORTS `app`; IT NEVER BOOTS THE PROCESS. That gap shipped a
 * server that could not start: a custom rate-limit key built from a bare
 * `req.ip` made express-rate-limit throw ERR_ERL_KEY_GEN_IPV6 at module load,
 * and the desktop app then waited sixty times for a server that was never
 * going to answer. Every test was green.
 *
 * This is the cheapest possible cover for that class: spawn the real entry
 * point and wait for it to say it is listening. It cannot catch everything a
 * running server does, and it catches the one thing a thousand unit tests
 * structurally cannot - that the module loads at all.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

const ENTRY = path.resolve(__dirname, '../../dist/server.js');

describe('the built server', () => {
  it('boots and reports that it is listening', async () => {
    if (!fs.existsSync(ENTRY)) {
      // Built output is not there in a bare `vitest` run against source. Say so
      // rather than passing: a skipped boot check reads exactly like a passing
      // one in the summary, which is the failure this file exists to stop.
      throw new Error(
        `${ENTRY} is missing. Run \`npm run build -w packages/server\` before this test; `
        + 'it is a check on the BUILT entry point, so there is nothing to check without it.',
      );
    }

    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-boot-')), 'db.sqlite');
    const child = spawn(process.execPath, [ENTRY], {
      env: {
        ...process.env,
        /*
         * The test environment is stripped ON PURPOSE. Inherited, the child
         * sees VITEST and NODE_ENV=test and takes the paths the suite takes -
         * it exited 0 without listening, which is not a boot and would have
         * made this file assert nothing while looking like it asserted a lot.
         *
         * A smoke test that runs the subject in test mode is testing the mode.
         */
        NODE_ENV: 'production',
        VITEST: undefined as unknown as string,
        VITEST_WORKER_ID: undefined as unknown as string,
        VITEST_POOL_ID: undefined as unknown as string,
        // A port nothing else in the suite uses, and its own database: booting
        // onto a shared one would make this test's failure depend on the order
        // it ran in.
        AGENFK_PORT: '3987',
        AGENFK_DB_PATH: dbPath,
        AGENFK_HUB_URL: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const output: string[] = [];
    const listening = new Promise<boolean>(resolve => {
      const onData = (b: Buffer): void => {
        const text = b.toString();
        output.push(text);
        if (/running on/i.test(text)) resolve(true);
        // A validation error from a middleware is thrown at module load, which
        // is before anything listens - catching it here names the cause instead
        // of leaving a timeout to say "did not respond".
        if (/ValidationError|ERR_ERL|Cannot find module/i.test(text)) resolve(false);
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      // The diagnostics that turn "did not respond" into a cause. A child that
      // fails to spawn, or exits, produces no output at all - and an empty
      // failure message is the thing that sent somebody hunting for fifteen
      // minutes last time.
      child.on('error', e => { output.push(`spawn error: ${String(e)}`); resolve(false); });
      child.on('exit', (code, signal) => {
        output.push(`child exited early: code=${code} signal=${signal}`);
        resolve(false);
      });
      setTimeout(() => { output.push('timed out with no output'); resolve(false); }, 20_000);
    });

    const ok = await listening;
    child.kill();
    expect(ok, `the server did not report listening:\n${output.join('')}`).toBe(true);
    expect(output.join(''), 'a middleware rejected its own configuration').not.toMatch(/ValidationError/);
  }, 30_000);
});
