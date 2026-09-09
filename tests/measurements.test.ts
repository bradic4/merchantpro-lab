import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeMeasurement } from '../src/measurements.js';
import { groupMeasurements, renderReport, summarize } from '../src/report.js';
import type { RunState } from '../src/domain.js';

const context = { id: 'run-1', storeId: 'store', pageId: 'home', requestedUrl: 'https://store.example/', rawFile: 'raw/run-1.json', rawSha256: 'a'.repeat(64) };
const fixture = () => ({
  requestedUrl: context.requestedUrl, finalUrl: context.requestedUrl, fetchTime: '2026-09-08T12:00:00.000Z', lighthouseVersion: '13.0.0',
  userAgent: 'Chrome/140.0.0.0', environment: { hostUserAgent: 'HeadlessChrome/141.0.1.2' },
  configSettings: { formFactor: 'mobile', throttlingMethod: 'simulate', throttling: { cpuSlowdownMultiplier: 4 } },
  categories: { performance: { score: 0.53 } },
  audits: {
    'largest-contentful-paint': { numericValue: 4200 }, 'cumulative-layout-shift': { numericValue: 0 },
    'total-blocking-time': { numericValue: 300 }, 'first-contentful-paint': { numericValue: 1800 },
    'server-response-time': { numericValue: 510 },
    'resource-summary': { details: { items: [{ resourceType: 'image', transferSize: 450000 }, { resourceType: 'total', transferSize: 900000 }] } },
  },
});

test('normalizes real units and preserves zero while omitting absent or invalid metrics', () => {
  const raw: any = fixture();
  raw.audits['largest-contentful-paint'].numericValue = Number.NaN;
  delete raw.audits['total-blocking-time'];
  raw.audits['first-contentful-paint'].numericValue = '1200';
  raw.audits['resource-summary'].details.items[0].transferSize = -1;
  const result = normalizeMeasurement(raw, context);
  assert.deepEqual(result.metrics, { performance: 53, lcpMs: null, cls: 0, tbtMs: null, fcpMs: null, ttfbMs: 510, imageTransferBytes: null, totalTransferBytes: 900000 });
  assert.equal(result.browserVersion, '141.0.1.2');
  assert.equal(result.fieldData, null);
  assert.equal('inp' in result.metrics, false);
});

test('rejects malformed, runtime-failed, unknown-device and wrong-URL reports', () => {
  for (const raw of [null, [], {}, { lighthouseResult: null }, { error: { message: 'quota exceeded' } }, { ...fixture(), runtimeError: { code: 'NO_FCP' } }, { ...fixture(), configSettings: { formFactor: 'none' } }]) {
    assert.throws(() => normalizeMeasurement(raw, context));
  }
  assert.throws(() => normalizeMeasurement({ ...fixture(), requestedUrl: 'https://other.example/' }, context), /ne odgovara/);
  assert.throws(() => normalizeMeasurement({ ...fixture(), requestedUrl: 'https://store.example/?different=true' }, context), /ne odgovara/);
  assert.equal(normalizeMeasurement({ ...fixture(), requestedUrl: 'https://store.example/#section' }, context).requestedUrl, context.requestedUrl);
});

test('stable settings hashes do not depend on object key order and preserve profile differences', () => {
  const a = normalizeMeasurement(fixture(), context);
  const b = normalizeMeasurement({ ...fixture(), configSettings: { throttling: { cpuSlowdownMultiplier: 4 }, throttlingMethod: 'simulate', formFactor: 'mobile' } }, context);
  const c = normalizeMeasurement({ ...fixture(), configSettings: { ...fixture().configSettings, throttlingMethod: 'devtools' } }, context);
  assert.equal(a.settingsHash, b.settingsHash);
  assert.notEqual(a.settingsHash, c.settingsHash);
});

test('rejects metadata-only results but allows partial core metrics including zero', () => {
  const metadataOnly = { ...fixture(), categories: {}, audits: {} };
  assert.throws(() => normalizeMeasurement(metadataOnly, context), /nijednu validnu osnovnu/);
  assert.throws(() => normalizeMeasurement({ ...metadataOnly, audits: { 'server-response-time': { numericValue: 250 } } }, context), /nijednu validnu osnovnu/);
  assert.throws(() => normalizeMeasurement({ lighthouseResult: metadataOnly, loadingExperience: { metrics: { LARGEST_CONTENTFUL_PAINT_MS: { percentile: 1500 } } } }, context), /nijednu validnu osnovnu/);
  const partial = normalizeMeasurement({ ...metadataOnly, audits: { 'cumulative-layout-shift': { numericValue: 0 } } }, context);
  assert.equal(partial.metrics.cls, 0);
  assert.equal(partial.metrics.performance, null);
  assert.equal(partial.metrics.lcpMs, null);
});

