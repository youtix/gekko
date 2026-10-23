declare global {
  interface IndicatorRegistry {
    TrueRange: { input: void; output: number | null };
  }
}

export {};
