import { isFiniteNumber } from '@utils/math/math.utils';
import { countDecimals, round } from '@utils/math/round.utils';
import { camelCase, upperFirst } from 'lodash-es';
import { END_Y_WORDS, IRREGULAR } from './string.const';

export const toCamelCase = (...args: string[]) => {
  return camelCase(args.join(' '));
};

/**
 * word as English writes it after count: the singular for a count of 1 or -1, the plural for any other, 0 included (the singular,
 * once kept for every count up to 1, wrote 'Fetched 0 candle'). The plural is pluralForm when given, else the one IRREGULAR holds,
 * else word with 'es' after s, sh, ch, x or z, 'ies' in place of a 'y' after a consonant, and 's' otherwise.
 */
export function pluralize(word: string, count: number, pluralForm?: string): string {
  if (Math.abs(count) === 1) return word;
  if (pluralForm) return pluralForm;

  const lower = word.toLowerCase();
  // Its own keys only: read through the prototype of the map, 'constructor' gave the function Object
  if (Object.hasOwn(IRREGULAR, lower)) {
    const plural = IRREGULAR[lower];
    // The map is in lower case: a capitalised word keeps its capital ('Person' → 'People'), as the rules below keep the word
    return word[0] === lower[0] ? plural : upperFirst(plural);
  }

  // “bus” → “buses”, “box” → “boxes”, “buzz” → “buzzes”
  if (['s', 'sh', 'ch', 'x', 'z'].some(end => lower.endsWith(end))) return `${word}es`;

  // “lady” → “ladies”
  if (END_Y_WORDS.some(end => lower.endsWith(end))) return `${word.slice(0, -1)}ies`;

  // default: just add “s”  (“cat” → “cats”)
  return `${word}s`;
}

const ratioFormatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  useGrouping: false,
});

/**
 * A ratio or a deviation to two decimals, for a person and for a CSV cell alike: 1.24, -0.01, and 0.00 rather than -0.00. Without a
 * finite number it is '', as in toPlainNumber: Intl would write ∞, which no program reads back as a number, and the stats helpers
 * give a ratio of 0, not an infinite one, for a deviation of 0.
 */
export function formatRatio(x: number | null | undefined): string {
  if (!isFiniteNumber(x)) return '';
  const rounded = Math.abs(x) < 0.005 ? 0 : x;
  return ratioFormatter.format(rounded);
}

// Amounts and prices span many orders of magnitude, from a balance in thousands to a PEPE price below 0.0001: eight fraction
// digits, down to a satoshi, keep the small ones from rounding to 0. The locale is explicit because Node formats with the one
// of the machine ('1 234,568' on a French one). 'negative' writes a value rounded to zero as 0, not -0.
const AMOUNT_FORMAT: Intl.NumberFormatOptions = { maximumFractionDigits: 8, signDisplay: 'negative' };
const amountFormatter = new Intl.NumberFormat('en-US', AMOUNT_FORMAT);
const plainNumberFormatter = new Intl.NumberFormat('en-US', { ...AMOUNT_FORMAT, useGrouping: false });

/** An amount or a price for a person to read, its thousands grouped: 1,234.5678, 0.0000012. */
export const formatAmount = (value: number): string => amountFormatter.format(value);

/**
 * A number for a program to read, such as a CSV cell: no grouping, a '.' separator and never an exponent (0.00000012, which
 * String writes 1.2e-7). Without a finite number it is '', where Intl would write NaN or ∞.
 */
export const toPlainNumber = (value: number | null | undefined): string =>
  isFiniteNumber(value) ? plainNumberFormatter.format(value) : '';

/**
 * A number with every decimal String gives it, without an exponent: 0.0000001, which String writes 1e-7, and 0.000099997, which
 * formatAmount and toPlainNumber round to 0.0001. For a message that quotes a value beside the bound it missed, or a balance beside
 * what an order needs: rounded, the two could read alike, "value 0.0001 is too low. Minimum allowed is 0.0001". String's own digits,
 * the point moved where its exponent puts it (String writes one below 1e-6 and from 1e21 on): toFixed works the digits out again from
 * the double and can write another neighbour of it, -104563116752869.13 for the -104563116752869.12 String writes. NaN, ±Infinity and
 * a number of more than 100 decimals, which no market has, are written as String writes them.
 */
export const formatEveryDecimal = (value: number): string => {
  const text = String(value);
  const [mantissa, exponent] = text.split('e');
  if (exponent === undefined || countDecimals(value) > 100) return text;
  // One digit before the point, never 0: 4.5678e-7, 1.5e+21
  const [integer, fraction = ''] = mantissa.replace('-', '').split('.');
  const digits = integer + fraction;
  const point = integer.length + Number(exponent);
  const unsigned = point <= 0 ? `0.${'0'.repeat(-point)}${digits}` : digits.padEnd(point, '0');
  return value < 0 ? `-${unsigned}` : unsigned;
};

/** How formatPercent rounds a percentage to its 2 decimals: down to the hundredth below, or half to even (see round) */
export type PercentRounding = 'down' | 'halfEven';

/**
 * A percentage to 2 decimals, for a person and for a CSV cell alike: the number round gives, then '%' (-5.01% for -5.001 rounded down,
 * 3.12% for 3.125 rounded half to even, 10.5% for 10.5). The rounding is that of the figure, the same wherever it is written: each
 * output rounding in its own way, one figure read 0.01 apart from one to the other.
 */
export const formatPercent = (value: number, rounding: PercentRounding): string => `${round(value, 2, rounding)}%`;

export const formatSignedPercent = (value: number | null | undefined) => {
  if (!isFiniteNumber(value)) return 'n/a';
  const roundedValue = round(value, 2, 'halfEven');
  const absolute = Math.abs(roundedValue);
  if (roundedValue > 0) return `+${absolute}%`;
  if (roundedValue < 0) return `-${absolute}%`;
  return '0%';
};
