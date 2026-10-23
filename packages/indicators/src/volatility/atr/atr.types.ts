declare global {
  interface IndicatorRegistry {
    ATR: { input: { period: number }; output: number | null };
  }
}

export {};
