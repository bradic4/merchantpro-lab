import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { Measurement, Protocol } from './domain.js';
import { publicUrl, safeId } from './manifest.js';
import { normalizeMeasurement } from './measurements.js';
import { captureLighthouse } from './runner.js';
import { atomicWrite, ensureNewDirectory, readJson, sha256, withLock, writeJson } from './storage.js';
import { summarize } from './report.js';

export interface ExperimentConfig {
  schemaVersion: 1; id: string; storeId: string; pageId: string; url: string;
  protocol: Protocol; targetPrefix: string; hypothesis: string; captureTimeoutMs?: number;
}
export interface ExperimentItem {
  id: string; pair: number; variant: 'baseline' | 'blocked'; status: 'pending' | 'running' | 'succeeded' | 'failed';
  measurement?: Measurement; evidence?: { attempted: number; loaded: number; blocked: number; executed: number };
  comparisonHash?: string; benchmarkIndex?: number | null; error?: string;
}
export interface ExperimentState {
  schemaVersion: 1; kind: 'resource-block-experiment'; config: ExperimentConfig; configHash: string;
  createdAt: string; updatedAt: string; items: ExperimentItem[];
}
export function validateExperiment(input: unknown): ExperimentConfig {
  const c = input as ExperimentConfig;
  if (!c || c.schemaVersion !== 1) throw new Error('Experiment schemaVersion mora biti 1.');
  safeId(c.id); safeId(c.storeId); safeId(c.pageId);
  const url = publicUrl(c.url); const target = publicUrl(c.targetPrefix);
  if (target.origin === url.origin || target.pathname === '/' || target.search || /[*]/.test(c.targetPrefix)) throw new Error('Cilj mora biti precizan HTTPS prefiks putanje spoljnog dodatka bez wildcard-a.');
  if (!c.hypothesis?.trim()) throw new Error('Unesite hipotezu pre testa.');
  if (c.captureTimeoutMs !== undefined && (!Number.isInteger(c.captureTimeoutMs) || c.captureTimeoutMs < 150_000 || c.captureTimeoutMs > 600_000)) throw new Error('Capture timeout mora biti između 150000 i 600000 ms.');
  if (!c.protocol || c.protocol.runs !== 5 || !['mobile', 'desktop'].includes(c.protocol.device) || c.protocol.consent !== 'no-interaction' || c.protocol.browserCache !== 'cold' || c.protocol.cdnCache !== 'unknown' || !c.protocol.location?.trim()) throw new Error('Eksperiment zahteva 5 parova, cold browser cache, unknown CDN i no-interaction consent.');
  return c;
}
export function experimentItems(): ExperimentItem[] {
  return Array.from({ length: 5 }, (_, n) => {
    const variants: ExperimentItem['variant'][] = n % 2 ? ['blocked', 'baseline'] : ['baseline', 'blocked'];
    return variants.map(variant => ({ id: `pair-${n + 1}-${variant}`, pair: n + 1, variant, status: 'pending' as const }));
  }).flat();
}
export function verifyTarget(raw: any, network: unknown, prefix: string): NonNullable<ExperimentItem['evidence']> {
  const requests = new Map<string, { loaded: boolean; blocked: boolean }>();
  for (const event of Array.isArray(network) ? network : []) {
    const p = event?.params; const key = `${event.sessionId ?? ''}:${p?.requestId}`;
    if (event.method === 'Network.requestWillBeSent' && typeof p?.request?.url === 'string' && p.request.url.startsWith(prefix)) requests.set(key, { loaded: false, blocked: false });
    const request = requests.get(key);
    if (!request) continue;
    if (event.method === 'Network.responseReceived' && p.response?.status >= 200 && p.response?.status < 300) request.loaded = true;
    if (event.method === 'Network.loadingFailed' && p.blockedReason === 'inspector') request.blocked = true;
  }
  const items = raw?.audits?.['bootup-time']?.details?.items;
  const executed = (Array.isArray(items) ? items : []).filter((i: any) => typeof i.url === 'string' && i.url.startsWith(prefix) && i.scripting > 0).length;
  return { attempted: requests.size, loaded: [...requests.values()].filter(r => r.loaded).length, blocked: [...requests.values()].filter(r => r.blocked).length, executed };
}
export function usablePairs(state: ExperimentState): { baseline: ExperimentItem; blocked: ExperimentItem }[] {
  const pairs = [];
  for (let n = 1; n <= 5; n++) {
    const a = state.items.find(i => i.pair === n && i.variant === 'baseline');
    const b = state.items.find(i => i.pair === n && i.variant === 'blocked');
    if (!a?.measurement || !b?.measurement || a.status !== 'succeeded' || b.status !== 'succeeded' || !a.evidence || !b.evidence) continue;
    if (a.evidence.loaded < 1 || a.evidence.executed < 1 || b.evidence.blocked < 1 || b.evidence.loaded || b.evidence.executed) continue;
    if (!a.comparisonHash || a.comparisonHash !== b.comparisonHash || a.measurement.browserVersion === 'unknown' || a.measurement.browserVersion !== b.measurement.browserVersion || a.measurement.lighthouseVersion !== b.measurement.lighthouseVersion || a.measurement.finalUrl !== b.measurement.finalUrl) continue;
    if ([...a.measurement.warnings, ...b.measurement.warnings].some(w => /incomplete|too slowly|time limit/i.test(w))) continue;
    pairs.push({ baseline: a, blocked: b });
  }
  return pairs;
}
const fmt = (n: number | null | undefined, digits = 0) => n == null ? '—' : n.toFixed(digits);
export function renderExperiment(state: ExperimentState): string {
  const pairs = usablePairs(state);
  const lines = ['# Kliklak — kontrolisani test dodatka', '', `URL: ${state.config.url}`, '',
    `Hipoteza: ${state.config.hypothesis}`, '',
    'A = normalno učitavanje; B = blokada ciljnog resursa samo u lokalnom test browseru. Produkciona prodavnica nije izmenjena.', '',
    `Ciljni prefiks: \`${state.config.targetPrefix}\`. Pet parova: AB, BA, AB, BA, AB. Lokacija: ${state.config.protocol.location}. Browser keš hladan, CDN nepoznat, bez interakcije sa cookie banerom.`, '',
    'Unapred izabran dijagnostički prag: medijana smanjenja TBT po paru najmanje 20% i 500 ms, poboljšanje u najmanje 4/5 parova, bez relevantnog pogoršanja LCP/CLS. Ovo je prag za dalju proveru, ne obećanje učinka.', '',
    `Završeno: ${state.items.filter(i => i.status === 'succeeded').length}/10; parovi sa potvrđenom intervencijom i uporedivim uslovima: **${pairs.length}/5**.`, '',
    '| Par | Varijanta | Status | LCP ms | TBT ms | CLS | Target loaded / blocked / executed | CPU benchmark |',
    '| --- | --- | --- | ---: | ---: | ---: | --- | ---: |'];
  for (const i of state.items) lines.push(`| ${i.pair} | ${i.variant} | ${i.status} | ${fmt(i.measurement?.metrics.lcpMs)} | ${fmt(i.measurement?.metrics.tbtMs)} | ${fmt(i.measurement?.metrics.cls, 3)} | ${i.evidence ? `${i.evidence.loaded} / ${i.evidence.blocked} / ${i.evidence.executed}` : '—'} | ${fmt(i.benchmarkIndex, 1)} |`);
  lines.push('', '## Poređenje potvrđenih parova', '', '| Metrika | A medijana [min–max] | B medijana [min–max] | Medijana razlike A−B |', '| --- | --- | --- | --- |');
  for (const key of ['lcpMs', 'tbtMs', 'cls', 'imageTransferBytes', 'totalTransferBytes'] as const) {
    const complete = pairs.filter(p => p.baseline.measurement!.metrics[key] !== null && p.blocked.measurement!.metrics[key] !== null);
    const a = summarize(complete.map(p => p.baseline.measurement!.metrics[key]));
    const b = summarize(complete.map(p => p.blocked.measurement!.metrics[key]));
    const delta = summarize(complete.map(p => p.baseline.measurement!.metrics[key]! - p.blocked.measurement!.metrics[key]!));
    const d = key === 'cls' ? 3 : 0;
    lines.push(`| ${key} (n=${complete.length}) | ${fmt(a.median, d)} [${fmt(a.min, d)}–${fmt(a.max, d)}] | ${fmt(b.median, d)} [${fmt(b.min, d)}–${fmt(b.max, d)}] | ${fmt(delta.median, d)} |`);
  }
  const tbt = pairs.filter(p => (p.baseline.measurement!.metrics.tbtMs ?? 0) > 0 && p.blocked.measurement!.metrics.tbtMs !== null);
  const percentages = tbt.map(p => 100 * (1 - p.blocked.measurement!.metrics.tbtMs! / p.baseline.measurement!.metrics.tbtMs!));
  lines.push('', `Medijana relativne promene TBT: ${fmt(summarize(percentages).median, 1)}% smanjenja; poboljšanje u ${percentages.filter(p => p > 0).length}/${tbt.length} parova.`, '',
    pairs.length < 5 ? '**Nepotpun ili neuporediv eksperiment: nema konačnog zaključka.**' : 'Pet parova je dostupno. Rezultat opisuje ovaj URL, trenutak i blokadu dodatka; ne dokazuje učinak odloženog učitavanja ili stanje svih MerchantPro prodavnica.', '',
    'Blokiranje uklanja funkciju chatbota. Eventualni proizvodni zahvat (učitavanje na zahtev, promena dodatka) mora zasebno očuvati funkcije i biti izmeren. TBT je laboratorijski, ne INP stvarnih poseta. CPU benchmark i LCP element mogu varirati; pogledati sirove rezultate. Ne sabirati bootup-time direktno u TBT.', '', '## Dokazi i greške', '');
  for (const i of state.items) {
    if (i.measurement) lines.push(`- ${i.id}: [raw](raw/${i.id}.json), SHA-256 ${i.measurement.rawSha256}; Lighthouse ${i.measurement.lighthouseVersion}, Chrome ${i.measurement.browserVersion}; ${i.measurement.warnings.join('; ') || 'bez upozorenja'}.`);
    if (i.error) lines.push(`- ${i.id}: ${i.error.replace(/[\r\n<>]/g, ' ')}`);
  }
  return lines.join('\n') + '\n';
}
export async function runExperiment(options: { config: ExperimentConfig; directory: string; resume?: boolean; chromePath?: string; capture?: typeof captureLighthouse; onProgress?: (s: string) => void }): Promise<ExperimentState> {
  const config = validateExperiment(options.config);
  return withLock(options.directory, async () => {
    const path = join(options.directory, 'experiment.json'); const hash = sha256(JSON.stringify(config));
    let state: ExperimentState;
    if (options.resume) {
      state = await readJson<ExperimentState>(path);
      if (state.kind !== 'resource-block-experiment' || state.configHash !== hash || state.items.length !== 10 || state.items.some((i, n) => i.id !== experimentItems()[n].id || i.variant !== experimentItems()[n].variant || i.pair !== experimentItems()[n].pair)) throw new Error('Nastavak zahteva isti eksperiment i redosled.');
      for (const item of state.items.filter(i => i.status === 'succeeded')) {
        if (!item.measurement || sha256(await readFile(join(options.directory, 'raw', `${item.id}.json`))) !== item.measurement.rawSha256) throw new Error('Integritet postojećeg eksperimenta nije potvrđen.');
      }
    } else {
      await ensureNewDirectory(options.directory);
      const now = new Date().toISOString();
      state = { schemaVersion: 1, kind: 'resource-block-experiment', config, configHash: hash, createdAt: now, updatedAt: now, items: experimentItems() };
    }
    const persist = async () => { state.updatedAt = new Date().toISOString(); await writeJson(path, state); await atomicWrite(join(options.directory, 'report.md'), renderExperiment(state)); };
    await persist();
    let stop = false; const signal = () => { stop = true; };
    process.once('SIGINT', signal); process.once('SIGTERM', signal);
    try {
      for (const item of state.items) {
        if (stop) break;
        if (item.status === 'succeeded') continue;
        item.status = 'running'; delete item.error; await persist();
        options.onProgress?.(`${item.id}: počinje`);
        try {
          const patterns = item.variant === 'blocked' ? [`${config.targetPrefix}*`] : [];
          const result = await (options.capture ?? captureLighthouse)(config.url, config.protocol, options.chromePath, { blockedUrlPatterns: patterns, captureTimeoutMs: config.captureTimeoutMs });
          const raw = result.raw as any;
          if (JSON.stringify(raw?.configSettings?.blockedUrlPatterns ?? []) !== JSON.stringify(patterns)) throw new Error('Lighthouse nije primenio traženu konfiguraciju blokiranja.');
          const rawFile = `raw/${item.id}.json`; await writeJson(join(options.directory, rawFile), raw);
          await writeJson(join(options.directory, 'artifacts', `${item.id}.network.json`), result.network);
          await writeJson(join(options.directory, 'artifacts', `${item.id}.trace.json`), result.trace);
          const context = { id: item.id, storeId: config.storeId, pageId: config.pageId, requestedUrl: config.url, rawFile, rawSha256: sha256(await readFile(join(options.directory, rawFile))) };
          item.measurement = normalizeMeasurement(raw, context);
          item.comparisonHash = normalizeMeasurement({ ...raw, configSettings: { ...raw.configSettings, blockedUrlPatterns: [] } }, context).settingsHash;
          item.evidence = verifyTarget(raw, result.network, config.targetPrefix);
          item.benchmarkIndex = typeof raw.environment?.benchmarkIndex === 'number' ? raw.environment.benchmarkIndex : null;
          item.status = 'succeeded';
          options.onProgress?.(`${item.id}: LCP=${fmt(item.measurement.metrics.lcpMs)}ms TBT=${fmt(item.measurement.metrics.tbtMs)}ms; ${JSON.stringify(item.evidence)}`);
        } catch (error) { item.status = 'failed'; delete item.measurement; item.error = error instanceof Error ? error.message : 'Test nije uspeo'; options.onProgress?.(`${item.id}: ${item.error}`); }
        await persist();
      }
    } finally { process.removeListener('SIGINT', signal); process.removeListener('SIGTERM', signal); }
    return state;
  });
}
