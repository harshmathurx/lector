// Rule-based English TTS verbalizer: numbers, money, units, dates, symbols and
// a few abbreviations become plain words so Kokoro reads them like a person.
//
// Ideas and rule shapes are adapted from misaki's English G2P (hexgrad/misaki,
// misaki/en.py, Apache-2.0): currency table (dollar/cent, pound/pence,
// euro/cent), ordinal suffix handling, "point" for decimals and comma-stripping.
// Number-to-words uses the `number-to-words` package (MIT).
//
// Contract with kokoro-js: it runs its OWN normalizer on our output (4-digit
// years, decimals -> "N point M", digit ranges -> " to ", "$"/"£" amounts,
// "H:MM" times). So everything we convert is emitted as plain words (never "$",
// never a decimal point between digits, never a digit-hyphen-digit), and what we
// deliberately leave as digits (years, small bare numbers, "5:30") is exactly
// what kokoro already handles. Runs on one segment (<= ~300 chars); all regexes
// are precompiled at module load.

// @ts-ignore number-to-words ships no type declarations
import { toWords, toWordsOrdinal } from 'number-to-words';

const DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
  'November', 'December',
];

// A number with optional thousands separators and decimals. Never swallows a
// trailing comma or period ("1,200," / "5.").
const NUM = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?`;
// Not glued to a preceding word character or decimal point.
const LB = String.raw`(?<![\w.])`;

function cardinal(n: number): string {
  return (toWords(n) as string).replace(/,/g, '');
}
function ordinal(n: number): string {
  return (toWordsOrdinal(n) as string).replace(/,/g, '');
}

/** "1,234.56" -> "one thousand two hundred thirty-four point five six". */
function numWords(s: string): string {
  const clean = s.replace(/,/g, '');
  const dot = clean.indexOf('.');
  const ip = dot < 0 ? clean : clean.slice(0, dot);
  let out = ip.length > 15 ? ip : cardinal(parseInt(ip, 10));
  if (dot >= 0) {
    out += ' point';
    for (const c of clean.slice(dot + 1)) out += ' ' + DIGITS[+c];
  }
  return out;
}
const isOne = (s: string) => parseFloat(s.replace(/,/g, '')) === 1;

/** Clock minutes: "05" -> "oh five", "30" -> "thirty", "00" -> "". */
function minutesWords(mm: string): string {
  if (mm === '00') return '';
  return mm[0] === '0' ? 'oh ' + DIGITS[+mm[1]] : cardinal(+mm);
}

// ---------------------------------------------------------------- magnitudes
const MAG_WORD: Record<string, string> = {
  k: 'thousand', K: 'thousand', thousand: 'thousand',
  m: 'million', M: 'million', mn: 'million', MM: 'million', million: 'million',
  b: 'billion', B: 'billion', bn: 'billion', billion: 'billion',
  t: 'trillion', T: 'trillion', tn: 'trillion', trillion: 'trillion',
  crore: 'crore', crores: 'crore', lakh: 'lakh', lakhs: 'lakh',
};

// ---------------------------------------------------------------- currency
const CUR: Record<string, [string, string, string, string]> = {
  // symbol: [unit, plural unit, minor, plural minor]
  $: ['dollar', 'dollars', 'cent', 'cents'],
  '£': ['pound', 'pounds', 'penny', 'pence'],
  '€': ['euro', 'euros', 'cent', 'cents'],
  '₹': ['rupee', 'rupees', 'paisa', 'paise'],
  Rs: ['rupee', 'rupees', 'paisa', 'paise'],
  '¥': ['yen', 'yen', 'sen', 'sen'],
};
const AMT = String.raw`(${NUM})(?:\s?(thousand|million|billion|trillion|crores?|lakhs?)\b|(k|K|mn|MM|bn|tn|[MBTmb])(?![A-Za-z0-9]))?`;
// amount [- amount]; the second amount may repeat the symbol
const CURRENCY_RE = new RegExp(
  String.raw`(?:\b(?:US|CA|AU|NZ|HK)(?=\$))?(\$|£|€|₹|¥|\bRs\.?)\s?${AMT}(?:\s?(?:[–—-]|to)\s?(?:[$£€₹¥]\s?)?${AMT})?`,
  'g',
);
// Capture groups: symbol, then (num, word, abbr) for each of the two amounts.

const magOf = (word?: string, abbr?: string): string => MAG_WORD[word ?? abbr ?? ''] ?? '';

function currencyReplace(...g: any[]): string {
  const [, sym, n1, w1, a1, n2, w2, a2] = g as [string, string, string, string?, string?, string?, string?, string?];
  const key = sym.startsWith('Rs') ? 'Rs' : sym;
  const [unit, units, minor, minors] = CUR[key];
  const mag1 = magOf(w1, a1);
  if (n2 === undefined) {
    if (!mag1) {
      const dot = n1.indexOf('.');
      const decs = dot < 0 ? 0 : n1.length - dot - 1;
      if (decs >= 1 && decs <= 2 && key !== '¥') {
        const [whole, frac] = n1.replace(/,/g, '').split('.');
        const w = parseInt(whole, 10);
        const c = parseInt(frac.padEnd(2, '0'), 10);
        const cw = cardinal(c) + ' ' + (c === 1 ? minor : minors);
        if (w === 0) return cw;
        const ww = cardinal(w) + ' ' + (w === 1 ? unit : units);
        return c === 0 ? ww : ww + ' and ' + cw;
      }
      return numWords(n1) + ' ' + (isOne(n1) ? unit : units);
    }
    return numWords(n1) + ' ' + mag1 + ' ' + units;
  }
  const mag2 = magOf(w2, a2);
  const left = numWords(n1) + (mag1 && mag1 !== mag2 ? ' ' + mag1 : '');
  return left + ' to ' + numWords(n2) + (mag2 ? ' ' + mag2 : '') + ' ' + units;
}

// ---------------------------------------------------------------- units
// [singular, plural]; matched case-sensitively after a number.
const UNIT: Record<string, [string, string]> = {
  'km/h': ['kilometer per hour', 'kilometers per hour'],
  kph: ['kilometer per hour', 'kilometers per hour'],
  mph: ['mile per hour', 'miles per hour'],
  km: ['kilometer', 'kilometers'],
  cm: ['centimeter', 'centimeters'],
  mm: ['millimeter', 'millimeters'],
  kg: ['kilogram', 'kilograms'],
  mg: ['milligram', 'milligrams'],
  g: ['gram', 'grams'],
  lb: ['pound', 'pounds'],
  lbs: ['pound', 'pounds'],
  oz: ['ounce', 'ounces'],
  ml: ['milliliter', 'milliliters'],
  ft: ['foot', 'feet'],
  mi: ['mile', 'miles'],
  KB: ['kilobyte', 'kilobytes'],
  kB: ['kilobyte', 'kilobytes'],
  MB: ['megabyte', 'megabytes'],
  GB: ['gigabyte', 'gigabytes'],
  TB: ['terabyte', 'terabytes'],
  PB: ['petabyte', 'petabytes'],
  kbps: ['kilobit per second', 'kilobits per second'],
  Mbps: ['megabit per second', 'megabits per second'],
  Gbps: ['gigabit per second', 'gigabits per second'],
  Hz: ['hertz', 'hertz'],
  kHz: ['kilohertz', 'kilohertz'],
  MHz: ['megahertz', 'megahertz'],
  GHz: ['gigahertz', 'gigahertz'],
  kW: ['kilowatt', 'kilowatts'],
  kWh: ['kilowatt hour', 'kilowatt hours'],
  ms: ['millisecond', 'milliseconds'],
  hr: ['hour', 'hours'],
  hrs: ['hour', 'hours'],
  min: ['minute', 'minutes'],
  mins: ['minute', 'minutes'],
  sec: ['second', 'seconds'],
  secs: ['second', 'seconds'],
};
const unitKeys = Object.keys(UNIT).sort((a, b) => b.length - a.length).map((k) => k.replace('/', '\\/'));
// "g" must touch the number ("5g"); every other unit may have one space ("5 km").
const UNIT_RE = new RegExp(
  `${LB}(${NUM})(?:\\s?(${unitKeys.filter((k) => k !== 'g').join('|')})|(g))(?![A-Za-z0-9/])`,
  'g',
);

// ---------------------------------------------------------------- roman numerals
const ROMAN_VALID = /^M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/;
const ROMAN_VAL: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
function romanToInt(s: string): number {
  if (!s || !ROMAN_VALID.test(s)) return 0;
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const v = ROMAN_VAL[s[i]];
    total += i + 1 < s.length && ROMAN_VAL[s[i + 1]] > v ? -v : v;
  }
  return total;
}

// ---------------------------------------------------------------- acronyms
// espeak already spells most all-caps initialisms (CEO, FBI, API, URL, HTML, PDF,
// GDP, CSS, SQL, GPU, ...) and leaves pronounceable ones alone (NASA, NATO, GIF).
// Verified with the phonemizer kokoro-js ships; only ones it mangles are listed.
// A spaced "A" is read as the article, so the letter A is written "ay".
const SPELLED = ['YC', 'ETF', 'UX', 'SEO', 'AWS', 'IPO', 'FAQ', 'ROI', 'IDE', 'OKR', 'CLI', 'SME', 'NYC', 'IQ', 'QA', 'ARR', 'AR', 'PTO', 'ETA', 'KYC', 'IIT', 'CAGR', 'EV', 'TLDR'];
const spell = (a: string) => a.split('').map((c) => (c === 'A' ? 'ay' : c)).join(' ');
const ACRONYM_RE = new RegExp(`(?<![\\w.])(${SPELLED.join('|')})(s?)(?![\\w])`, 'g');

// ---------------------------------------------------------------- misc tables
const VULGAR: Record<string, string> = {
  '½': 'one half', '⅓': 'one third', '⅔': 'two thirds', '¼': 'one quarter', '¾': 'three quarters',
  '⅛': 'one eighth', '⅜': 'three eighths', '⅝': 'five eighths', '⅞': 'seven eighths',
};
const FRACTION_WORDS: Record<number, [string, string]> = {
  2: ['half', 'halves'], 3: ['third', 'thirds'], 4: ['quarter', 'quarters'], 5: ['fifth', 'fifths'],
  6: ['sixth', 'sixths'], 8: ['eighth', 'eighths'],
};
const DECADE: Record<string, string> = {
  '2': 'twenties', '3': 'thirties', '4': 'forties', '5': 'fifties', '6': 'sixties', '7': 'seventies',
  '8': 'eighties', '9': 'nineties',
};
const METER_CONTEXT = String.raw`(?=\s*(?:tall|long|high|wide|deep|away|above|below|apart|per|from)\b|\s*\/s\b)`;

// ---------------------------------------------------------------- rules
const RE = {
  thread: /^(\d{1,2})\/\s+(?=\S)/,
  eg: /\be\.g\.,?/gi,
  ie: /\bi\.e\.,?/gi,
  etcEnd: /\betc\.(?=\s+[A-Z]|\s*$)/g,
  etc: /\betc\./g,
  vs: /\bvs\.?(?=\s)/gi,
  approx: /\bapprox\./gi,
  wo: /\bw\/o\b/gi,
  w: /\bw\/(?=[\s\w])/gi,
  andOr: /\band\/or\b/gi,
  bc: /\bb\/c\b/gi,
  na: /\bn\/a\b/gi,
  allDay: /(?<![\w/])24\/7(?![\w/])/g,
  no: /\bNo\.\s?(?=\d)/g,
  isoDate: /(?<![\w.-])(\d{4})-(\d{2})-(\d{2})(?![\w-])/g,
  slashDate: /(?<![\w./])(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})(?![\w/])/g,
  ampm: new RegExp(`${LB}(\\d{1,2})(?::(\\d{2}))?\\s?([aApP])\\.?[mM]\\b`, 'g'),
  time24: /(?<![\w:.])(0\d|1[3-9]|2[0-3]):([0-5]\d)(?![\w:])/g,
  versionV: /(?<![\w.])v(\d+(?:\.\d+)*)(?!\w|\.\d)/g,
  semver: /(?<![\w.])\d+(?:\.\d+){2,}(?!\w|\.\d)/g,
  tilde: /[~≈]\s?(?=[\w$£€₹¥])/g,
  approxSym: /≈/g,
  plusMinus: /±\s?/g,
  ge: /≥/g,
  le: /≤/g,
  signedMinus: /(^|[\s(])[-−](?=\d)/g,
  signedPlus: /(^|[\s(])\+(?=\d)/g,
  currency: CURRENCY_RE,
  percent: new RegExp(`${LB}(${NUM})\\s?%`, 'g'),
  strayPercent: /\s?%/g,
  period: /\b(YoY|QoQ|MoM|WoW|YTD)\b/g,
  range: /(?<![\w.])(\d[\d,]*(?:\.\d+)?)\s?[–—-]\s?(?=\d)/g,
  vulgarMixed: /(\d)\s?([½⅓⅔¼¾⅛⅜⅝⅞])/g,
  vulgar: /[½⅓⅔¼¾⅛⅜⅝⅞]/g,
  fraction: /(?<![\w./])(\d{1,3})\/(\d{1,3})(?![\w/])/g,
  mult: new RegExp(`${LB}(${NUM})[x×](?![A-Za-z0-9])`, 'g'),
  ordinal: /(?<![\w.])(\d{1,15})(?:st|nd|rd|th)\b/g,
  decade: /(?<![\w.])['’]?([2-9])0s\b/g,
  meters: new RegExp(`${LB}(${NUM})m(?![A-Za-z0-9])${METER_CONTEXT}`, 'g'),
  magnitude: new RegExp(
    `${LB}(?!401[kK]\\b)(${NUM})(k|K|mn|MM|M|bn|B|tn|T|m)(?![A-Za-z0-9])(?!\\s+(?:video|resolution|display|monitor|screen|TV|UHD|HDR|run|race|footage))`,
    'g',
  ),
  unit: UNIT_RE,
  degreesNum: new RegExp(`${LB}(${NUM})\\s?°\\s?([CF])?(?![A-Za-z])`, 'g'),
  degrees: /°\s?([CF])?(?![A-Za-z])/g,
  commaNum: /(?<![\w.])\d{1,3}(?:,\d{3})+(?:\.\d+)?(?![\w])/g,
  wwRoman: /\bWW(I{1,2})\b/g,
  romanCtx:
    /\b(World War|Chapter|Part|Act|Volume|Vol\.|Section|Phase|Stage|Type|Appendix|Article|Episode|Season|Super Bowl)\s+([IVXLCDM]+)\b/g,
  romanKing:
    /\b(Henry|Edward|George|Louis|Charles|Richard|Elizabeth|William|James|John|Philip|Frederick|Napoleon|Alexander|Ivan|Peter|Paul|Pius|Leo|Benedict|Gregory|Clement|Nicholas|Ramses|Ramesses|Pope [A-Z][a-z]+)\s+([IVXLCDM]+)\b/g,
  acronym: ACRONYM_RE,
  tldr: /\bTL;DR\b/g,
  saas: /\bSaaS\b/g,
  handle: /(?<![\w.@])@(\w{1,30})/g,
  hashNum: /(?<![\w&#])#(\d+)\b/g,
  hashtag: /(?<![\w&#])#([A-Za-z]\w{0,60})/g,
  marks: /[™®©]/g,
};

const capitalize = (s: string) => s[0].toUpperCase() + s.slice(1);

const HAS_DIGIT = /[\d½⅓⅔¼¾⅛⅜⅝⅞]/;
const HAS_MATH = /[~≈±≥≤]/;
const HAS_UPPER = /[A-Z]/;
const HAS_AT_HASH = /[@#]/;

function monthDay(m: number, d: number, y: string): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}
const YEAR_OR_NULL = (y: string) => (y.length === 4 ? y : (+y <= 69 ? '20' : '19') + y);

function clock(h: string, mm: string, mer?: string): string {
  const hn = +h;
  const hw = h[0] === '0' && hn > 0 ? 'oh ' + DIGITS[hn] : cardinal(hn);
  if (mer) return [hw, minutesWords(mm), mer.toUpperCase() + ' M'].filter(Boolean).join(' ');
  return mm === '00' ? hw + ' hundred' : [hw, minutesWords(mm)].join(' ');
}

/** Normalize one segment of display text into speakable English. */
export function normalize(input: string): string {
  let t = input;

  // X-thread numbering at the start of a segment: "1/ stop" -> "1. stop"
  t = t.replace(RE.thread, '$1. ');

  // Abbreviations
  t = t.replace(RE.eg, 'for example,').replace(RE.ie, 'that is,');
  t = t.replace(RE.etcEnd, 'et cetera.').replace(RE.etc, 'et cetera');
  t = t.replace(RE.vs, 'versus').replace(RE.approx, 'approximately');
  t = t.replace(RE.wo, 'without').replace(RE.w, 'with').replace(RE.andOr, 'and or');
  t = t.replace(RE.bc, 'because').replace(RE.na, 'not applicable');
  t = t.replace(RE.allDay, 'twenty four seven').replace(RE.no, 'number ');

  // Symbols
  if (HAS_MATH.test(t)) {
    t = t.replace(RE.tilde, 'about ').replace(RE.approxSym, 'approximately');
    t = t.replace(RE.plusMinus, 'plus or minus ').replace(RE.ge, 'at least ').replace(RE.le, 'at most ');
  }
  t = t.replace(RE.marks, '');

  if (HAS_DIGIT.test(t)) {
    t = t.replace(RE.signedMinus, '$1minus ').replace(RE.signedPlus, '$1plus ');

    // Dates (ISO, then US month/day/year; day/month when the first part cannot be a month)
    t = t.replace(RE.isoDate, (m, y, mo, d) => monthDay(+mo, +d, y) ?? m);
    t = t.replace(RE.slashDate, (m, a, b, y) => {
      const yr = YEAR_OR_NULL(y);
      return monthDay(+a, +b, yr) ?? (+a > 12 ? monthDay(+b, +a, yr) : null) ?? m;
    });

    // Clock times: "5:30 pm", "5pm", "17:30"
    t = t.replace(RE.ampm, (_m, h, mm, ap) => clock(h, mm ?? '00', ap));
    t = t.replace(RE.time24, (_m, h, mm) => clock(h, mm));

    // Versions
    t = t.replace(RE.versionV, (_m, v: string) => 'version ' + v.split('.').map(numWords).join(' point '));
    t = t.replace(RE.semver, (v) => v.split('.').map(numWords).join(' point '));

    // Money, with optional magnitude and ranges
    t = t.replace(RE.currency, currencyReplace);

    // Percent and period shorthands
    t = t.replace(RE.percent, (_m, n) => numWords(n) + ' percent').replace(RE.strayPercent, ' percent');

    // Ranges ("10-20", "2019–2024"): digits stay, hyphen becomes "to"
    t = t.replace(RE.range, '$1 to ');

    // Fractions and multipliers
    t = t.replace(RE.vulgarMixed, (_m, d, v) => d + (v === '½' ? ' and a half' : ' and ' + VULGAR[v]));
    t = t.replace(RE.vulgar, (v) => VULGAR[v]);
    t = t.replace(RE.fraction, (m, n, d) => {
      const nn = +n, dd = +d;
      const f = FRACTION_WORDS[dd];
      if (f && nn >= 1 && nn < dd) {
        if (dd === 2) return 'one half';
        if (dd === 4) return nn === 1 ? 'one quarter' : cardinal(nn) + ' quarters';
        return cardinal(nn) + ' ' + (nn === 1 ? f[0] : f[1]);
      }
      if ((dd === 10 || dd === 100) && nn <= dd) return cardinal(nn) + ' out of ' + cardinal(dd);
      return m;
    });
    t = t.replace(RE.mult, (_m, n) => numWords(n) + ' times');

    // Ordinals and decades
    t = t.replace(RE.ordinal, (_m, n) => ordinal(parseInt(n, 10)));
    t = t.replace(RE.decade, (_m, d) => DECADE[d]);

    // Magnitudes, then units. Lowercase "m" is metres only before a measuring
    // word ("5m tall", "3m long", "2m/s"); otherwise it reads as million.
    t = t.replace(RE.meters, (_m, n) => numWords(n) + (isOne(n) ? ' meter' : ' meters'));
    t = t.replace(RE.magnitude, (_m, n, s) => numWords(n) + ' ' + MAG_WORD[s]);
    t = t.replace(RE.unit, (_m, n, u, g) => {
      const e = UNIT[u ?? g];
      return numWords(n) + ' ' + (isOne(n) ? e[0] : e[1]);
    });
    t = t.replace(RE.degreesNum, (_m, n, s) =>
      numWords(n) + (isOne(n) ? ' degree' : ' degrees') + (s ? (s === 'C' ? ' Celsius' : ' Fahrenheit') : ''));
    t = t.replace(RE.degrees, (_m, s) => ' degrees' + (s ? (s === 'C' ? ' Celsius' : ' Fahrenheit') : ''));

    // Remaining comma-grouped numbers ("1,234,567"): kokoro would read a 4-digit
    // result as a year, so say them in words.
    t = t.replace(RE.commaNum, numWords);
  }

  // Roman numerals, only with a clear context word
  if (HAS_UPPER.test(t)) {
    t = t.replace(RE.period, (w) =>
      w === 'YoY' ? 'year over year' : w === 'QoQ' ? 'quarter over quarter'
        : w === 'MoM' ? 'month over month' : w === 'WoW' ? 'week over week' : 'year to date');

    t = t.replace(RE.wwRoman, (_m, r) => 'World War ' + (r === 'I' ? 'One' : 'Two'));
    t = t.replace(RE.romanCtx, (m, ctx, r) => {
    const v = romanToInt(r);
    return v ? ctx + ' ' + (ctx === 'World War' ? capitalize(cardinal(v)) : cardinal(v)) : m;
    });
    t = t.replace(RE.romanKing, (m, name, r) => {
    const v = romanToInt(r);
    // single "I" is the pronoun; single D/L/C/M are initials ("John D Rockefeller")
    if (!v || v > 40 || (r.length === 1 && r !== 'V' && r !== 'X')) return m;
    return name + ' the ' + ordinal(v);
    });

    // Acronyms the phonemizer mangles
    t = t.replace(RE.acronym, (_m, a, s) => spell(a) + s);
    t = t.replace(RE.tldr, 'T L D R').replace(RE.saas, 'sass');

  }

  // Handles and hashtags
  if (HAS_AT_HASH.test(t)) {
    t = t.replace(RE.handle, 'at $1');
    t = t.replace(RE.hashNum, 'number $1');
    t = t.replace(RE.hashtag, (_m, tag: string) => 'hashtag ' + tag.replace(/([a-z])([A-Z])/g, '$1 $2'));
  }
  return t;
}
