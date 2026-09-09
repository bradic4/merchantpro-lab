import { createHash } from 'node:crypto';
import type { LabMetrics, Measurement } from './domain.js';
import { analyzeResources } from './resource-analysis.js';

type JsonObject = Record<string, unknown>;
export interface MeasurementContext {
  id: string;
  storeId: string;
  pageId: string;
  requestedUrl: string;
  rawFile: string;
  rawSha256: string;
}
export interface FieldSnapshot {
  scope: 'url' | 'origin' | 'unknown';
  id: string | null;
  initialUrl: string | null;
  collectionPeriod: unknown | null;
  available: boolean;
  raw: JsonObject;
}
export interface FieldData {
  requestedUrl: string;
  requestedOrigin: string;
  url: FieldSnapshot | null;
  origin: FieldSnapshot | null;
}

const object = (value: unknown): JsonObject | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
const string = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null;
const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

function requiredString(value: unknown, name: string): string {
  const result = string(value);
  if (!result) throw new Error(`Neispravan Lighthouse rezultat: nedostaje ${name}.`);
  return result;
}

function normalizedUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('URL mora koristiti HTTP ili HTTPS.');
  url.hash = '';
  return url.href;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  const record = object(value);
  return record ? Object.fromEntries(Object.keys(record).sort().map(key => [key, canonical(record[key])])) : value;
}

function fieldSnapshot(value: unknown, source: 'url' | 'origin', urls: string[], period: unknown): FieldSnapshot | null {
  const raw = object(value);
  if (!raw) return null;
  const id = string(raw.id);
  let scope: FieldSnapshot['scope'] = source === 'origin' ? 'origin' : 'unknown';
  if (source === 'url') {
    if (raw.origin_fallback === true || raw.originFallback === true) scope = 'origin';
    else if (id) {
      try {
        if (urls.includes(normalizedUrl(id))) scope = 'url';
        else if (normalizedUrl(id) === `${new URL(urls[0]!).origin}/`) scope = 'origin';
      } catch { /* Preserve unfamiliar API identifiers without guessing their scope. */ }
    }
  }
  const metrics = object(raw.metrics);
  return {
    scope, id, initialUrl: string(raw.initial_url ?? raw.initialUrl),
    collectionPeriod: raw.collectionPeriod ?? raw.collection_period ?? period ?? null,
    available: metrics !== null && Object.values(metrics).some(metric => finite(object(metric)?.percentile) !== null),
    raw,
  };
}

