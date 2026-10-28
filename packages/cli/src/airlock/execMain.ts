/**
 * ea94c023: the entry of the Airlock exec helper the desktop app ships
 * (packages/desktop/scripts/bundle-airlock.mjs bundles it). The packaged app has
 * no CLI beside its server; for a card an Airlock sandbox touched, the server
 * runs this - `airlock exec ...` - with Electron as Node. Only the airlock
 * commands are registered: it is not a general agenfk CLI.
 */
import { Command } from 'commander';
import { registerAirlockCommands } from '../commands/airlock';

const program = new Command();
program.name('agenfk');
registerAirlockCommands(program);
program.parseAsync(process.argv).catch((e) => {
  console.error(`[agenfk airlock] ${(e as Error)?.message ?? e}`);
  process.exit(125);
});
