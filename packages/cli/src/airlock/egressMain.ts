/**
 * The egress decider of one running smolvm machine (CGLAB-696), as a process of
 * its own so it outlives the session that started the machine:
 *   node egressMain.js <config.json>
 * It listens on the loopback, writes its address where the config says once it
 * does, appends each decision as a JSON line, and ends on SIGTERM.
 */
import fs from 'fs';
import { EgressService, readRoutes, type EgressConfig } from './egress';

/** The whole buffer, or a throw: a short write (a full disk) is a failure, never half a line. */
export function writeAll(fd: number, buf: Buffer, write: typeof fs.writeSync = fs.writeSync): void {
  for (let off = 0; off < buf.length;) {
    const n = write(fd, buf, off, buf.length - off);
    if (!(n > 0)) throw new Error('the decision log took no more bytes');
    off += n;
  }
}

async function main(configPath: string): Promise<void> {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as EgressConfig;
  const out = fs.openSync(config.decisionsPath, 'a', 0o600);
  const service = new EgressService({
    token: config.token,
    network: config.network,
    auditPath: config.auditPath,
    // Written before the flow is answered: a decision that cannot be written refuses its flow.
    record: (d) => writeAll(out, Buffer.from(`${JSON.stringify({ ...d, ts: new Date().toISOString() })}\n`)),
    onDecision: () => undefined,
    routes: () => readRoutes(config.routesDir),
  });
  const address = await service.listen();
  // Written whole, so the broker never reads half an address.
  fs.writeFileSync(`${config.addressPath}.tmp`, address, { mode: 0o600 });
  fs.renameSync(`${config.addressPath}.tmp`, config.addressPath);
  const end = () => { void service.close().finally(() => process.exit(0)); };
  process.once('SIGTERM', end);
  process.once('SIGINT', end);
}

if (require.main === module) main(process.argv[2]).catch((e) => {
  process.stderr.write(`agenfk egress decider: ${(e as Error)?.message ?? e}\n`);
  process.exit(1);
});
