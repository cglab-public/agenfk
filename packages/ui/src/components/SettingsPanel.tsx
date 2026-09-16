/**
 * Settings that belong to the installation.
 *
 * Its reason to exist is that changing a preference should not require
 * starting a task. Until this screen, the only way to turn tmux on was the
 * dialog that opens a terminal — so a preference lived inside an action, which
 * made it hard to find and made the action heavier than it needed to be.
 *
 * Three rules, each of which is a way this kind of screen usually goes wrong:
 *
 * **Only sections that exist.** The section rail is built FROM the content, not
 * written beside it, so the two cannot drift. Copying a reference app's list of
 * sections produces entries that lead to an empty pane, and the user pays a
 * click to find that out — a worse lie than a missing entry.
 *
 * **The description says what it DOES.** "Enable tmux" tells someone who has
 * never heard of tmux precisely nothing. The row has to answer "what changes
 * for me if I flip this".
 *
 * **A failed save shows the truth.** The switch reverts rather than staying
 * where the user put it, because a switch reading "on" over a write that never
 * landed tells them their terminals are protected when they are not.
 */
import React from 'react';
import { clsx } from 'clsx';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Switch } from './ui/switch';
import {
  sessionPersistenceFromBridge, listAgentsFromBridge,
  readPrefsFromBridge, setAutoApproveOnBridge,
} from './agentBridge';
import { api } from '../api';

export interface AppSettings {
  tmuxByDefault: boolean;
}

/**
 * One row: what it is, what it does, and the switch.
 *
 * Deliberately dumb. It owns no state — the value comes from the server and
 * goes back to the server, so there is no local copy to drift out of sync with
 * what is actually stored.
 */
function SettingRow({
  title, description, checked, onChange, busy, note,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  busy?: boolean;
  /** Why this setting cannot take effect here, when that is the case. */
  note?: React.ReactNode;
}): React.ReactElement {
  // Ties the description and the caveat to the switch. Without it a screen
  // reader announcing the most dangerous control on the page says only
  // "Auto-approve by default, switch, off" — never what it lets happen, and
  // never which agents ignore it.
  const rowId = React.useId();
  return (
    <div
      data-testid="setting-row"
      className="flex items-start gap-4 border-b border-border-soft py-4 last:border-b-0"
    >
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold text-ink">{title}</p>
        <p id={`${rowId}-desc`} className="mt-0.5 text-[12px] leading-snug text-ink-tertiary">
          {description}
        </p>
        {note && (
          // A light/dark PAIR, like every other warning in this app.
          // text-amber-400 alone is roughly 1.6:1 on the light theme's
          // near-white card, which made the one message that says "sessions
          // will not survive quitting" unreadable for light-theme users.
          <p
            data-testid="setting-note"
            id={`${rowId}-note`}
            className="mt-1.5 text-[12px] leading-snug text-amber-600 dark:text-amber-400"
          >
            {note}
          </p>
        )}
      </div>
      <Switch
        aria-label={title}
        aria-describedby={note ? `${rowId}-desc ${rowId}-note` : `${rowId}-desc`}
        checked={checked}
        disabled={busy}
        onCheckedChange={onChange}
        className={clsx('mt-0.5', busy && 'cursor-wait')}
      />
    </div>
  );
}

/**
 * A group of rows, and the thing the rail is generated from.
 *
 * Sections are DATA rather than markup precisely so the rail cannot list one
 * the pane does not render. When a second section arrives, both sides learn
 * about it at once.
 */
interface SettingsSection {
  readonly id: string;
  readonly label: string;
  readonly rows: React.ReactNode;
}

