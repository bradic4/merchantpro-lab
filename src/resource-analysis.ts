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
  totalImageBytes: number;
  lcpElement: { url: string | null; type: string | null; tagName: string | null } | null;
  blockingResources: BlockingResource[];
  totalBlockingMs: number;
  domElements: number | null;
  totalRequests: number | null;
}

export function analyzeResources(lhr: unknown): PageResources | null {
  const root = object(lhr);
  if (!root) return null;
  const audits = object(root.audits);
  if (!audits) return null;

  const networkAudit = object(audits['network-requests']);
  const lcpElementAudit = object(audits['largest-contentful-paint-element']) ?? object(audits['largest-contentful-paint']);
  const blockingAudit = object(audits['render-blocking-resources']);
  const domAudit = object(audits['dom-size']);

  if (!networkAudit && !lcpElementAudit && !blockingAudit && !domAudit) return null;

  const rawNetworkItems = object(networkAudit?.details)?.items;
  const networkItems: unknown[] = Array.isArray(rawNetworkItems) ? rawNetworkItems : [];
  const totalRequests = networkAudit ? networkItems.length : null;

  const images: ImageResource[] = [];
  let totalImageBytes = 0;

  for (const item of networkItems) {
    const req = object(item);
    if (!req) continue;
    const url = string(req.url);
    if (!url) continue;
    const mimeType = string(req.mimeType);
    if (mimeType?.startsWith('image/')) {
      const transferSize = finite(req.transferSize);
      if (transferSize) totalImageBytes += transferSize;
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

  if (lcpItems.length > 0) {
    const first = object(lcpItems[0]);
    if (first) {
      const node = object(first.node);
      lcpType = string(first.type) ?? null;
      lcpUrl = string(first.url) ?? null;
      lcpTagName = node ? string(node.nodeName) : null;
    }
  }

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
  let totalBlockingMs = 0;

  for (const item of blockingItems) {
    const req = object(item);
    if (!req) continue;
    const url = string(req.url);
    if (!url) continue;
    const wastedMs = finite(req.wastedMs);
    if (wastedMs) totalBlockingMs += wastedMs;
    blockingResources.push({
      url,
      wastedMs,
      totalBytes: finite(req.totalBytes),
    });
  }

  const domElements = finite(domAudit?.numericValue);

  return {
    images,
    totalImageBytes,
    lcpElement: lcpUrl || lcpType || lcpTagName ? { url: lcpUrl, type: lcpType, tagName: lcpTagName } : null,
    blockingResources,
    totalBlockingMs,
    domElements,
    totalRequests,
  };
}
