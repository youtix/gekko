import { InputSources } from '@gekko/shared/models/inputSources.types';

declare global {
  interface IndicatorRegistry {
    EMARibbon: {
      input?: {
        /** Number of EMAs in the ribbon. Default: 22 */
        count?: number;
        /** Period for the first EMA. Default: 3 */
        start?: number;
        /** Step between consecutive EMA periods. Default: 3 */
        step?: number;
        /** Candle value used to calculate each EMA. Default: 'close' */
        src?: InputSources;
      };
      output: {
        /** Array of calculated EMA values */
        results: number[];
        /** Difference between the highest and lowest EMA values */
        spread: number;
      } | null;
    };
  }
}

export {};
