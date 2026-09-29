/**
 * 7b640e64 — Settings from the browser board.
 *
 * The Settings panel lives in the desktop shell's sidebar, which a browser
 * never mounts (App.tsx: isDesktop()), so the board at localhost had no way to
 * reach any setting. The same panel, in a dialog; its desktop-only rows (a
 * custom sound, OS banners) already hide themselves outside the app.
 */
import React from 'react';
import { X } from 'lucide-react';
import { SettingsPanel } from './SettingsPanel';

export function BoardSettingsDialog({ onClose }: { onClose: () => void }): React.ReactElement {
  // Escape closes it, like every other overlay in the app.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      data-testid="board-settings-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      onClick={onClose}
    >
      <div
        // 35e1fe96: the tallest section's height, capped at the viewport - the panel's body scrolls, not the dialog.
        className="relative flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-border-soft bg-canvas shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close settings"
          className="absolute right-3 top-3 rounded p-1 text-ink-tertiary hover:text-ink"
        >
          <X size={16} />
        </button>
        <SettingsPanel />
      </div>
    </div>
  );
}
