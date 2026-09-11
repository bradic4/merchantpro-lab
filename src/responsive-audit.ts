import { analyzeResources } from './resource-analysis.js';
type JsonObject = Record<string, unknown>;

const object = (value: unknown): JsonObject | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
const string = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null;
const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

export interface ResponsiveIssue {
  type: 'oversized-variant' | 'missing-responsive' | 'missing-lazy' | 'lcp-not-preloaded';
  severity: 'critical' | 'warning' | 'info';
  url: string;
  details: string;
  suggestion: string;
  estimatedSavingsBytes?: number;
}

export interface ResponsiveAuditResult {
  url: string;
  device: 'mobile' | 'desktop' | 'unknown';
  totalImages: number;
  merchantProImages: number;
  issues: ResponsiveIssue[];
  totalEstimatedSavingsBytes: number;
  summary: string;
}

/**
 * Analyzes image delivery behavior from Lighthouse JSON.
 * Specifically checks for MerchantPro /p/l/ (large) vs /p/m/ (medium) variants on mobile devices,
 * LCP image preload status, and non-LCP lazy-loading candidates.
 */
export function auditResponsiveImages(lhr: unknown): ResponsiveAuditResult | null {
  const root = object(lhr);
  if (!root) return null;
  const audits = object(root.audits);
  if (!audits) return null;

  const targetUrl = string(root.requestedUrl) ?? string(root.finalUrl) ?? 'Nepoznat URL';
  const settings = object(root.configSettings);
  const device = (settings?.formFactor === 'mobile' || settings?.formFactor === 'desktop')
    ? (settings.formFactor as 'mobile' | 'desktop')
    : 'unknown';

  const networkAudit = object(audits['network-requests']);
  const rawNetworkItems = object(networkAudit?.details)?.items;
  const networkItems: unknown[] = Array.isArray(rawNetworkItems) ? rawNetworkItems : [];

  const lcpUrl = analyzeResources(lhr)?.lcpElement?.url ?? null;

  const issues: ResponsiveIssue[] = [];
  let totalImages = 0;
  let merchantProImages = 0;
  let totalEstimatedSavingsBytes = 0;

  for (let i = 0; i < networkItems.length; i++) {
    const item = object(networkItems[i]);
    if (!item) continue;
    const url = string(item.url);
    if (!url) continue;
    const mimeType = string(item.mimeType);
    if (!mimeType?.startsWith('image/')) continue;

    totalImages++;
    const transferSize = finite(item.transferSize) ?? 0;
    const isLcp = lcpUrl !== null && url === lcpUrl;
    const isMerchantPro = url.includes('cdnmp.net') || url.includes('/p/l/') || url.includes('/p/m/') || url.includes('/p/t/');

    if (isMerchantPro) merchantProImages++;

    // 1. Mobile requesting Large (/p/l/) variant
    if (device === 'mobile' && url.includes('/p/l/')) {
      // Estimated ~55% savings if medium variant (/p/m/) were requested instead
      const estSavings = Math.round(transferSize * 0.55);
      totalEstimatedSavingsBytes += estSavings;
      issues.push({
        type: 'oversized-variant',
        severity: transferSize > 150_000 ? 'critical' : 'warning',
        url,
        details: `Mobilni uređaj preuzima veliku varijantu slike (/p/l/) veličine ${(transferSize / 1024).toFixed(1)} kB.`,
        suggestion: `Iskoristiti srcset/picture sa /p/m/ varijantom za mobilni viewport (ušteda cca ${(estSavings / 1024).toFixed(1)} kB).`,
        estimatedSavingsBytes: estSavings,
      });
    }

    // 2. Missing lazy loading candidate: image requested very early in the waterfall (> 200kB, not LCP, index > 5)
    if (!isLcp && i < 15 && transferSize > 100_000) {
      issues.push({
        type: 'missing-lazy',
        severity: 'warning',
        url,
        details: `Slika nije LCP element, ali se učitava u ranoj fazi prenosa (${(transferSize / 1024).toFixed(1)} kB, zahtev #${i + 1}).`,
        suggestion: `Dodati loading="lazy" i decoding="async" ukoliko se slika nalazi ispod prvog ekrana (below-the-fold).`,
      });
    }
  }

  // 3. LCP not preloaded check
  if (lcpUrl) {
    const lcpReqIndex = networkItems.findIndex(it => object(it)?.url === lcpUrl);
    // If LCP image starts loading late (after 10+ other resources)
    if (lcpReqIndex > 10) {
      issues.push({
        type: 'lcp-not-preloaded',
        severity: 'critical',
        url: lcpUrl,
        details: `LCP hero slika se nalazi tek na poziciji #${lcpReqIndex + 1} u redosledu zahteva.`,
        suggestion: `Dodati <link rel="preload" fetchpriority="high" as="image" href="..."> u <head> za LCP sliku.`,
      });
    }
  }

  const summary = `Pronađeno ${totalImages} slika (${merchantProImages} MerchantPro CDN). Otkriveno ${issues.length} stavki za delivery optimizaciju. Potencijalna ušteda na mobilnom: ${(totalEstimatedSavingsBytes / 1024).toFixed(1)} kB.`;

  return {
    url: targetUrl,
    device,
    totalImages,
    merchantProImages,
    issues,
    totalEstimatedSavingsBytes,
    summary,
  };
}
