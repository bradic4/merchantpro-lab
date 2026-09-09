import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Manifest, Protocol, RunState } from './domain.js';
import { normalizeMeasurement } from './measurements.js';
import { manifestHash, newRun, readJson, saveRun, sha256, withLock, writeJson, ensureNewDirectory } from './storage.js';

export async function captureLighthouse(url: string, protocol: Protocol, chromePath?: string, experiment?: { blockedUrlPatterns: string[]; captureTimeoutMs?: number }): Promise<{ raw: unknown; trace: unknown; network: unknown }> {
  const [{ default: lighthouse }, { launch }, { mkdtemp, rm }, { tmpdir }, { join }] = await Promise.all([
    import('lighthouse'), import('chrome-launcher'), import('node:fs/promises'), import('node:os'), import('node:path')
  ]);
  const customUserDataDir = await mkdtemp(join(tmpdir(), 'lighthouse-profile-'));
  const chrome = await launch({
    chromePath,
    userDataDir: customUserDataDir,
    chromeFlags: ['--headless=new', '--disable-gpu', '--no-first-run']
  });
  let timedOut = false;
  const captureTimeoutMs = experiment?.captureTimeoutMs ?? 150_000;
  const deadline = setTimeout(() => { timedOut = true; void chrome.kill(); }, captureTimeoutMs);
  deadline.unref();
  const cleanup = () => { void chrome.kill(); };
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);
  try {
    const mobile = protocol.device === 'mobile';
    const result = await lighthouse(url, { port: chrome.port, output: 'json', logLevel: 'error' }, {
      extends: 'lighthouse:default',
      settings: {
        onlyCategories: ['performance', 'seo'], formFactor: protocol.device, emulatedUserAgent: true,
        ...(experiment ? { blockedUrlPatterns: experiment.blockedUrlPatterns } : {}),
        screenEmulation: { mobile, width: mobile ? 412 : 1350, height: mobile ? 823 : 940, deviceScaleFactor: mobile ? 1.75 : 1, disabled: false },
        throttlingMethod: 'simulate',
        throttling: { rttMs: mobile ? 150 : 40, throughputKbps: mobile ? 1638.4 : 10240, cpuSlowdownMultiplier: mobile ? 4 : 1 },
        disableStorageReset: false, maxWaitForLoad: 45_000, maxWaitForFcp: 30_000
      }
    });
    if (!result) throw new Error('Lighthouse nije vratio rezultat.');
    const artifacts = result.artifacts as unknown as Record<string, unknown>;
    return { raw: result.lhr, trace: artifacts.Trace ?? null, network: artifacts.DevtoolsLog ?? null };
  } catch (error) {
    if (timedOut) throw new Error(`Lighthouse capture deadline exceeded (${captureTimeoutMs} ms).`);
    throw error;
  } finally {
    clearTimeout(deadline); process.removeListener('SIGINT', cleanup); process.removeListener('SIGTERM', cleanup);
    try { await chrome.kill(); } catch { /* ignore */ }
    // Asynchronously cleanup customUserDataDir with retries on Windows
    setTimeout(async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await rm(customUserDataDir, { recursive: true, force: true, maxRetries: 5 });
          break;
        } catch {
          await new Promise(res => setTimeout(res, 1000));
        }
      }
    }, 1000).unref();
  }
}
type Capture = typeof captureLighthouse;
export async function runBenchmark(options: { manifest: Manifest; directory: string; resume?: boolean; chromePath?: string; capture?: Capture; onProgress?: (message: string) => void }): Promise<RunState> {
  const { manifest, directory } = options;
  if (!manifest.stores.length) throw new Error('Uzorak je prazan. Prvo dodajte prodavnicu.');
  return withLock(directory, async () => {
    let state: RunState;
    if (options.resume) {
      state = await readJson<RunState>(join(directory, 'state.json'));
      if (state.schemaVersion !== 1 || state.manifestHash !== manifestHash(manifest) || state.kind !== 'live') throw new Error('Nastavak zahteva isti manifest i postojeći live skup.');
      const expected = newRun(manifest, 'live').items;
      if (state.items.length !== expected.length || state.items.some((item, i) => item.id !== expected[i].id || item.storeId !== expected[i].storeId || item.pageId !== expected[i].pageId)) throw new Error('Stanje merenja ne odgovara manifestu.');
      for (const item of state.items.filter(i => i.status === 'succeeded')) {
        if (!item.measurement) throw new Error('Nedostaje zapis uspešnog merenja.');
        const raw = await readFile(join(directory, 'raw', `${item.id}.json`));
        if (sha256(raw) !== item.measurement.rawSha256) throw new Error(`Sirovi rezultat ${item.id} je izmenjen; nastavak zaustavljen.`);
      }
    } else {
      await ensureNewDirectory(directory);
      state = newRun(manifest, 'live');
    }
    state.status = 'running'; await saveRun(directory, state);
    const capture = options.capture ?? captureLighthouse;
    const warmed = new Set<string>();
    let interrupted = false;
    const stop = () => { interrupted = true; };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try {
      for (const item of state.items) {
        if (interrupted) break;
        if (item.status === 'succeeded') continue;
        const store = manifest.stores.find(s => s.id === item.storeId)!;
        const page = store.pages.find(p => p.id === item.pageId)!;
        item.status = 'running'; delete item.error; await saveRun(directory, state);
        options.onProgress?.(`${store.id}/${page.id}: ${item.repetition}/${manifest.protocol.runs}`);
        const rawFile = `raw/${item.id}.json`;
        try {
          // A valid raw result saved just before a crash is recovered without another navigation.
          let rawText: string | undefined;
          try {
            if (options.resume) {
              const previous = await readFile(join(directory, rawFile), 'utf8');
              const marker = await readJson<{ rawSha256: string; trace: boolean; network: boolean }>(join(directory, 'artifacts', `${item.id}.complete.json`));
              if (marker.rawSha256 !== sha256(previous)) throw new Error('Oštećen sirovi rezultat pri oporavku.');
              if (marker.trace) await readFile(join(directory, 'artifacts', `${item.id}.trace.json`));
              if (marker.network) await readFile(join(directory, 'artifacts', `${item.id}.network.json`));
              normalizeMeasurement(JSON.parse(previous), { ...item, requestedUrl: page.url, rawFile, rawSha256: sha256(previous) });
              rawText = previous;
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
          if (!rawText) {
            if (manifest.protocol.cdnCache === 'warmed-by-preflight' && !warmed.has(page.url)) {
              const warmup = await capture(page.url, manifest.protocol, options.chromePath);
              normalizeMeasurement(warmup.raw, { ...item, requestedUrl: page.url, rawFile, rawSha256: 'preflight' });
              warmed.add(page.url);
            }
            const result = await capture(page.url, manifest.protocol, options.chromePath);
            await writeJson(join(directory, rawFile), result.raw);
            if (result.trace !== null) await writeJson(join(directory, 'artifacts', `${item.id}.trace.json`), result.trace);
            if (result.network !== null) await writeJson(join(directory, 'artifacts', `${item.id}.network.json`), result.network);
            rawText = await readFile(join(directory, rawFile), 'utf8');
            await writeJson(join(directory, 'artifacts', `${item.id}.complete.json`), { rawSha256: sha256(rawText), trace: result.trace !== null, network: result.network !== null });
          }
          item.measurement = normalizeMeasurement(JSON.parse(rawText), { ...item, requestedUrl: page.url, rawFile, rawSha256: sha256(rawText) });
          item.status = 'succeeded';
        } catch (error) {
          item.status = 'failed'; delete item.measurement;
          item.error = error instanceof Error ? error.message : 'Merenje nije uspelo.';
          options.onProgress?.(`Neuspeh ${item.id}: ${item.error}`);
        }
        await saveRun(directory, state);
      }
    } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
    state.status = state.items.every(i => i.status === 'succeeded') ? 'completed' : 'partial';
    await saveRun(directory, state); return state;
  });
}
