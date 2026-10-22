declare global {
  interface IndicatorRegistry {
    TRIX: { input?: { period?: number }; output: number | null };
  }
}

export {};
