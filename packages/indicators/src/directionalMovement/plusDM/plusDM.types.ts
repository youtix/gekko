declare global {
  interface IndicatorRegistry {
    PlusDM: { input: { period: number }; output: number | null };
  }
}

export {};
