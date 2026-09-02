#!/usr/bin/env node
/**
 * Home-integrity sentinel (item 9c297075).
 *
 * The 2026-08-31 hub.json clobber went unnoticed for days because nothing
 * detected that ~/.agenfk had been overwritten by a test fixture. This
 * sentinel snapshots the protected home files before a test run and fails the
 * run on any drift (changed / added / removed).
 *
 * Usage:
 *   node scripts/home-integrity.mjs snapshot   # writes a snapshot to $TMPDIR
 *   node scripts/home-integrity.mjs verify     # compares and exits 1 on drift
 *
 * Only the small credential/config files are protected. DB files
 * (db.sqlite*, backup/) are excluded by design — they churn legitimately.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';

export const PROTECTED_FILES = [
  'hub.json',
  'verify-token',
  'config.json',
  'installation-id',
  'server-port',
  'hub-deadletter.jsonl',
  'hub-audit.jsonl',
  'jira-token.json',
  'migration.json',
];

const SNAPSHOT_FILE = path.join(os.tmpdir(), 'agenfk-home-snapshot-latest.json');

function entry(homeDir, file) {
  try {
    const p = path.join(homeDir, '.agenfk', file);
    const st = fs.statSync(p);
    if (!st.isFile()) return null;
    const sha = createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    return { size: st.size, sha };
  } catch {
    return null; // absent (or not a regular file)
  }
}

/** Snapshot the protected files under <homeDir>/.agenfk. */
export function snapshotHome(homeDir = os.homedir()) {
  const snap = {};
  for (const f of PROTECTED_FILES) snap[f] = entry(homeDir, f);
  return snap;
}

/** Compare the current state against a snapshot. Drift = changed/added/removed. */
export function verifyHome(homeDir, snapshot) {
  const drift = [];
  for (const f of Object.keys(snapshot)) {
    const was = snapshot[f];
    const now = entry(homeDir, f);
    if (was === null && now !== null) drift.push(f); // added
    else if (was !== null && now === null) drift.push(f); // removed
    else if (was !== null && (now.sha !== was.sha || now.size !== was.size)) drift.push(f); // changed
  }
  return { ok: drift.length === 0, drift };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const [, , cmd] = process.argv;
  if (cmd === 'snapshot') {
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshotHome(), null, 2));
    console.log(`home integrity snapshot written (${SNAPSHOT_FILE})`);
  } else if (cmd === 'verify') {
    if (!fs.existsSync(SNAPSHOT_FILE)) {
      console.error('no snapshot found — run `node scripts/home-integrity.mjs snapshot` first');
      process.exit(2);
    }
    const snap = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
    const res = verifyHome(os.homedir(), snap);
    if (!res.ok) {
      console.error('✗ HOME INTEGRITY DRIFT — something touched the real ~/.agenfk:');
      for (const f of res.drift) console.error(`   ${f}`);
      process.exit(1);
    }
    console.log('home integrity ok');
  } else {
    console.error('usage: node scripts/home-integrity.mjs snapshot | verify');
    process.exit(2);
  }
}
