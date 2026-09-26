/**
 * Create a project from the sidebar (CGLAB-172).
 *
 * The board already has this, behind the project picker — you open a modal to
 * reach it. Here it is a `+` sitting next to the list it adds to, and the field
 * opens inline, because the whole reason to move it is to skip the modal.
 *
 * Its own component rather than more markup inside AppShell: the shell should
 * stay a layout, and a thing with a form, a mutation and an error state
 * deserves to be testable without mounting the whole window.
 */
import React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api } from '../api';

export function NewProjectButton({ onCreated }: { onCreated?: (id: string) => void }) {
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const inputRef = React.useRef<HTMLInputElement>(null);
  // Guards the submit path. `mutation.isPending` only becomes true on the next
  // render, so it cannot stop a second Enter fired in the same tick — holding
  // someone's key down would create two projects.
  const submitting = React.useRef(false);
  const queryClient = useQueryClient();

  const create = useMutation({
    mutationFn: (projectName: string) => api.createProject({ name: projectName }),
    onSuccess: (project: { id: string }) => {
      submitting.current = false;
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      setOpen(false);
      setName('');
      onCreated?.(project.id);
    },
    onError: () => { submitting.current = false; },
    // On failure the field stays open with the text intact: the request failed,
    // what you typed did not, and making you retype it is a second punishment.
  });

  // Focus after the field exists. An effect, not requestAnimationFrame: the
  // field is created by the same update that sets `open`, and rAF would also
  // leave this untestable outside a real browser frame loop.
  React.useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const submit = (): void => {
    const trimmed = name.trim();
    if (!trimmed || submitting.current) return;
    submitting.current = true;
    create.mutate(trimmed);
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        aria-label="New project"
        title="New project"
        className="flex items-center rounded p-1 text-ink-tertiary transition-colors hover:bg-canvas hover:text-ink-secondary"
      >
        <Plus size={14} />
      </button>
    );
  }

  return (
    <div className="px-1 py-1">
      <input
        ref={inputRef}
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') { setOpen(false); setName(''); submitting.current = false; create.reset(); }
        }}
        placeholder="Project name"
        aria-label="New project name"
        className="w-full rounded border border-border-soft bg-canvas px-2 py-1 text-xs text-ink outline-none focus:border-border-brand"
      />
      {create.isError && (
        <p className="mt-1 px-1 text-[10px] leading-snug text-danger-text">
          Could not create the project. Check the name is not already taken.
        </p>
      )}
    </div>
  );
}
