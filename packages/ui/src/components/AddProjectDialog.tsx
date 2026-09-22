import React from 'react';
import { createPortal } from 'react-dom';
import { FolderGit2, Download, Github, X, ChevronDown, ChevronLeft, Check } from 'lucide-react';
import {
  addChosenFolderFromBridge, chooseCloneDirFromBridge, chooseProjectFolderFromBridge,
  cloneDirFromBridge, cloneRepositoryFromBridge, createRepositoryFromBridge,
  githubOwnersFromBridge, type GitHubOwner,
} from './agentBridge';

/**
 * Add Project — one door, three ways in, and the ways do NOT share a screen.
 *
 * It started as two buttons bolted onto the project row of the propose panel,
 * with the clone form unfolding underneath. Everything was visible at once,
 * which reads as one long form with two thirds of it inert: the folder button
 * has nothing to do with the URL field beside it. Tabs fix that by answering
 * the only question that orders the rest — do you HAVE this project already,
 * are you FETCHING it, or does it not exist yet — and then showing the fields
 * that belong to that answer and no others.
 *
 * THE DIRECTORY IS PROPOSED, NOT IMPOSED. The field arrives filled with
 * ~/agenfk rather than empty, because "choose where clones land" as a
 * precondition is a question with an obvious answer that we made the person
 * type anyway. It is still written on screen and still changeable, which is
 * the whole difference between a default and an app that writes where it
 * likes. Nothing is created until the clone runs, so a machine that never
 * clones never grows the folder.
 */

type Mode = 'folder' | 'clone' | 'create';

const TABS: { id: Mode; label: string; Icon: typeof Download }[] = [
  { id: 'folder', label: 'Pick a folder', Icon: FolderGit2 },
  { id: 'clone', label: 'Clone', Icon: Download },
  { id: 'create', label: 'Create on GitHub', Icon: Github },
];

/**
 * The repository's own name, read out of any shape git accepts.
 *
 * Mirrors `folderNameFor` in the main process on purpose: this one only
 * SUGGESTS — a name to show and a folder to promise — while that one decides
 * where the clone actually lands. Main never trusts this value.
 */
export function repoNameFrom(url: string): string {
  return url.trim().replace(/\/+$/, '').split(/[/:]/).pop()?.replace(/\.git$/i, '') ?? '';
}

/** The folder `git clone <url>` would make, spelled out before it exists. */
export function landingFolder(dir: string, url: string): string {
  const name = repoNameFrom(url);
  if (!name) return '';
  return `${dir.replace(/\/+$/, '')}/${name}`;
}

/**
 * An owner's avatar, or their initial when there is none to show.
 *
 * Failure is silent on purpose: an avatar that will not load is a missing
 * picture, not a missing owner, and a broken-image icon beside a name reads as
 * "something is wrong with this account".
 */
function OwnerMark({ owner }: { owner: GitHubOwner | null }) {
  const [broken, setBroken] = React.useState(false);
  if (owner?.avatarUrl && !broken) {
    return (
      <img
        src={owner.avatarUrl}
        alt=""
        onError={() => setBroken(true)}
        className="h-4 w-4 shrink-0 rounded-full"
      />
    );
  }
  return (
    <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-chip text-[9px] font-bold uppercase text-accent-text">
      {owner?.login?.[0] ?? '?'}
    </span>
  );
}

