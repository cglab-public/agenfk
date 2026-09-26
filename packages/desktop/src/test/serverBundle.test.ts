/**
 * @vitest-environment node
 *
 * CGLAB-171: the packaged server must carry its own dependencies.
 *
 * This is the bug the whole packaging exercise exists to find, and it is
 * invisible everywhere else. In the monorepo the server's dependencies —
 * express, socket.io, axios — are hoisted into the ROOT node_modules, so
 * `node packages/server/dist/server.js` works on a dev machine. The packaged
 * app ships `packages/server/dist` and a package.json and nothing else, so the
 * first thing the forked server does is die with `Cannot find module
 * 'express'`. Every unit test passes; the .app is broken.
 *
 * The test that catches it has to run the server the way the packaged app
 * does: from a directory with no node_modules anywhere above it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(here, '../..');
const bundleDir = path.join(desktopDir, 'build', 'server-bundle');
const bundleEntry = path.join(bundleDir, 'server.js');

/** Somewhere with no node_modules above it — like an installed .app. */
let isolated: string;

beforeAll(() => {
  execFileSync('node', [path.join(desktopDir, 'scripts', 'bundle-server.mjs')], {
    cwd: desktopDir,
    stdio: 'pipe',
  });
  isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-isolated-'));
}, 120_000);

afterAll(() => {
  if (isolated) fs.rmSync(isolated, { recursive: true, force: true });
});

describe('the bundled server', () => {
  it('is produced by the packaging script', () => {
    expect(fs.existsSync(bundleEntry)).toBe(true);
    expect(fs.statSync(bundleEntry).size).toBeGreaterThan(100_000);
  });

  it('carries its third-party dependencies instead of requiring them', () => {
    const source = fs.readFileSync(bundleEntry, 'utf8');
    for (const dep of ['express', 'socket.io', 'axios', 'cors', 'body-parser']) {
      expect(
        source.includes(`require("${dep}")`),
        `${dep} is still required at runtime — it will be missing in the packaged app`,
      ).toBe(false);
    }
  });

  it('still leaves node builtins external, node:sqlite included', () => {
    // Bundling a builtin is impossible and would be wrong; storage needs the
    // real node:sqlite from Electron's Node 24.
    const source = fs.readFileSync(bundleEntry, 'utf8');
    expect(source).toMatch(/require\("node:sqlite"\)|from"node:sqlite"/);
  });

  it('starts from a directory with no node_modules — the packaged case', async () => {
    const db = path.join(isolated, 'test.sqlite');
    const child = spawn(process.execPath, [bundleEntry], {
      cwd: isolated,
      env: {
        ...process.env,
        AGENFK_DB_PATH: db,
        AGENFK_PORT: '3977',
        NODE_ENV: 'production',
        NODE_PATH: '',
        // Cleared deliberately: server.ts skips its listen block entirely when
        // it sees VITEST, so inheriting it makes the child exit at once and
        // the test fail for a reason that has nothing to do with bundling.
        VITEST: '',
        VITEST_WORKER_ID: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.on('data', d => { output += d.toString(); });
    child.stderr.on('data', d => { output += d.toString(); });

    const started = await new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(false), 25_000);
      child.stdout.on('data', () => {
        if (/API Server running/.test(output)) { clearTimeout(timer); resolve(true); }
      });
      child.on('exit', () => { clearTimeout(timer); resolve(false); });
    });

    child.kill('SIGTERM');

    expect(output, 'the bundled server could not resolve a dependency').not.toMatch(/Cannot find module/);
    expect(started, `server never reported listening. Output:\n${output.slice(0, 800)}`).toBe(true);
  }, 40_000);
});
