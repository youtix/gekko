/**
 * value * 10 ** places, by moving the decimal point of value as String writes it, the shortest decimal that reads back as value.
 * This is exact where the binary product is not: 8.2 has no exact binary value, so 8.2 * 100 is 819.9999999999999 while 8.2e2 is 820.
 */
export const shiftDecimalPoint = (value: number, places: number): number => {
  if (value === 0) return value; // String writes -0 as '0'
  const [mantissa, exponent = '0'] = String(value).split('e');
  return Number(`${mantissa}e${Number(exponent) + places}`);
};

/**
 * The decimals of value as String writes it: 2 for 8.25, 8 for 1.5e-7, -21 for 1e21, and -2 for 1200, whose zeros need no rounding to
 * tens or hundreds. Counted as decimals, they would make 123456789012345680000 to tens a product past 2 ** 53, beyond what a double holds.
 */
export const countDecimals = (value: number): number => {
  const [mantissa, exponent = '0'] = String(value).split('e');
  const [integer, fraction] = mantissa.split('.');
  return (fraction?.length ?? integer.replace(/0+$/, '').length - integer.length) - Number(exponent);
};

/**
 * How what lies past the floor of value * 10 ** places compares with one half, from the digits String writes for value: -1 below it,
 * 0 on it, 1 above it. Below zero what lies past the floor is 1 minus the fraction written (-2.3 is -3 + 0.7), hence the sign.
 */
const compareFractionToHalf = (value: number, places: number): number => {
  const length = countDecimals(value) - places; // the digits past the moved point, the last of them not 0
  const digits = String(Math.abs(value)).split('e')[0].replace('.', '').replace(/0+$/, '');
  const fraction = digits.slice(-length).padStart(length, '0');
  if (fraction === '5') return 0;
  return Math.sign(value) * (fraction > '5' ? 1 : -1);
};

const roundHalfEven = (n: number): number => {
  const floor = Math.floor(n);
  const fraction = n - floor;
  if (fraction > 0.5) return floor + 1;
  if (fraction < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
};

/**
 * Rounds value to `decimals` decimals: 'down' to the decimal below (Math.floor), 'up' to the nearest one, a tie to the one above
 * (Math.round), 'halfEven' to the nearest one, a tie to the even one. value is rounded as it is written, so that 8.2 rounded down
 * to 2 decimals stays 8.2 and 1.005 rounded up is 1.01. This is exact for any value. A negative value rounded to 0 is -0 'up', as
 * with Math.round, and 0 'halfEven'; Intl.NumberFormat takes a negative tie away from zero (-2.914906545 to 8 decimals: -2.91490655).
 */
export const round = (value: number, decimals = 0, option: 'down' | 'up' | 'halfEven' = 'up'): number => {
  // Nothing to round. value is given back as it is: shifted there and back, one of 16 or 17 significant digits could come back a unit off
  if (!Number.isFinite(value) || countDecimals(value) <= decimals) return value;
  // n is the double nearest to value * 10 ** decimals. Of 17 significant digits, the product can be nearer to an integer or to a half than
  // to any other double: at 8 decimals 2752.0325676499997 is 275203256764.99997, read as 275203256765, and 1466135.4430033849 is
  // 146613544300338.49, read as 146613544300338.5. From 2 ** 52 doubles are integers: 4503673817229070.5 is read as 4503673817229070.
  const n = shiftDecimalPoint(value, decimals);
  if (option === 'down') {
    // Read as the integer above it, the product would be floored to that integer, which comes back above value
    return shiftDecimalPoint(Number.isInteger(n) && shiftDecimalPoint(n, -decimals) > value ? n - 1 : Math.floor(n), -decimals);
  }
  // Read as a half, or as an integer that can stand for a tie, the product is placed against the half by the digits written
  if (Math.abs(n % 1) === 0.5 || Math.abs(n) >= 2 ** 52) {
    const half = compareFractionToHalf(value, decimals);
    if (half !== 0) return shiftDecimalPoint(half < 0 ? Math.floor(n) : Math.ceil(n), -decimals);
    // A tie from 2 ** 52 is read as its even integer, right for 'halfEven', but a unit short for 'up' when it is the one below
    if (option === 'up' && shiftDecimalPoint(n, -decimals) < value) return shiftDecimalPoint(n + 1, -decimals);
  }
  return shiftDecimalPoint(option === 'up' ? Math.round(n) : roundHalfEven(n), -decimals);
};
