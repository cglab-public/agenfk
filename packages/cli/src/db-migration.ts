import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Detects a legacy db.json in agenfkHome and stages it as migration.json
 * in ~/.agenfk/ so the server imports it into SQLite on next startup.
 *
 * @returns true if migration was staged, false otherwise
 */
export function stageJsonMigration(agenfkHome: string): boolean {
  const dbJsonPath = path.join(agenfkHome, 'db.json');
  if (!fs.existsSync(dbJsonPath)) return false;

  const migrationPath = path.join(os.homedir(), '.agenfk', 'migration.json');

  // Do not overwrite an already-staged migration.json
  if (fs.existsSync(migrationPath)) return false;

  try {
    const raw = fs.readFileSync(dbJsonPath, 'utf8');
    const data = JSON.parse(raw);

    const agenfkHome2 = path.join(os.homedir(), '.agenfk');
    if (!fs.existsSync(agenfkHome2)) fs.mkdirSync(agenfkHome2, { recursive: true });

    fs.writeFileSync(migrationPath, JSON.stringify({
      version: data.version || '1',
      backupDate: new Date().toISOString(),
      dbType: 'json',
      projects: data.projects || [],
      items: data.items || [],
    }, null, 2));

    return true;
  } catch {
    return false;
  }
}
