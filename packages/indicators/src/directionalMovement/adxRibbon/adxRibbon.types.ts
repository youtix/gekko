declare global {
  interface IndicatorRegistry {
    ADXRibbon: {
      input?: {
        /**
         * Total number of ADX indicators to include in the ribbon.
         * Each indicator uses a progressively increasing period.
         * Default: 19
         */
        count?: number;
        /** Starting period for the first ADX indicator in the ribbon. Default: 12 */
        start?: number;
        /**
         * Step size by which the period increases for each subsequent ADX.
         * For example, with start = 12 and step = 3, the periods would be 12, 15, 18, ...
         * Default: 3
         */
        step?: number;
      };
      output: {
        /** Array of calculated ADX values from all configured periods. */
        results: number[];
        /** Difference between the maximum and minimum ADX values in the ribbon. */
        spread: number;
      } | null;
    };
  }
}

export {};
