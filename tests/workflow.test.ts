import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { emptyManifest, validateManifest } from '../src/manifest.js';
import { runBenchmark } from '../src/runner.js';
import { importResults } from '../src/importer.js';
import { syntheticLhr } from '../src/demo.js';
import { newRun, readJson, writeJson, withLock } from '../src/storage.js';
import type { RunState } from '../src/domain.js';

async function directory(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'merchantpro-lab-test-'));
  t.after(async () => {
    assert.equal(dirname(resolve(path)), resolve(tmpdir()));
    assert.ok(path.includes('merchantpro-lab-test-'));
    await rm(path, { recursive: true, force: true });
  });
  return path;
}
function sample() {
  const m = emptyManifest(); m.protocol.location = 'test';
  m.stores = [{ id: 'sample', name: 'Sample', origin: 'https://shop.example', platform: 'merchantpro', role: 'sample', market: 'unknown', theme: 'unknown', notes: '', pages: [{ id: 'home', type: 'home', url: 'https://shop.example/' }] }];
  return m;
}

test('manifest rejects duplicate domains, path traversal, cross-origin pages and invalid protocol', () => {
  const m = sample(); validateManifest(m);
  const bad = (change: (value: ReturnType<typeof sample>) => void) => { const copy = structuredClone(m); change(copy); assert.throws(() => validateManifest(copy)); };
  bad(v => v.stores.push({ ...v.stores[0], id: 'another' }));
  bad(v => { v.stores[0].id = '../escape'; });
  bad(v => { v.stores[0].pages[0].url = 'https://other.example/'; });
  bad(v => { v.stores[0].origin = 'https://user:secret@shop.example'; });
  bad(v => { (v.protocol as any).runs = 1; });
});

test('composite run IDs cannot collide across stores and pages containing separators', () => {
  const m = sample(); m.stores[0].id = 'a--b'; m.stores[0].pages[0].id = 'c';
  m.stores.push({ ...structuredClone(m.stores[0]), id: 'a', origin: 'https://second.example', pages: [{ id: 'b--c', type: 'home', url: 'https://second.example/' }] });
  const ids = newRun(m, 'live').items.map(i => i.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('partial run resumes only failed items and verifies preserved raw evidence', async t => {
  const dir = await directory(t); const m = sample(); let calls = 0;
  const capture = async (url: string) => { calls++; if (calls === 2) throw new Error('Temporary failure'); return { raw: syntheticLhr(url, calls), trace: { traceEvents: [] }, network: [] }; };
  const first = await runBenchmark({ manifest: m, directory: dir, capture });
  assert.equal(first.status, 'partial'); assert.equal(calls, 3);
  const second = await runBenchmark({ manifest: m, directory: dir, resume: true, capture });
  assert.equal(second.status, 'completed'); assert.equal(calls, 4);
  await runBenchmark({ manifest: m, directory: dir, resume: true, capture });
  assert.equal(calls, 4);
  await writeFile(join(dir, second.items[0].measurement!.rawFile), '{}');
  await assert.rejects(runBenchmark({ manifest: m, directory: dir, resume: true, capture }), /izmenjen/);
});

test('crash after artifact commit recovers raw without another navigation', async t => {
  const dir = await directory(t); const m = sample(); let calls = 0;
  const capture = async (url: string) => ({ raw: syntheticLhr(url, ++calls), trace: [], network: [] });
  const state = await runBenchmark({ manifest: m, directory: dir, capture });
  state.items[2].status = 'running'; delete state.items[2].measurement;
  await writeJson(join(dir, 'state.json'), state);
  const resumed = await runBenchmark({ manifest: m, directory: dir, resume: true, capture });
  assert.equal(resumed.status, 'completed'); assert.equal(calls, 3);
});

test('fresh run refuses orphan raw evidence and another active writer', async t => {
  const dir = await directory(t); await mkdir(join(dir, 'raw'));
  await assert.rejects(runBenchmark({ manifest: sample(), directory: dir }), /nije prazan/);
  const lockDir = join(dir, 'locked');
  await withLock(lockDir, async () => { await assert.rejects(withLock(lockDir, async () => {}), /zaključan/); });
});

test('import deduplicates raw formatting and PSI wrappers without inflating sample size', async t => {
  const dir = await directory(t); const m = sample(); const raw = syntheticLhr(m.stores[0].pages[0].url, 1);
  const files = [join(dir, 'one.json'), join(dir, 'two.json'), join(dir, 'three.json')];
  await writeFile(files[0], JSON.stringify(raw)); await writeFile(files[1], JSON.stringify(raw, null, 2));
  await writeFile(files[2], JSON.stringify({ lighthouseResult: raw }));
  const result = await importResults({ manifest: m, directory: join(dir, 'import'), storeId: 'sample', pageId: 'home', files });
  assert.equal(result.imported, 1); assert.equal(result.duplicates, 2); assert.equal(result.state.status, 'partial');
  assert.equal(result.state.items.filter(i => i.status === 'succeeded').length, 1);
  assert.equal(await readFile(join(dir, 'import', result.state.items[0].measurement!.rawFile), 'utf8'), JSON.stringify(raw));
});

test('invalid import device and URL reject the entire batch before storing results', async t => {
  const dir = await directory(t); const m = sample();
  const one = syntheticLhr(m.stores[0].pages[0].url, 1) as any;
  const two = syntheticLhr(m.stores[0].pages[0].url, 2) as any; two.configSettings.formFactor = 'desktop';
  const files = [join(dir, 'one.json'), join(dir, 'two.json')];
  await writeJson(files[0], one); await writeJson(files[1], two);
  await assert.rejects(importResults({ manifest: m, directory: join(dir, 'import'), storeId: 'sample', pageId: 'home', files }), /Uređaj/);
  assert.deepEqual((await readdir(dir)).sort(), ['one.json', 'two.json']);
});

test('resume refuses changed protocol and import state', async t => {
  const dir = await directory(t); const m = sample();
  const state = newRun(m, 'import'); await writeJson(join(dir, 'state.json'), state);
  await assert.rejects(runBenchmark({ manifest: m, directory: dir, resume: true }), /isti manifest/);
  state.kind = 'live'; await writeJson(join(dir, 'state.json'), state);
  m.protocol.location = 'another';
  await assert.rejects(runBenchmark({ manifest: m, directory: dir, resume: true }), /isti manifest/);
  assert.equal((await readJson<RunState>(join(dir, 'state.json'))).kind, 'live');
});

test('over-capacity import rejects before writing any results', async t => {
  const dir = await directory(t); const m = sample();
  const files = await Promise.all([1, 2, 3, 4].map(async n => { const file = join(dir, `${n}.json`); await writeJson(file, syntheticLhr(m.stores[0].pages[0].url, n)); return file; }));
  const target = join(dir, 'import');
  await assert.rejects(importResults({ manifest: m, directory: target, storeId: 'sample', pageId: 'home', files }), /broj ponavljanja/);
  assert.deepEqual(await readdir(target), []);
});
