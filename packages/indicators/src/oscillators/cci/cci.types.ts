declare global {
  interface IndicatorRegistry {
    CCI: { input?: { period?: number }; output: number | null };
  }
}

export {};