/** "a", "a and b", "a, b and c" — `join(' and ')` gives "a and b and c". */
function listAnd(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export function SettingsPanel(): React.ReactElement {
  const queryClient = useQueryClient();
  const { data: settings, isError: readFailed } = useQuery<AppSettings>({
    queryKey: ['settings'],
    queryFn: api.getSettings,
  });

  const save = useMutation({
    mutationFn: (patch: Partial<AppSettings>) => api.updateSettings(patch),
    // The server answers with the whole settled state, so the cache is filled
    // from what was actually stored rather than from what we hoped.
    onSuccess: settled => { queryClient.setQueryData(['settings'], settled); },
    // No rollback needed: nothing was written optimistically, so the switch is
    // still showing the stored value. Refetching makes that explicit in case
    // another client changed it in the meantime.
    // Nothing was written optimistically, so there is nothing to roll back —
    // the switch never moved. Which is exactly the problem: a failed save is
    // indistinguishable from a missed click unless it SAYS so. The refetch is
    // to pick up a change another client made in the meantime.
    onError: () => { void queryClient.invalidateQueries({ queryKey: ['settings'] }); },
  });

  // Absent while the first read is in flight. `?? false` rather than a spinner:
  // the row is one line, and a switch that appears after a flash of skeleton is
  // more jarring than one that starts at its default and corrects itself.
  /**
   * Whether this machine can actually honour the tmux setting.
   *
   * Asked here because the switch stores a PREFERENCE while tmux being
   * installed is a FACT about one machine. Storing a wish that silently does
   * nothing is how the user finds out by quitting the app and losing an agent
   * mid-run — the one failure this whole feature exists to prevent.
   *
   * The switch is still enabled either way: the choice is theirs and travels to
   * a machine that can honour it. Only the warning is conditional.
   */
  const { data: persistence } = useQuery({
    queryKey: ['session-persistence'],
    queryFn: sessionPersistenceFromBridge,
    // A minute, not Infinity. This panel is never unmounted, so Infinity meant
    // a user who read the warning, ran `brew install tmux` and came back was
    // still told it was unavailable for the rest of the app's lifetime.
    staleTime: 60_000,
  });

  /**
   * Which installed agents have no flag for skipping their own prompts.
   *
   * The setting is global; the support is not. Without naming them, a switch
   * reading "on" over an agent that ignores it tells the user the rails are off
   * when they are not — which is exactly what the terminal dialog's per-agent
   * toggle used to prevent before it moved here.
   *
   * Installed only: warning about an agent the user cannot launch is noise
   * about a choice they cannot make.
   */
  const { data: agents = [] } = useQuery({
    queryKey: ['agents'],
    queryFn: listAgentsFromBridge,
    staleTime: Infinity,
  });
  // `shell` is excluded, and not as a special case for its own sake: it has no
  // permission prompts to skip, so saying it "will ignore this" and "always
  // asks" is nonsense about a login shell. It is also ALWAYS_AVAILABLE, so
  // including it put a permanent caveat on screen for every user — and a
  // caveat that is always there stops being read, which is the failure this
  // line exists to avoid.
  const ignoring = agents
    .filter(a => a.installed && !a.supportsAutoApprove && a.id !== 'shell')
    .map(a => a.label);

  const tmuxByDefault = settings?.tmuxByDefault ?? false;
  /**
   * Auto-approve comes from the DESKTOP, not from the server.
   *
   * It disables an agent's permission prompts, and the server's settings route
   * is unauthenticated — an agent granted one localhost call could have
   * disarmed every future session. It lives behind the preload IPC instead, so
   * the only caller is code running in this app.
   */
  const { data: prefs, isError: prefsFailed } = useQuery({
    queryKey: ['desktop-prefs'],
    queryFn: readPrefsFromBridge,
  });
  const saveAutoApprove = useMutation({
    mutationFn: (value: boolean) => setAutoApproveOnBridge(value),
    onSuccess: settled => { queryClient.setQueryData(['desktop-prefs'], settled); },
    onError: () => { void queryClient.invalidateQueries({ queryKey: ['desktop-prefs'] }); },
  });
  const autoApproveByDefault = prefs?.autoApprove ?? false;

  const sections: SettingsSection[] = [
    {
      id: 'general',
      label: 'General',
      rows: (
        <SettingRow
          title="Enable tmux"
          /* Names the consequence first. Someone who does not know what tmux
             is still learns exactly what changes for them. */
          description="Run agent sessions and terminals inside tmux, so they keep running when you quit the app. Requires tmux to be installed."
          checked={tmuxByDefault}
          busy={save.isPending && save.variables !== undefined && 'tmuxByDefault' in save.variables}
          onChange={next => save.mutate({ tmuxByDefault: next })}
          note={persistence && !persistence.available ? (
            persistence.warning === 'tmux_unsupported_on_windows' ? (
              // The platform reason, never an install command. Telling a
              // Windows user to `brew install tmux` is worse than saying
              // nothing: it sends them after a fix that cannot exist there.
              <>tmux is not available on Windows, so agent PROCESSES will not survive quitting. Your terminals are reopened, and agents that support it resume their conversation.</>
            ) : (
              <>
                tmux is not available here, so agent PROCESSES will not survive quitting.
                Your terminals are reopened, and agents that support it resume their conversation.
                {persistence.hint && (
                  <>
                    {' '}
                    <code className="rounded bg-canvas px-1 py-px font-mono text-[11px]">
                      {persistence.hint}
                    </code>
                  </>
                )}
              </>
            )
          ) : undefined}
        />
      ),
    },
    {
      id: 'agents',
      label: 'Agents',
      rows: (
        <SettingRow
          title="Auto-approve by default"
          /* The only setting here that can cost something irreversible, so the
             description says what it lets happen rather than what it turns on.
             This was a per-terminal decision until it moved here; the price of
             the move is that a terminal can now open with the rails off on a
             day nobody thought about it, and the user should read that before
             flipping it, not discover it afterwards. */
          description="Start agents with their own permission prompts disabled, so they edit, delete and run commands without asking. Applies to every terminal you open, including ones you open without thinking about it."
          checked={autoApproveByDefault}
          busy={saveAutoApprove.isPending}
          onChange={next => saveAutoApprove.mutate(next)}
          /* Only the ones that will ignore it. Listing every agent would be a
             list of nothing, leaving the reader to work out which half
             matters. */
          note={ignoring.length > 0
            ? `${listAnd(ignoring)} will ignore this: ${ignoring.length === 1 ? 'it has' : 'they have'} no flag for it and always ask.`
            : undefined}
        />
      ),
    },
  ];

  const [current, setCurrent] = React.useState(sections[0].id);
  const shown = sections.find(s => s.id === current) ?? sections[0];

  return (
    <div className="flex h-full min-h-0">
      {/* The rail. Its entries come from `sections`, so it can never offer one
          the pane cannot show. */}
      <nav
        aria-label="Settings sections"
        className="w-48 shrink-0 border-r border-border-soft px-2 py-6"
      >
        {sections.map(section => (
          <button
            key={section.id}
            type="button"
            onClick={() => setCurrent(section.id)}
            // `aria-current` rather than a class alone: which section you are
            // looking at is information, not decoration, and a screen reader
            // needs it as much as the eye does.
            aria-current={section.id === shown.id ? 'page' : undefined}
            className={clsx(
              'mb-0.5 flex w-full items-center rounded-md px-3 py-1.5 text-left text-[13px] transition-colors',
              section.id === shown.id
                ? 'bg-canvas font-medium text-ink'
                : 'text-ink-secondary hover:bg-canvas hover:text-ink',
            )}
          >
            {section.label}
          </button>
        ))}
      </nav>

      {/* min-w-0 is load-bearing: without it a long description refuses to wrap
          and pushes the whole window into horizontal scroll, which is the
          classic way a two-column settings pane breaks. */}
      <div data-testid="settings-body" className="min-w-0 flex-1 overflow-y-auto scrollbar-slim">
        <div className="mx-auto w-full max-w-2xl px-8 py-6">
          <header>
            <h1 className="text-xl font-semibold text-ink">{shown.label}</h1>
            <p className="mt-1 text-[13px] text-ink-tertiary">
              These apply to every project on this installation.
            </p>
          </header>

          {/* Read failure is NOT "everything is off". Rendering the defaults
              over an unread store makes the screen assert a state it never
              verified — and for auto-approve that is asserting a safety
              property. */}
          {(readFailed || prefsFailed) && (
            <div
              role="alert"
              className="mt-6 rounded-lg border border-amber-600/40 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-700 dark:text-amber-300"
            >
              Could not read your settings, so the switches below may not reflect
              what is stored. Check that AgEnFK is running.
            </div>
          )}

          {/* A save that fails has to be visible. The switch does not move on
              its own, so silence here reads as "I missed the button". */}
          {(save.isError || saveAutoApprove.isError) && (
            <div
              role="alert"
              className="mt-6 rounded-lg border border-rose-600/40 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-700 dark:text-rose-300"
            >
              Could not save that change; it was not applied.
            </div>
          )}

          <section data-testid="settings-section" className="mt-8">
            <h2 className="text-[11px] font-bold uppercase tracking-[0.14em] text-ink-tertiary">
              Preferences
            </h2>
            <div className="mt-2 rounded-xl border border-border-soft bg-nav-surface px-5">
              {shown.rows}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
