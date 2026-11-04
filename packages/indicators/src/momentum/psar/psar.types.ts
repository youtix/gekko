declare global {
  interface IndicatorRegistry {
    PSAR: { input: { acceleration?: number; maxAcceleration?: number }; output: number | null };
  }
}

export {};
