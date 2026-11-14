/**
 * What a scenario can do: talk to the server as the CLI and the board do, run
 * the real CLI, and run shell commands in a sample project's tree.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const HOME = process.env.HOME;
export const port = () => readFileSync(join(HOME, '.agenfk', 'server-port'), 'utf8').trim();
export const base = () => `http://127.0.0.1:${port()}`;

/** REST call. `board: true` sends the header the Kanban board sends. */
export async function api(method, path, body, { board = false, headers = {} } = {}) {
  const send = () => fetch(base() + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(board ? { 'x-agenfk-ui': '1' } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let r;
  // cli() blocks this process's event loop (execFileSync) for a whole verify: a
  // keep-alive socket the server closed meanwhile is still pooled here, and the
  // next request dies on it. A GET is tried once more, on a fresh one; anything
  // else might have reached the server, and is never sent twice.
  try { r = await send(); } catch (e) { if (e?.cause?.code !== 'UND_ERR_SOCKET' || method !== 'GET') throw e; r = await send(); }
  let json = null;
  try { json = await r.json(); } catch { /* no body */ }
  return { status: r.status, body: json };
}

/** The real CLI, as an agent runs it. Returns { code, out }. */
export function cli(args, { cwd } = {}) {
  try {
    // The CLI itself; bin/agenfk.js is the npx installer bootstrap, never run it here.
    const out = execFileSync('node', ['/agenfk/packages/cli/dist/index.js', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

export const sh = (cmd, cwd) => execFileSync('sh', ['-c', cmd], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
