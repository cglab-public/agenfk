/**
 * Conformance driver for airlock-sandbox-conformance.test.ts (GH-294, L2-3).
 *
 * Runs in its own process: the Sandbox Runtime's proxy dials real hosts, which
 * the test worker's net guard (rightly) forbids. Reads one request (a JSON file
 * named on argv), writes one JSON answer on stdout.
 *
 *   { mode: 'check' }                      platform support and dependencies
 *   { mode: 'preflight', urls, lookup }    reachability OUTSIDE any sandbox
 *   { mode: 'run', config, commands }      each command wrapped and run inside
 */
import fs from 'fs';
import dns from 'dns/promises';
import { createRequire } from 'module';
import { spawn } from 'child_process';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';

const require = createRequire(import.meta.url);
const request = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const answer = (o) => { process.stdout.write(JSON.stringify(o)); };

function run(argv, env, cwd, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: null, signal: null, stdout, stderr: String(e) }); });
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

async function main() {
  if (request.mode === 'check') {
    const version = JSON.parse(fs.readFileSync(require.resolve('@anthropic-ai/sandbox-runtime/package.json'), 'utf8')).version;
    const deps = SandboxManager.checkDependencies();
    return answer({ version, supported: SandboxManager.isSupportedPlatform(), errors: deps.errors, warnings: deps.warnings });
  }
  if (request.mode === 'preflight') {
    const reachable = {};
    for (const url of request.urls) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        reachable[url] = res.status < 500;
      } catch {
        reachable[url] = false;
      }
    }
    const addresses = {};
    for (const host of request.lookup ?? []) {
      try { addresses[host] = (await dns.lookup(host, { family: 4 })).address; } catch { addresses[host] = null; }
    }
    return answer({ reachable, addresses });
  }
  if (request.mode === 'run') {
    await SandboxManager.initialize(request.config);
    const results = [];
    try {
      for (const c of request.commands) {
        const wrapped = await SandboxManager.wrapWithSandboxArgv(c.line, undefined, undefined, undefined, c.cwd);
        // A pseudo-terminal around the wrapped command (macOS `script`), for the TUI check.
        const argv = c.pty ? ['/usr/bin/script', '-q', '/dev/null', ...wrapped.argv] : wrapped.argv;
        results.push({ name: c.name, ...(await run(argv, wrapped.env, c.cwd)) });
      }
    } finally {
      await SandboxManager.reset();
    }
    return answer(results);
  }
  throw new Error(`unknown mode ${request.mode}`);
}

main().then(() => process.exit(0), (e) => {
  process.stdout.write(JSON.stringify({ driverError: String(e?.stack ?? e) }));
  process.exit(0);
});
