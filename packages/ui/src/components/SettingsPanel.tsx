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
 * **Only settings that exist.** No section is included because a reference app
 * has one. An empty section promises a control that is not there and sends the
 * user looking for it twice.
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
  title, description, checked, onChange, busy,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  busy?: boolean;
}): React.ReactElement {
  return (
    <div
      data-testid="setting-row"
      className="flex items-start gap-4 border-b border-border-soft py-4 last:border-b-0"
    >
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold text-ink">{title}</p>
        <p className="mt-0.5 text-[12px] leading-snug text-ink-tertiary">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={title}
        disabled={busy}
        onClick={() => onChange(!checked)}
        className={clsx(
          'mt-0.5 shrink-0',
          busy ? 'cursor-wait opacity-60' : 'cursor-pointer',
        )}
      >
        <span
          className={clsx(
            'relative block h-5 w-9 rounded-full transition-colors',
            checked ? 'bg-emerald-500' : 'border border-border-soft bg-canvas',
          )}
        >
          <span
            className={clsx(
              'absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform motion-reduce:transition-none',
              checked ? 'translate-x-[18px]' : 'translate-x-0.5',
            )}
          />
        </span>
      </button>
    </div>
  );
}

export function SettingsPanel(): React.ReactElement {
  const queryClient = useQueryClient();
  const { data: settings } = useQuery<AppSettings>({
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
    onError: () => { void queryClient.invalidateQueries({ queryKey: ['settings'] }); },
  });

  // Absent while the first read is in flight. `?? false` rather than a spinner:
  // the row is one line, and a switch that appears after a flash of skeleton is
  // more jarring than one that starts at its default and corrects itself.
  const tmuxByDefault = settings?.tmuxByDefault ?? false;

  return (
    <div className="mx-auto w-full max-w-3xl px-8 py-10">
      <header>
        <h1 className="text-xl font-semibold text-ink">Settings</h1>
        <p className="mt-1 text-[13px] text-ink-tertiary">
          These apply to every project on this installation.
        </p>
      </header>

      <section data-testid="settings-section" className="mt-8">
        <h2 className="text-[11px] font-bold uppercase tracking-[0.14em] text-ink-tertiary">
          Preferences
        </h2>
        <div className="mt-2 rounded-xl border border-border-soft bg-nav-surface px-5">
          <SettingRow
            title="Enable tmux"
            /* Names the consequence first. Someone who does not know what tmux
               is still learns exactly what changes for them. */
            description="Run agent sessions and terminals inside tmux, so they keep running when you quit the app. Requires tmux to be installed."
            checked={tmuxByDefault}
            busy={save.isPending}
            onChange={next => save.mutate({ tmuxByDefault: next })}
          />
        </div>
      </section>
    </div>
  );
}
