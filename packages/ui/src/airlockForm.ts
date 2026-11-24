/**
 * GH-294 T5: the deep link the board's Airlock panel is opened by
 * (`agenfk airlock edit` prints `<board>?settings=airlock`).
 */

/** The Settings section a `?settings=<id>` link opens, or null. */
export function settingsSectionFromSearch(search: string): string | null {
  const id = new URLSearchParams(search).get('settings');
  return id ? id : null;
}
