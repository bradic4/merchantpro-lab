

export interface PsiOptions {
  url: string;
  strategy: 'mobile' | 'desktop';
  apiKey?: string;
  requestIntervalMs?: number;
}

export interface PsiDependencies {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

const PSI_API = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
const MAX_BYTES = 10 * 1024 * 1024; // 10MB just in case
const MAX_RETRIES = 2;
const MAX_RETRY_AFTER_MS = 60_000;

export class PsiError extends Error {
  constructor(public readonly code: string, message: string, public readonly status?: number) {
    super(message);
    this.name = 'PsiError';
  }
}

export function validatePsiUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new PsiError('INVALID_URL', 'Use a public HTTPS URL.'); }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || !hostname.includes('.') || /^\d+(\.\d+){3}$/.test(hostname) || hostname.includes(':') || hostname.endsWith('.') || /(^|\.)(localhost|local|localdomain|internal)$/.test(hostname)) {
    throw new PsiError('INVALID_URL', 'Use a public HTTPS URL without credentials, local hosts or IP literals.');
  }
  return url.toString();
}

function retryDelay(header: string | null, now: number, attempt: number): number {
  if (header === null) return 2_000 * 2 ** attempt;
  const trimmed = header.trim();
  const delay = /^\d+$/.test(trimmed) ? Number(trimmed) * 1_000 : Date.parse(trimmed) - now;
  if (!Number.isFinite(delay) || delay > MAX_RETRY_AFTER_MS || delay < -1_000) {
    throw new PsiError('RETRY_PAUSED', 'The API requested a long or invalid retry delay.');
  }
  return Math.max(0, delay);
}

export class PsiClient {
  readonly url: string;
  readonly #strategy: 'mobile' | 'desktop';
  readonly #apiKey?: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #timeoutMs: number;
  readonly #interval: number;
  #nextRequestAt = 0;

  constructor(options: PsiOptions, dependencies: PsiDependencies = {}) {
    this.url = validatePsiUrl(options.url);
    if (options.strategy !== 'mobile' && options.strategy !== 'desktop') throw new PsiError('INVALID_OPTIONS', 'strategy must be mobile or desktop');
    this.#strategy = options.strategy;
    this.#apiKey = options.apiKey;
    const interval = options.requestIntervalMs ?? 1_000;
    if (typeof interval !== 'number' || !Number.isSafeInteger(interval) || interval < 1000 || interval > 60_000) {
      throw new PsiError('INVALID_OPTIONS', 'Request interval must be between 1000 and 60000 milliseconds.');
    }
    this.#interval = interval;
    this.#timeoutMs = dependencies.timeoutMs ?? 60_000;
    this.#fetch = dependencies.fetch ?? globalThis.fetch;
    this.#now = dependencies.now ?? Date.now;
    this.#sleep = dependencies.sleep ?? ((ms) => new Promise(resolve => setTimeout(resolve, ms)));
  }

  #clean(message: string): string {
    if (!this.#apiKey) return message;
    return message.replaceAll(this.#apiKey, '[redacted]');
  }

  async #json(response: Response): Promise<unknown> {
    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null && Number(declaredLength) > MAX_BYTES) {
      await response.body?.cancel();
      throw new PsiError('RESPONSE_TOO_LARGE', 'API response exceeds the limit.');
    }
    if (!response.body) throw new PsiError('INVALID_RESPONSE', 'Empty response body.');
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
          throw new PsiError('RESPONSE_TOO_LARGE', 'API response exceeds the limit.');
        }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new PsiError('INVALID_RESPONSE', 'API did not return valid JSON.'); }
  }

  async fetchPsi(): Promise<unknown> {
    const target = new URL(PSI_API);
    target.searchParams.set('url', this.url);
    target.searchParams.set('strategy', this.#strategy);
    target.searchParams.set('category', 'performance');
    if (this.#apiKey) target.searchParams.set('key', this.#apiKey);

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const wait = this.#nextRequestAt - this.#now();
      if (wait > 0) await this.#sleep(wait);
      this.#nextRequestAt = this.#now() + this.#interval;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
      try {
        const response = await this.#fetch(target, {
          method: 'GET', redirect: 'error', signal: controller.signal,
          headers: { Accept: 'application/json' },
        });

        if (response.status === 400 || response.status === 403) {
          await response.body?.cancel();
          throw new PsiError('HTTP_ERROR', 'API rejected the request.', response.status);
        }

        if (response.status === 429 || response.status >= 500 && response.status <= 599) {
          await response.body?.cancel();
          if (attempt === MAX_RETRIES) throw new PsiError('RETRY_EXHAUSTED', 'The API remained unavailable after bounded retries.', response.status);
          const delay = retryDelay(response.headers.get('retry-after'), this.#now(), attempt);
          this.#nextRequestAt = Math.max(this.#nextRequestAt, this.#now() + delay);
          continue;
        }

        if (!response.ok) {
          await response.body?.cancel();
          throw new PsiError('HTTP_ERROR', 'The API rejected the request.', response.status);
        }

        return await this.#json(response);
      } catch (error) {
        if (error instanceof PsiError) throw error;
        if (controller.signal.aborted) throw new PsiError('TIMEOUT', 'The API request timed out.');
        throw new PsiError('NETWORK_ERROR', this.#clean(error instanceof Error ? error.message : 'Network error'));
      } finally { clearTimeout(timer); }
    }
    throw new PsiError('RETRY_EXHAUSTED', 'The API remained unavailable after bounded retries.');
  }
}

export async function fetchPsi(options: PsiOptions, dependencies?: PsiDependencies): Promise<unknown> {
  return new PsiClient(options, dependencies).fetchPsi();
}
