#!/usr/bin/env node
import { createHubApp, configFromEnv } from './server.js';

const PORT = Number.parseInt(process.env.AGENFK_HUB_PORT || '4000', 10);
const cfg = configFromEnv();
const { app } = createHubApp(cfg);
app.listen(PORT, () => {
  console.log(`[AGENFK_HUB] listening on :${PORT} (db=${cfg.dbPath}, org=${cfg.defaultOrgId})`);
});
