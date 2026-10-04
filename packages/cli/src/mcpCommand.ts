import path from 'path';

/**
 * The command + args `claude mcp add ... -- agenfk <these>` registers for the
 * agenfk MCP server (BUG 3a939855).
 *
 * Claude Code starts an MCP server without a shell, and Node refuses a
 * .cmd/.bat without one (CVE-2024-27980), so on Windows the installer's
 * agenfk.cmd goes through `cmd /c` - the wrapper Claude Code's docs ask for on
 * native Windows. `platform` is required: the caller's choice is the thing
 * that goes wrong.
 *
 * Mirrors claudeMcpServerCommand in scripts/install-helpers.mjs, which the
 * installer uses; keep the two in step.
 */
export function claudeMcpServerCommand(platform: NodeJS.Platform, bin: string): string[] {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) return ['cmd', '/c', bin, 'mcp'];
  return [bin, 'mcp'];
}

/** The agenfk launcher the installer writes into ~/.local/bin on this platform. */
export function installedAgenfkBin(platform: NodeJS.Platform, home: string): string {
  return platform === 'win32'
    ? path.win32.join(home, '.local', 'bin', 'agenfk.cmd')
    : path.posix.join(home, '.local', 'bin', 'agenfk');
}
