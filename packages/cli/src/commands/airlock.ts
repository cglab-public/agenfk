import { Command } from 'commander';
import chalk from 'chalk';
import axios from 'axios';
import { execFileSync } from 'child_process';
import { getApiUrl } from '@agenfk/telemetry';
import { resolveDashboardUrl } from '../uiUrl.js';

/**
 * `agenfk airlock` (GH-294): read the Airlock policy and ask what it would
 * decide. The CLI is the agent's route to the server, so nothing here writes the
 * policy: `edit` only points a person at the board, where it is changed (or, on
 * a hub-joined installation, at nothing local - the hub owns it).
 */

/** Where the board's Airlock settings open (the panel itself arrives with T5). */
export function airlockBoardUrl(base: string = resolveDashboardUrl('')): string {
  return `${base}${base.includes('?') ? '&' : '?'}settings=airlock`;
}

const fail = (e: any): void => {
  const message = e?.response?.data?.error || e?.message || String(e);
  console.error(chalk.red(`❌ ${message}`));
  process.exit(1);
};

function openInBrowser(url: string): void {
  try {
    if (process.platform === 'darwin') execFileSync('open', [url], { stdio: 'ignore', windowsHide: true });
    else if (process.platform === 'win32') execFileSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore', windowsHide: true });
    else execFileSync('xdg-open', [url], { stdio: 'ignore', windowsHide: true });
  } catch {
    console.log(chalk.yellow('Could not open a browser; open the URL above yourself.'));
  }
}

export function registerAirlockCommands(program: Command): void {
  const airlock = program
    .command('airlock')
    .description('Airlock: the per-tool-call policy for pi and OpenCode sessions (read-only here; change it on the board)');

  airlock
    .command('status')
    .description('Show the Airlock policy in force: mode, coverage, source (hub or local) and revision. MCP: airlock_status.')
    .option('--json', 'Print the server answer as JSON')
    .action(async (options) => {
      try {
        const { data } = await axios.get(`${getApiUrl()}/airlock/policy`);
        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }
        const p = data?.effective ?? {};
        const models = Array.isArray(p.models) && p.models.length
          ? p.models.map((m: any) => [m.client ?? '*', m.provider ?? '*', m.model ?? '*'].join(':')).join(', ')
          : 'every session';
        console.log(`Airlock mode: ${chalk.bold(String(p.mode ?? 'off'))}`);
        console.log(`Source: ${data?.source} (revision ${data?.revision})${data?.hubManaged ? chalk.yellow(' - managed by your organization\'s hub; it cannot be changed here') : ''}`);
        console.log(`Covers: ${models}${p.appliesWhenModelUnknown === false ? ' (not sessions whose model is unknown)' : ''}`);
      } catch (e) { fail(e); }
    });

  airlock
    .command('check')
    .description('Ask what Airlock would decide for a command, path or URL. A dry run: nothing runs and nothing is logged. MCP: airlock_check.')
    .requiredOption('--client <client>', 'pi or opencode')
    .option('--model <provider/model>', 'The session model, e.g. cloudflare-workers-ai/@cf/zai-org/glm-5.2')
    .option('--command <command>', 'A shell command to judge')
    .option('--path <path>', 'A file path to judge')
    .option('--url <url>', 'A URL to judge')
    .option('--json', 'Print the server answer as JSON')
    .action(async (options) => {
      const args: Record<string, string> = {};
      if (options.command) args.command = options.command;
      if (options.path) args.path = options.path;
      if (options.url) args.url = options.url;
      if (!Object.keys(args).length) {
        console.error(chalk.red('Pass at least one of --command, --path or --url.'));
        process.exit(1);
        return;
      }
      try {
        const { data } = await axios.post(`${getApiUrl()}/airlock/evaluate`, {
          client: options.client, model: options.model, toolName: 'agenfk airlock check', args, dryRun: true,
        });
        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }
        const v = data?.verdict ?? {};
        const colour = v.decision === 'deny' ? chalk.red : v.decision === 'needs-human-approval' ? chalk.yellow : chalk.green;
        const detail = v.decision === 'allow'
          ? `(${v.why}${v.observed ? `; enforce would ${v.observed.decision}: ${v.observed.rule}` : ''})`
          : `${v.rule}: ${v.reason}`;
        console.log(`${colour(String(v.decision))} ${detail}`);
        console.log(chalk.gray(`mode ${data?.mode}, revision ${data?.revision}${data?.applies ? '' : ', this session is not covered'}`));
      } catch (e) { fail(e); }
    });

  airlock
    .command('edit')
    .description('Print (or with --open, open) the board page where a person changes the Airlock policy. Writes nothing.')
    .option('--open', 'Also open it in the browser')
    .action((options) => {
      const url = airlockBoardUrl();
      console.log(`Change the Airlock policy on the board: ${url}`);
      console.log(chalk.gray('On a hub-joined installation the hub owns the policy: an org admin changes it there.'));
      if (options.open) openInBrowser(url);
    });
}
