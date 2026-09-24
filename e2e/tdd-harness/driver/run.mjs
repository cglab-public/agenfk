/**
 * The TDD harness driver: runs every scenario, prints the report, exits with
 * its verdict. Scenarios live in ./scenarios/*.mjs, each exporting an array of
 * { name, check, expected, run(ctx) -> { actual, detail } }.
 */
import { readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evaluate } from './report.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const only = process.argv[2];
const results = [];
for (const file of readdirSync(join(here, 'scenarios')).filter(f => f.endsWith('.mjs')).sort()) {
  const { scenarios } = await import(pathToFileURL(join(here, 'scenarios', file)).href);
  for (const s of scenarios) {
    if (only && !`${file} ${s.check} ${s.name}`.includes(only)) continue;
    let actual, detail;
    try {
      ({ actual, detail } = await s.run());
    } catch (e) {
      actual = 'error';
      detail = e?.stack ?? String(e);
    }
    results.push({ scenario: s.name, check: s.check, expected: s.expected, actual, detail });
  }
}
const report = evaluate(results);
console.log(`\nAgEnFK TDD harness\n${report.lines.join('\n')}\n\n${report.summary}`);
writeFileSync('/work/report.json', JSON.stringify({ ...report, results }, null, 2));
process.exit(report.exitCode);
