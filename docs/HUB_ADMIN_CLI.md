# Hub admin CLI

`agenfk hub admin <area> <verb>` does from a terminal what the hub's admin
pages do on the board: people and access, flows and upgrades, Airlock,
repositories, models, the organization, federation, JIRA, the audit log, and
the fleet's events and data. It talks to the hub's own API with your admin
rights, so the hub enforces everything it enforces for the board.

## Signing in

```bash
agenfk hub admin login            # the hub in ~/.agenfk/hub.json
agenfk hub admin login --url https://hub.example.com
```

The command prints a code and opens `/connect?code=…&kind=admin` on the hub.
Approve it there, signed in as yourself; the terminal then holds an admin
session **as you** for 12 hours. The credential lives in
`~/.agenfk/hub-admin.json` (mode 0600), apart from the installation key in
`hub.json`. Whether you are still an admin is checked on every request, so a
demotion or deactivation takes effect at once.

```bash
agenfk hub admin whoami
agenfk hub admin logout                    # revokes the token on the hub
agenfk hub admin sessions list             # every live CLI session in the org
agenfk hub admin sessions revoke <id> --yes
```

A CLI session cannot approve another CLI sign-in: renewing takes a person at
the board. Changes made from the CLI appear in the audit log with source `cli`.

## Conventions

- **`--json`** on every command that answers with data (lists, `show`, and
  changes that return what they made) prints the hub's answer as JSON, for
  scripts. Commands that only act (`logout`, `delete`, `revoke`, ...) print a
  line and exit 0 or 1. `data` and `events` print JSON by default and take
  `--csv` for list results (cells a spreadsheet would run as a formula are
  neutralized).
- **`--yes`** is required for what is destructive, fleet- or group-wide, or
  hard to take back: deleting, deactivating, demoting, revoking, retiring,
  merging, dispatching, upgrading, moving the fleet's address, changing the
  org-wide flow or a flow's definition, the Airlock policy or IOC list, trusting every installation's
  receipts, enforcing receipts, letting identities be shared, replacing the
  JIRA app, joining or leaving a federation. Without it the command says what it
  would do and sends nothing. Granting access to one person (`users invite`,
  `users activate`, `users set-role <user> admin`) does not ask: it is what the
  command is for, and the audit log records it.
- **Secrets are read from stdin only** (`--password-stdin`,
  `--client-secret-stdin`, `--token-stdin`): never as arguments, which land in
  shell history. Commands refuse arguments they do not declare.
- **Files for documents**: flow definitions and Airlock policies are read from
  and written to JSON files (`flows get --out`, `airlock policy show --out`), so
  a change can be reviewed, and kept in git, before it is applied. The Airlock
  policy is saved against the revision it was read at; a newer one is a conflict,
  not an overwrite.
- **Errors are the hub's own words**, and the exit code is 1.

## Examples

```bash
agenfk hub admin users invite dev@acme.com --role viewer
printf %s "$PASSWORD" | agenfk hub admin users set-password dev@acme.com --password-stdin
agenfk hub admin flows get <id> --out flow.json && $EDITOR flow.json && agenfk hub admin flows update <id> --file flow.json --yes
agenfk hub admin upgrades start 2.1.0 --installation <id> --yes
agenfk hub admin airlock policy show --out policy.json   # edit, then:
agenfk hub admin airlock policy set --file policy.json --yes
agenfk hub admin events --users dev@acme.com --from 2026-10-01 --csv > events.csv
agenfk hub admin data prs --model claude-opus-5-5 --from 2026-10-01
agenfk hub admin audit export --area users --out audit.csv
```

## Keeping up with the board

`packages/cli/src/test/hub-admin-parity.test.ts` lists every route a signed-in
person can reach on the hub and fails unless an admin command calls it or
`packages/cli/src/hubAdmin/parity.ts` says why it has none. A page added to the
board without a command fails the build.

## Commands

