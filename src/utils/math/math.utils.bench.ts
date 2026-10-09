import { bench, describe } from 'vitest';
import { addPrecise, stdev, toSignificantDigits } from './math.utils';

// Sample data for benchmarks
const smallArray = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const mediumArray = Array.from({ length: 100 }, (_, i) => i + Math.random());
const largeArray = Array.from({ length: 1000 }, (_, i) => i + Math.random());

describe('stdev Performance', () => {
  bench('stdev - small array (10 elements)', () => {
    stdev(smallArray);
  });

  bench('stdev - medium array (100 elements)', () => {
    stdev(mediumArray);
  });

  bench('stdev - large array (1000 elements)', () => {
    stdev(largeArray);
  });
});

describe('addPrecise Performance', () => {
  bench('addPrecise - simple addition', () => {
    addPrecise(0.1, 0.2);
  });

  bench('addPrecise - many decimals', () => {
    addPrecise(1.23456789, 9.87654321);
  });

  bench('addPrecise - scientific notation', () => {
    addPrecise(1e-7, 2e-7);
  });

  bench('addPrecise - 100 sequential additions', () => {
    let result = 0;
    for (let i = 0; i < 100; i++) {
      result = addPrecise(result, 0.01);
    }
  });
});

describe('toSignificantDigits Performance', () => {
  bench('toSignificantDigits - a quotient with no end', () => {
    toSignificantDigits(100 / 3);
  });

  bench('toSignificantDigits - a value of fewer digits', () => {
    toSignificantDigits(0.07);
  });
});
