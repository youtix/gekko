declare global {
  interface IndicatorRegistry {
    ROC: { input: { period: number }; output: number | null };
  }
}

export {};
