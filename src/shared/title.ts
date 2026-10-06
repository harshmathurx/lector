// Page titles arrive as "Why we save articles | Longreads". Keep the part that
// is the article (the longest), drop the site.

const SEPARATOR = /\s+[|–—·•]\s+|\s+-\s+/;

export function cleanTitle(title: string | undefined): string {
  if (!title) return '';
  const parts = title.split(SEPARATOR).map((p) => p.trim()).filter(Boolean);
  return parts.length > 1 ? parts.reduce((a, b) => (b.length > a.length ? b : a)) : title.trim();
}
