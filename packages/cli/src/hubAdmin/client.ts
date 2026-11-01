import axios, { AxiosRequestConfig } from 'axios';
import chalk from 'chalk';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The admin CLI's credential and its one way of talking to the hub (CGLAB-702).
 *
 * The credential is a 12-hour admin bearer token, approved in the browser by
 * the admin it acts as. It lives in its own file, never in hub.json: hub.json
 * is the installation's key that every agent on the machine pushes events
 * with, and an admin's session must not ride along with it.
 */
export interface AdminCreds {
  url: string;
  token: string;
  orgId: string;
  email: string | null;
  role: string | null;
  expiresAt: string;
}

/** Resolved at call time, so a test (or a changed HOME) sees the right home. */
export function adminCredsFile(): string { return path.join(os.homedir(), '.agenfk', 'hub-admin.json'); }

export function readAdminCreds(): AdminCreds | null {
  try {
    const c = JSON.parse(fs.readFileSync(adminCredsFile(), 'utf8'));
    return c && typeof c.url === 'string' && typeof c.token === 'string' ? c as AdminCreds : null;
  } catch {
    return null;
  }
}

export function writeAdminCreds(c: AdminCreds): void {
  const file = adminCredsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(c, null, 2), { mode: 0o600 });
  // writeFileSync keeps an existing file's mode: set it, whatever was there.
  fs.chmodSync(file, 0o600);
}

export function clearAdminCreds(): void {
  fs.rmSync(adminCredsFile(), { force: true });
}

/** A failure the CLI reports in words and exits 1 on; never a stack trace. */
export class AdminCliError extends Error {}

const LOGIN_HINT = 'Run `agenfk hub admin login` to sign in.';

/** The signed-in credential, or an AdminCliError saying how to get one. */
export function requireAdminCreds(): AdminCreds {
  const c = readAdminCreds();
  if (!c) throw new AdminCliError(`Not signed in to a hub as an admin. ${LOGIN_HINT}`);
  return c;
}

export interface AdminRequest {
  params?: Record<string, unknown>;
  body?: unknown;
  /** 'text' for a CSV export and the like; JSON otherwise. */
  responseType?: 'json' | 'text';
}

/**
 * One call to the hub as the signed-in admin. Every failure becomes an
 * AdminCliError that says what to do: sign in again (401), you are not an
 * admin (403), the hub is unreachable, or the hub's own words.
 */
export async function adminRequest<T = any>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', urlPath: string, req: AdminRequest = {}): Promise<T> {
  const creds = requireAdminCreds();
  const config: AxiosRequestConfig = {
    method,
    url: `${creds.url}${urlPath}`,
    headers: { Authorization: `Bearer ${creds.token}` },
    params: req.params,
    data: req.body,
    responseType: req.responseType ?? 'json',
    timeout: 30_000,
  };
  try {
    const { data } = await axios.request<T>(config);
    return data;
  } catch (e: any) {
    throw toAdminCliError(e, creds.url);
  }
}

export function toAdminCliError(e: any, url: string): AdminCliError {
  const status: number | undefined = e?.response?.status;
  const said = typeof e?.response?.data?.error === 'string' ? e.response.data.error : null;
  if (status === undefined) return new AdminCliError(`Could not reach the hub at ${url}: ${e?.message ?? e}`);
  if (status === 401) return new AdminCliError(`Your admin CLI session is expired or revoked. ${LOGIN_HINT}`);
  if (status === 403) return new AdminCliError(said ?? 'Admin role required.');
  return new AdminCliError(`The hub answered ${status}${said ? `: ${said}` : ''}`);
}

/** Wraps a command's action: an AdminCliError is printed and exits 1; anything else propagates. */
export function adminAction<A extends unknown[]>(fn: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (e) {
      if (!(e instanceof AdminCliError)) throw e;
      console.error(chalk.red(e.message));
      process.exit(1);
    }
  };
}

/** Prints `data` as JSON with --json, else through `human`. */
export function emit<T>(data: T, opts: { json?: boolean }, human: (d: T) => void): void {
  if (opts.json) console.log(JSON.stringify(data, null, 2));
  else human(data);
}

/** A destructive change runs only with --yes; without it, says so and changes nothing. */
export function requireYes(opts: { yes?: boolean }, what: string): void {
  if (!opts.yes) throw new AdminCliError(`Refusing to ${what} without --yes. Re-run with --yes to confirm.`);
}