/** Normalize an original Lighthouse/PSI response; never substitute zero for absent measurements. */
export function normalizeMeasurement(raw: unknown, context: MeasurementContext): Measurement {
  const envelope = object(raw);
  if (!envelope) throw new Error('Očekivan je Lighthouse ili PageSpeed Insights JSON objekat.');
  if (envelope.error) throw new Error(`PageSpeed greška: ${string(object(envelope.error)?.message) ?? 'neispravan odgovor'}`);
  const source = Object.hasOwn(envelope, 'lighthouseResult') ? 'psi-import' : 'lighthouse';
  const lhr = source === 'psi-import' ? object(envelope.lighthouseResult) : envelope;
  if (!lhr) throw new Error('Odgovor ne sadrži ispravan lighthouseResult.');
  if (lhr.runtimeError && object(lhr.runtimeError)?.code !== 'NO_ERROR') {
    throw new Error(`Lighthouse runtime greška: ${string(object(lhr.runtimeError)?.message) ?? string(object(lhr.runtimeError)?.code) ?? 'nepoznata greška'}`);
  }
  const audits = object(lhr.audits);
  const settings = object(lhr.configSettings);
  if (!audits || !settings) throw new Error('Neispravan Lighthouse rezultat: potrebni su audits i configSettings.');
  const device = settings.formFactor ?? settings.emulatedFormFactor;
  if (device !== 'mobile' && device !== 'desktop') throw new Error('Lighthouse profil uređaja nedostaje ili nije mobile/desktop.');
  const requestedUrl = normalizedUrl(requiredString(lhr.requestedUrl, 'requestedUrl'));
  if (requestedUrl !== normalizedUrl(context.requestedUrl)) {
    throw new Error(`URL rezultata (${requestedUrl}) ne odgovara izabranoj stranici (${context.requestedUrl}).`);
  }
  const finalUrl = normalizedUrl(requiredString(lhr.finalUrl ?? lhr.finalDisplayedUrl, 'finalUrl'));
  const fetchedAt = requiredString(lhr.fetchTime, 'fetchTime');
  if (!Number.isFinite(Date.parse(fetchedAt))) throw new Error('Neispravan datum fetchTime u Lighthouse rezultatu.');
  const warnings = Array.isArray(lhr.runWarnings) ? lhr.runWarnings.filter((value): value is string => typeof value === 'string') : [];
  const metric = (id: string): number | null => {
    const audit = object(audits[id]);
    if (audit?.scoreDisplayMode === 'error' || audit?.errorMessage) {
      warnings.push(`Audit ${id} nije uspeo; metrika nije dostupna.`);
      return null;
    }
    return finite(audit?.numericValue);
  };
  const score = finite(object(object(lhr.categories)?.performance)?.score);
  const summary = object(audits['resource-summary']);
  const resources = !summary?.errorMessage && summary?.scoreDisplayMode !== 'error' ? object(summary?.details)?.items : null;
  const transfer = (type: string): number | null => Array.isArray(resources)
    ? finite(object(resources.find(item => object(item)?.resourceType === type))?.transferSize) : null;
  const metrics: LabMetrics = {
    performance: score !== null && score <= 1 ? score * 100 : null,
    lcpMs: metric('largest-contentful-paint'), cls: metric('cumulative-layout-shift'),
    tbtMs: metric('total-blocking-time'), fcpMs: metric('first-contentful-paint'),
    ttfbMs: metric('server-response-time'), imageTransferBytes: transfer('image'), totalTransferBytes: transfer('total'),
  };
  if ([metrics.performance, metrics.lcpMs, metrics.cls, metrics.tbtMs, metrics.fcpMs].every(value => value === null)) {
    throw new Error('Rezultat ne sadrži nijednu validnu osnovnu laboratorijsku metriku (Performance, LCP, CLS, TBT ili FCP).');
  }
  const environment = object(lhr.environment);
  const userAgent = string(environment?.hostUserAgent) ?? string(lhr.userAgent) ?? '';
  const browserVersion = userAgent.match(/(?:HeadlessChrome|Chrome|Chromium)\/([\d.]+)/)?.[1] ?? 'unknown';
  if (browserVersion === 'unknown') warnings.push('Verzija browsera nije dostupna; ovo izvršavanje se ne agregira sa drugim izvršavanjima.');
  if (requestedUrl !== finalUrl) warnings.push(`Preusmerenje: ${requestedUrl} → ${finalUrl}. Proveriti da li je sadržaj uporediv.`);
  const missing = Object.entries(metrics).filter(([, value]) => value === null).map(([key]) => key);
  if (missing.length) warnings.push(`Nedostaju validne metrike: ${missing.join(', ')}.`);
  const fieldData: FieldData | null = source === 'psi-import' ? {
    requestedUrl, requestedOrigin: new URL(requestedUrl).origin,
    url: fieldSnapshot(envelope.loadingExperience, 'url', [requestedUrl, finalUrl], envelope.collectionPeriod),
    origin: fieldSnapshot(envelope.originLoadingExperience, 'origin', [requestedUrl, finalUrl], envelope.collectionPeriod),
  } : null;
  return {
    schemaVersion: 1, ...context, requestedUrl, finalUrl, fetchedAt, source,
    lighthouseVersion: requiredString(lhr.lighthouseVersion, 'lighthouseVersion'), browserVersion, device,
    settingsHash: createHash('sha256').update(JSON.stringify(canonical(settings))).digest('hex'),
    metrics, warnings, fieldData, resources: analyzeResources(lhr),
  };
}
