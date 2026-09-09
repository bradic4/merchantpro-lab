import type { RunState, Measurement, LabMetrics } from './domain.js';

export function benchmarkRows(state: RunState, runDirectory: string) {
  if (!state?.manifest?.stores || !['live', 'import'].includes(state.kind)) return [];
  const rows = [];
  for (const store of state.manifest.stores) {
    for (const page of store.pages) {
      const groups = new Map<string, Measurement[]>();
      for (const item of state.items) {
        const m = item.measurement;
        if (item.storeId !== store.id || item.pageId !== page.id || item.status !== 'succeeded' || !m) continue;
        const key = JSON.stringify([m.device, m.settingsHash, m.lighthouseVersion, m.browserVersion, m.source, m.finalUrl]);
        groups.set(key, [...(groups.get(key) ?? []), m]);
      }
      for (const measurements of groups.values()) {
        const m = measurements[0]!;
        const median = (key: keyof LabMetrics) => {
          const values = measurements.map(m => m.metrics[key]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v)).sort((a,b) => a-b);
          const mid = Math.floor(values.length / 2);
          return values.length ? values.length % 2 ? values[mid]! : (values[mid-1]! + values[mid]!) / 2 : null;
        };
        const formatted = (key: keyof LabMetrics, divisor: number, digits: number, suffix: string) => {
          const value = median(key);
          return value === null ? '—' : `${(value / divisor).toFixed(digits)}${suffix}`;
        };
        rows.push({runId: state.id, runDirectory, updatedAt: state.updatedAt,
          storeId: store.id, name: store.name, platform: store.platform, role: store.role,
          pageId: page.id, pageType: page.type, url: page.url, device: m.device,
          profileLabel: `${m.source} / LH ${m.lighthouseVersion} / ${m.settingsHash}`,
          score: median('performance') === null ? null : Math.round(median('performance')!),
          lcp: formatted('lcpMs',1000,1,' s'), tbt: formatted('tbtMs',1000,1,' s'),
          ttfb: formatted('ttfbMs',1,0,' ms'), images: formatted('imageTransferBytes',1024,0,' kB'),
          total: formatted('totalTransferBytes',1048576,1,' MB'),
          measurementsCount: `${measurements.length}/${state.manifest.protocol.runs}`});
      }
    }
  }
  return rows;
}
