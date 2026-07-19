#!/usr/bin/env node
/**
 * Bump the monorepo version across every manifest in one shot.
 *
 * Usage:
 *   node scripts/bump-version.mjs <new-version>
 *   node scripts/bump-version.mjs 1.1.8-beta.6
 *
 * It rewrites:
 *   - root package.json `version`
 *   - every packages/*\/package.json `version`
 *   - every internal `@agenfk/*` reference in dependencies / devDependencies /
 *     peerDependencies / optionalDependencies that currently pins the OLD version
 *     (preserving any ^ / ~ range prefix)
 *
 * The OLD version is read from the root package.json, so callers only pass the new
 * one. After running this, regenerate the lockfile (npm install --package-lock-only)
 * and commit both in the same commit so manifest and lockfile never drift apart.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const NEW = process.argv[2];
if (!NEW) {
  console.error('Usage: node scripts/bump-version.mjs <new-version>');
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootPkgPath = path.join(root, 'package.json');
const OLD = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8')).version;
if (OLD === NEW) {
  console.error(`Root version is already ${NEW}; nothing to do.`);
  process.exit(1);
}

const pkgsDir = path.join(root, 'packages');
const files = [
  rootPkgPath,
  ...(fs.existsSync(pkgsDir)
    ? fs.readdirSync(pkgsDir)
        .map((d) => path.join(pkgsDir, d, 'package.json'))
        .filter((f) => fs.existsSync(f))
    : []),
];

const DEP_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const changed = [];

for (const f of files) {
  const raw = fs.readFileSync(f, 'utf8');
  const j = JSON.parse(raw);
  let touched = false;
  if (j.version === OLD) { j.version = NEW; touched = true; }
  for (const sec of DEP_SECTIONS) {
    if (!j[sec]) continue;
    for (const [k, v] of Object.entries(j[sec])) {
      if (k.startsWith('@agenfk/') && typeof v === 'string' && v.includes(OLD)) {
        j[sec][k] = v.replaceAll(OLD, NEW);
        touched = true;
      }
    }
  }
  if (touched) {
    fs.writeFileSync(f, JSON.stringify(j, null, 2) + (raw.endsWith('\n') ? '\n' : ''));
    changed.push(path.relative(root, f));
  }
}

console.log(`Bumped ${OLD} -> ${NEW} in:\n${changed.map((f) => `  ${f}`).join('\n')}`);
console.log('\nNext: regenerate the lockfile and commit both together, e.g.:');
console.log('  npm install --package-lock-only');
console.log(`  git add . && git commit -m "chore: bump version to ${NEW}"`);
