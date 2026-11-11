declare global {
  interface IndicatorRegistry {
    MinusDM: { input: { period: number }; output: number | null };
  }
}

export {};
