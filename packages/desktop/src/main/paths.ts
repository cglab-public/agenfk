/**
 * Where the desktop app finds the pieces it ships with.
 *
 * Two layouts exist and must both work: a source checkout, where this file is
 * <repo>/packages/desktop/dist/main/, and a packaged app, where the same
 * artefacts are copied under process.resourcesPath by electron-builder.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface DesktopPaths {
  /** packages/server/dist/server.js — the API server entry we fork. */
  serverEntry: string;
  /** packages/ui/dist — the built bundle the server serves. */
  uiDir: string;
}

/**
 * Resolve against the first root that actually contains the server entry, so a
 * missing build fails with "server bundle not found" naming every place we
 * looked, rather than ENOENT on a path the reader has to reverse-engineer.
 */
export function resolveDesktopPaths(opts: {
  dirname: string;
  resourcesPath?: string;
  packaged?: boolean;
}): DesktopPaths {
  const { dirname, resourcesPath, packaged } = opts;

  const roots = [
    // Packaged: electron-builder copies packages/* into resources/packages.
    packaged && resourcesPath ? path.join(resourcesPath, 'packages') : null,
    // Source checkout: dist/main -> packages/desktop -> packages
    path.resolve(dirname, '../../..'),
  ].filter(Boolean) as string[];

  const found = roots.find(r => fs.existsSync(path.join(r, 'server', 'dist', 'server.js')));
  if (!found) {
    throw new Error(
      `AgEnFK server bundle not found. Looked in:\n  ${roots.join('\n  ')}\n` +
      `Run \`npm run build\` at the repo root first.`,
    );
  }

  return {
    serverEntry: path.join(found, 'server', 'dist', 'server.js'),
    uiDir: path.join(found, 'ui', 'dist'),
  };
}
