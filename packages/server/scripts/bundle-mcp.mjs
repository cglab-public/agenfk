/**
 * AgEnFK's MCP client (src/index.ts, which only calls the REST API) bundled into one file that runs
 * with no install beside it (CGLAB-696 story review 2): what an OpenCode session in an Airlock
 * machine runs, the machine having none of the host's install. `npm run build` writes
 * dist/mcp-bundle.js.
 */
import { build } from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, '..');
const packages = path.resolve(pkg, '..');

export async function bundleMcp(outfile = path.join(pkg, 'dist', 'mcp-bundle.js')) {
  await build({
    // index.ts starts its stdio transport when it is the main module, which it is in the bundle.
    entryPoints: [path.join(pkg, 'src', 'index.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    // The workspace's own packages from their sources: no build of theirs is needed first.
    alias: {
      '@agenfk/core': path.join(packages, 'core', 'src', 'index.ts'),
      '@agenfk/telemetry': path.join(packages, 'telemetry', 'src', 'index.ts'),
    },
    logLevel: 'warning',
  });
  return outfile;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await bundleMcp(process.argv[2] ? path.resolve(process.argv[2]) : undefined);
}
