declare global {
  interface IndicatorRegistry {
    PlusDI: { input: { period: number }; output: number | null };
  }
}

export {};
