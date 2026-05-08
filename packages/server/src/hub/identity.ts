import * as os from 'os';
import { execFileSync } from 'child_process';
import { HubActor } from '@agenfk/core';

const cache = new Map<string, HubActor>();

function readGitConfig(cwd: string, key: string): string | null {
  try {
    const out = execFileSync('git', ['config', '--get', key], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

export function resolveActor(cwd: string = process.cwd()): HubActor {
  const cached = cache.get(cwd);
  if (cached) return cached;
  const actor: HubActor = {
    osUser: os.userInfo().username,
    gitName: readGitConfig(cwd, 'user.name'),
    gitEmail: readGitConfig(cwd, 'user.email'),
  };
  cache.set(cwd, actor);
  return actor;
}

// Test-only: forget cached identities so a new process env is honored.
export function _resetActorCache(): void {
  cache.clear();
}
