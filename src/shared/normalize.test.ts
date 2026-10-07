import { describe, expect, test } from 'bun:test';
import { normalize } from './normalize';
import { prepareForSpeech } from './speech';

// [input, expected spoken text]
const CASES: Array<[string, string]> = [
  // currency + magnitude
  ['$2.5M', 'two point five million dollars'],
  ['$40B', 'forty billion dollars'],
  ['$1.2bn', 'one point two billion dollars'],
  ['£3bn', 'three billion pounds'],
  ['€5', 'five euros'],
  ['€5.50', 'five euros and fifty cents'],
  ['₹1,200 crore', 'one thousand two hundred crore rupees'],
  ['₹5 lakh', 'five lakh rupees'],
  ['Rs. 500', 'five hundred rupees'],
  ['¥300', 'three hundred yen'],
  ['US$5', 'five dollars'],
  ['$5k', 'five thousand dollars'],
  ['$5 million', 'five million dollars'],
  ['$100', 'one hundred dollars'],
  ['$1', 'one dollar'],
  ['$0.99', 'ninety-nine cents'],
  ['$1,200,000', 'one million two hundred thousand dollars'],
  ['It cost $5.', 'It cost five dollars.'],
  ['$2–3M raised', 'two to three million dollars raised'],
  ['$500K-$1M', 'five hundred thousand to one million dollars'],
  // plain magnitudes
  ['3.4k followers', 'three point four thousand followers'],
  ['10M users', 'ten million users'],
  ['1.2B', 'one point two billion'],
  ['5T', 'five trillion'],
  ['401k plan', '401k plan'],
  ['4K video', '4K video'],
  // percent and period shorthands
  ['12%', 'twelve percent'],
  ['-3.5%', 'minus three point five percent'],
  ['up 12% YoY', 'up twelve percent year over year'],
  ['QoQ and MoM', 'quarter over quarter and month over month'],
  // ranges, decades, ordinals
  ['10–20', '10 to 20'],
  ['10-20 years', '10 to 20 years'],
  ['2019–2024', '2019 to 2024'],
  ['1990s', '1990s'],
  ['the 90s', 'the nineties'],
  ["the '80s", 'the eighties'],
  ['1st and 22nd', 'first and twenty-second'],
  // fractions
  ['1/2 cup', 'one half cup'],
  ['3/4', 'three quarters'],
  ['2/3', 'two thirds'],
  ['7/10', 'seven out of ten'],
  ['½', 'one half'],
  ['1½ hours', '1 and a half hours'],
  ['24/7', 'twenty four seven'],
  // multipliers, approx, signs
  ['10x', 'ten times'],
  ['3x faster', 'three times faster'],
  ['0x1F', '0x1F'],
  ['~50', 'about 50'],
  ['~$5', 'about five dollars'],
  ['±5', 'plus or minus 5'],
  ['+5', 'plus 5'],
  ['C++', 'C++'],
  // units
  ['5km', 'five kilometers'],
  ['1 km', 'one kilometer'],
  ['12 km/h', 'twelve kilometers per hour'],
  ['60 mph', 'sixty miles per hour'],
  ['5kg', 'five kilograms'],
  ['200g', 'two hundred grams'],
  ['10 lbs', 'ten pounds'],
  ['16GB RAM', 'sixteen gigabytes RAM'],
  ['2 TB', 'two terabytes'],
  ['512MB', 'five hundred twelve megabytes'],
  ['250 ms', 'two hundred fifty milliseconds'],
  ['20°C', 'twenty degrees Celsius'],
  ['98.6°F', 'ninety-eight point six degrees Fahrenheit'],
  ['5m tall', 'five meters tall'],
  ['10m users', 'ten million users'],
  ['5 cm', 'five centimeters'],
  ['3mm', 'three millimeters'],
  ['6ft', 'six feet'],
  ['5 hrs', 'five hours'],
  ['5 mins', 'five minutes'],
  ['100 Mbps', 'one hundred megabits per second'],
  ['3.2 GHz', 'three point two gigahertz'],
  ['1200 km', 'one thousand two hundred kilometers'],
  // dates and times
  ['2026-10-07', 'October 7, 2026'],
  ['10/07/2026', 'October 7, 2026'],
  ['13/07/2026', 'July 13, 2026'],
  ['10/07/26', 'October 7, 2026'],
  ['Oct 7', 'Oct 7'],
  ['5:30 pm', 'five thirty P M'],
  ['5pm', 'five P M'],
  ['9:05 a.m.', 'nine oh five A M.'],
  ['17:30', 'seventeen thirty'],
  ['09:05', 'oh nine oh five'],
  ['1:23:45', '1:23:45'],
  // roman numerals (context only)
  ['World War II', 'World War Two'],
  ['WWII', 'World War Two'],
  ['Henry VIII', 'Henry the eighth'],
  ['Louis XIV', 'Louis the fourteenth'],
  ['Chapter IV', 'Chapter four'],
  ['Part III', 'Part three'],
  ['Super Bowl LVIII', 'Super Bowl fifty-eight'],
  ['Type II diabetes', 'Type two diabetes'],
  ['I think so', 'I think so'],
  ['Then John I saw', 'Then John I saw'],
  ['John D Rockefeller', 'John D Rockefeller'],
  ['MIX and CIV and DC', 'MIX and CIV and DC'],
  // acronyms
  ['the CEO of YC', 'the CEO of Y C'],
  ['read the FAQ', 'read the F ay Q'],
  ['ETFs', 'E T Fs'],
  ['SaaS', 'sass'],
  ['NASA and NATO', 'NASA and NATO'],
  ['TL;DR', 'T L D R'],
  // versions
  ['v0.3.0', 'version zero point three point zero'],
  ['v2', 'version two'],
  ['Ship v1.2.', 'Ship version one point two.'],
  ['iOS 17', 'iOS 17'],
  // handles, hashtags, abbreviations
  ['@anuj says', 'at anuj says'],
  ['#buildinpublic', 'hashtag buildinpublic'],
  ['#BuildInPublic', 'hashtag Build In Public'],
  ['#1 spot', 'number 1 spot'],
  ['C# and F#', 'C# and F#'],
  ['and/or', 'and or'],
  ['w/ cheese w/o salt', 'with cheese without salt'],
  ['e.g. this', 'for example, this'],
  ['i.e. that', 'that is, that'],
  ['etc. Then', 'et cetera. Then'],
  ['apples, etc.', 'apples, et cetera.'],
  ['vs. them', 'versus them'],
  ['approx. 5', 'approximately 5'],
  ['No. 5', 'number 5'],
  ['b/c it works', 'because it works'],
  ['1/ stop waiting', '1. stop waiting'],
  // numbers that must be left to kokoro (years, bare digits, decimals)
  ['in 1990', 'in 1990'],
  ['in 2026', 'in 2026'],
  ['3.14', '3.14'],
  ['COVID-19', 'COVID-19'],
  ['1,234,567', 'one million two hundred thirty-four thousand five hundred sixty-seven'],
  ['1,234 people', 'one thousand two hundred thirty-four people'],
  ['1, 2, 3', '1, 2, 3'],
];

