import type { MovingAverageTypes } from '../../indicator.types';
import { InputSources } from '@gekko/shared/models/inputSources.types';

declare global {
  interface IndicatorRegistry {
    EFI: {
      input?: { period?: number; maType?: MovingAverageTypes; src?: InputSources };
      output: { fi: number; smoothed: number } | null;
    };
  }
}

export {};
