export type StorePlatform = 'merchantpro' | 'shopify' | 'woocommerce' | 'custom';
export type StoreStatus = 'live' | 'pilot' | 'issue' | 'paused';
export type UserRole = 'ADMIN' | 'CLIENT';

export interface VendorConfig {
  meta: boolean;
  gtm: boolean;
  tiktok: boolean;
}

export interface Store {
  id: string;
  name: string;
  domain: string;
  platform: StorePlatform;
  status: StoreStatus;
  canaryPercent: number; // e.g. 1 for 1%, 5 for 5%
  killSwitch: boolean;
  vendors: VendorConfig;
  baselineBlockingMs: number; // e.g. 11300
  optimizedBlockingMs: number; // e.g. 6900
  createdAt: string;
  updatedAt: string;
}

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  name: string;
  role: UserRole;
  storeId: string | null; // null for ADMIN, store slug for CLIENT
  createdAt: string;
}

export interface TelemetrySession {
  id: string;
  storeId: string;
  timestamp: number;
  cohort: string;
  country: string;
  clientIp: string;
  url: string;
  longTaskBlockingMs: number;
  errorsCount: number;
  eventsBuffered: number;
  meta: 'idle' | 'deferred' | 'loading' | 'loaded' | 'failed';
  gtm: 'idle' | 'deferred' | 'loading' | 'loaded' | 'failed';
  tiktok: 'idle' | 'deferred' | 'loading' | 'loaded' | 'failed';
}

export interface VendorHealth {
  status: 'healthy' | 'degraded' | 'failed';
  eventsBuffered: number;
  errorsCount: number;
}

export interface StoreMetrics {
  storeId: string;
  totalSessions: number;
  optimizedSessions: number;
  baselineSessions: number;
  crawlerSessions: number;
  totalErrors: number;
  baselineBlockingMs: number;
  optimizedBlockingMs: number;
  reductionPercent: number; // e.g. -38.9
  vendorHealth: {
    meta: VendorHealth;
    gtm: VendorHealth;
    tiktok: VendorHealth;
  };
  recentSessions: TelemetrySession[];
  countryBreakdown: Record<string, number>;
}

export interface StorageAdapter {
  init(): Promise<void>;
  getStore(storeId: string): Promise<Store | null>;
  listStores(): Promise<Store[]>;
  updateStoreConfig(storeId: string, updates: Partial<Pick<Store, 'canaryPercent' | 'killSwitch' | 'vendors' | 'status'>>): Promise<Store>;
  recordTelemetry(session: Omit<TelemetrySession, 'id'>): Promise<TelemetrySession>;
  getStoreMetrics(storeId: string, windowHours?: number): Promise<StoreMetrics>;
  getUserByEmail(email: string): Promise<User | null>;
  getUserById(id: string): Promise<User | null>;
}
