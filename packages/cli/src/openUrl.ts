import { execFile } from 'child_process';

/**
 * Opens a URL the HUB gave us (a device-flow verification URI) in the browser.
 *
 * Never through a shell: the URL is the hub's to choose, and `exec("open \"…\"")`
 * runs `$(…)` and backticks inside double quotes, so a malicious or intercepted
 * hub could run commands on the admin's machine (CGLAB-702 review). The opener
 * gets the URL as one argument, and only an http(s) URL is opened at all.
 *
 * Windows uses rundll32's URL handler rather than `cmd /c start`, which would
 * parse `&` and `^` in the URL as cmd syntax.
 *
 * Returns false (and opens nothing) for a URL it will not open; the caller has
 * already printed the URL, so the person can open it themselves.
 */
export function openUrlInBrowser(url: string, platform: NodeJS.Platform = process.platform): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const href = parsed.href;
  const [cmd, args] = platform === 'darwin' ? ['open', [href]]
    : platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', href]]
    : ['xdg-open', [href]];
  execFile(cmd, args, { windowsHide: true }, () => { /* best-effort: the URL is printed */ });
  return true;
}
