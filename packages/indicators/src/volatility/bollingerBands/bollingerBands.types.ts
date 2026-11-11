import type { MovingAverageTypes } from '../../indicator.types';

declare global {
  interface IndicatorRegistry {
    BollingerBands: {
      input?: { period?: number; stdevUp?: number; stdevDown?: number; maType?: MovingAverageTypes };
      output: { upper: number; lower: number; middle: number } | null;
    };
  }
}

export {};
