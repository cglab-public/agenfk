/**
 * A person on a dashboard: the name in sans when the hub knows it, with the
 * user_key (usually an email) under it; the key alone, in mono, when it does not.
 */
export function PersonName({ name, userKey, className = '' }: { name?: string; userKey: string; className?: string }) {
  if (!name) return <span className={`font-mono text-[12px] text-ink truncate ${className}`} title={userKey}>{userKey}</span>;
  return (
    <span className={`min-w-0 flex flex-col ${className}`} title={userKey}>
      <span className="text-[13px] text-ink truncate">{name}</span>
      <span className="font-mono text-[11px] text-ink-tertiary truncate">{userKey}</span>
    </span>
  );
}

/** Two letters for an avatar: from the name when there is one, else the key. */
export function initialsOf(name: string | undefined, userKey: string): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length) return words.slice(0, 2).map(w => w[0]!.toUpperCase()).join('');
  return userKey.slice(0, 2).toUpperCase();
}
