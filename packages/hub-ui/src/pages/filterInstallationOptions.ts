export interface InstallationOption {
  id: string;
  label: string;
}

/**
 * Case-insensitive substring filter for the Admin → Upgrades installation
 * picker. Empty / whitespace-only query returns the full list. Match is
 * primarily against the label (which already includes user name / git
 * email); falls back to the id so a bare id still matches.
 */
export function filterInstallationOptions(
  options: InstallationOption[],
  query: string,
): InstallationOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  return options.filter(o => {
    const label = (o.label ?? '').toLowerCase();
    if (label.includes(q)) return true;
    return o.id.toLowerCase().includes(q);
  });
}
