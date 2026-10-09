/**
 * gh argv assembly for `agenfk pr create` (CGLAB-571).
 *
 * Extracted from the command action so the arguments reaching `gh pr create`
 * are pinned by a test rather than discovered against a live repository — the
 * `--base` option in particular is a pass-through to gh, and a literal
 * `--base undefined` or a trailing flag would only fail there. Order matters
 * only in that repeated flags must each carry their own value, which is why
 * values are pushed as separate elements.
 *
 * `base` is the PR's target branch. When omitted, gh keeps its own default
 * detection — unchanged behaviour for every caller that does not pass it.
 */
export function ghPrCreateArgs(opts: {
  title: string;
  body: string;
  draft?: boolean;
  base?: string;
}): string[] {
  const args = ['pr', 'create', '--title', opts.title, '--body', opts.body];
  if (opts.draft) args.push('--draft');
  // Trimmed and non-empty or not at all: an empty string would send gh a
  // branch named '' and fail with a confusing error far from the cause.
  if (opts.base && opts.base.trim()) args.push('--base', opts.base.trim());
  return args;
}
