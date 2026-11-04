declare global {
  interface IndicatorRegistry {
    MinusDI: { input: { period: number }; output: number | null };
  }
}

export {};