test('PSI field values retain URL/origin scope and provided windows separately', () => {
  const period = { firstDate: { year: 2026, month: 8, day: 1 }, lastDate: { year: 2026, month: 8, day: 28 } };
  const result = normalizeMeasurement({ lighthouseResult: fixture(), loadingExperience: { id: context.requestedUrl, metrics: { INTERACTION_TO_NEXT_PAINT: { percentile: 250 } }, collectionPeriod: period }, originLoadingExperience: { id: 'https://store.example', metrics: {} } }, context);
  const field = result.fieldData as any;
  assert.equal(result.source, 'psi-import');
  assert.equal(field.url.scope, 'url');
  assert.equal(field.url.available, true);
  assert.deepEqual(field.url.collectionPeriod, period);
  assert.equal(field.origin.scope, 'origin');
  assert.equal(field.origin.available, false);
  assert.equal(field.origin.collectionPeriod, null);
  assert.equal(field.url.raw.metrics.INTERACTION_TO_NEXT_PAINT.percentile, 250);
});

test('median uses only valid values and handles odd/even/empty sets', () => {
  assert.deepEqual(summarize([null, 5, 1, 3]), { median: 3, min: 1, max: 5, count: 3 });
  assert.deepEqual(summarize([1, 5, null, 3, 7]), { median: 4, min: 1, max: 7, count: 4 });
  assert.deepEqual(summarize([null, Number.NaN, Number.POSITIVE_INFINITY]), { median: null, min: null, max: null, count: 0 });
});

test('aggregation never combines distinct measurement profiles or redirected content', () => {
  const measurement = normalizeMeasurement(fixture(), context);
  const same = { ...measurement, id: 'same' };
  const variants = [
    { ...measurement, id: 'desktop', device: 'desktop' as const },
    { ...measurement, id: 'psi', source: 'psi-import' as const },
    { ...measurement, id: 'settings', settingsHash: 'different' },
    { ...measurement, id: 'lighthouse', lighthouseVersion: '14.0.0' },
    { ...measurement, id: 'browser', browserVersion: '142.0.0.0' },
    { ...measurement, id: 'redirect', finalUrl: 'https://store.example/new' },
    { ...measurement, id: 'unknown-1', browserVersion: 'unknown' },
    { ...measurement, id: 'unknown-2', browserVersion: 'unknown' },
  ];
  const groups = groupMeasurements([measurement, same, ...variants]);
  assert.equal(groups.length, 9);
  assert.equal(groups[0]?.length, 2);
});

