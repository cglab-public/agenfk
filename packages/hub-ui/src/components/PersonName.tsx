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

const AVATAR = {
  sm: 'w-7 h-7 rounded-lg text-[10px]',
  md: 'w-8 h-8 rounded-full text-[11px]',
  lg: 'w-12 h-12 rounded-2xl text-base',
} as const;

/** The initials badge beside a person: small in tables, large on their page. */
export function PersonAvatar({ name, userKey, size = 'md' }: { name?: string; userKey: string; size?: keyof typeof AVATAR }) {
  return (
    <div className={`${AVATAR[size]} bg-accent-fill text-accent-ink font-bold flex items-center justify-center shrink-0`}>
      {initialsOf(name, userKey)}
    </div>
  );
}