export function AddProjectDialog(
  { open, onClose, onAdded }:
  { open: boolean; onClose: () => void; onAdded: (projectId: string) => void },
) {
  const [mode, setMode] = React.useState<Mode>('folder');
  const [folder, setFolder] = React.useState('');
  const [name, setName] = React.useState('');
  const [namedByHand, setNamedByHand] = React.useState(false);
  const [dir, setDir] = React.useState('');
  const [url, setUrl] = React.useState('');
  const [owners, setOwners] = React.useState<GitHubOwner[] | null>(null);
  const [owner, setOwner] = React.useState('');
  const [repo, setRepo] = React.useState('');
  const [visibility, setVisibility] = React.useState<'private' | 'public'>('private');
  /*
   * The owner list takes over THIS dialog rather than opening a second one.
   * A modal on top of a modal has two Escapes, two backdrops and no obvious
   * way back — so choosing is a VIEW of the same window, with a Back button.
   */
  const [choosingOwner, setChoosingOwner] = React.useState(false);
  const [ownerQuery, setOwnerQuery] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  /*
   * OPENING IS A FRESH START. The dialog stays mounted (the early return below
   * sits after the hooks), so without this a URL that was just cloned is still
   * in the field the next time it opens — with the primary button armed, and
   * the only thing standing between it and a second clone being main's "already
   * exists". Reopening is not resuming.
   */
  React.useEffect(() => {
    if (!open) return;
    setError(null);
    setUrl('');
    setFolder('');
    setName('');
    setNamedByHand(false);
    setMode('folder');
    setRepo('');
    setChoosingOwner(false);
    setOwnerQuery('');
    /*
     * Asked once per opening, not per keystroke: `gh api user/orgs` is a
     * network round trip, and the answer does not change while a dialog is
     * open. An empty list is "not signed in" and says so below.
     */
    const pendingOwners = githubOwnersFromBridge();
    if (pendingOwners) {
      pendingOwners
        .then(list => {
          setOwners(list);
          // Default to the person themselves, which is who most repositories
          // belong to — and never overwrite a choice already made.
          setOwner(prev => prev || list.find(o => o.self)?.login || list[0]?.login || '');
        })
        .catch(() => setOwners([]));
    } else {
      setOwners([]);
    }
    // The proposed directory comes from the main process, which is the only
    // side that knows this machine's home — the renderer never invents a path.
    const pending = cloneDirFromBridge();
    if (pending) pending.then(({ path }) => setDir(path)).catch(() => {});
  }, [open]);

  /*
   * ESCAPE ANSWERS THE INNERMOST QUESTION. The panel behind this one closes on
   * Escape too, at document level, and unmounts this subtree with it — so
   * without stopping the key here, dismissing the dialog also threw away the
   * objective, the proposal and every kept/dropped row behind it.
   *
   * And never mid-clone: the X and Cancel are deliberately disabled while git
   * runs, so a keyboard route that ignored that would be the disabled buttons
   * lying. Swallowed rather than passed on, for the same reason.
   */
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (busy) return;
      // One level at a time: the owner list closes first, the dialog second.
      if (choosingOwner) setChoosingOwner(false);
      else onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, busy, onClose, choosingOwner]);

  if (!open) return null;

  const settle = (projectId: string) => {
    onAdded(projectId);
    onClose();
  };

  /*
   * CHOOSING IS NOT ADDING. The picker used to be the whole decision — a
   * folder was chosen and a project existed, under a name nobody was offered.
   * Now it fills the two fields and stops; the button below is what writes.
   */
  const pickFolder = async () => {
    setError(null);
    const pending = chooseProjectFolderFromBridge();
    if (!pending) {
      setError('This build cannot add a project from a folder — it predates that, or this is the browser.');
      return;
    }
    try {
      const picked = await pending;
      if (!picked) return; // cancelled is not an error
      setFolder(picked.path);
      // The suggestion follows the folder until somebody types over it; after
      // that it is theirs, and a second pick must not overwrite their word.
      if (!namedByHand) setName(picked.name);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  };

  const addFolder = async () => {
    setError(null);
    const pending = addChosenFolderFromBridge(name.trim());
    if (!pending) {
      setError('This build cannot add a project from a folder — it predates that, or this is the browser.');
      return;
    }
    setBusy(true);
    try {
      settle((await pending).id);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const clone = async () => {
    setError(null);
    const pending = cloneRepositoryFromBridge(url.trim(), name.trim());
    if (!pending) {
      setError('This build cannot clone — it predates that, or this is the browser.');
      return;
    }
    setBusy(true);
    try {
      const project = await pending;
      settle(project.id);
    } catch (e: any) {
      // git's own words, including where any leftovers are.
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const createRepo = async () => {
    setError(null);
    const pending = createRepositoryFromBridge({
      owner, repo: repo.trim(), visibility, name: name.trim(),
    });
    if (!pending) {
      setError('This build cannot create a repository — it predates that, or this is the browser.');
      return;
    }
    setBusy(true);
    try {
      settle((await pending).id);
    } catch (e: any) {
      // GitHub's own words, including "was created" when the clone is what
      // failed — the difference between a retry and a duplicate repository.
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const target = landingFolder(dir, url);
  const chosen = owners?.find(o => o.login === owner) ?? null;
  const matching = (owners ?? []).filter(
    o => o.login.toLowerCase().includes(ownerQuery.trim().toLowerCase()),
  );

  /*
   * PORTALLED TO THE BODY. This renders from inside the Ask panel, which is
   * itself a scrolling box inside a backdrop-blurred overlay — and a
   * backdrop-filter makes that overlay the containing block for fixed
   * descendants. Rather than reason about whether the scroll box clips us,
   * leave the subtree entirely: the dialog belongs to the window, not to the
   * panel that opened it.
   */
  return createPortal(
    <div
      data-testid="add-project"
      role="dialog"
      aria-modal="true"
      aria-label="Add Project"
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-8"
    >
      <div className="w-full max-w-xl overflow-hidden rounded-2xl border border-border-soft bg-surface shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-border-soft px-5 py-4">
          <h2 className="flex items-center gap-2 text-base font-semibold text-ink">
            <FolderGit2 size={17} className="text-ink-secondary" />
            Add a project
          </h2>
          {/* The key that closes it, written down. It is the gesture people try
              first, and until this card it closed the panel behind instead. */}
          <span className="rounded-full border border-border-soft px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest text-ink-tertiary">
            esc
          </span>
          <button
            type="button"
            data-testid="add-project-close"
            aria-label="Close"
            onClick={onClose}
            disabled={busy}
            className="sr-only"
          >
            <X size={16} />
          </button>
        </div>

        {/*
          * ABOVE THE TABS, because every door needs it. A folder, a clone and
          * a repository created on GitHub all end as a project, and a project
          * has a name — so the field belongs to the dialog, not to one mode.
          * Each mode only decides what it SUGGESTS: the folder's basename, or
          * the repository's own name.
          */}
        <div className="flex flex-col gap-2 px-5 pt-4">
          <label htmlFor="add-project-name" className="text-[10.5px] font-mono uppercase tracking-widest text-ink-tertiary">
            Project name
          </label>
          <div className="flex items-center gap-2 rounded-lg border border-border-soft bg-canvas px-3 py-2">
            <input
              id="add-project-name"
              data-testid="add-project-name"
              value={name}
              disabled={busy}
              onChange={e => { setName(e.target.value); setNamedByHand(true); }}
              placeholder="named after the folder or the repository"
              className="min-w-0 flex-1 bg-transparent text-sm text-ink focus:outline-none"
            />
            {/* Where the word came from, so an unexpected name is traceable
                rather than mysterious. */}
            {!namedByHand && name && (
              <span data-testid="add-project-name-from" className="shrink-0 text-xs text-ink-tertiary">
                — {mode === 'clone' ? 'from the repository' : 'from the folder'}
              </span>
            )}
          </div>
        </div>

        <div role="tablist" aria-label="How to add the project" className="flex gap-2 px-5 pt-4">
          {TABS.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={mode === id}
              data-testid={`add-project-tab-${id}`}
              onClick={() => { setMode(id); setError(null); }}
              disabled={busy}
              className={`flex flex-1 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors ${
                mode === id
                  ? 'border-border-brand bg-chip text-accent-text'
                  : 'border-border-soft bg-canvas text-ink-secondary hover:text-ink'
              }`}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-4 border-t border-border-soft px-5 py-4">
          {mode === 'folder' && (
            <div data-testid="add-project-folder" className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <p id="add-project-folder-label" className="text-[10.5px] font-mono uppercase tracking-widest text-ink-tertiary">
                  Folder
                </p>
                <div className="flex items-center gap-2">
                  <span
                    data-testid="add-project-folder-path"
                    aria-labelledby="add-project-folder-label"
                    className="flex min-w-0 flex-1 items-center gap-2 truncate rounded-lg border border-border-soft bg-canvas px-3 py-2 font-mono text-[11.5px] text-ink-secondary"
                  >
                    <FolderGit2 size={13} className="shrink-0 text-ink-tertiary" />
                    {folder || 'no folder chosen yet'}
                  </span>
                  <button
                    type="button"
                    data-testid="add-project-choose-folder"
                    onClick={pickFolder}
                    disabled={busy}
                    className="shrink-0 rounded-lg border border-border-soft bg-canvas px-3 py-2 text-[11px] font-semibold text-ink disabled:opacity-50"
                  >
                    Choose…
                  </button>
                </div>
              </div>

              <p className="text-xs text-ink-secondary">
                Cards land here and agents run here. Nothing is cloned, nothing is created.
              </p>
            </div>
          )}

          {mode === 'clone' && (
            <div data-testid="add-project-clone" className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <label htmlFor="add-project-url" className="text-[10.5px] font-mono uppercase tracking-widest text-ink-tertiary">
                  Repository
                </label>
                <input
                  id="add-project-url"
                  data-testid="add-project-url"
                  value={url}
                  disabled={busy}
                  onChange={e => {
                    setUrl(e.target.value);
                    // The repository names the project, exactly as the folder
                    // does on the other tab — and stops the moment somebody
                    // decides otherwise.
                    if (!namedByHand) setName(repoNameFrom(e.target.value));
                  }}
                  placeholder="git@github.com:team/repo.git"
                  className="w-full rounded-lg border border-border-soft bg-canvas px-3 py-2 font-mono text-xs text-ink focus:outline-none focus:ring-2 focus:ring-brand"
                />
              </div>
              <div className="flex flex-col gap-2">
                {/* A span, not an input — the picker is the only writer — so
                    this is a heading for it rather than a <label> with nothing
                    to point at. */}
                <p id="add-project-dir-label" className="text-[10.5px] font-mono uppercase tracking-widest text-ink-tertiary">
                  Clone into
                </p>
                <div className="flex items-center gap-2">
                  <span data-testid="add-project-dir" aria-labelledby="add-project-dir-label" className="min-w-0 flex-1 truncate rounded-lg border border-border-soft bg-canvas px-3 py-2 font-mono text-[11px] text-ink-tertiary">
                    {dir || 'choose where clones land'}
                  </span>
                  <button
                    type="button"
                    data-testid="add-project-choose-dir"
                    disabled={busy}
                    onClick={async () => {
                      const pending = chooseCloneDirFromBridge();
                      if (!pending) { setError('This build cannot choose a folder.'); return; }
                      // The main process refuses too — an older build answers
                      // this channel with a rejection, and swallowing it left
                      // the button doing nothing at all.
                      try {
                        const { path } = await pending;
                        if (path) setDir(path);
                      } catch (e: any) {
                        setError(String(e?.message ?? e));
                      }
                    }}
                    className="shrink-0 rounded-lg border border-border-soft bg-canvas px-3 py-2 text-[11px] font-semibold text-ink disabled:opacity-50"
                  >
                    Choose…
                  </button>
                </div>
                {target && (
                  <p data-testid="add-project-target" className="text-[11px] text-ink-tertiary">
                    Becomes <span className="font-mono">{target}</span>. Remembered for next time.
                  </p>
                )}
              </div>
            </div>
          )}

          {mode === 'create' && (
            <div data-testid="add-project-create" className="flex flex-col gap-4">
              {owners !== null && owners.length === 0 ? (
                /* NOT SIGNED IN IS A STATE, not an error: the mode is still
                   offered, explains itself, and names the one command that
                   helps. An empty menu would just look broken. */
                <div data-testid="add-project-signed-out" className="flex flex-col gap-2">
                  <p className="text-xs text-ink-secondary">
                    No GitHub account is connected, so there is nobody to create the repository as.
                  </p>
                  <p className="font-mono text-[11px] text-ink-tertiary">gh auth login</p>
                </div>
              ) : (
                <>
                  <div className="flex items-end gap-2">
                    <div className="relative flex min-w-0 flex-col gap-2">
                      <p id="add-project-owner-label" className="text-[10.5px] font-mono uppercase tracking-widest text-ink-tertiary">
                        Owner
                      </p>
                      <button
                        type="button"
                        data-testid="add-project-owner"
                        aria-labelledby="add-project-owner-label"
                        disabled={busy}
                        onClick={() => { setOwnerQuery(''); setChoosingOwner(true); }}
                        className="flex items-center gap-2 rounded-lg border border-border-soft bg-canvas px-3 py-2 text-sm text-ink disabled:opacity-50"
                      >
                        <OwnerMark owner={chosen} />
                        <span className="max-w-[9rem] truncate">{owner || 'choose…'}</span>
                        <ChevronDown size={13} className="text-ink-tertiary" />
                      </button>
                      {choosingOwner && (
                        /*
                         * ON THE SAME SCREEN, under the control it belongs to.
                         * This was briefly a view that replaced the form, which
                         * is a second modal wearing a Back button: the name,
                         * the visibility and the destination all vanished to
                         * answer one question about one field.
                         */
                        <div
                          data-testid="add-project-owner-list"
                          className="absolute left-0 top-full z-10 mt-1 w-72 overflow-hidden rounded-xl border border-border-soft bg-surface shadow-2xl"
                        >
                          <div className="flex items-center gap-2 border-b border-border-soft px-2 py-2">
                            <button
                              type="button"
                              data-testid="add-project-owner-back"
                              onClick={() => setChoosingOwner(false)}
                              className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-semibold text-ink-tertiary hover:text-ink"
                            >
                              <ChevronLeft size={13} /> Back
                            </button>
                            <input
                              data-testid="add-project-owner-search"
                              value={ownerQuery}
                              autoFocus
                              onChange={e => setOwnerQuery(e.target.value)}
                              placeholder="Search owners…"
                              className="min-w-0 flex-1 bg-transparent text-xs text-ink focus:outline-none"
                            />
                          </div>
                          <div className="flex max-h-56 flex-col gap-0.5 overflow-y-auto p-1">
                            {matching.map(o => (
                              <button
                                key={o.login}
                                type="button"
                                data-testid={`add-project-owner-option-${o.login}`}
                                onClick={() => { setOwner(o.login); setChoosingOwner(false); }}
                                className={`flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs ${
                                  o.login === owner ? 'bg-chip text-ink' : 'text-ink-secondary hover:text-ink'
                                }`}
                              >
                                <OwnerMark owner={o} />
                                <span className="min-w-0 flex-1 truncate text-left">{o.login}</span>
                                {o.login === owner && <Check size={13} className="text-accent-text" />}
                              </button>
                            ))}
                            {matching.length === 0 && (
                              <p data-testid="add-project-owner-none" className="px-2.5 py-2 text-[11px] text-ink-tertiary">
                                No owner matches “{ownerQuery}”.
                              </p>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                    <span className="pb-2 text-ink-tertiary">/</span>
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                      <label htmlFor="add-project-repo" className="text-[10.5px] font-mono uppercase tracking-widest text-ink-tertiary">
                        Repository name
                      </label>
                      <input
                        id="add-project-repo"
                        data-testid="add-project-repo"
                        value={repo}
                        disabled={busy}
                        onChange={e => {
                          setRepo(e.target.value);
                          if (!namedByHand) setName(e.target.value);
                        }}
                        placeholder="Enter a repository name"
                        className="w-full rounded-lg border border-border-soft bg-canvas px-3 py-2 font-mono text-xs text-ink focus:outline-none focus:ring-2 focus:ring-brand"
                      />
                    </div>
                  </div>

                  <div className="flex items-center gap-3 border-t border-border-soft pt-4">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-ink">Choose visibility</p>
                      <p className="text-xs text-ink-tertiary">
                        Who can see and commit to this repository.
                      </p>
                    </div>
                    {/* Two states, both visible. A menu would hide the one that
                        matters — publishing something by accident is the
                        mistake this control exists to prevent. */}
                    <div className="flex shrink-0 overflow-hidden rounded-lg border border-border-soft">
                      {(['private', 'public'] as const).map(v => (
                        <button
                          key={v}
                          type="button"
                          data-testid={`add-project-visibility-${v}`}
                          aria-pressed={visibility === v}
                          disabled={busy}
                          onClick={() => setVisibility(v)}
                          className={`px-3 py-1.5 text-xs font-semibold capitalize ${
                            visibility === v ? 'bg-chip text-accent-text' : 'bg-canvas text-ink-tertiary'
                          }`}
                        >
                          {v}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="flex flex-col gap-2 border-t border-border-soft pt-4">
                    <p id="add-project-into-label" className="text-[10.5px] font-mono uppercase tracking-widest text-ink-tertiary">
                      Clone into
                    </p>
                    <div className="flex items-center gap-2">
                      <span
                        data-testid="add-project-create-dir"
                        aria-labelledby="add-project-into-label"
                        className="min-w-0 flex-1 truncate rounded-lg border border-border-soft bg-canvas px-3 py-2 font-mono text-[11px] text-ink-tertiary"
                      >
                        {dir}
                      </span>
                      <button
                        type="button"
                        data-testid="add-project-create-choose-dir"
                        disabled={busy}
                        onClick={async () => {
                          const pending = chooseCloneDirFromBridge();
                          if (!pending) { setError('This build cannot choose a folder.'); return; }
                          try {
                            const { path } = await pending;
                            if (path) setDir(path);
                          } catch (e: any) {
                            setError(String(e?.message ?? e));
                          }
                        }}
                        className="shrink-0 rounded-lg border border-border-soft bg-canvas px-3 py-2 text-[11px] font-semibold text-ink disabled:opacity-50"
                      >
                        Choose…
                      </button>
                    </div>
                    {repo.trim() && (
                      <p data-testid="add-project-create-target" className="text-[11px] text-ink-tertiary">
                        Becomes <span className="font-mono">{landingFolder(dir, repo)}</span>.
                      </p>
                    )}
                  </div>

                  {/* WHO IS ACTING, above the button, because this is the only
                      door that writes where other people can see it. */}
                  {chosen && (
                    <p data-testid="add-project-acting-as" className="flex items-center gap-2 rounded-lg border border-border-soft bg-canvas px-3 py-2 text-xs text-ink-secondary">
                      <OwnerMark owner={chosen} />
                      Creating as <span className="font-semibold text-ink">@{chosen.login}</span>
                      <span className="text-ink-tertiary">github.com</span>
                    </p>
                  )}
                </>
              )}
            </div>
          )}

          {error && (
            <p data-testid="add-project-error" className="whitespace-pre-wrap rounded-lg border border-danger-muted bg-canvas p-2 font-mono text-[11px] text-danger-text">
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border-soft bg-canvas px-5 py-3">
          <button
            type="button"
            data-testid="add-project-cancel"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg border border-border-soft bg-surface px-3 py-1.5 text-xs font-semibold text-ink disabled:opacity-50"
          >
            Cancel
          </button>
          {mode === 'folder' && (
            <button
              type="button"
              data-testid="add-project-add"
              onClick={addFolder}
              disabled={busy || !folder || !name.trim()}
              className="flex items-center gap-2 rounded-lg bg-brand px-3 py-1.5 text-xs font-bold text-navy disabled:opacity-50"
            >
              {busy ? 'Adding…' : '＋ Add project'}
            </button>
          )}
          {mode === 'create' && owners !== null && owners.length > 0 && (
            <button
              type="button"
              data-testid="add-project-create-run"
              onClick={createRepo}
              disabled={busy || !owner || !repo.trim() || !name.trim()}
              className="rounded-lg bg-brand px-3 py-1.5 text-xs font-bold text-navy disabled:opacity-50"
            >
              {busy ? 'Creating…' : 'Create & add'}
            </button>
          )}
          {mode === 'clone' && (
            <button
              type="button"
              data-testid="add-project-clone-run"
              onClick={clone}
              disabled={busy || !url.trim() || !dir || !name.trim()}
              className="rounded-lg bg-brand px-3 py-1.5 text-xs font-bold text-navy disabled:opacity-50"
            >
              {busy ? 'Cloning…' : 'Clone & add'}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
