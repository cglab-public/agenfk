const EASTER_EGGS_ENABLED = import.meta.env.VITE_EASTER_EGGS === 'true';

export function useEasterEggs(): boolean {
  return EASTER_EGGS_ENABLED;
}