describe('normalize', () => {
  for (const [input, expected] of CASES) {
    test(JSON.stringify(input), () => {
      expect(normalize(input)).toBe(expected);
    });
  }

  test('output is stable under kokoro-js own normalizer (no $, %, digit.digit, digit-digit)', () => {
    const converted = CASES.filter(([i]) => /[$£€₹¥%]|\d[kKmMbBT]\b|°|\d\.\d\.\d/.test(i));
    expect(converted.length).toBeGreaterThan(10);
    for (const [input] of converted) {
      const out = normalize(input);
      if (/^(401k|4K)/.test(input)) continue; // deliberately untouched
      expect(out).not.toMatch(/[$£€₹¥%°]/);
      expect(out).not.toMatch(/\d\.\d/);
      expect(out).not.toMatch(/\d-\d/);
    }
  });

  test('idempotent on its own output', () => {
    for (const [, expected] of CASES) {
      const once = normalize(expected);
      expect(normalize(once)).toBe(once);
    }
  });

  test('performance: 5,000-word article under 20ms', () => {
    const para =
      'In 2026 the company raised $2.5M at a $40B valuation, up 12% YoY, after 3x growth since 2019–2024. ' +
      'Its CEO said the 1st quarter hit 10M users at 5:30 pm on 2026-10-07, v0.3.0 shipped, e.g. 16GB RAM, etc. ' +
      'Most people read the article slowly and then moved on to something else entirely without any numbers at all. ' +
      'The Quick Brown Fox jumped over the lazy dog while everyone watched from the porch that evening. ' +
      'Nothing about this sentence needs any work from the normalizer, which is the common case in prose. ';
    const words = para.split(' ').length;
    const text = para.repeat(Math.ceil(5000 / words));
    const sentences = text.match(/[^.]+\.\s?/g) ?? [];
    normalize(sentences[0]); // warm up
    const t0 = performance.now();
    for (const s of sentences) normalize(s);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(20);
  });
});

describe('prepareForSpeech with normalize', () => {
  test('dates no longer read "slash"', () => {
    expect(prepareForSpeech('Due 10/07/2026 sharp')).toBe('Due October 7, 2026 sharp.');
  });
  test('leftover slashes become spaces', () => {
    expect(prepareForSpeech('TCP/IP and he/she')).toBe('TCP IP and he she.');
  });
  test('normalize runs after url stripping', () => {
    expect(prepareForSpeech('Visit https://x.com/a/1/2 for $5 — fish & chips')).toBe(
      'Visit link for five dollars, fish and chips.',
    );
  });
  test('tilde and hash are handled before punctuation cleanup', () => {
    expect(prepareForSpeech('~50 people tagged #launch')).toBe('about 50 people tagged hashtag launch.');
  });
  test('thread numbering', () => {
    expect(prepareForSpeech('1/ stop waiting')).toBe("1. stop waiting.");
  });
});
