#!/usr/bin/env node
import { createHubApp, configFromEnv } from './server.js';

async function main() {
  const PORT = Number.parseInt(process.env.AGENFK_HUB_PORT || '4000', 10);
  const cfg = configFromEnv();
  const { app, ctx } = await createHubApp(cfg);
  const server = app.listen(PORT, () => {
    console.log(`[AGENFK_HUB] listening on :${PORT} (db=${cfg.dbPath}, org=${cfg.defaultOrgId})`);
  });

  // Without this the background workers keep ticking through shutdown and can
  // touch the database after it closes. The comment on ctx.stopWorkers claimed
  // a graceful shutdown existed; this is it.
  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`[AGENFK_HUB] ${signal} — shutting down`);
    ctx.stopWorkers?.();
    server.close(() => {
      void ctx.db.close().finally(() => process.exit(0));
    });
    // Do not wait forever on lingering keep-alive sockets.
    setTimeout(() => process.exit(0), 10_000).unref?.();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[AGENFK_HUB] fatal:', err);
  process.exit(1);
});
