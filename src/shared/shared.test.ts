import { describe, expect, test } from 'bun:test';
import { prepareForSpeech } from './speech';
import { splitNearMiddle } from './split';
import { chooseTitle, cleanTitle, isJunkTitle } from './title';

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


describe('chooseTitle', () => {
  const xJunk = 'Incentivising on X: "https://t.co/zLW6XKmj8g" / X';
  test('flags X-style titles as junk', () => {
    expect(isJunkTitle(xJunk)).toBe(true);
    expect(isJunkTitle('Name on X: "https://t.co/abc" / X')).toBe(true);
    expect(isJunkTitle('Incentivising (@incentivising) on X')).toBe(true);
    expect(isJunkTitle('https://example.com/a')).toBe(true);
    expect(isJunkTitle('How to Do Great Work')).toBe(false);
    expect(isJunkTitle('Why I like X')).toBe(false);
  });
  test('falls through junk og:title to the article h1', () => {
    expect(chooseTitle({ og: 'Incentivising (@incentivising) on X', heading: 'Incentivising', readability: xJunk, doc: xJunk })).toBe('Incentivising');
  });
  test('prefers og:title, strips the site name', () => {
    expect(chooseTitle({ og: 'Why we save articles | Longreads', heading: 'Other', doc: 'x' })).toBe('Why we save articles');
  });
  test('uses document title when nothing better exists, even if junk', () => {
    expect(chooseTitle({ doc: xJunk })).toBe(xJunk);
    expect(chooseTitle({})).toBe('');
  });
});
