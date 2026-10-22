declare global {
  interface IndicatorRegistry {
    ATRCD: {
      input?: { short?: number; long?: number; signal?: number };
      output: { atrcd: number; signal: number; hist: number } | null;
    };
  }
}

export {};
