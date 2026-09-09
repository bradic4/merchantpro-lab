export type Platform = 'merchantpro' | 'shopify' | 'woocommerce' | 'other';
export type PageType = 'home' | 'category' | 'product';
export interface Store {
  id: string;
  name: string;
  origin: string;
  platform: Platform;
  role: 'sample' | 'control' | 'clean-test';
  market: string;
  theme: string;
  notes: string;
  pages: { id: string; type: PageType; url: string }[];
}
export interface Protocol {
  device: 'mobile' | 'desktop';
  runs: 3 | 5;
  location: string;
  consent: 'no-interaction';
  browserCache: 'cold';
  cdnCache: 'unknown' | 'warmed-by-preflight';
  notes: string;
}
export interface Manifest {
  schemaVersion: 1;
  name: string;
  protocol: Protocol;
  stores: Store[];
}
export interface LabMetrics {
  performance: number | null;
  lcpMs: number | null;
  cls: number | null;
  tbtMs: number | null;
  fcpMs: number | null;
  ttfbMs: number | null;
  imageTransferBytes: number | null;
  totalTransferBytes: number | null;
}
export interface Measurement {
  schemaVersion: 1;
  id: string;
  storeId: string;
  pageId: string;
  requestedUrl: string;
  finalUrl: string;
  fetchedAt: string;
  source: 'lighthouse' | 'psi-import';
  lighthouseVersion: string;
  browserVersion: string;
  device: 'mobile' | 'desktop';
  settingsHash: string;
  metrics: LabMetrics;
  warnings: string[];
  fieldData: unknown | null;
  rawFile: string;
  rawSha256: string;
  resources: import('./resource-analysis.js').PageResources | null;
}
export interface RunItem {
  id: string;
  storeId: string;
  pageId: string;
  repetition: number;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  error?: string;
  measurement?: Measurement;
}
export interface RunState {
  schemaVersion: 1;
  id: string;
  manifestHash: string;
  manifest: Manifest;
  createdAt: string;
  updatedAt: string;
  status: 'running' | 'completed' | 'partial';
  kind: 'live' | 'import' | 'demo';
  items: RunItem[];
}
