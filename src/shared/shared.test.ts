import { describe, expect, test } from 'bun:test';
import { prepareForSpeech } from './speech';
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
