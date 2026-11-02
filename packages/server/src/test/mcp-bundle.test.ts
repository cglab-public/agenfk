/**
 * CGLAB-696 story review 2 (DEL-1): AgEnFK's MCP client, bundled into one file, so an OpenCode
 * session in an Airlock machine - which has none of the host's install - can run it there.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { spawn } from 'child_process';
// @ts-ignore - a plain .mjs build script
import { bundleMcp } from '../../scripts/bundle-mcp.mjs';

describe('the MCP bundle', () => {
  it('runs on its own - no repository, no node_modules - and answers a tool call through AGENFK_API_URL', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-mcp-bundle-'));
    const seen: string[] = [];
    const api = http.createServer((q, r) => { seen.push(q.url ?? ''); r.setHeader('content-type', 'application/json'); r.end('[]'); });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()));
    try {
      const out = path.join(dir, 'packages', 'server', 'dist', 'index.js');
      await bundleMcp(out);
      const port = (api.address() as { port: number }).port;
      const child = spawn(process.execPath, [out], { cwd: dir, env: { PATH: process.env.PATH, HOME: dir, AGENFK_API_URL: `http://127.0.0.1:${port}` }, stdio: ['pipe', 'pipe', 'pipe'] });
      let buf = '';
      const answers = new Map<number, any>();
      child.stdout.setEncoding('utf8').on('data', (d: string) => {
        buf += d;
        for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          try { const m = JSON.parse(line); if (typeof m.id === 'number') answers.set(m.id, m); } catch { /* not a message */ }
        }
      });
      const send = (m: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
      send({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
      send({ method: 'notifications/initialized' });
      send({ id: 2, method: 'tools/list' });
      send({ id: 3, method: 'tools/call', params: { name: 'list_projects', arguments: {} } });
      for (let i = 0; i < 200 && !answers.has(3); i++) await new Promise((r) => setTimeout(r, 50));
      child.kill();
      expect(answers.get(2)?.result?.tools?.some((t: { name: string }) => t.name === 'list_projects')).toBe(true);
      expect(answers.get(3)?.result).toBeDefined();
      expect(seen).toContain('/projects');
    } finally {
      await new Promise<void>((r) => api.close(() => r()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
