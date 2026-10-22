import { InputSources } from '@gekko/shared/models/inputSources.types';

declare global {
  interface IndicatorRegistry {
    TEMA: { input: { period: number; src?: InputSources }; output: number | null };
  }
}

export {};
