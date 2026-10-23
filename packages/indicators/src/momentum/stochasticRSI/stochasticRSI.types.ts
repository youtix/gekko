import type { MovingAverageTypes } from '../../indicator.types';

declare global {
  interface IndicatorRegistry {
    StochasticRSI: {
      input?: {
        period?: number;
        fastKPeriod?: number;
        fastDPeriod?: number;
        slowMaType?: MovingAverageTypes;
      };
      output: { fastK: number; fastD: number } | null;
    };
  }
}

export {};
