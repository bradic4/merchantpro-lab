import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Manifest, RunState } from './domain.js';
import { normalizeMeasurement } from './measurements.js';
import { manifestHash, newRun, readJson, saveRun, sha256, withLock, atomicWrite, ensureNewDirectory } from './storage.js';

export async function importResults(options: { manifest: Manifest; directory: string; storeId: string; pageId: string; files: string[] }): Promise<{ state: RunState; imported: number; duplicates: number }> {
  const { manifest, directory, storeId, pageId, files } = options;
  const page = manifest.stores.find(s => s.id === storeId)?.pages.find(p => p.id === pageId);
  if (!page) throw new Error('Prodavnica/stranica ne postoji u manifestu.');
  if (!files.length) throw new Error('Navedite bar jedan --input JSON fajl.');
  // Validate the whole batch before any writes. File whitespace and PSI wrappers cannot create another run.
  const candidates = await Promise.all(files.map(async file => {
    const text = await readFile(file, 'utf8');
    const raw = JSON.parse(text);
    const measurement = normalizeMeasurement(raw, { id: 'import', storeId, pageId, requestedUrl: page.url, rawFile: '', rawSha256: sha256(text) });
    if (measurement.device !== manifest.protocol.device) throw new Error('Uređaj u izveštaju se razlikuje od manifesta.');
    return { text, measurement };
  }));
  return withLock(directory, async () => {
    let state: RunState;
    try { state = await readJson<RunState>(join(directory, 'state.json')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await ensureNewDirectory(directory);
      state = newRun(manifest, 'import');
    }
    if (state.manifestHash !== manifestHash(manifest) || state.kind !== 'import') throw new Error('Import zahteva isti manifest i zaseban import folder.');
    const isSame = (a: typeof candidates[number]['measurement'], b: typeof candidates[number]['measurement']) =>
      a.rawSha256 === b.rawSha256 || (a.requestedUrl === b.requestedUrl && Date.parse(a.fetchedAt) === Date.parse(b.fetchedAt) && a.lighthouseVersion === b.lighthouseVersion);
    const known = state.items.flatMap(item => item.measurement ? [item.measurement] : []);
    let newCount = 0;
    for (const candidate of candidates) {
      if (!known.some(m => isSame(m, candidate.measurement))) { newCount++; known.push(candidate.measurement); }
    }
    if (newCount > state.items.filter(i => i.storeId === storeId && i.pageId === pageId && i.status !== 'succeeded').length) throw new Error('Dostignut je broj ponavljanja za stranicu; koristite novi skup za drugi eksperiment.');
    let imported = 0; let duplicates = 0;
    for (const { text, measurement } of candidates) {
      const duplicate = state.items.some(item => item.measurement && isSame(item.measurement, measurement));
      if (duplicate) { duplicates++; continue; }
      const slot = state.items.find(item => item.storeId === storeId && item.pageId === pageId && item.status !== 'succeeded');
      if (!slot) throw new Error('Dostignut je broj ponavljanja za stranicu; koristite novi skup za drugi eksperiment.');
      measurement.id = slot.id;
      measurement.rawFile = `raw/${slot.id}.json`;
      await atomicWrite(join(directory, measurement.rawFile), text);
      slot.measurement = measurement; slot.status = 'succeeded'; delete slot.error;
      imported++;
      // Persist each accepted result so a process interruption can be resumed by reimporting.
      state.status = state.items.every(i => i.status === 'succeeded') ? 'completed' : 'partial';
      await saveRun(directory, state);
    }
    state.status = state.items.every(i => i.status === 'succeeded') ? 'completed' : 'partial';
    await saveRun(directory, state);
    return { state, imported, duplicates };
  });
}