| Command | What it does |
|---|---|
| `agenfk hub admin login` | Sign in as a hub admin: approve the code in the browser, get a 12-hour admin session |
| `agenfk hub admin whoami` | Who the admin CLI is signed in as, and where |
| `agenfk hub admin logout` | End the admin CLI session: revoke its token on the hub and forget it here |
| `agenfk hub admin sessions list` | List live admin CLI sessions |
| `agenfk hub admin sessions revoke <id>` | Revoke an admin CLI session at once |
| `agenfk hub admin users list` | List users |
| `agenfk hub admin users invite <email>` | Add a user (SSO-only unless --password-stdin) |
| `agenfk hub admin users set-role <user> <role>` | Make a user an admin or a viewer (demoting needs --yes) |
| `agenfk hub admin users activate <user>` | Let a deactivated user sign in again |
| `agenfk hub admin users deactivate <user>` | Stop a user signing in (their sessions end at once) |
| `agenfk hub admin users set-password <user>` | Set a password-sign-in user's password (read from stdin) |
| `agenfk hub admin users delete <user>` | Delete a user |
| `agenfk hub admin identities suggestions` | Identities the hub thinks are the same person |
| `agenfk hub admin identities merges` | Merges made so far |
| `agenfk hub admin identities merge <from> <to>` | Fold one user key's history into another's |
| `agenfk hub admin identities revert <mergeId>` | Undo a merge |
| `agenfk hub admin identities hidden` | People hidden from the hub's views |
| `agenfk hub admin identities hide <userKey>` | Hide a person and revoke their machines' API keys |
| `agenfk hub admin identities unhide <userKey>` | Show a hidden person again |
| `agenfk hub admin installations list` | List installations |
| `agenfk hub admin installations retire <id>` | Retire a machine: revoke its keys and stop fleet directives to it |
| `agenfk hub admin installations approve <code>` | Approve the code a machine's `agenfk hub login` shows: it gets an API key bound to it |
| `agenfk hub admin installations unretire <id>` | Bring a retired installation back |
| `agenfk hub admin sign-in show` | Show the sign-in configuration (secrets are never shown) |
| `agenfk hub admin sign-in set` | Change the sign-in configuration (only the options given change) |
| `agenfk hub admin api-keys list` | List API keys (by hash prefix; the keys themselves are never stored) |
| `agenfk hub admin api-keys create` | Issue an unbound API key (prefer `invites create` to onboard a machine) |
| `agenfk hub admin api-keys revoke <prefix>` | Revoke the API key whose hash starts with <prefix> |
| `agenfk hub admin invites create` | Create an installation invite and print its `agenfk hub join` command |
| `agenfk hub admin ci-tokens list` | List CI tokens |
| `agenfk hub admin ci-tokens create` | Issue a CI token |
| `agenfk hub admin ci-tokens revoke <prefix>` | Revoke the CI token whose hash starts with <prefix> |
| `agenfk hub admin flows list` | List flows |
| `agenfk hub admin flows get <id>` | Show a flow; --out writes its definition to a file for `update` |
| `agenfk hub admin flows default` | Show the built-in default flow |
| `agenfk hub admin flows create` | Create a flow from a definition file |
| `agenfk hub admin flows update <id>` | Replace a flow's definition from a file |
| `agenfk hub admin flows contract` | What a definition's steps require of an agent (its contract) |
| `agenfk hub admin flows available <id> <onOff>` | Offer the flow to the org's projects, or stop offering it |
| `agenfk hub admin flows delete <id>` | Delete a flow |
| `agenfk hub admin flows projects` | Projects seen in the fleet: the targets of --scope project |
| `agenfk hub admin flows assignments` | Which flow each scope runs |
| `agenfk hub admin flows assign` | Assign a flow to a scope (--flow none clears it) |
| `agenfk hub admin flows registry show` | Show the registry configuration (the token is never shown) |
| `agenfk hub admin flows registry set` | Use a GitHub repo of your own as the org registry |
| `agenfk hub admin flows registry sync` | Copy the public registry's flows into the org registry |
| `agenfk hub admin flows registry pulls` | Open pull requests on the org registry |
| `agenfk hub admin flows registry list` | Flows in the registry |
| `agenfk hub admin flows registry install <filename>` | Install a flow from the registry into the hub |
| `agenfk hub admin flows dispatch <flowId>` | Send a flow to child hubs: those named with --child, or (without it) every current AND future child hub until cancelled |
| `agenfk hub admin flows dispatches` | Flow dispatches to child hubs and how each landed |
| `agenfk hub admin flows dispatch-cancel <id>` | Stop delivering a flow dispatch (hubs that already installed it keep it) |
| `agenfk hub admin upgrades versions` | Releases the fleet can move to (newest first) |
| `agenfk hub admin upgrades list` | Upgrade directives and where each installation is |
| `agenfk hub admin upgrades start <version>` | Upgrade the fleet (or the installations named with --installation) |
| `agenfk hub admin upgrades cancel <directiveId>` | Cancel an upgrade for the installations it has not reached |
| `agenfk hub admin upgrades dispatch <version>` | Upgrade child hubs' fleets: those named with --child, or (without it) every current AND future child hub until cancelled |
| `agenfk hub admin upgrades dispatches` | Group upgrade dispatches to child hubs |
| `agenfk hub admin upgrades dispatch-cancel <id>` | Cancel a group upgrade dispatch |
| `agenfk hub admin repoint status` | The address change under way, and where each installation is |
| `agenfk hub admin repoint start <targetUrl>` | Tell every installation to move to a new hub address |
| `agenfk hub admin repoint close <id>` | End an address change |
| `agenfk hub admin airlock policy show` | Show the policy; --out writes { revision, policy } for `policy set` |
| `agenfk hub admin airlock policy set` | Save a policy from a file (a bare policy, or what `policy show --out` wrote) |
| `agenfk hub admin airlock ioc set` | Replace the IOC host list from a file (one host per line, # comments; or a JSON array) |
| `agenfk hub admin airlock installations` | Which policy revision each installation runs |
| `agenfk hub admin airlock history` | Past policy revisions |
| `agenfk hub admin airlock decisions` | What sandboxes allowed and denied |
| `agenfk hub admin airlock dataset show` | Whether the dataset is collected, and its size |
| `agenfk hub admin airlock dataset on` | Start collecting the dataset |
| `agenfk hub admin airlock dataset off` | Stop collecting the dataset |
| `agenfk hub admin airlock dataset export` | Export the dataset as JSON lines |
| `agenfk hub admin airlock learning list` | Proposed hosts |
| `agenfk hub admin airlock learning accept <hosts>` | Allow proposed hosts (a new policy revision) |
| `agenfk hub admin repos list` | Repositories the hub knows |
| `agenfk hub admin repos receipts` | Recent verification receipts of a repository |
| `agenfk hub admin repos revisions` | The verify command's revisions |
| `agenfk hub admin repos set-command` | Change the command that verifies a repository |
| `agenfk hub admin repos set-mode` | How receipts gate a repository: off, shadow or enforce |
| `agenfk hub admin repos producer-mode` | Who may produce receipts: the listed installations, or all |
| `agenfk hub admin repos producer allow` | Add an installation to the list |
| `agenfk hub admin repos producer deny` | Remove an installation from the list |
| `agenfk hub admin models list` | Models seen, their mappings and metadata |
| `agenfk hub admin models map <alias> <canonical>` | Count an alias as another model |
| `agenfk hub admin models unmap <alias>` | Remove a mapping |
| `agenfk hub admin models meta set <model>` | Label a model |
| `agenfk hub admin models meta delete <model>` | Remove a model's labels (back to the built-in ones, if any) |
| `agenfk hub admin org rename <newId>` | Change the org id (every installation and record moves with it) |
| `agenfk hub admin org pending` | Notices the hub is holding for the operator |
| `agenfk hub admin org pending-ack` | Dismiss the pending notice (after updating the environment) |
| `agenfk hub admin federation status` | Whether this hub has a parent, and how it stands |
| `agenfk hub admin federation join` | Join a parent hub with the token its admin gave you (`child-hubs invite` there), read from stdin |
| `agenfk hub admin federation release-request` | Ask the parent to release this hub from the group |
| `agenfk hub admin federation leave` | Leave the group once the parent has released this hub |
| `agenfk hub admin federation identity-policy show` | The group policy and each child hub's |
| `agenfk hub admin federation identity-policy set <policy>` | Set the group policy: keep or pseudonymize (keep needs --yes) |
| `agenfk hub admin child-hubs list` | Child hubs |
| `agenfk hub admin child-hubs invite` | A single-use token another hub uses to join this one |
| `agenfk hub admin child-hubs rename <id> <name>` | Rename a child hub |
| `agenfk hub admin child-hubs detach <id>` | Remove a child hub from the group and revoke its keys |
| `agenfk hub admin child-hubs identity-policy <id> <policy>` | A child hub's own identity policy: keep, pseudonymize, or inherit (keep and inherit need --yes) |
| `agenfk hub admin jira show` | The JIRA app (the secret is never shown) |
| `agenfk hub admin jira set` | Set the Atlassian app (a new app needs its secret) |
| `agenfk hub admin jira disconnect-all` | Disconnect every person's JIRA account |
| `agenfk hub admin events` | The fleet's events, newest first (the board's timeline) |
| `agenfk hub admin data <query>` | The board's charts and lists as data. Queries: timeline (events, newest first (also `agenfk hub admin events`)); metrics (daily series and totals); histogram (events per bucket (--bucket)); adherence (workflow adherence); prs (the PR overview (--model, --pr)); users (people and their activity); people (people's names (takes no filters)); projects (repositories seen); event-types (event types seen); item-types (item types seen, with counts); child-hubs (child hubs with their event counts) |
| `agenfk hub admin rollups recompute` | Rebuild the daily rollups the charts read (after a crash, or a merge that did not finish) |
| `agenfk hub admin audit list` | Audit rows, newest first |
| `agenfk hub admin audit export` | The audit log as CSV (the board's download) |
