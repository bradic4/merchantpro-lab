/** Future presentation contracts; optional values must never be filled with defaults or examples. */
export interface BusinessImpactPopulation {
  sampleSize: number;
  orders?: number;
  revenue?: number;
  currency?: string;
  conversionRate?: number;
  revenuePerSession?: number;
}

export interface BusinessImpactData {
  periodStart: string;
  periodEnd: string;
  control?: BusinessImpactPopulation;
  optimized?: BusinessImpactPopulation;
  observedDifference?: { metric: 'conversionRate' | 'revenuePerSession'; absolute: number; relative?: number };
  sufficientData: boolean;
}

export interface ProductionPerformanceBucket {
  timestamp: string;
  mode: 'immediate_fallback' | 'smart_deferral_canary' | 'unknown';
  sampleSize: number;
  medianLongTaskBlockingMs: number;
  p75LongTaskBlockingMs?: number;
}

export interface ControlledPerformanceTest {
  testId: string;
  measuredAt: string;
  baselineBlockingMs: number;
  optimizedBlockingMs: number;
  sampleSize?: number;
  measurementProfile?: string;
}
