/**
 * Settings that belong to the installation.
 *
 * Its reason to exist is that changing a preference should not require
 * starting a task. Until this screen, the only way to turn tmux on was the
 * dialog that opens a terminal — so a preference lived inside an action, which
 * made it hard to find and made the action heavier than it needed to be.
 *
 * Four rules, each of which is a way this kind of screen usually goes wrong:
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
 *
 * **Every state drawn has a producer.** Not one value on this screen is
 * invented here. The account comes from the credential `gh` already holds, the
 * version from the same release query the reminder rocket reads, telemetry from
 * the file `agenfk config set telemetry` writes, and the notification switches
 * gate an alert that fires off `NEEDS_A_PERSON` — the set the card dot and the
 * sidebar count already share. A second source for any of them is two places
 * that can disagree, and the user has no way to know which is lying.
 *
 * The shape — account, then app, then notifications, one panel per group, a
 * description under each label — is borrowed from the reference the user
 * brought, because it is a good shape and people already read it. The palette,
 * the type and the copy are this app's own.
 */
import React from 'react';
import { clsx } from 'clsx';
import { UserRound, AppWindow, Bell, Bot, type LucideIcon } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Switch } from './ui/switch';
import {
  listAgentsFromBridge,
  readPrefsFromBridge, setAutoApproveOnBridge,
  canChooseSound, canNotifyAttention,
  currentSoundFromBridge, chooseSoundOnBridge, clearSoundOnBridge,
} from './agentBridge';
import { playAttentionSound, browserSoundDeps } from '../attentionSound';
import { isNewerVersion } from '../versionCompare';
import { api, type AppSettingsDto, type SoundTimingDto } from '../api';

/**
 * One row: what it is, what it does, and whatever acts on it.
 *
 * Deliberately dumb, and deliberately NOT switch-only. It carried a `Switch`
 * hard-coded until this screen grew a sign-out, an update check and a file
 * picker; the alternative to a slot was a second row component with the same
 * layout, the same testid and its own copy of the note rule — which is how one
 * of the two ends up with a warning nobody can read in light mode.
 *
 * It owns no state. The value comes from the server and goes back to the
 * server, so there is no local copy to drift out of sync with what is stored.
 */
function SettingRow({
  testId, title, description, control, note, meta, lead, indent,
}: {
  /** Addresses this row. Rows are found by what they ARE, not by their copy. */
  testId: string;
  title: React.ReactNode;
  description: React.ReactNode;
  control: React.ReactNode;
  /**
   * Why this setting cannot take effect here, when that is the case.
   *
   * A WARNING, and drawn as one. `meta` below exists because the first version
   * of the custom-sound row put "Playing chime.wav" in here and got an amber
   * caveat for an ordinary fact — and an amber line that is always there stops
   * being read, which is the one thing the real warnings cannot afford.
   */
  note?: React.ReactNode;
  /** An ordinary secondary fact about the row. Not a caveat. */
  meta?: React.ReactNode;
  /** An avatar or a status glyph, when the row has one. */
  lead?: React.ReactNode;
  /** Subordinate to the row above it, e.g. the sound rows under the master. */
  indent?: boolean;
}): React.ReactElement {
  return (
    <div
      data-testid="setting-row"
      data-row={testId}
      className={clsx(
        'flex items-start gap-4 border-b border-border-soft py-4 last:border-b-0',
        indent && 'pl-4',
      )}
    >
      {lead && <div className="mt-0.5 shrink-0">{lead}</div>}
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold text-ink">{title}</p>
        <p className="mt-0.5 text-[12px] leading-snug text-ink-tertiary">
          {description}
        </p>
        {meta && (
          <p className="mt-1.5 text-[12px] leading-snug text-ink-tertiary">{meta}</p>
        )}
        {note && (
          // A light/dark PAIR, like every other warning in this app.
          // text-amber-400 alone is roughly 1.6:1 on the light theme's
          // near-white card, which made the one message that says "sessions
          // will not survive quitting" unreadable for light-theme users.
          <p
            data-testid="setting-note"
            className="mt-1.5 text-[12px] leading-snug text-amber-600 dark:text-amber-400"
          >
            {note}
          </p>
        )}
      </div>
      <div className="mt-0.5 flex shrink-0 items-center gap-2">{control}</div>
    </div>
  );
}

