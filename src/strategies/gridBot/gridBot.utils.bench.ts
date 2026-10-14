import { MarketData } from '@services/exchange/exchange.types';
import { bench, describe } from 'vitest';
import {
  computeGridBounds,
  computeLevelPrice,
  computeRebalancePlan,
  deriveLevelQuantity,
  getMaximumAmount,
  getMinimumAmount,
  getOutOfRangeSide,
  hasOnlyOneSide,
  inferAmountPrecision,
  inferPricePrecision,
  roundAmount,
  roundPrice,
  validateConfig,
} from './gridBot.utils';

// Test values matching the old portfolio: assetFree=10, assetTotal=10, currencyFree=1000, currencyTotal=1000
const assetFree = 10;
const currencyFree = 1000;

const marketData: MarketData = {
  precision: { price: 0.01, amount: 0.001 },
  amount: { min: 0.001, max: 1000 },
  cost: { min: 1, max: 100000 },
};

describe('gridBot.utils Performance', () => {
  describe('roundPrice', () => {
    bench('10000 price roundings without step', () => {
      for (let i = 0; i < 10000; i++) {
        roundPrice(100.12345, 2);
      }
    });

    bench('10000 price roundings to a tick of one unit of a decimal', () => {
      for (let i = 0; i < 10000; i++) {
        roundPrice(100.12345, 2, 0.01);
      }
    });

    bench('10000 price roundings with step', () => {
      for (let i = 0; i < 10000; i++) {
        roundPrice(100.12345, 2, 0.05);
      }
    });

    bench('10000 price roundings to the tick of 5 significant digits, coarser than the step', () => {
      for (let i = 0; i < 10000; i++) {
        roundPrice(10000.37, 1, 0.1, 5);
      }
    });
  });

  describe('roundAmount', () => {
    bench('10000 amount roundings', () => {
      for (let i = 0; i < 10000; i++) {
        roundAmount(1.23456, 0.001);
      }
    });
  });

  describe('computeLevelPrice', () => {
    bench('1000 fixed spacing calculations', () => {
      for (let i = 0; i < 1000; i++) {
        computeLevelPrice(100, (i % 10) - 5, 2, 'fixed', 5);
      }
    });

    bench('1000 percent spacing calculations', () => {
      for (let i = 0; i < 1000; i++) {
        computeLevelPrice(100, (i % 10) - 5, 2, 'percent', 1);
      }
    });

    bench('1000 logarithmic spacing calculations', () => {
      for (let i = 0; i < 1000; i++) {
        computeLevelPrice(100, (i % 10) - 5, 2, 'logarithmic', 0.01);
      }
    });
  });

  describe('inferPricePrecision', () => {
    bench('10000 precision inferences', () => {
      for (let i = 0; i < 10000; i++) {
        inferPricePrecision(marketData);
      }
    });
  });

  describe('inferAmountPrecision', () => {
    bench('10000 amount precision inferences', () => {
      for (let i = 0; i < 10000; i++) {
        inferAmountPrecision(marketData);
      }
    });
  });

  describe('computeGridBounds', () => {
    bench('1000 grid bounds calculations', () => {
      for (let i = 0; i < 1000; i++) {
        computeGridBounds(100, 5, 5, 2, 'fixed', 5);
      }
    });
  });

  describe('getOutOfRangeSide', () => {
    const bounds = { min: 90, max: 110 };
    const reentryPrices = { below: 95, above: 105 };

    bench('10000 range checks', () => {
      for (let i = 0; i < 10000; i++) {
        getOutOfRangeSide(100 + ((i % 50) - 25), bounds, reentryPrices, null);
      }
    });
  });

  describe('validateConfig', () => {
    const params = { buyLevels: 5, sellLevels: 5, spacingType: 'fixed' as const, spacingValue: 5, retryOnError: 3 };

    bench('1000 config validations', () => {
      for (let i = 0; i < 1000; i++) {
        validateConfig(params, 100, marketData);
      }
    });
  });

  describe('getMinimumAmount', () => {
    bench('10000 minimum amounts', () => {
      for (let i = 0; i < 10000; i++) {
        getMinimumAmount(90 + (i % 20), marketData);
      }
    });
  });

  describe('getMaximumAmount', () => {
    bench('10000 maximum amounts', () => {
      for (let i = 0; i < 10000; i++) {
        getMaximumAmount(110 + (i % 20), marketData);
      }
    });
  });

  describe('computeRebalancePlan', () => {
    const grid = { buyLevels: 5, sellLevels: 5, spacingType: 'fixed' as const, spacingValue: 5 };

    bench('1000 rebalance plan calculations', () => {
      for (let i = 0; i < 1000; i++) {
        computeRebalancePlan(100, assetFree, currencyFree, grid, marketData);
      }
    });
  });

  describe('deriveLevelQuantity', () => {
    bench('100 quantity derivations', () => {
      for (let i = 0; i < 100; i++) {
        deriveLevelQuantity(100, assetFree, currencyFree, 5, 5, 2, 'fixed', 5, marketData);
      }
    });
  });

  describe('hasOnlyOneSide', () => {
    const levels = [
      { side: 'BUY' as const, orderId: '1' },
      { side: 'BUY' as const, orderId: '2' },
      { side: 'SELL' as const, orderId: '3' },
      { side: 'SELL' as const, orderId: '4' },
    ];

    bench('10000 side checks', () => {
      for (let i = 0; i < 10000; i++) {
        hasOnlyOneSide(levels);
      }
    });
  });
});
