/**
 * @vitest-environment node
 *
 * The preload must arrive as ONE file (CGLAB f2fa8fc4 regression).
 *
 * The renderer runs with `sandbox: true`, and a sandboxed preload cannot
 * `require` a local file — it gets `electron` and a few polyfilled builtins,
 * and nothing else.
 *
 * Splitting the session demux into its own module was right for testing and
 * broke the packaged app completely: the require threw, `exposeInMainWorld`
 * never ran, `window.agenfkDesktop` never appeared, and `isDesktop()` answered
 * false. The app fell back to the BROWSER shell — a bare board with no
 * sidebar, no tabs, no terminal — which reads as a build that never happened
 * rather than as a bridge that failed.
 *
 * NOTHING IN THE SUITE COULD SEE IT. The modules were right, the types were
 * right, the file was in the asar, 411 desktop tests were green. It only
 * appears when the packaged app runs, which is the worst place to find out.
 *
 * So this reads the BUILD OUTPUT rather than the source: what ships is the
 * only thing that matters here.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const built = path.resolve(here, '../../dist/preload/index.js');
const read = () => fs.readFileSync(built, 'utf8');

describe('the built preload', () => {
  it('exists, so this cannot pass by reading nothing', () => {
    // The trap every source-reading test has. An absent file would make every
    // assertion below vacuously true.
    expect(fs.existsSync(built), `not built: ${built}. Run npm run build -w packages/desktop`).toBe(true);
    expect(read().length).toBeGreaterThan(1000);
  });

  it('requires nothing but electron', () => {
    /*
     * THE assertion. A sandboxed preload may reach `electron` and the
     * polyfilled builtins; a relative require throws at load and takes the
     * whole bridge with it.
     */
    const required = [...read().matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map(m => m[1]);
    const local = required.filter(r => r.startsWith('.') || r.startsWith('/'));
    expect(local, 'a sandboxed preload cannot require a local file').toEqual([]);
  });

  it('still exposes the bridge', () => {
    // If bundling ever dropped the call, the symptom is identical to the bug
    // this file guards: a browser shell inside the desktop app.
    expect(read()).toContain('exposeInMainWorld');
  });

  it('carries the demux it was split into', () => {
    // Proof the bundle INLINED the module rather than losing it. Without this,
    // an empty bundle would satisfy both assertions above.
    expect(read()).toContain('pty:data');
    expect(read()).toMatch(/bySession|sessionId/);
  });
});

describe('the window that loads it', () => {
  it('is still sandboxed, which is why the rule above exists', () => {
    /*
     * Read from the main process source. If sandbox were ever turned off, the
     * bundling requirement would disappear with it — and so should this file,
     * rather than being left asserting a constraint that no longer applies.
     */
    const main = fs.readFileSync(path.resolve(here, '../main/index.ts'), 'utf8');
    expect(main).toMatch(/sandbox:\s*true/);
  });
});
