declare global {
  interface IndicatorRegistry {
    WilliamsR: { input?: { period?: number }; output: number | null };
  }
}

export {};