/** The one button shape this screen uses, so five rows cannot each invent one. */
function RowButton({
  children, onClick, disabled, primary, busy,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  busy?: boolean;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      className={clsx(
        'rounded-lg border px-3 py-1.5 text-[13px] font-medium transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50',
        busy && 'cursor-wait',
        primary
          ? 'border-border-brand bg-chip text-accent-text hover:bg-brand/15'
          : 'border-border-soft bg-canvas text-ink-secondary hover:bg-nav-surface hover:text-ink',
      )}
    >
      {children}
    </button>
  );
}

/**
 * Something went wrong, said where the user is looking.
 *
 * One component rather than the four copies this screen accumulated while the
 * blocks were being written. They differed only in their text, and keeping them
 * apart meant four places for the `role="alert"` to be forgotten from — which is
 * the part that matters, since a message a screen reader never announces is a
 * message that did not happen.
 *
 * Both tones are a light/dark PAIR, like every other coloured text in this app.
 */
function Alert({
  children, tone = 'error',
}: {
  children: React.ReactNode;
  tone?: 'error' | 'warning';
}): React.ReactElement {
  return (
    <div
      role="alert"
      className={clsx(
        'mt-6 rounded-lg border px-3 py-2 text-[12px]',
        tone === 'warning'
          ? 'border-amber-600/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'
          : 'border-rose-600/40 bg-rose-500/10 text-rose-700 dark:text-rose-300',
      )}
    >
      {children}
    </div>
  );
}

/**
 * A command the user is meant to run, rendered the way this app renders one.
 *
 * `React.ReactNode` rather than `string`: JSX splits `v{version}` into an array
 * of children, so a string-only prop makes the one interpolated case — the
 * version number, which is the whole point of the update row — a type error.
 */
function Command({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <code className="rounded bg-canvas px-1 py-px font-mono text-[11px]">{children}</code>
  );
}

/**
 * A group of rows, and the thing the rail is generated from.
 *
 * Sections are DATA rather than markup precisely so the rail cannot list one
 * the pane does not render. When a section arrives, both sides learn about it
 * at once.
 */
interface SettingsSection {
  readonly id: string;
  readonly label: string;
  /**
   * The nav glyph. REQUIRED, not optional.
   *
   * Optional is how a list like this ends up half-iconed: somebody adds a
   * section, forgets the icon, and the row silently renders two pixels narrower
   * than its neighbours. Required means the compiler asks the question at the
   * moment the section is written, which is the only moment anybody is thinking
   * about it.
   *
   * lucide-react because the app already draws every other icon with it. A
   * second icon library would mean two stroke weights and two grids in one
   * window, which reads as two applications.
   */
  readonly icon: LucideIcon;
  readonly rows: React.ReactNode;
}

