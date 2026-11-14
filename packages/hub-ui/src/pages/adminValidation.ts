// Field rules the admin forms used to state only in their placeholders.
// Each returns what to say, or nothing when the value is fine (or empty:
// an untouched field is not an error yet).

export const MIN_PASSWORD = 8;

export function inviteErrors(d: { email: string; password: string; authMethod: 'password' | 'sso' }): { email?: string; password?: string } {
  const out: { email?: string; password?: string } = {};
  if (d.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email.trim())) out.email = 'Enter a valid email address.';
  if (d.authMethod === 'password' && d.password && d.password.length < MIN_PASSWORD) out.password = `Use at least ${MIN_PASSWORD} characters.`;
  return out;
}

/** The address change needs the hub's new public https URL. */
export function addressChangeError(url: string): string | null {
  const v = url.trim();
  if (!v) return null;
  try {
    if (new URL(v).protocol === 'https:') return null;
  } catch { /* not a URL at all */ }
  return 'Enter the new address as an https:// URL, e.g. https://hub.new-domain.com.';
}
