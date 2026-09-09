#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { emptyManifest, readManifest, validateManifest, coverageWarnings, safeId } from './manifest.js';
import { atomicWrite, readJson, withLock, writeJson } from './storage.js';
import { renderReport } from './report.js';
import { runBenchmark } from './runner.js';
import { importResults } from './importer.js';
import { inventory } from './connector.js';
import { createDemo } from './demo.js';
import { runExperiment, validateExperiment } from './experiment.js';
import { optimizeImage, type ImageProfile } from './image-pipeline.js';
import { backupFile, calcSha256, rollbackJob, saveJobManifest, type JobItem, type OptimizationJob } from './optimizer-storage.js';
import { generateRemediationPlan } from './remediation.js';
import { startServer } from './server.js';
import type { RunState, Store, Protocol } from './domain.js';

const help = `MerchantPro Lab 0.1 — interni alat za fazu A

  init       --manifest sample.json
  add-store  --manifest sample.json --id radnja --name "Radnja" --origin https://shop.example
             --platform merchantpro --home https://shop.example/ [--category URL --product URL]
             [--role sample|control|clean-test --market RS --theme unknown]
  validate   --manifest sample.json
  run        --manifest sample.json --out data/benchmark [--chrome PATH] [--resume]
  import     --manifest sample.json --store radnja --page home --input result.json
             [--input result2.json ...] --out data/import
  report     --state data/benchmark/state.json [--out report.md]
  inventory  --manifest sample.json --store radnja [--max-products 20] [--include-images]
             --out data/catalog.json
  psi        --manifest sample.json --out data/psi-benchmark [--api-key KEY] [--resume]
  demo       --out data/demo
  experiment --config experiment.json --out data/experiment [--chrome PATH] [--resume]
  optimize-images --input path/to/images --out data/optimized [--profile thumb|medium|large|banner] [--quality 80] [--format webp|avif]
  remediation-plan --lhr data/raw/run.json --out data/remediation.md
  rollback   --job data/optimized/optimization-job.json
  ui         [--port 3333]

Pre run komande upišite protocol.location u manifest. Profil sadrži 3 ili 5 ponavljanja.
Inventory čita MERCHANTPRO_<STORE_ID>_USERNAME i MERCHANTPRO_<STORE_ID>_SECRET iz okruženja.
Kredencijali se ne upisuju u manifest. Demo podaci su izmišljeni.
`;
async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ['help', '--help', '-h'].includes(command)) { console.log(help); return; }
  const { values: v } = parseArgs({ args, strict: true, options: {
    manifest: { type: 'string' }, config: { type: 'string' }, out: { type: 'string' }, id: { type: 'string' }, name: { type: 'string' },
    origin: { type: 'string' }, platform: { type: 'string' }, home: { type: 'string' }, category: { type: 'string' }, product: { type: 'string' },
    role: { type: 'string' }, market: { type: 'string' }, theme: { type: 'string' }, chrome: { type: 'string' },
    store: { type: 'string' }, page: { type: 'string' }, input: { type: 'string', multiple: true }, state: { type: 'string' },
    resume: { type: 'boolean' }, 'include-images': { type: 'boolean' }, 'max-products': { type: 'string' }, 'api-key': { type: 'string' },
    profile: { type: 'string' }, format: { type: 'string' }, quality: { type: 'string' }, job: { type: 'string' }, lhr: { type: 'string' },
    port: { type: 'string' }
  } });
  const need = (key: string): string => { const value = v[key as keyof typeof v]; if (typeof value !== 'string' || !value) throw new Error(`Nedostaje --${key}.`); return value; };
  const manifestPath = () => resolve(need('manifest'));
  const output = () => resolve(need('out'));
  if (command === 'experiment') {
    const config = validateExperiment(await readJson(resolve(need('config'))));
    const state = await runExperiment({ config, directory: output(), resume: v.resume, chromePath: v.chrome, onProgress: console.log });
    console.log(`Izveštaj: ${join(output(), 'report.md')}`);
    if (state.items.some(i => i.status !== 'succeeded')) process.exitCode = 2;
    return;
  }
  if (command === 'init') {
    const path = manifestPath(); await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(emptyManifest(), null, 2) + '\n', { flag: 'wx' });
    console.log(`Kreiran manifest: ${path}`); return;
  }
  if (command === 'add-store') {
    const path = manifestPath();
    await withLock(dirname(path), async () => {
      const manifest = await readManifest(path);
      const store: Store = { id: safeId(need('id')), name: need('name'), origin: need('origin'), platform: need('platform') as Store['platform'],
        role: (v.role ?? 'sample') as Store['role'], market: v.market ?? 'unknown', theme: v.theme ?? 'unknown', notes: '', pages: [] };
      for (const type of ['home', 'category', 'product'] as const) { if (v[type]) store.pages.push({ id: type, type, url: v[type]! }); }
      manifest.stores.push(store); validateManifest(manifest); await writeJson(path, manifest);
    });
    console.log('Prodavnica je dodata.'); return;
  }
  if (command === 'validate') {
    const manifest = await readManifest(manifestPath());
    console.log(`Ispravan manifest: ${manifest.stores.length} prodavnica, ${manifest.stores.reduce((n, s) => n + s.pages.length, 0)} stranica.`);
    for (const warning of coverageWarnings(manifest)) console.log(`Napomena: ${warning}`);
    return;
  }
  if (command === 'demo') {
    const directory = output(); const state = await createDemo(directory);
    await atomicWrite(join(directory, 'report.md'), renderReport(state));
    console.log(`SINTETIČKI DEMO: ${join(directory, 'report.md')}`); return;
  }
  if (command === 'report') {
    const state = await readJson<RunState>(resolve(need('state')));
    validateManifest(state.manifest);
    if (state.schemaVersion !== 1 || !Array.isArray(state.items)) throw new Error('Neispravno stanje merenja.');
    const target = v.out ? output() : join(dirname(resolve(need('state'))), 'report.md');
    if (dirname(target) !== dirname(resolve(need('state')))) throw new Error('Izveštaj sa vezama ka sirovim rezultatima sačuvajte u istom folderu kao state.json.');
    await atomicWrite(target, renderReport(state)); console.log(target); return;
  }
  if (command === 'run') {
    const manifest = await readManifest(manifestPath()); const directory = output();
    const state = await runBenchmark({ manifest, directory, resume: v.resume, chromePath: v.chrome, onProgress: console.log });
    await atomicWrite(join(directory, 'report.md'), renderReport(state));
    console.log(`Status: ${state.status}. Izveštaj: ${join(directory, 'report.md')}`);
    if (state.status !== 'completed') process.exitCode = 2;
    return;
  }
  if (command === 'import') {
    const directory = output();
    const result = await importResults({ manifest: await readManifest(manifestPath()), directory, storeId: need('store'), pageId: need('page'), files: (v.input ?? []).map(p => resolve(p)) });
    await atomicWrite(join(directory, 'report.md'), renderReport(result.state));
    console.log(`Uvezeno: ${result.imported}; duplikati: ${result.duplicates}. ${join(directory, 'report.md')}`); return;
  }
  if (command === 'inventory') {
    const manifest = await readManifest(manifestPath());
    const store = manifest.stores.find(s => s.id === need('store'));
    if (!store || store.platform !== 'merchantpro') throw new Error('Inventory zahteva MerchantPro prodavnicu iz manifesta.');
    const prefix = `MERCHANTPRO_${store.id.toUpperCase().replaceAll('-', '_')}`;
    const username = process.env[`${prefix}_USERNAME`]; const secret = process.env[`${prefix}_SECRET`];
    if (!username || !secret) throw new Error(`Postavite ${prefix}_USERNAME i ${prefix}_SECRET u okruženju.`);
    const result = await inventory({ origin: store.origin, username, secret, maxProducts: Number(v['max-products'] ?? 20), includeImages: v['include-images'] ?? false });
    const path = output(); await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ storeId: store.id, inventory: result }, null, 2) + '\n', { flag: 'wx' });
    console.log(`Inventar sačuvan: ${path}`); return;
  }
  if (command === 'psi') {
    const { fetchPsi } = await import('./psi-client.js');
    const manifest = await readManifest(manifestPath()); const directory = output();
    const apiKey = v['api-key'] as string | undefined ?? process.env.PSI_API_KEY;
    const capturePsi = async (url: string, protocol: Protocol) => {
      const raw = await fetchPsi({ url, strategy: protocol.device, apiKey });
      return { raw, trace: null, network: null };
    };
    const state = await runBenchmark({ manifest, directory, resume: v.resume, capture: capturePsi, onProgress: console.log });
    await atomicWrite(join(directory, 'report.md'), renderReport(state));
    console.log(`Status: ${state.status}. Izveštaj: ${join(directory, 'report.md')}`);
    if (state.status !== 'completed') process.exitCode = 2;
    return;
  }
  if (command === 'optimize-images') {
    const rawInputs = Array.isArray(v.input) ? v.input : (typeof v.input === 'string' ? [v.input] : []);
    if (rawInputs.length === 0) throw new Error('Nedostaje --input.');
    const outDir = output();
    const backupDir = join(outDir, 'backups');
    await mkdir(outDir, { recursive: true });
    await mkdir(backupDir, { recursive: true });

    const filesToProcess: string[] = [];
    for (const raw of rawInputs) {
      const inputPath = resolve(raw);
      const inputStat = await stat(inputPath);
      if (inputStat.isDirectory()) {
        const entries = await readdir(inputPath);
        for (const entry of entries) {
          const ext = extname(entry).toLowerCase();
          if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
            filesToProcess.push(join(inputPath, entry));
          }
        }
      } else {
        filesToProcess.push(inputPath);
      }
    }

    if (filesToProcess.length === 0) {
      console.log('Nema pronađenih slika za obradu.');
      return;
    }

    console.log(`Započeta optimizacija ${filesToProcess.length} slika...`);
    const jobItems: JobItem[] = [];
    let totalOriginal = 0;
    let totalOptimized = 0;

    for (let i = 0; i < filesToProcess.length; i++) {
      const src = filesToProcess[i]!;
      const filename = basename(src);
      try {
        const backup = await backupFile(src, backupDir);
        const optResult = await optimizeImage(backup.content, {
          profile: v.profile as ImageProfile | undefined,
          quality: v.quality ? Number(v.quality) : undefined,
          format: v.format as 'webp' | 'avif' | undefined,
        });

        const targetBase = filename.replace(/\.[^/.]+$/, '');
        const targetFilename = `${targetBase}.${optResult.format}`;
        const targetPath = join(outDir, targetFilename);

        await writeFile(targetPath, optResult.buffer);

        const item: JobItem = {
          id: `img-${i + 1}`,
          originalPath: src,
          originalSha256: backup.sha256,
          originalBytes: backup.bytes,
          originalDimensions: { width: optResult.width, height: optResult.height },
          backupPath: backup.backupPath,
          optimizedPath: targetPath,
          optimizedSha256: calcSha256(optResult.buffer),
          optimizedBytes: optResult.optimizedBytes,
          optimizedDimensions: { width: optResult.width, height: optResult.height },
          savedBytes: optResult.savedBytes,
          savedPercent: optResult.savedPercent,
          status: optResult.skipped ? 'skipped' : 'optimized',
        };
        jobItems.push(item);
        totalOriginal += backup.bytes;
        totalOptimized += optResult.optimizedBytes;

        const origKb = (backup.bytes / 1024).toFixed(1);
        const optKb = (optResult.optimizedBytes / 1024).toFixed(1);
        const pct = optResult.savedPercent.toFixed(1);
        console.log(`[${i + 1}/${filesToProcess.length}] ${filename} -> ${targetFilename} (${origKb} kB -> ${optKb} kB, -${pct}%)${optResult.skipped ? ' [preskočeno]' : ''}`);
      } catch (err: any) {
        console.error(`Greška pri obradi ${filename}: ${err.message}`);
        jobItems.push({
          id: `img-${i + 1}`,
          originalPath: src,
          originalSha256: '',
          originalBytes: 0,
          backupPath: '',
          optimizedPath: '',
          savedBytes: 0,
          savedPercent: 0,
          status: 'failed',
          error: err.message,
        });
      }
    }

    const totalSaved = totalOriginal - totalOptimized;
    const totalSavedPct = totalOriginal > 0 ? ((totalSaved / totalOriginal) * 100).toFixed(1) : '0';
    const jobManifest: OptimizationJob = {
      schemaVersion: 1,
      id: `job-${Date.now()}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sourceDirectory: rawInputs.join('; '),
      backupDirectory: backupDir,
      totalOriginalBytes: totalOriginal,
      totalOptimizedBytes: totalOptimized,
      totalSavedBytes: totalSaved,
      items: jobItems,
    };

    const jobPath = join(outDir, 'optimization-job.json');
    await saveJobManifest(jobManifest, jobPath);

    console.log(`\n--- Rezime optimizacije ---`);
    console.log(`Ukupno original: ${(totalOriginal / 1024).toFixed(1)} kB`);
    console.log(`Ukupno optimizovano: ${(totalOptimized / 1024).toFixed(1)} kB`);
    console.log(`Ušteđeno: ${(totalSaved / 1024).toFixed(1)} kB (-${totalSavedPct}%)`);
    console.log(`Manifest posla i backup sačuvani u: ${jobPath}`);
    return;
  }
  if (command === 'remediation-plan') {
    const lhrPath = resolve(need('lhr'));
    const outPath = output();
    const lhr = await readJson(lhrPath);
    const plan = generateRemediationPlan(lhr);
    await atomicWrite(outPath, plan.markdownReport);
    console.log(`Akcioni plan sanacije sačuvan u: ${outPath}`);
    console.log(`Pronađeno ${plan.issues.length} ključnih propusta:`);
    plan.issues.forEach((issue, idx) => console.log(` ${idx + 1}. [${issue.impact.toUpperCase()}] ${issue.title}`));
    return;
  }
  if (command === 'rollback') {
    const jobPath = resolve(need('job'));
    const result = await rollbackJob(jobPath);
    console.log(`Rollback završen. Vraćeno fajlova: ${result.restoredCount}.`);
    if (result.errors.length > 0) {
      console.warn(`Greške (${result.errors.length}):`);
      result.errors.forEach(e => console.warn(` - ${e}`));
    }
    return;
  }
  if (command === 'ui') {
    const port = v.port ? Number(v.port) : 3333;
    const { url, close } = await startServer({ port });
    console.log(`\n======================================================`);
    console.log(`🚀 MerchantPro Lab Control Panel pokrenut na:`);
    console.log(`👉 ${url}`);
    console.log(`======================================================\n`);
    console.log(`Pritisnite Ctrl+C za zaustavljanje servera.`);
    await new Promise<void>((done, reject) => {
      let stopping = false;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        console.log('Zaustavljanje servisa; poslovi koji čekaju ostaju sačuvani.');
        void close().then(done, reject).finally(() => {
          process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
        });
      };
      process.on('SIGINT', stop); process.on('SIGTERM', stop);
    });
    return;
  }
  throw new Error(`Nepoznata komanda: ${command}. Koristite help.`);
}
main().catch(error => { console.error(`Greška: ${error instanceof Error ? error.message : 'Operacija nije uspela.'}`); process.exitCode = 1; });
