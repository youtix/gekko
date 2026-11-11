declare global {
  interface IndicatorRegistry {
    AO: { input?: { short?: number; long?: number }; output: number | null };
  }
}

export {};
