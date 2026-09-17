import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { normalizeTelemetry, fingerprintRecord } from '../lib/telemetry-normalize.js';
import { createTelemetryRepository } from '../lib/telemetry-repository.js';
import { shadowWrite, readTelemetryMetrics } from '../lib/telemetry.js';
import { createTelemetryHandler } from '../api/telemetry.js';
import { compareOriginalPayloads } from '../lib/telemetry-verification.js';
import retentionHandler from '../api/telemetry-retention.js';

const migration = await readFile(new URL('../migrations/001_telemetry.sql', import.meta.url), 'utf8');
const now = new Date('2026-09-17T12:00:00Z');
const hour = 3600000;
const beacon = { type: 'session_summary', url: 'https://www.volimsvojdom.rs/product/one?private=omit#fragment',
  country: 'US', cohort: 'foreign_canary', timestamp: now.getTime() - 5000,
  meta: 'loaded', gtm: 'deferred', tiktok: 'idle', errorsCount: 0, eventsBuffered: 0, longTaskBlockingMs: 0 };

test('v1 normalization attributes tenants without inventing telemetry fields', async () => {
  const row = await normalizeTelemetry(beacon, { edgeCountry: 'RS', receivedAt: now.getTime() });
  assert.equal(row.store_id, 'volimsvojdom'); assert.equal(row.attribution, 'host');
  assert.equal(row.edge_country, 'RS'); assert.equal(row.reported_country, 'US');
  assert.equal(row.page_path, '/product/one'); assert.equal(row.long_task_blocking_ms, 0);
  assert.equal(Object.hasOwn(row, 'session_id'), false); assert.equal(Object.hasOwn(row, 'mode'), false);
  assert.equal(JSON.stringify(row).includes('private=omit'), false);
  assert.equal(row.fingerprint, await fingerprintRecord(row));
  for (const input of [ { ...beacon, storeId: 'baldino' }, { ...beacon, url: 'https://www.volimsvojdom.rs.evil.example/' }, { ...beacon, url: 'https://constructor/' } ]) {
    assert.equal((await normalizeTelemetry(input)).store_id, null);
  }
  const missing = await normalizeTelemetry({ type: 'error', url: beacon.url, vendor: 'gtm', error: 'private email' });
  assert.equal(missing.errors_count, null); assert.equal(missing.long_task_blocking_ms, null);
  assert.equal(missing.client_timestamp_ms, null); assert.equal(missing.error_vendor, 'gtm');
  assert.equal(JSON.stringify(missing).includes('private email'), false);
  const invalid = await normalizeTelemetry({ ...beacon, errorsCount: '0', longTaskBlockingMs: -1, timestamp: 1e100 });
  assert.equal(invalid.errors_count, null); assert.equal(invalid.long_task_blocking_ms, null); assert.equal(invalid.client_timestamp_ms, null);
});

test('log verification compares payload values and multiplicity, not only write markers', async () => {
  const row = await normalizeTelemetry(beacon);
  assert.deepEqual(await compareOriginalPayloads([beacon], [row]), { unmatchedOriginals: 0, unexpectedRecords: 0 });
  assert.deepEqual(await compareOriginalPayloads([beacon, beacon], [row]), { unmatchedOriginals: 1, unexpectedRecords: 0 });
  assert.deepEqual(await compareOriginalPayloads([beacon], [{ ...row, long_task_blocking_ms: 123 }]), { unmatchedOriginals: 1, unexpectedRecords: 1 });
});

