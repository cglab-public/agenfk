/**
 * The real-smolvm tests' broker: the built decider (dist/airlock/egressMain.js)
 * as a detached process, smolvm's audit found through its data dir. Those tests
 * run only with AGENFK_SMOLVM_TESTS=1 after `npm run build`.
 */
import path from 'path';
import fs from 'fs';
import { spawn, spawnSync } from 'child_process';
import { HelperEgressBroker } from '../../airlock/egress';

export const DIST_EGRESS_HELPER = path.resolve(__dirname, '..', '..', '..', 'dist', 'airlock', 'egressMain.js');

/** Whether the real-smolvm tests can run here. */
export const smolvmTestsEnabled = (): boolean => process.env.AGENFK_SMOLVM_TESTS === '1' && fs.existsSync(DIST_EGRESS_HELPER);

export function realBroker(stateDir: string): HelperEgressBroker {
  return new HelperEgressBroker({
    stateDir,
    auditPathOf: async (machine) => {
      const r = spawnSync('smolvm', ['machine', 'data-dir', '--name', machine], { encoding: 'utf8' });
      return r.status === 0 ? path.join(r.stdout.trim(), 'egress-decisions.jsonl') : null;
    },
    startHelper: async (_m, configPath) => {
      const child = spawn(process.execPath, [DIST_EGRESS_HELPER, configPath], { detached: true, stdio: 'ignore' });
      child.unref();
      return child.pid as number;
    },
    pidAlive: (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } },
    kill: (pid, sig) => { try { process.kill(pid, sig); } catch { /* gone */ } },
  });
}
