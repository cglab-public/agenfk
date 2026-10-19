// The installer command bin/agenfk.js runs, with the flags it forwards
// (INFRA-463: --no-hub joined them). Only known flags pass, in a fixed order,
// so nothing from argv reaches the shell unchecked.
const FORWARDED = ['--rebuild', '--beta', '--with-mcp', '--no-mcp', '--no-hub', '--debuglog'];

export function installCommand(argv) {
  return ['node scripts/install.mjs', ...FORWARDED.filter(f => argv.includes(f))].join(' ');
}
