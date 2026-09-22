import React from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Folder } from 'lucide-react';

/**
 * Which project this is for.
 *
 * NOT A NATIVE `<select>`, and that is the whole reason this file exists. A
 * native menu is drawn by the operating system: inside a dark window it opened
 * as a white system list, in the system font, ignoring every token the rest of
 * the app is built from. It also cannot draw the folder beside the name or the
 * path beneath it — and the path is the part that answers "which agenfk", on a
 * machine with three checkouts of it.
 *
 * The menu is a portal for the same reason the agent picker's is: absolutely
 * positioned inside its own wrapper it was clipped by the first scrolling
 * ancestor, which in a panel is the panel.
 */
export interface ProjectOption {
  readonly id: string;
  readonly name: string;
  readonly projectRoot?: string;
}

export interface ProjectPickerProps {
  readonly value: string;
  readonly projects: readonly ProjectOption[];
  readonly onChange: (projectId: string) => void;
  readonly testId?: string;
}

export function ProjectPicker({ value, projects, onChange, testId = 'project-picker' }: ProjectPickerProps) {
  const [open, setOpen] = React.useState(false);
  const [anchor, setAnchor] = React.useState<{ top: number; left: number; width: number } | null>(null);
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  /*
   * THE LIST ITSELF, because "outside" cannot be decided from the button alone
   * once the menu is a portal.
   */
  const listRef = React.useRef<HTMLUListElement>(null);
  const current = projects.find(p => p.id === value);

  const place = React.useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setAnchor({ top: rect.bottom + 6, left: rect.left, width: rect.width });
  }, []);

  React.useEffect(() => {
    if (!open) return;
    place();
    /*
     * THE BUG THIS GUARD EXISTS FOR, and the one it caused.
     *
     * Closing on `mousedown` outside the BUTTON meant the menu closed on the
     * way down over one of its own options: the list lives in a portal, so it
     * is never inside the button. React unmounted the option between mousedown
     * and mouseup, and the `click` therefore never completed on it — choosing
     * a project did nothing at all, silently.
     *
     * The list is "inside" too. It is a portal in the DOM, not in the idea of
     * this control.
     */
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (buttonRef.current?.contains(target) || listRef.current?.contains(target)) return;
      setOpen(false);
    };
    /*
     * Escape answers the innermost question, and stops there. The panel this
     * sits in closes on Escape too, at document level — so without stopping
     * the key, dismissing a dropdown also threw away the objective, the
     * agent's answer and every kept/dropped row behind it.
     */
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };
    // Re-measured on scroll: a fixed menu keeping its first position detaches
    // from its button the moment anything moves.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, place]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-testid={testId}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Project"
        onClick={() => { place(); setOpen(o => !o); }}
        className="flex min-w-0 items-center gap-2 rounded-lg border border-border-soft bg-surface px-2.5 py-1.5 text-xs text-ink"
      >
        <Folder size={14} className="shrink-0 text-ink-tertiary" />
        <span className="min-w-0 flex-1 truncate text-left font-semibold">{current?.name ?? 'Choose a project'}</span>
        <ChevronDown size={14} className="shrink-0 text-ink-tertiary" />
      </button>

      {open && anchor && createPortal(
        <ul
          ref={listRef}
          role="listbox"
          aria-label="Project"
          data-testid={`${testId}-options`}
          style={{ position: 'fixed', top: anchor.top, left: anchor.left, minWidth: Math.max(anchor.width, 280) }}
          className="z-[60] max-h-[20rem] overflow-y-auto rounded-xl border border-border-soft bg-surface py-1 shadow-2xl"
        >
          {projects.map(project => {
            // A project with no checkout cannot host an agent run, so it is
            // offered as unavailable rather than hidden: hiding it turns "not
            // set up yet" into "does not exist".
            const usable = Boolean(project.projectRoot);
            return (
              <li key={project.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={project.id === value}
                  aria-disabled={!usable || undefined}
                  data-testid={`${testId}-option-${project.id}`}
                  onClick={() => { if (usable) { onChange(project.id); setOpen(false); } }}
                  className={`flex w-full items-start gap-2.5 px-3 py-2 text-left ${
                    usable ? 'hover:bg-chip' : 'cursor-not-allowed opacity-50'
                  }`}
                >
                  <Folder size={14} className="mt-0.5 shrink-0 text-ink-tertiary" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-semibold text-ink">{project.name}</span>
                    {/* The path, because "which agenfk" is a real question on a
                        machine with three checkouts of it. */}
                    <span className="block truncate font-mono text-[10.5px] text-ink-tertiary">
                      {project.projectRoot ?? 'no folder yet — an agent has nowhere to run'}
                    </span>
                  </span>
                  {project.id === value && <Check size={14} className="mt-0.5 shrink-0 text-accent-text" />}
                </button>
              </li>
            );
          })}
        </ul>,
        document.body,
      )}
    </>
  );
}
