/** Read-only MerchantPro v2 inventory. Wire contract verified against the public docs 2026-09-08. */
export interface InventoryOptions {
  origin: string;
  username: string;
  secret: string;
  maxProducts: number;
  includeImages: boolean;
  requestIntervalMs?: number;
}

export interface ConnectorDependencies {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
}

type RecordValue = Record<string, unknown>;
export interface InventoryResult {
  schemaVersion: 1;
  source: { kind: 'merchantpro-api'; origin: string };
  capturedAt: string;
  limits: { maxProducts: number; includeImages: boolean };
  complete: boolean;
  totalAvailable: number;
  products: RecordValue[];
  requests: number;
}

export class MerchantProError extends Error {
  constructor(public readonly code: string, message: string, public readonly status?: number) {
    super(message);
    this.name = 'MerchantProError';
  }
}

const PRODUCT_PATH = '/api/v2/products';
const FIELDS = 'id,type,sku,name,description,category_id,category_name,manufacturer_id,manufacturer_name,url,status,visibility,date_modified';
const STRING_FIELDS = ['type', 'sku', 'name', 'description', 'category_name', 'manufacturer_name', 'url', 'status', 'visibility', 'date_modified'] as const;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_RETRIES = 2;
const MAX_RETRY_AFTER_MS = 30_000;

function invalid(message = 'Unexpected MerchantPro response structure.'): never {
  throw new MerchantProError('INVALID_RESPONSE', message);
}
function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function integer(value: unknown, min = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min;
}

