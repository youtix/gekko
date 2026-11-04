declare global {
  interface IndicatorRegistry {
    DX: { input: { period: number }; output: number | null };
  }
}

export {};
