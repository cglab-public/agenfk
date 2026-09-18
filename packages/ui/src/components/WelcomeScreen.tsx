/**
 * What the window shows before there is any work in it (004bd193).
 *
 * An app with nothing in it is the first thing a new user sees and the last
 * thing anyone thinks about. Left alone it is an empty grey rectangle, which
 * reads as broken rather than as new - so this is the one screen where the
 * brand mark earns its size: at this point it is the only thing identifying
 * the window.
 *
 * THE ACTIONS ARE THE SCREEN, not decoration under a logo. Somebody here has
 * exactly one question - how do I start - and the answer is a short list of
 * real routes. Every entry below is wired to something the app can already do:
 * a control that opens nothing would be worse than a shorter list, and this is
 * precisely the screen where a dead button is most likely to be pressed.
 *
 * Deliberately NOT a modal. It is the resting state of an empty window, not an
 * interruption, and there is nothing behind it to go back to.
 */
import React from 'react';
import { FolderPlus, Github, Link2 } from 'lucide-react';
import { AgenfkFlag } from './AgenfkFlag';
import { AgenfkWordmark } from './AgenfkWordmark';

export interface WelcomeAction {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly Icon: React.ComponentType<{ size?: number; className?: string }>;
  readonly onSelect: () => void;
}

export interface WelcomeScreenProps {
  /**
   * What somebody can do from here. Passed in rather than built inside,
   * because the shell owns the dialogs these open and a screen that reached
   * for them itself would be a second place that knows how to start work.
   */
  readonly actions: readonly WelcomeAction[];
}

export function WelcomeScreen({ actions }: WelcomeScreenProps): React.ReactElement {
  return (
    <div
      data-testid="welcome-screen"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-10 p-8"
    >
      {/* The LOCKUP: the flag with the name beside it, which is how the brand
          book draws it. The top bar carries the name alone because a chrome bar
          has no room for the mark; here there is room, and this is the one
          screen where the product should introduce itself in full.

          The flag is named and the wordmark is hidden from assistive tech -
          otherwise the pair announces "AgEnFK agenFK", which is the same thing
          twice. */}
      <div className="flex items-center gap-4">
        <AgenfkFlag size={64} label="AgEnFK" />
        <span aria-hidden="true">
          <AgenfkWordmark size={34} />
        </span>
      </div>

      <ul className="flex w-full max-w-md flex-col gap-1">
        {actions.map(action => (
          <li key={action.id}>
            <button
              type="button"
              onClick={action.onSelect}
              className="group flex w-full items-start gap-3 rounded-lg border border-transparent px-4 py-3 text-left transition-colors hover:border-border-soft hover:bg-nav-surface focus-visible:border-brand focus-visible:outline-none"
            >
              <action.Icon size={18} className="mt-0.5 shrink-0 text-ink-tertiary transition-colors group-hover:text-brand" />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-ink">{action.label}</span>
                {/* Says what the action DOES, not what it is called again. The
                    label is the verb; this is the consequence, which is the
                    part somebody who has never used this needs. */}
                <span className="block text-xs leading-relaxed text-ink-tertiary">
                  {action.description}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The ways to start, as data.
 *
 * Exported so the shell can wire the handlers and a test can assert the SET
 * without reaching into the shell. Every entry names a route that exists, and
 * the caller decides which of them are reachable from where it is calling -
 * see the imports below.
 */
export function welcomeActions(handlers: {
  onNewProject: () => void;
  /** Both imports need somewhere to import INTO - see below. */
  onImportGitHub?: () => void;
  onImportJira?: () => void;
}): WelcomeAction[] {
  const actions: WelcomeAction[] = [
    {
      id: 'new-project',
      label: 'New project',
      description: 'Start from a directory on this machine.',
      Icon: FolderPlus,
      onSelect: handlers.onNewProject,
    },
  ];

  /*
   * The imports are OPTIONAL, and the reason is the whole point of this list.
   *
   * Both of them bring issues INTO a project - their dialogs take a projectId
   * and cannot run without one. On the screen that exists because there are no
   * projects, they have nowhere to put anything, so offering them would be the
   * dead control this screen is most likely to have pressed.
   *
   * The reference this was drawn from shows four entries. Two of them do not
   * exist here at all (cloning a repository, adding an SSH host) and these two
   * do not exist YET at this moment. A shorter list that works beats a longer
   * one that matches a mockup.
   */
  if (handlers.onImportGitHub) {
    actions.push({
      id: 'import-github',
      label: 'Import from GitHub',
      description: 'Bring issues in as cards you can work.',
      Icon: Github,
      onSelect: handlers.onImportGitHub,
    });
  }
  if (handlers.onImportJira) {
    actions.push({
      id: 'import-jira',
      label: 'Import from Jira',
      description: 'Bring issues in from a connected Jira project.',
      Icon: Link2,
      onSelect: handlers.onImportJira,
    });
  }
  return actions;
}
