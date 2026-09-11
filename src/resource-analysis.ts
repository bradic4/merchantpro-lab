type JsonObject = Record<string, unknown>;

const object = (value: unknown): JsonObject | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
const string = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null;
const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

export interface ImageResource {
  url: string;
  mimeType: string | null;
  transferSize: number | null;
  resourceSize: number | null;
  isLcpElement: boolean;
  protocol: string | null;
  statusCode: number | null;
}

export interface BlockingResource {
  url: string;
  wastedMs: number | null;
  totalBytes: number | null;
}

export interface PageResources {
  images: ImageResource[];
  totalImageBytes: number | null;
  lcpElement: { url: string | null; type: string | null; tagName: string | null; selector?: string | null } | null;
  blockingResources: BlockingResource[];
  totalBlockingMs: number | null;
  blockingDurationMeaning: 'sum-of-request-durations-not-TBT';
  domElements: number | null;
  totalRequests: number | null;
}

export function analyzeResources(lhr: unknown): PageResources | null {
  const root = object(lhr);
  if (!root) return null;
  const audits = object(root.audits);
  if (!audits) return null;

  const networkAudit = object(audits['network-requests']);
  const lcpElementAudit = object(audits['lcp-discovery-insight']) ?? object(audits['lcp-breakdown-insight']) ?? object(audits['largest-contentful-paint-element']);
  const blockingAudit = object(audits['render-blocking-insight']) ?? object(audits['render-blocking-resources']);
  const domAudit = object(audits['dom-size-insight']) ?? object(audits['dom-size']);

  if (!networkAudit && !lcpElementAudit && !blockingAudit && !domAudit) return null;

  const rawNetworkItems = object(networkAudit?.details)?.items;
  const networkItems: unknown[] = Array.isArray(rawNetworkItems) ? rawNetworkItems : [];
  const totalRequests = Array.isArray(rawNetworkItems) ? networkItems.length : null;

  const images: ImageResource[] = [];
  let totalImageBytes: number | null = Array.isArray(rawNetworkItems) ? 0 : null;

  for (const item of networkItems) {
    const req = object(item);
    if (!req) continue;
    const url = string(req.url);
    if (!url) continue;
    const mimeType = string(req.mimeType);
    if (mimeType?.startsWith('image/')) {
      const transferSize = finite(req.transferSize);
      if (transferSize === null) totalImageBytes = null;
      else if (totalImageBytes !== null) totalImageBytes += transferSize;
      images.push({
        url,
        mimeType,
        transferSize,
        resourceSize: finite(req.resourceSize),
        isLcpElement: false,
        protocol: string(req.protocol),
        statusCode: finite(req.statusCode),
      });
    }
  }

  const rawLcpItems = object(lcpElementAudit?.details)?.items;
  const lcpItems: unknown[] = Array.isArray(rawLcpItems) ? rawLcpItems : [];
  let lcpUrl: string | null = null;
  let lcpType: string | null = null;
  let lcpTagName: string | null = null;

  const first = object(lcpItems[0]);
  const node = lcpItems.map(object).find(x => x?.type === 'node') ?? object(first?.node);
  const selector = string(node?.selector);
  const snippet = string(node?.snippet);
  lcpTagName = string(node?.nodeName) ?? snippet?.match(/^<([a-z0-9-]+)/i)?.[1]?.toUpperCase() ?? null;
  lcpType = lcpTagName === 'IMG' ? 'image' : string(first?.type) === 'image' ? 'image' : null;
  // A snippet src can be truncated or differ from currentSrc. Never guess the selected URL.
  lcpUrl = string(first?.url);

  if (lcpUrl) {
    for (const img of images) {
      if (img.url === lcpUrl) {
        img.isLcpElement = true;
      }
    }
  }

  const rawBlockingItems = object(blockingAudit?.details)?.items;
  const blockingItems: unknown[] = Array.isArray(rawBlockingItems) ? rawBlockingItems : [];
  const blockingResources: BlockingResource[] = [];
  let totalBlockingMs: number | null = Array.isArray(rawBlockingItems) ? 0 : null;

  for (const item of blockingItems) {
    const req = object(item);
    if (!req) continue;
    const url = string(req.url);
    if (!url) continue;
    const wastedMs = finite(req.wastedMs);
    if (wastedMs === null) totalBlockingMs = null;
    else if (totalBlockingMs !== null) totalBlockingMs += wastedMs;
    blockingResources.push({
      url,
      wastedMs,
      totalBytes: finite(req.totalBytes),
    });
  }

  const domElements = finite(domAudit?.numericValue) ?? finite(object(object(domAudit?.details)?.debugData)?.totalElements);

  return {
    images,
    totalImageBytes,
    lcpElement: lcpUrl || lcpType || lcpTagName || selector ? { url: lcpUrl, type: lcpType, tagName: lcpTagName, ...(selector ? {selector} : {}) } : null,
    blockingResources,
    totalBlockingMs,
    blockingDurationMeaning: 'sum-of-request-durations-not-TBT',
    domElements,
    totalRequests,
  };
}
