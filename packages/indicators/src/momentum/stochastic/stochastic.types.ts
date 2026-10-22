import type { MovingAverageTypes } from '../../indicator.types';

declare global {
  interface IndicatorRegistry {
    Stochastic: {
      input?: {
        fastKPeriod?: number;
        slowKPeriod?: number;
        slowKMaType?: MovingAverageTypes;
        slowDPeriod?: number;
        slowDMaType?: MovingAverageTypes;
      };
      output: { k: number; d: number } | null;
    };
  }
}

export {};
