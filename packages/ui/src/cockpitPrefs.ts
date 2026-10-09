/**
 * Which cockpit gadgets the header shows (INFRA-425).
 *
 * In this browser's storage, like the sidebar's own preferences: a view choice
 * for the person at this screen, not something the server or other windows
 * need. Read failures fall back to everything on, which is what the cockpit
 * shows before anyone chooses.
 */
import { COCKPIT_GADGETS, type CockpitGadgetId, type CockpitToggles } from './cockpit';

const KEY = 'agenfk.cockpitGadgets';

const ALL_ON: CockpitToggles = Object.fromEntries(COCKPIT_GADGETS.map(id => [id, true])) as CockpitToggles;

export function readCockpitToggles(): CockpitToggles {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(COCKPIT_GADGETS.map(id => [id, raw[id] !== false])) as CockpitToggles;
  } catch {
    return ALL_ON;
  }
}

export function writeCockpitToggle(id: CockpitGadgetId, on: boolean): CockpitToggles {
  const next = { ...readCockpitToggles(), [id]: on };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode: this session only */ }
  window.dispatchEvent(new Event(KEY));
  return next;
}

/** Re-read whenever any part of this page changes a toggle. */
export function onCockpitTogglesChanged(cb: () => void): () => void {
  // KEY for this window, `storage` for the others: a change in one window's
  // Settings reaches every window's header.
  const fromOtherWindow = (e: StorageEvent): void => { if (e.key === KEY) cb(); };
  window.addEventListener(KEY, cb);
  window.addEventListener('storage', fromOtherWindow);
  return () => {
    window.removeEventListener(KEY, cb);
    window.removeEventListener('storage', fromOtherWindow);
  };
}
