/**
 * The shortcode of an Instagram post link, whatever form it was pasted in:
 * /p/, /reel/, /reels/ or /tv/, with or without www, a username before the
 * kind, a query string or a trailing slash. Anything else is null.
 */
export function shortcodeFromUrl(raw: string): string | null {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return null; }
  if (!/^(www\.)?instagram\.com$/i.test(url.hostname)) return null;
  const match = url.pathname.match(/^\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)\/?$/);
  return match?.[1] ?? null;
}