export function validateOrigin(value: string): string {
  let origin: URL;
  try { origin = new URL(value); } catch { throw new MerchantProError('INVALID_ORIGIN', 'Use the HTTPS origin of your MerchantPro store.'); }
  const hostname = origin.hostname.toLowerCase();
  // Store origins use public DNS names. Reject IP literals, local names, ports and URL normalization tricks.
  if (!/^https:\/\/[^/?#\\\s]+\/?$/i.test(value) || origin.protocol !== 'https:' || origin.username || origin.password ||
      origin.port || origin.pathname !== '/' || origin.search || origin.hash || !hostname.includes('.') ||
      /^\d+(\.\d+){3}$/.test(hostname) || hostname.includes(':') || hostname.endsWith('.') ||
      /(^|\.)(localhost|local|localdomain|internal)$/.test(hostname)) {
    throw new MerchantProError('INVALID_ORIGIN', 'Use a public HTTPS store origin without a path, credentials, query, fragment or custom port.');
  }
  return origin.origin;
}

/** Retry-After can be seconds or an HTTP date; long or malformed values stop the run. */
export function retryDelay(header: string | null, now: number, attempt: number): number {
  if (header === null) return 2_000 * 2 ** attempt;
  const trimmed = header.trim();
  const delay = /^\d+$/.test(trimmed) ? Number(trimmed) * 1_000 : Date.parse(trimmed) - now;
  if (!Number.isFinite(delay) || delay > MAX_RETRY_AFTER_MS || delay < -1_000) {
    throw new MerchantProError('RETRY_PAUSED', 'The API requested a long or invalid retry delay. Inventory stopped; try again later.');
  }
  return Math.max(0, delay);
}

export class MerchantProClient {
  readonly origin: string;
  readonly #authorization: string;
  readonly #secret: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #timeoutMs: number;
  readonly #interval: number;
  readonly #maxProducts: number;
  readonly #includeImages: boolean;
  #nextRequestAt = 0;
  #requests = 0;
  #running = false;

  constructor(options: InventoryOptions, dependencies: ConnectorDependencies = {}) {
    this.origin = validateOrigin(options.origin);
    if (typeof options.username !== 'string' || typeof options.secret !== 'string' || !options.username || !options.secret ||
        options.username.includes(':') || /[\x00-\x1f\x7f]/.test(options.username + options.secret) ||
        options.username.length > 4096 || options.secret.length > 4096) {
      throw new MerchantProError('INVALID_CREDENTIALS', 'Provide a valid API username and secret through environment variables.');
    }
    if (!integer(options.maxProducts, 1) || options.maxProducts > 1_000 || typeof options.includeImages !== 'boolean') {
      throw new MerchantProError('INVALID_OPTIONS', 'maxProducts must be an integer from 1 to 1000; includeImages must be boolean.');
    }
    const interval = options.requestIntervalMs ?? 2_000;
    if (!integer(interval, 2_000) || interval > 60_000) {
      throw new MerchantProError('INVALID_OPTIONS', 'Request interval must be between 2000 and 60000 milliseconds.');
    }
    this.#timeoutMs = dependencies.timeoutMs ?? 15_000;
    if (!integer(this.#timeoutMs, 1) || this.#timeoutMs > 60_000) {
      throw new MerchantProError('INVALID_OPTIONS', 'Request timeout must be between 1 and 60000 milliseconds.');
    }
    this.#authorization = `Basic ${Buffer.from(`${options.username}:${options.secret}`, 'utf8').toString('base64')}`;
    this.#secret = options.secret;
    this.#fetch = dependencies.fetch ?? globalThis.fetch;
    this.#now = dependencies.now ?? Date.now;
    this.#sleep = dependencies.sleep ?? ((milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds)));
    this.#interval = interval;
    this.#maxProducts = options.maxProducts;
    this.#includeImages = options.includeImages;
  }

  #clean(value: string): string {
    return value.replaceAll(this.#authorization, '[redacted]').replaceAll(this.#authorization.slice(6), '[redacted]').replaceAll(this.#secret, '[redacted]');
  }

  async #json(response: Response): Promise<unknown> {
    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null && Number(declaredLength) > MAX_BYTES) {
      await response.body?.cancel();
      throw new MerchantProError('RESPONSE_TOO_LARGE', 'API response exceeds the 4 MiB inventory limit.');
    }
    if (!response.body) invalid();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_BYTES) {
          await reader.cancel();
          throw new MerchantProError('RESPONSE_TOO_LARGE', 'API response exceeds the 4 MiB inventory limit.');
        }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return invalid('API did not return valid JSON.'); }
  }

  async #get(path: string, query = new URLSearchParams()): Promise<unknown> {
    if (path !== PRODUCT_PATH && !/^\/api\/v2\/products\/[1-9]\d*\/images$/.test(path)) {
      throw new MerchantProError('INVALID_PATH', 'Only product inventory and image reads are supported.');
    }
    const url = new URL(path, this.origin);
    url.search = query.toString();
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const wait = this.#nextRequestAt - this.#now();
      if (wait > 0) await this.#sleep(wait);
      this.#nextRequestAt = this.#now() + this.#interval;
      this.#requests++;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
      try {
        const response = await this.#fetch(url, {
          method: 'GET', redirect: 'error', signal: controller.signal,
          headers: { Accept: 'application/json', Authorization: this.#authorization },
        });
        if (response.status >= 300 && response.status < 400 || response.redirected) {
          await response.body?.cancel();
          throw new MerchantProError('REDIRECT_BLOCKED', 'The store redirected the API request. Use its canonical HTTPS origin.');
        }
        if (response.status === 401 || response.status === 403) {
          await response.body?.cancel();
          throw new MerchantProError('AUTHENTICATION_FAILED', 'API authentication or permissions failed; no retry was made.', response.status);
        }
        if (response.status === 429 || response.status >= 500 && response.status <= 599) {
          await response.body?.cancel();
          if (attempt === MAX_RETRIES) throw new MerchantProError('RETRY_EXHAUSTED', 'The API remained unavailable after bounded retries.', response.status);
          const delay = retryDelay(response.headers.get('retry-after'), this.#now(), attempt);
          this.#nextRequestAt = Math.max(this.#nextRequestAt, this.#now() + delay);
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new MerchantProError('HTTP_ERROR', 'The API rejected the inventory request.', response.status);
        }
        return await this.#json(response);
      } catch (error) {
        if (error instanceof MerchantProError) throw error;
        if (controller.signal.aborted) throw new MerchantProError('TIMEOUT', 'The API request timed out; inventory stopped.');
        throw new MerchantProError('NETWORK_ERROR', 'The API request failed or redirected; check the canonical store origin and connection.');
      } finally { clearTimeout(timer); }
    }
    throw new MerchantProError('RETRY_EXHAUSTED', 'The API remained unavailable after bounded retries.');
  }

  #nextStart(next: unknown, expected: number): number | null {
    if (next === null) return null;
    if (typeof next !== 'string' || !next.startsWith(`${PRODUCT_PATH}?`) || next.includes('\\')) invalid('Invalid product pagination link.');
    const url = new URL(next, this.origin);
    if (url.origin !== this.origin || url.pathname !== PRODUCT_PATH || url.hash || url.username || url.password) invalid('Invalid product pagination link.');
    for (const key of url.searchParams.keys()) {
      if (!['start', 'limit', 'fields'].includes(key) || url.searchParams.getAll(key).length !== 1) invalid('Unexpected pagination parameters.');
    }
    const rawStart = url.searchParams.get('start');
    if (!rawStart || !/^\d+$/.test(rawStart)) invalid('Invalid product pagination offset.');
    const start = Number(rawStart);
    if (!integer(start, 1) || start !== expected) invalid('Non-contiguous product pagination; inventory stopped.');
    const rawLimit = url.searchParams.get('limit');
    if (rawLimit !== null && (!/^\d+$/.test(rawLimit) || !integer(Number(rawLimit), 1) || Number(rawLimit) > 100)) invalid('Invalid pagination limit.');
    const fields = url.searchParams.get('fields');
    if (fields !== null && fields !== FIELDS) invalid('Unexpected pagination fields.');
    return start;
  }

  #product(value: unknown): RecordValue {
    if (!record(value) || !integer(value.id, 1)) invalid('Product is missing a valid integer ID.');
    const result: RecordValue = { id: value.id };
    for (const field of STRING_FIELDS) {
      const item = value[field];
      if (item === undefined) continue;
      if (item !== null && (typeof item !== 'string' || item.length > 100_000)) invalid('Invalid product text field.');
      result[field] = typeof item === 'string' ? this.#clean(item) : item;
    }
    for (const field of ['category_id', 'manufacturer_id']) {
      const item = value[field];
      if (item === undefined) continue;
      if (item !== null && !integer(item)) invalid('Invalid product reference ID.');
      result[field] = item;
    }
    return result;
  }

  #images(value: unknown): RecordValue[] {
    if (!Array.isArray(value) || value.length > 1_000) invalid('Unexpected product image response.');
    return value.map(item => {
      if (!record(item) || !integer(item.id, 1)) invalid('Image is missing a valid integer ID.');
      const image: RecordValue = { id: item.id };
      for (const field of ['url', 'caption', 'name', 'hash', 'extension']) {
        if (item[field] === undefined) continue;
        if (item[field] !== null && (typeof item[field] !== 'string' || item[field].length > 100_000)) invalid('Invalid image text field.');
        image[field] = typeof item[field] === 'string' ? this.#clean(item[field]) : item[field];
      }
      if (item.dimensions !== undefined && item.dimensions !== null) {
        if (!record(item.dimensions)) invalid('Invalid image dimensions.');
        const sizes: RecordValue = {};
        for (const size of ['l', 'm', 't']) {
          const dimension = item.dimensions[size];
          if (dimension === undefined) continue;
          if (!record(dimension) || !integer(dimension.h) || !integer(dimension.w)) invalid('Invalid image dimensions.');
          sizes[size] = { h: dimension.h, w: dimension.w };
        }
        image.dimensions = sizes;
      }
      return image;
    });
  }

  async inventory(): Promise<InventoryResult> {
    if (this.#running) throw new MerchantProError('RUN_IN_PROGRESS', 'This client already has an inventory run in progress.');
    this.#running = true;
    const initialRequests = this.#requests;
    const products: RecordValue[] = [];
    const ids = new Set<number>();
    let start = 0;
    let complete = false;
    let totalAvailable = 0;
    try {
      while (products.length < this.#maxProducts) {
        const limit = Math.min(100, this.#maxProducts - products.length);
        const query = new URLSearchParams({ fields: FIELDS, start: String(start), limit: String(limit) });
        const page = await this.#get(PRODUCT_PATH, query);
        if (!record(page) || !Array.isArray(page.data) || !record(page.meta) || !record(page.meta.count) || !record(page.meta.links)) invalid();
        const count = page.meta.count;
        if (!integer(count.total) || count.start !== start || count.current !== page.data.length ||
            !integer(count.limit, 1) || count.limit > limit || page.data.length > count.limit || count.total < start + page.data.length) invalid('Inconsistent product pagination metadata.');
        totalAvailable = count.total;
        const next = this.#nextStart(page.meta.links.next, start + page.data.length);
        if (page.data.length === 0 && next !== null) invalid('Empty product page cannot have a next page.');
        if (next === null && start + page.data.length < count.total) invalid('Product pagination ended before its declared total.');
        for (const entry of page.data) {
          const product = this.#product(entry);
          const id = product.id as number;
          if (ids.has(id)) invalid('Repeated product ID; the catalog may have changed during pagination.');
          ids.add(id);
          if (this.#includeImages) product.images = this.#images(await this.#get(`${PRODUCT_PATH}/${id}/images`));
          products.push(product);
        }
        complete = next === null;
        if (complete) break;
        start = next!;
      }
      return {
        schemaVersion: 1, source: { kind: 'merchantpro-api', origin: this.origin },
        capturedAt: new Date(this.#now()).toISOString(),
        limits: { maxProducts: this.#maxProducts, includeImages: this.#includeImages },
        complete, totalAvailable, products, requests: this.#requests - initialRequests,
      };
    } finally { this.#running = false; }
  }
}

export async function inventory(options: InventoryOptions): Promise<InventoryResult> {
  return new MerchantProClient(options).inventory();
}