test('report exposes partial/demo status, coverage, valid counts, raw provenance and unconfirmed G1', () => {
  const measurement = normalizeMeasurement(fixture(), context);
  measurement.metrics.tbtMs = null;
  const state: RunState = {
    schemaVersion: 1, id: 'example', manifestHash: 'b'.repeat(64), createdAt: '2026-09-08T12:00:00Z', updatedAt: '2026-09-08T12:00:00Z', status: 'partial', kind: 'demo',
    manifest: { schemaVersion: 1, name: 'Primer', protocol: { device: 'mobile', runs: 3, location: 'Belgrade', consent: 'no-interaction', browserCache: 'cold', cdnCache: 'unknown', notes: '' }, stores: [{ id: 'store', name: 'Primer', origin: context.requestedUrl, platform: 'merchantpro', role: 'sample', market: 'RS', theme: 'unknown', notes: '', pages: [{ id: 'home', type: 'home', url: context.requestedUrl }] }] },
    items: [{ id: 'run-1', storeId: 'store', pageId: 'home', repetition: 1, status: 'succeeded', measurement }, { id: 'run-2', storeId: 'store', pageId: 'home', repetition: 2, status: 'failed', error: 'Timeout' }, { id: 'run-3', storeId: 'store', pageId: 'home', repetition: 3, status: 'pending' }],
  };
  const report = renderReport(state);
  assert.match(report, /DEMO — SINTETIČKI PODACI/);
  assert.match(report, /Uzorak je nepotpun/);
  assert.match(report, /\| TBT \(ms\) \| — \| — \| — \| 0\/1 \|/);
  assert.match(report, /Nema podataka stvarnih korisnika/);
  assert.match(report, /G1 ostaje nepotvrđen/);
  assert.match(report, /raw\/run-1.json/);
  assert.match(report, /Timeout/);
  assert.match(report, /Uporedni pregled/);
  assert.match(report, /4200 \[4200–4200\], n=1/);
  assert.match(report, /450.0, n=1/);
  assert.match(report, /Uporedna tabela prodavnica/);
  assert.match(report, /Pokrivenost po platformi/);
  state.kind = 'import';
  state.manifest.name = '[danger](javascript:alert(1)) <script>';
  state.items[0]!.measurement!.rawFile = 'javascript:alert(1)';
  state.items[0]!.measurement!.id = '[danger](https://other.example)';
  const imported = renderReport(state);
  assert.match(imported, /predstavljaju izjavu operatora/);
  assert.match(imported, /Lokacija izvršavanja i stanje keša PSI testa su nepoznati/);
  assert.match(imported, /ne potvrđuje iste stvarne uslove/);
  assert.match(imported, /same metrike ne potvrđuju uzrok/);
  assert.match(imported, /neispravna putanja sirovog rezultata/);
  assert.doesNotMatch(imported, /\[danger\]\(javascript:/);
  assert.doesNotMatch(imported, /\]\(<javascript:/);
  assert.doesNotMatch(imported, /<script>/);
});

test('comparative table groups measurements by store and platform', () => {
  const m1 = normalizeMeasurement(fixture(), { ...context, storeId: 'store-a', pageId: 'home', rawFile: 'raw/1.json' });
  const m2 = normalizeMeasurement(fixture(), { ...context, storeId: 'store-b', pageId: 'home', rawFile: 'raw/2.json' });
  const state: RunState = {
    schemaVersion: 1, id: 'multi-store', manifestHash: 'c'.repeat(64), createdAt: '2026-09-08T12:00:00Z', updatedAt: '2026-09-08T12:00:00Z', status: 'completed', kind: 'live',
    manifest: {
      schemaVersion: 1, name: 'Multi', protocol: { device: 'mobile', runs: 3, location: 'Belgrade', consent: 'no-interaction', browserCache: 'cold', cdnCache: 'unknown', notes: '' },
      stores: [
        { id: 'store-a', name: 'Shop A', origin: 'https://a.example', platform: 'merchantpro', role: 'sample', market: 'RS', theme: 'default', notes: '', pages: [{ id: 'home', type: 'home', url: 'https://a.example' }] },
        { id: 'store-b', name: 'Control B', origin: 'https://b.example', platform: 'shopify', role: 'control', market: 'RS', theme: 'default', notes: '', pages: [{ id: 'home', type: 'home', url: 'https://b.example' }] },
      ]
    },
    items: [
      { id: 'run-1', storeId: 'store-a', pageId: 'home', repetition: 1, status: 'succeeded', measurement: m1 },
      { id: 'run-2', storeId: 'store-b', pageId: 'home', repetition: 1, status: 'succeeded', measurement: m2 },
    ]
  };
  const report = renderReport(state);
  assert.match(report, /\| Shop A \| merchantpro \| sample \|/);
  assert.match(report, /\| Control B \| shopify \| control \|/);
  assert.match(report, /\| merchantpro \(sample\) \| 1 \|/);
  assert.match(report, /\| shopify \(control\) \| 1 \|/);
  const otherPage = structuredClone(m1);
  otherPage.pageId = 'product'; otherPage.metrics.lcpMs = 10000;
  state.items.push({ id: 'run-3', storeId: 'store-a', pageId: 'product', repetition: 1, status: 'succeeded', measurement: otherPage });
  const differentProfile = structuredClone(m1);
  differentProfile.settingsHash = 'different'; differentProfile.metrics.lcpMs = 20000;
  state.items.push({ id: 'run-4', storeId: 'store-a', pageId: 'home', repetition: 2, status: 'succeeded', measurement: differentProfile });
  const separated = renderReport(state).split('### Pokrivenost po platformi')[0]!;
  assert.equal(separated.split('\n').filter(line => line.startsWith('| Shop A | merchantpro')).length, 4);
  assert.match(separated, /\| product \/ 3 \| mobile \| 53 \| 10000 \|/);
  assert.match(separated, /\| home \/ 4 \| mobile \| 53 \| 20000 \|/);
  assert.doesNotMatch(separated, /Prosek po platformi/);
});