/** "a", "a and b", "a, b and c" — `join(' and ')` gives "a and b and c". */
function listAnd(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The two initials an avatar falls back to. */
function initials(name: string | null, login: string): string {
  const source = (name ?? login).trim();
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

export function SettingsPanel(): React.ReactElement {
  const queryClient = useQueryClient();
  const { data: settings, isError: readFailed } = useQuery<AppSettingsDto>({
    queryKey: ['settings'],
    queryFn: api.getSettings,
  });

  const save = useMutation({
    mutationFn: (patch: Partial<AppSettingsDto>) => api.updateSettings(patch),
    // The server answers with the whole settled state, so the cache is filled
    // from what was actually stored rather than from what we hoped.
    onSuccess: settled => { queryClient.setQueryData(['settings'], settled); },
    // Nothing was written optimistically, so there is nothing to roll back —
    // the switch never moved. Which is exactly the problem: a failed save is
    // indistinguishable from a missed click unless it SAYS so. The refetch is
    // to pick up a change another client made in the meantime.
    onError: () => { void queryClient.invalidateQueries({ queryKey: ['settings'] }); },
  });

  /** Whether a particular key is the one currently being written. */
  const saving = (key: keyof AppSettingsDto): boolean =>
    save.isPending && save.variables !== undefined && key in save.variables;

  /*
   * Deliberately NOT asking whether tmux is available any more.
   *
   * That query existed to caption one row, and the row went with the General
   * section. Keeping it alive for a caption nothing renders is how a screen
   * accumulates work nobody can see — and it is not free: `sessionPersistence`
   * crosses the preload IPC to run a PATH lookup on the main process. The
   * bridge helper stays where it is; the terminal dialog still asks.
   */

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

  /*
   * `tmuxByDefault` is deliberately NOT read here any more.
   *
   * The setting is still stored, still sent with every PUT /settings, and still
   * consulted when a terminal is spawned — only its switch is gone. Reading it
   * into a variable no row renders would leave the next person looking for the
   * control that goes with it.
   */
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

  // ── Account ───────────────────────────────────────────────────────────────

  /**
   * The GitHub account, read from the credential `gh` already holds.
   *
   * `retry: false` and a staleTime, because the server shells out to `gh api
   * user` — a network call. Retrying a logged-out machine three times on every
   * mount buys nothing and delays the honest answer.
   */
  const account = useQuery({
    queryKey: ['github-account'],
    queryFn: api.getGitHubAccount,
    staleTime: 60_000,
    retry: false,
    // A page that refetches on every window focus would shell out to `gh` every
    // time the user alt-tabs back.
    refetchOnWindowFocus: false,
  });
  const [confirmingSignOut, setConfirmingSignOut] = React.useState(false);
  const signOut = useMutation({
    mutationFn: () => api.signOutGitHub(),
    onSettled: () => {
      setConfirmingSignOut(false);
      void queryClient.invalidateQueries({ queryKey: ['github-account'] });
    },
  });
  /**
   * A sign-out that answered but did not sign out.
   *
   * `gh` refuses to log out of a host whose token came from the environment,
   * and the request succeeds while nothing happens. Reported as its own message
   * because the alternative — the row silently going on saying "connected" —
   * reads as the button being broken.
   */
  const signOutRefused = signOut.data && signOut.data.signedOut === false
    ? signOut.data.error ?? 'gh refused to sign out.'
    : null;

  // ── App ───────────────────────────────────────────────────────────────────

  const version = useQuery({ queryKey: ['version'], queryFn: api.getVersion, staleTime: Infinity });
  /**
   * The SAME query the reminder rocket reads, by key.
   *
   * Not a second request and not a second comparator: a separate one would go
   * out of date independently, and the visible result is this row saying
   * "You're up to date" while the rocket in the corner says the opposite.
   */
  const release = useQuery({
    queryKey: ['latestRelease'],
    queryFn: api.getLatestRelease,
    staleTime: 15 * 60 * 1000,
    retry: false,
  });
  const currentVersion = release.data?.currentVersion ?? version.data?.version ?? null;
  /**
   * Three states, not two.
   *
   * "Could not check" is the one that gets drawn as "up to date" by accident,
   * and then the app claims it is current while offline. It is its own branch
   * here precisely so it cannot collapse into the reassuring one: the row only
   * says you are up to date once something has actually answered.
   */
  const updateState: 'checking' | 'unknown' | 'available' | 'current' =
    release.isFetching && !release.data ? 'checking'
      : release.isError || !release.data?.version ? 'unknown'
        : isNewerVersion(release.data.version, currentVersion ?? '') ? 'available'
          : 'current';

  const telemetry = useQuery({ queryKey: ['telemetry-config'], queryFn: api.getTelemetryConfig });
  const saveTelemetry = useMutation({
    mutationFn: (enabled: boolean) => api.setTelemetryConfig(enabled),
    onSuccess: settled => {
      queryClient.setQueryData(['telemetry-config'], {
        ...telemetry.data, telemetryEnabled: settled.telemetryEnabled,
      });
    },
    onError: () => { void queryClient.invalidateQueries({ queryKey: ['telemetry-config'] }); },
  });

  // ── Notifications ─────────────────────────────────────────────────────────

  const attentionAlerts = settings?.attentionAlerts ?? false;
  const attentionSound = settings?.attentionSound ?? false;
  const soundTiming: SoundTimingDto = settings?.soundTiming ?? 'unfocused';
  const osNotifications = settings?.osNotifications ?? false;

  /**
   * Whether this build can offer a custom sound at all.
   *
   * A browser has no picker that can write into the app's own directory and no
   * filesystem to read the bytes back from, so the row is ABSENT there rather
   * than present and dead — which is the failure this card was written to stop
   * repeating.
   */
  const soundsAvailable = canChooseSound();
  /**
   * Whether this build can raise an OS banner.
   *
   * A separate probe from `soundsAvailable`, because they are separate bridges
   * and a preload can expose one without the other — the version skew
   * agentBridge.ts's own header is written around.
   */
  const canRaiseBanners = canNotifyAttention();
  const customSound = useQuery({
    queryKey: ['custom-sound'],
    queryFn: currentSoundFromBridge,
    enabled: soundsAvailable,
  });
  const chooseSound = useMutation({
    mutationFn: () => chooseSoundOnBridge(),
    onSuccess: result => { queryClient.setQueryData(['custom-sound'], { name: result.name }); },
  });
  const clearSound = useMutation({
    mutationFn: () => clearSoundOnBridge(),
    onSuccess: () => { queryClient.setQueryData(['custom-sound'], { name: null }); },
  });
  /**
   * A file the picker returned and `storeCustomSound` refused.
   *
   * Surfaced rather than swallowed: the user picked something and the row would
   * otherwise go on saying "built-in", which reads as the button not working.
   */
  const soundRefused = chooseSound.data?.error ?? null;

  const sections: SettingsSection[] = [
    {
      id: 'account',
      label: 'Account',
      icon: UserRound,
      rows: <>
        {account.data?.connected ? (
          <SettingRow
            testId="account-row"
            lead={account.data.avatarUrl ? (
              <img
                /* A real alt, not an empty one. `alt=""` takes the element out
                   of the accessibility tree entirely, so the avatar becomes
                   invisible to a screen reader AND unfindable by role - which
                   is how a test asserting it renders passes over nothing. */
                src={account.data.avatarUrl}
                alt={`${account.data.login} on GitHub`}
                className="h-10 w-10 rounded-full object-cover"
              />
            ) : (
              /* Initials, not a broken-image glyph. A packaged app is opened
                 offline and a new account has no avatar at all; two letters
                 beside somebody's name are better than a torn-paper icon. */
              <span className="grid h-10 w-10 place-items-center rounded-full bg-[image:var(--gradient-accent)] text-[13px] font-bold text-navy">
                {initials(account.data.name, account.data.login)}
              </span>
            )}
            title={account.data.name ?? account.data.login}
            /* Every field guarded: GitHub answers null for a private email and
               for an account with no display name, and rendering the string
               "null" under an avatar is worse than rendering nothing. */
            description={<>
              {account.data.email ? `${account.data.email} · ` : ''}
              {account.data.name ? `${account.data.login} · ` : ''}
              connected through the GitHub CLI
            </>}
            control={confirmingSignOut ? (
              <>
                <RowButton onClick={() => setConfirmingSignOut(false)}>Cancel</RowButton>
                <RowButton primary busy={signOut.isPending} onClick={() => signOut.mutate()}>
                  Yes, sign out
                </RowButton>
              </>
            ) : (
              <RowButton onClick={() => setConfirmingSignOut(true)}>Sign out</RowButton>
            )}
            /* Named, because it is not scoped to this app. The credential is
               the GitHub CLI's, shared with everything else on the machine that
               uses gh — and a user who loses issue import silently files it as
               a bug. */
            note={confirmingSignOut
              ? <>This signs the GitHub CLI out on this machine, not just AgEnFK. Importing issues and matching pull requests to cards will stop working until you run <Command>gh auth login</Command> again.</>
              : undefined}
          />
        ) : (
          <SettingRow
            testId="account-row"
            title={account.isLoading ? 'Checking your GitHub account…' : 'Not connected'}
            description="Importing issues and matching pull requests to cards need a GitHub account."
            control={
              <RowButton primary busy={account.isFetching} onClick={() => void account.refetch()}>
                Check again
              </RowButton>
            }
            /* Nothing until the first read answers. "Not connected" shown for
               half a second over an account that IS connected reads as a bug,
               and invites the user to go and re-authenticate for no reason. */
            note={account.isLoading ? undefined
              : account.data?.reason === 'gh_missing'
                ? <>The GitHub CLI is not installed on this machine. Install it from cli.github.com, then check again.</>
                : account.data?.reason === 'unreadable'
                  ? <>Could not read the account. Check that AgEnFK is running, then check again.</>
                  : <>Run <Command>gh auth login</Command> in a terminal, then check again. AgEnFK uses the GitHub CLI&apos;s own credential and never stores one of its own.</>}
          />
        )}
      </>,
    },
    {
      id: 'app',
      label: 'App',
      icon: AppWindow,
      rows: <>
        <SettingRow
          testId="update-row"
          lead={updateState === 'current' ? (
            <span
              aria-hidden
              className="grid h-6 w-6 place-items-center rounded-lg border border-border-brand bg-chip text-[13px] font-bold text-accent-text"
            >
              ✓
            </span>
          ) : undefined}
          title={
            updateState === 'current' ? "You're up to date"
              : updateState === 'available' ? 'An update is available'
                : updateState === 'checking' ? 'Checking for updates…'
                  /* The third state, said out loud. Collapsing it into "up to
                     date" is how the app claims to be current while offline. */
                  : 'Could not check for updates'
          }
          description={
            updateState === 'available'
              ? <>AgEnFK <Command>v{release.data?.version}</Command> is out; you are on <Command>v{currentVersion}</Command></>
              : currentVersion
                ? <>AgEnFK <Command>v{currentVersion}</Command>{updateState === 'current' ? ' is the latest release' : ''}</>
                : 'The version could not be read.'
          }
          control={
            <RowButton busy={release.isFetching} onClick={() => void release.refetch()}>
              Check for updates
            </RowButton>
          }
          note={updateState === 'unknown' && !release.isFetching
            ? <>The release feed could not be reached, so this may not be the newest version.</>
            : undefined}
        />
        <SettingRow
          testId="telemetry-row"
          title="Privacy &amp; telemetry"
          description="Send anonymous usage data to help improve AgEnFK. Never your code, your card titles or anything you type."
          control={
            <Switch
              aria-label="Privacy and telemetry"
              /*
               * OFF until something answers, and disabled while it does not know.
               *
               * A switch has no third position, so "the stored value or nothing"
               * - which an earlier comment here claimed - is not available: it
               * draws one of two states whatever we do. Given that, OFF is the
               * honest default. It matches what the route answers when it
               * cannot read the flag, and the two failure paths agreeing
               * matters more than either choice on its own: a server-side
               * failure showing OFF while a network failure showed ON is a
               * screen contradicting itself about a privacy setting.
               *
               * It also fails in the direction that cannot cost the user
               * anything. Drawing ON over an unread store invites somebody who
               * has already opted out to look at this row and believe they are
               * opted in.
               */
              checked={telemetry.data?.telemetryEnabled ?? false}
              disabled={saveTelemetry.isPending || telemetry.isLoading}
              onCheckedChange={next => saveTelemetry.mutate(next)}
            />
          }
        />
      </>,
    },
    {
      id: 'notifications',
      label: 'Notifications',
      icon: Bell,
      rows: <>
        <SettingRow
          testId="attention-row"
          title="Notify when an agent needs you"
          /* The three words are the states in NEEDS_A_PERSON, said in a way a
             person recognises. Not a fourth list — the card dot and the
             sidebar count read the same set. */
          description="Blocked on a prompt, crashed, or gone quiet long enough that we cannot tell. The events the amber dot already marks."
          control={
            <Switch
              aria-label="Notify when an agent needs you"
              checked={attentionAlerts}
              disabled={saving('attentionAlerts')}
              onCheckedChange={next => save.mutate({ attentionAlerts: next })}
            />
          }
        />
        <SettingRow
          testId="sound-row"
          indent
          title="Sound"
          description="An audio cue for those same events."
          control={<>
            {/* Not decoration. Choosing a sound you cannot hear until an agent
                blocks is choosing blind — and pressing it is the cheapest
                proof the audio path is wired at all. */}
            <button
              type="button"
              aria-label="Preview the sound"
              disabled={!attentionAlerts}
              onClick={() => { void playAttentionSound(browserSoundDeps()); }}
              className="rounded-md px-2 py-1 text-[13px] text-ink-tertiary transition-colors hover:bg-canvas hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
            >
              ▶
            </button>
            <Switch
              aria-label="Sound"
              checked={attentionSound}
              disabled={!attentionAlerts || saving('attentionSound')}
              onCheckedChange={next => save.mutate({ attentionSound: next })}
            />
          </>}
        />
        {soundsAvailable && (
          <SettingRow
            testId="custom-sound-row"
            indent
            title="Custom sound"
            description="Use your own file instead of the built-in cue."
            control={<>
              {customSound.data?.name && (
                <RowButton
                  disabled={!attentionAlerts}
                  busy={clearSound.isPending}
                  onClick={() => clearSound.mutate()}
                >
                  Use the built-in
                </RowButton>
              )}
              <RowButton
                disabled={!attentionAlerts}
                busy={chooseSound.isPending}
                onClick={() => chooseSound.mutate()}
              >
                Choose file…
              </RowButton>
            </>}
            /* Which file, by the name the user knows it by - the copy on
               disk is called custom.wav whatever they called it. `meta` and
               not `note`: this is an ordinary fact, and an amber line that is
               always on screen stops being read. */
            meta={customSound.data?.name
              ? `Playing ${customSound.data.name}`
              : 'Playing the built-in cue.'}
          />
        )}
        <SettingRow
          testId="sound-timing-row"
          indent
          title="When to play"
          description="Always, or only when the AgEnFK window is not the one you are looking at."
          control={
            <select
              aria-label="When to play"
              value={soundTiming}
              disabled={!attentionAlerts || saving('soundTiming')}
              onChange={e => save.mutate({ soundTiming: e.target.value as SoundTimingDto })}
              className="rounded-lg border border-border-soft bg-canvas px-2.5 py-1.5 text-[13px] text-ink-secondary disabled:cursor-not-allowed disabled:opacity-50"
            >
              {/* The two values the server will accept, and no third. A control
                  that can emit anything else produces a 400 the user cannot
                  explain. */}
              <option value="always">Always</option>
              <option value="unfocused">Only when unfocused</option>
            </select>
          }
        />
        <SettingRow
          testId="os-notifications-row"
          indent
          title="OS notifications"
          description="System banners while AgEnFK is in the background."
          control={
            <Switch
              aria-label="OS notifications"
              checked={osNotifications}
              disabled={!attentionAlerts || saving('osNotifications')}
              onCheckedChange={next => save.mutate({ osNotifications: next })}
            />
          }
          /* Probed against the NOTIFICATIONS bridge, not the sounds one.
             `canChooseSound` was the first version of this and it answers a
             different question: on a desktop build whose preload predates this
             feature, it would tell a desktop user that banners need "the
             desktop app" they are already running. agentBridge.ts's header is
             written around exactly that skew. */
          note={canRaiseBanners ? undefined
            /* A browser tab has no OS banner to raise. Said rather than hidden,
               because the preference is real and travels to the desktop app. */
            : <>Banners need the AgEnFK desktop app; this setting is stored but does nothing here.</>}
        />
      </>,
    },
    /*
     * The General section is not here on purpose.
     *
     * It held exactly one row - the tmux toggle - and that is pulled for now at
     * the user's request: the persistence story is being reworked (which agents
     * resume, what survives a quit), and a switch whose consequences are in
     * flux is a switch people flip and then distrust.
     *
     * Removed rather than hidden behind a flag. A section filtered out of this
     * list is a section nothing can reach, which is the same absence with more
     * code to read; git has the rows when they come back.
     */
    {
      id: 'agents',
      label: 'Agents',
      icon: Bot,
      rows: (
        <SettingRow
          testId="auto-approve-row"
          title="Auto-approve by default"
          /* The only setting here that can cost something irreversible, so the
             description says what it lets happen rather than what it turns on.
             This was a per-terminal decision until it moved here; the price of
             the move is that a terminal can now open with the rails off on a
             day nobody thought about it, and the user should read that before
             flipping it, not discover it afterwards. */
          description="Start agents with their own permission prompts disabled, so they edit, delete and run commands without asking. Applies to every terminal you open, including ones you open without thinking about it."
          control={
            <Switch
              aria-label="Auto-approve by default"
              checked={autoApproveByDefault}
              disabled={saveAutoApprove.isPending}
              onCheckedChange={next => saveAutoApprove.mutate(next)}
            />
          }
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
            {/* Decorative: the button's text already names the section, and a
                second label here would make a screen reader say it twice. */}
            <section.icon size={15} aria-hidden="true" className="mr-2.5 shrink-0 opacity-80" />
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
            <Alert tone="warning">
              Could not read your settings, so the switches below may not reflect
              what is stored. Check that AgEnFK is running.
            </Alert>
          )}

          {/* A save that fails has to be visible. The switch does not move on
              its own, so silence here reads as "I missed the button". */}
          {(save.isError || saveAutoApprove.isError || saveTelemetry.isError) && (
            <Alert>Could not save that change; it was not applied.</Alert>
          )}

          {/* An action that answered and did nothing needs its own message. The
              generic "could not save" above would be wrong — the request
              succeeded — and silence would read as the button being dead. */}
          {(signOut.isError || signOutRefused) && (
            /* The reason, when there is one. `gh` gives a specific and useful
               message when it refuses; a network failure gives none, and
               "Could not sign out. " with a dangling space reads as a sentence
               that got cut off. */
            <Alert>Could not sign out.{signOutRefused ? ` ${signOutRefused}` : ''}</Alert>
          )}

          {(chooseSound.isError || clearSound.isError || soundRefused) && (
            <Alert>{soundRefused ?? 'Could not change the sound.'}</Alert>
          )}

          <section data-testid="settings-section" className="mt-8">
            <h2 className="text-[11px] font-bold uppercase tracking-[0.14em] text-ink-tertiary">
              {shown.label === 'Account' ? 'Connected account' : 'Preferences'}
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
