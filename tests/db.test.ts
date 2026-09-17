import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStorageAdapter } from '../src/db/memory-adapter.js';

test('MemoryStorageAdapter initializes default stores and users', async () => {
  const db = new MemoryStorageAdapter({ persist: false });
  await db.init();

  const stores = await db.listStores();
  assert.ok(stores.length >= 2);
  const vsd = await db.getStore('volimsvojdom');
  assert.ok(vsd);
  assert.equal(vsd.name, 'VolimSvojDom.rs');
  assert.equal(vsd.platform, 'merchantpro');
  assert.equal(vsd.canaryPercent, 1);
  assert.equal(vsd.killSwitch, false);

  const admin = await db.getUserByEmail('admin@merchantpro.lab');
  assert.ok(admin);
  assert.equal(admin.role, 'ADMIN');

  const client = await db.getUserByEmail('client@volimsvojdom.rs');
  assert.ok(client);
  assert.equal(client.role, 'CLIENT');
  assert.equal(client.storeId, 'volimsvojdom');
});

test('MemoryStorageAdapter updates remote store configuration', async () => {
  const db = new MemoryStorageAdapter({ persist: false });
  await db.init();

  const updated = await db.updateStoreConfig('volimsvojdom', {
    canaryPercent: 5,
    killSwitch: true,
    vendors: { meta: true, gtm: true, tiktok: false },
  });

  assert.equal(updated.canaryPercent, 5);
  assert.equal(updated.killSwitch, true);
  assert.equal(updated.vendors.tiktok, false);

  const fetched = await db.getStore('volimsvojdom');
  assert.equal(fetched?.canaryPercent, 5);
  assert.equal(fetched?.killSwitch, true);
});

test('MemoryStorageAdapter records telemetry and calculates accurate metrics', async () => {
  const db = new MemoryStorageAdapter({ persist: false });
  await db.init();

  await db.recordTelemetry({
    storeId: 'volimsvojdom',
    timestamp: Date.now(),
    cohort: 'domestic_canary',
    country: 'RS',
    clientIp: '109.92.1.1',
    url: 'https://www.volimsvojdom.rs/product-1',
    longTaskBlockingMs: 450,
    errorsCount: 0,
    eventsBuffered: 2,
    meta: 'loaded',
    gtm: 'loaded',
    tiktok: 'idle',
  });

  await db.recordTelemetry({
    storeId: 'volimsvojdom',
    timestamp: Date.now(),
    cohort: 'baseline',
    country: 'RS',
    clientIp: '109.92.1.2',
    url: 'https://www.volimsvojdom.rs/product-2',
    longTaskBlockingMs: 820,
    errorsCount: 0,
    eventsBuffered: 0,
    meta: 'loaded',
    gtm: 'loaded',
    tiktok: 'idle',
  });

  const metrics = await db.getStoreMetrics('volimsvojdom', 24);
  assert.equal(metrics.totalSessions, 2);
  assert.equal(metrics.optimizedSessions, 1);
  assert.equal(metrics.baselineSessions, 1);
  assert.equal(metrics.totalErrors, 0);
  assert.equal(metrics.reductionPercent, -38.9);
  assert.equal(metrics.vendorHealth.meta.status, 'healthy');
  assert.equal(metrics.vendorHealth.gtm.status, 'healthy');
  assert.equal(metrics.recentSessions.length, 2);
  assert.equal(metrics.countryBreakdown['RS'], 2);
});
