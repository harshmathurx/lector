import { describe, expect, test } from 'bun:test';
import { prepareForSpeech } from './speech';
import { splitNearMiddle } from './split';
import { cleanTitle } from './title';

describe('prepareForSpeech', () => {
  test('strips citations, urls, emoji', () => {
    expect(prepareForSpeech('See this[12] at https://example.com/a?b=1 now 🎉')).toBe(
      'See this at link now.'
    );
  });

  test('dashes become commas, ampersand becomes and', () => {
    expect(prepareForSpeech('Fish — chips & peas')).toBe('Fish, chips and peas.');
  });

  test('keeps existing terminal punctuation', () => {
    expect(prepareForSpeech('Really?')).toBe('Really?');
  });

  test('empty stays empty', () => {
    expect(prepareForSpeech('  ')).toBe('');
  });
});

describe('cleanTitle', () => {
  test('drops the site name, keeps the article part', () => {
    expect(cleanTitle('Why we save articles | Longreads')).toBe('Why we save articles');
    expect(cleanTitle('Hansel and Gretel - World Stories')).toBe('Hansel and Gretel');
  });

  test('leaves a plain title alone, tolerates empty', () => {
    expect(cleanTitle('  Plain title ')).toBe('Plain title');
    expect(cleanTitle(undefined)).toBe('');
  });
});

describe('splitNearMiddle', () => {
  test('prefers a central semicolon over a nearer comma', () => {
    const t = 'aaaa aaaa aaaa, aaaa aaaa aaaa aaaa; bbbb bbbb bbbb bbbb bbbb';
    const [a, b] = splitNearMiddle(t)!;
    expect(a.endsWith(';')).toBe(true);
    expect(b.startsWith('bbbb')).toBe(true);
  });
  test('falls back to a space, then a hard cut', () => {
    expect(splitNearMiddle('one two three four five six')![0]).toBe('one two three');
    const [a, b] = splitNearMiddle('x'.repeat(40))!;
    expect(a.length + b.length).toBe(40);
  });
  test('nothing to split', () => expect(splitNearMiddle('')).toBeNull());
});
