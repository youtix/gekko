declare global {
  interface IndicatorRegistry {
    ADX: { input: { period: number }; output: number | null };
  }
}

export {};
