import { join } from 'node:path';
import { emptyManifest } from './manifest.js';
import { newRun, saveRun, sha256, writeJson, ensureNewDirectory, withLock } from './storage.js';
import { normalizeMeasurement } from './measurements.js';
import type { RunState } from './domain.js';

export function syntheticLhr(url: string, n: number, offset = 0): unknown {
  const audit = (numericValue: number) => ({ numericValue });
  return {
    lighthouseVersion: '13.4.1', requestedUrl: url, finalDisplayedUrl: url,
    fetchTime: new Date(Date.UTC(2026, 0, 1, 12, offset, n)).toISOString(),
    userAgent: 'Synthetic Chrome/130.0.0.0', environment: { hostUserAgent: 'Synthetic Chrome/130.0.0.0' },
    configSettings: { formFactor: 'mobile', throttlingMethod: 'simulate', disableStorageReset: false,
      screenEmulation: { mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75 },
      throttling: { rttMs: 150, throughputKbps: 1638.4, cpuSlowdownMultiplier: 4 } },
    categories: { performance: { score: 0.5 + n * 0.01 } },
    audits: {
      'largest-contentful-paint': audit(3200 + n * 200 + offset * 100),
      'cumulative-layout-shift': audit(0.08 + n * 0.01), 'total-blocking-time': audit(240 + n * 20),
      'first-contentful-paint': audit(1800 + n * 100), 'server-response-time': audit(430 + n * 10),
      'resource-summary': { details: { items: [{ resourceType: 'image', transferSize: 950000 + n * 10000 }, { resourceType: 'total', transferSize: 1500000 + n * 10000 }] } }
    }, runWarnings: ['SINTETIČKI DEMO: ovo nije merenje prodavnice.']
  };
}
export async function createDemo(directory: string): Promise<RunState> {
  return withLock(directory, async () => {
    await ensureNewDirectory(directory);
    const manifest = emptyManifest(); manifest.name = 'SINTETIČKI DEMO — bez stvarnih prodavnica';
    manifest.protocol.location = 'synthetic'; manifest.protocol.notes = 'Izmišljene vrednosti služe isključivo za demonstraciju alata.';
    manifest.stores = [{ id: 'demo', name: 'Demo prodavnica (izmišljena)', origin: 'https://demo.invalid', platform: 'merchantpro', role: 'sample', market: 'unknown', theme: 'unknown', notes: 'SINTETIČKI DEMO',
      pages: [{ id: 'home', type: 'home', url: 'https://demo.invalid/' }, { id: 'category', type: 'category', url: 'https://demo.invalid/category' }, { id: 'product', type: 'product', url: 'https://demo.invalid/product' }] }];
    const state = newRun(manifest, 'demo');
    for (const item of state.items) {
      const index = manifest.stores[0].pages.findIndex(p => p.id === item.pageId);
      const page = manifest.stores[0].pages[index];
      const raw = syntheticLhr(page.url, item.repetition, index);
      const text = JSON.stringify(raw, null, 2) + '\n'; const rawFile = `raw/${item.id}.json`;
      await writeJson(join(directory, rawFile), raw);
      item.measurement = normalizeMeasurement(raw, { ...item, requestedUrl: page.url, rawFile, rawSha256: sha256(text) });
      item.status = 'succeeded';
    }
    state.status = 'completed'; await saveRun(directory, state);
    return state;
  });
}
