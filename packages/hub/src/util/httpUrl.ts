/**
 * One definition of "an http(s) URL, in the form we will actually use it".
 *
 * Normalising matters wherever a URL is shown to a person before being dialled
 * by a machine: `https://parent.example.com@evil.example.com/x` reads as
 * parent.example.com and connects to evil.example.com. Anything that displays
 * a URL and anything that fetches it must agree on the string, or the display
 * is not a control — it is decoration.
 */
export function normalizeHttpUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  // Userinfo, the default port, a trailing slash and any stray control
  // characters are all dropped here — origin + path is what gets requested.
  return u.origin + (u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, ''));
}
