export function filterFacetOptions(
  options: string[],
  query: string,
  optionLabel?: (v: string) => string,
): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  return options.filter((o) => {
    const label = optionLabel ? optionLabel(o) : o;
    return o.toLowerCase().includes(q) || label.toLowerCase().includes(q);
  });
}

export function shortRemote(remote: string): string {
  const m = remote.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  return m ? m[1] : remote;
}
