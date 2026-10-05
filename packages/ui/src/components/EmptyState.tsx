/**
 * The "nothing here yet" panel.
 *
 * Lived inside AppShell until the Terminal tab needed it too (CGLAB-169).
 * Importing it back out of AppShell would have been a cycle — AppShell imports
 * TerminalTab — and copying the markup would have let the two drift, so it
 * moved to its own file instead.
 */
import React from 'react';

export function EmptyState({ title, body }: { title: string; body: string }): React.ReactElement {
  return (
    <div className="mx-auto mt-16 max-w-sm text-center">
      <p className="text-sm font-semibold text-ink-secondary">{title}</p>
      <p className="mt-1.5 text-xs leading-relaxed text-ink-tertiary">{body}</p>
    </div>
  );
}
