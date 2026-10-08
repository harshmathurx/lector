// Page titles arrive as "Why we save articles | Longreads". Keep the part that
// is the article (the longest), drop the site.

const SEPARATOR = /\s+[|–—·•]\s+|\s+-\s+/;

export function cleanTitle(title: string | undefined): string {
  if (!title) return '';
  const parts = title.split(SEPARATOR).map((p) => p.trim()).filter(Boolean);
  return parts.length > 1 ? parts.reduce((a, b) => (b.length > a.length ? b : a)) : title.trim();
}

/**
 * Titles some sites give pages that are not a name for the article: X's
 * `Name on X: "https://t.co/abc" / X`, `Name (@handle) on X`, bare URLs, handles.
 */
export function isJunkTitle(title: string | undefined): boolean {
  const t = (title ?? '').trim();
  if (t.length < 3) return true;
  if (/^(https?:\/\/|www\.)\S*$/i.test(t) || /^@\w+$/.test(t)) return true;
  if (/https?:\/\/t\.co\//i.test(t)) return true;
  if (/\(@\w+\)/.test(t)) return true; // "Name (@handle) on X"
  if (/\bon (X|Twitter)(:|$)/i.test(t)) return true;
  if (/^.{0,80}\s\/\sX$/.test(t) && /["“]/.test(t)) return true;
  return false;
}

/**
 * First usable title, in the caller's order of trust. `og`, `readability` and
 * `doc` have the site name trimmed (see cleanTitle); `heading` (the article's own
 * h1) is used verbatim. Falls back to the last non-empty candidate, junk or not.
 */
export function chooseTitle(c: { og?: string; heading?: string; readability?: string; doc?: string }): string {
  const ordered = [cleanTitle(c.og), (c.heading ?? '').trim(), cleanTitle(c.readability), cleanTitle(c.doc)];
  return ordered.find((t) => t && !isJunkTitle(t)) ?? ordered.filter(Boolean).pop() ?? '';
}
