// Splits text in two near its middle, for segments whose phonemes exceed the
// model's token budget. Prefers stronger punctuation, then a space.

const BREAKS: RegExp[] = [/;/g, /:/g, /,/g, /\s/g];

/** [head, tail] split at the best point near the middle, or null if it cannot be split. */
export function splitNearMiddle(text: string): [string, string] | null {
  const mid = text.length / 2;
  for (const re of BREAKS) {
    let best = -1;
    for (const m of text.matchAll(re)) {
      const i = m.index! + 1; // keep the punctuation with the head
      if (i < 8 || text.length - i < 8) continue; // no tiny fragments
      if (best < 0 || Math.abs(i - mid) < Math.abs(best - mid)) best = i;
    }
    // Only accept a punctuation break if it is reasonably central.
    if (best > 0 && (re === BREAKS[3] || Math.abs(best - mid) <= text.length * 0.3)) {
      return [text.slice(0, best).trim(), text.slice(best).trim()];
    }
  }
  const cut = Math.floor(mid);
  return text.length > 1 ? [text.slice(0, cut), text.slice(cut)] : null;
}
