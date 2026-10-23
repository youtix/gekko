import type { MovingAverageTypes } from '../../indicator.types';

declare global {
  interface IndicatorRegistry {
    OBV: {
      input?: { period?: number; stdevUp?: number; stdevDown?: number; maType?: MovingAverageTypes };
      output: { obv: number; ma: number; upper: number; lower: number } | null;
    };
  }
}

export {};