test('retention endpoint requires the cron credential and rejects other methods', async () => {
  const old = process.env.CRON_SECRET;
  try {
    delete process.env.CRON_SECRET;
    assert.equal((await retentionHandler(new Request('https://example.test/api/telemetry-retention'))).status, 401);
    process.env.CRON_SECRET = 'test-only-retention-secret';
    assert.equal((await retentionHandler(new Request('https://example.test/api/telemetry-retention', { headers: { authorization: 'Bearer wrong' } }))).status, 401);
    assert.equal((await retentionHandler(new Request('https://example.test/api/telemetry-retention', { method: 'POST' }))).status, 405);
  } finally {
    if (old === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = old;
  }
});

test('Postgres receipts survive restart; SQL periods, history, privacy and retention use stored reports', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'merchantpro-telemetry-test-'));
  let db = new PGlite(folder);
  t.after(async () => { await db.close(); if (dirname(folder) === tmpdir()) await rm(folder, { recursive: true, force: true }); });
  await db.exec(migration); await db.exec(migration); // additive/replay safe
  const query = async (text: string, params: any[] = []) => (await db.query(text, params)).rows;
  const repo = createTelemetryRepository(query);
  const one = await normalizeTelemetry(beacon, { edgeCountry: 'RS', receivedAt: now.getTime() - hour });
  await repo.insert(one); await repo.insert(one); // same receipt only
  await db.close(); db = new PGlite(folder);
  assert.equal((await repo.metrics('volimsvojdom', 24, now)).summaryReports, 1);
  // More records than the recent-table limit; reports are not fabricated sessions.
  for (let i = 1; i < 61; i++) {
    await repo.insert(await normalizeTelemetry({ ...beacon, longTaskBlockingMs: i * 10 }, { edgeCountry: 'RS', receivedAt: now.getTime() - hour - i }));
  }
  await repo.insert(await normalizeTelemetry({ type: 'error', vendor: 'meta', error: 'failure', url: beacon.url }, { receivedAt: now.getTime() - 1000 }));
  await repo.insert(await normalizeTelemetry({ ...beacon, url: 'https://baldino.rs/private', longTaskBlockingMs: 999999 }, { receivedAt: now.getTime() - hour }));
  await repo.insert(await normalizeTelemetry({ ...beacon, longTaskBlockingMs: 900 }, { receivedAt: now.getTime() - 48 * hour }));
  await repo.insert(await normalizeTelemetry({ ...beacon, longTaskBlockingMs: 1000 }, { receivedAt: now.getTime() - 10 * 24 * hour }));
  await repo.insert(await normalizeTelemetry(beacon, { receivedAt: now.getTime() })); // half-open boundary
  const m = await repo.metrics('volimsvojdom', 24, now);
  assert.equal(m.recordCount, 62); assert.equal(m.summaryReports, 61); assert.equal(m.errorReports, 1);
  assert.equal(m.summaryReportedErrors, 0); // don't add error beacons to summary counters
  assert.equal(m.totalSessions, null); assert.equal(m.storeStatus, null); assert.equal(m.runtimeVersion, null);
  assert.equal(m.recentSessions.length, 50); assert.equal(m.performanceSampleCount, 61);
  assert.equal(m.performanceMedian, 300); assert.equal(m.performanceP75, 450);
  assert.equal(m.performanceHistory.reduce((n: number, b: any) => n + b.sampleSize, 0), 61);
  assert.deepEqual(m.countryBreakdown, { RS: 61 });
  assert.equal(m.classificationBreakdown, null); assert.equal(m.vendors.meta.latestState, 'loaded');
  assert.equal(m.vendors.gtm.latestState, 'deferred'); assert.equal(m.vendors.meta.states.loaded, 61);
  assert.equal(JSON.stringify(m).includes('999999'), false);
  assert.equal((await repo.metrics('volimsvojdom', 168, now)).summaryReports, 62);
  assert.equal((await repo.metrics('volimsvojdom', 720, now)).summaryReports, 63);
  assert.equal((await repo.metrics("volimsvojdom' OR true --", 24, now)).recordCount, 0);
  assert.equal((await repo.metrics('missing', 24, now)).lastTelemetryAt, null);
  const malformed = await normalizeTelemetry({ type: 'session_summary', url: beacon.url }, { receivedAt: now.getTime() - 1 });
  await repo.insert(malformed);
  const partial = await repo.metrics('volimsvojdom', 24, now);
  assert.equal(partial.summaryReportedErrors, null); assert.equal(partial.performanceSampleCount, 61);
  // Last receipt is independent of the selected period and missing fields do not become zero.
  const oldOnly = await normalizeTelemetry({ ...beacon, url: 'https://baldino.rs/old' }, { receivedAt: now.getTime() - 36 * 24 * hour });
  await repo.insert(oldOnly);
  assert.equal(await repo.retain(now, 5000), 1);
  assert.equal((await query('SELECT count(*)::int AS n FROM telemetry_events WHERE receipt_id = $1', [oldOnly.receipt_id]))[0].n, 0);
  assert.equal((await query('SELECT count(*)::int AS n FROM telemetry_events WHERE receipt_id = $1', [one.receipt_id]))[0].n, 1);
});

test('shadow writes and read gates never turn failure/disabled persistence into synthetic metrics', async () => {
  let calls = 0; const entries: any[] = [];
  const query = async () => { calls++; throw new Error('secret postgres://must-not-appear'); };
  await shadowWrite(beacon, {}, { env: {}, query, log: (x: any) => entries.push(x) });
  assert.equal(calls, 0);
  const failed = await shadowWrite(beacon, {}, { env: { TELEMETRY_PERSIST_ENABLED: 'true' }, query, log: (x: any) => entries.push(x) });
  assert.equal(failed.outcome, 'failed'); assert.equal(calls, 1);
  assert.equal(JSON.stringify(entries).includes('secret'), false);
  const disabled = await readTelemetryMetrics('volimsvojdom', 24, { env: {}, query });
  assert.equal(disabled.source.available, false); assert.equal(disabled.totalSessions, null); assert.equal(calls, 1);
  const unavailable = await readTelemetryMetrics('volimsvojdom', 24, { env: { TELEMETRY_READ_ENABLED: 'true' }, query });
  assert.equal(unavailable.source.reason, 'database_unavailable'); assert.equal(unavailable.totalErrors, null);
});

test('Edge endpoint preserves the v1 production contract even on database failure', async () => {
  const handler = createTelemetryHandler(async () => { throw new Error('database outage'); });
  const url = 'https://example.test/api/telemetry';
  const summary = await handler(new Request(url, { method: 'POST', body: JSON.stringify(beacon), headers: { 'Content-Type': 'text/plain' } }));
  assert.equal(summary.status, 200); assert.deepEqual(await summary.json(), { ok: true });
  assert.equal(summary.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal((await handler(new Request(url, { method: 'OPTIONS' }))).status, 204);
  assert.equal((await handler(new Request(url))).status, 405);
  assert.equal((await handler(new Request(url, { method: 'POST', body: '{broken' }))).status, 400);
  assert.equal((await handler(new Request(url, { method: 'POST', body: '[]' }))).status, 200);
});
