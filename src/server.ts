import http from 'node:http';
import { AuditJobs, type AuditExecutor } from './audit-jobs.js';
import { readFile, readdir, mkdir, stat } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { optimizeImage, type ImageProfile } from './image-pipeline.js';
import { generateRemediationPlan } from './remediation.js';
import { benchmarkRows } from './benchmark-rows.js';
import { captureLighthouse } from './runner.js';
import { readManifest, validateManifest, safeId } from './manifest.js';
import { writeJson, readJson, sha256, atomicWrite } from './storage.js';
import { normalizeMeasurement } from './measurements.js';
import { inventory } from './connector.js';
import type { Protocol, Store, RunState } from './domain.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface ServerOptions {
  port?: number;
  host?: string;
  uiHtmlPath?: string;
  dataDirectory?: string;
  auditExecutor?: AuditExecutor;
}

export interface ServerHandle {
  server: http.Server;
  url: string;
  close: () => Promise<void>;
}

function parseMultipart(body: Buffer, boundary: string): { filename: string; buffer: Buffer; fields: Record<string, string> } {
  const boundaryMarker = `--${boundary}`;
  const parts = body.toString('binary').split(boundaryMarker);
  const fields: Record<string, string> = {};
  let fileBuffer: Buffer = Buffer.alloc(0);
  let filename = 'image.png';

  for (const part of parts) {
    if (!part || part === '--' || part === '--\r\n') continue;
    const headerEndIndex = part.indexOf('\r\n\r\n');
    if (headerEndIndex === -1) continue;

    const headers = part.substring(0, headerEndIndex);
    const contentBinary = part.substring(headerEndIndex + 4, part.length - 2);

    const dispositionMatch = headers.match(/name="([^"]+)"(?:;\s*filename="([^"]+)")?/);
    if (!dispositionMatch) continue;

    const name = dispositionMatch[1]!;
    const file = dispositionMatch[2];

    if (file) {
      filename = file;
      fileBuffer = Buffer.from(contentBinary, 'binary');
    } else {
      fields[name] = Buffer.from(contentBinary, 'binary').toString('utf8');
    }
  }

  return { filename, buffer: fileBuffer, fields };
}

export async function startServer(options: ServerOptions = {}): Promise<ServerHandle> {
  const port = options.port ?? 3333;
  const host = options.host ?? 'localhost';
  if (!['localhost', '127.0.0.1'].includes(host)) throw new Error('Panel mora biti vezan za lokalni interfejs.');
  const projectRoot = resolve(__dirname, '..');
  const dataRoot = options.dataDirectory ?? join(projectRoot, 'data');
  const manifestPath = join(dataRoot, 'manifest-sr.json');
  const auditsDir = join(dataRoot, 'ui-audits');

  // Ensure audits directory exists
  await mkdir(auditsDir, { recursive: true });

  const jobs = await AuditJobs.open(join(dataRoot, 'audit-jobs.sqlite'), options.auditExecutor ?? (async job => {
    const validUrl = job.url; const device = job.device;
        const protocol: Protocol = {
          device: device === 'desktop' ? 'desktop' : 'mobile',
          runs: 3,
          location: 'Live UI Audit',
          consent: 'no-interaction',
          browserCache: 'cold',
          cdnCache: 'unknown',
          notes: 'Single live capture from dashboard',
        };

        const captureResult = await captureLighthouse(validUrl, protocol);
        const rawLhr = captureResult.raw as any;

        // Save raw audit for audit trail
        const auditId = job.id;
        const auditRawPath = join(auditsDir, `${auditId}.json`);
        await atomicWrite(auditRawPath, JSON.stringify(rawLhr, null, 2));

        await writeJson(join(auditsDir, `${auditId}.trace.json`), captureResult.trace);
        await writeJson(join(auditsDir, `${auditId}.network.json`), captureResult.network);

        // Normalize and extract resources
        const normalized = normalizeMeasurement(rawLhr, {
          id: auditId,
          storeId: new URL(validUrl).hostname,
          pageId: auditId,
          requestedUrl: validUrl,
          rawFile: auditRawPath,
          rawSha256: sha256(JSON.stringify(rawLhr, null, 2)),
        });

        const plan = generateRemediationPlan(rawLhr);

        return {
          id: auditId,
          url: validUrl,
          device: protocol.device,
          score: normalized.metrics.performance,
          metrics: {
            lcpMs: normalized.metrics.lcpMs,
            tbtMs: normalized.metrics.tbtMs,
            cls: normalized.metrics.cls,
            fcpMs: normalized.metrics.fcpMs,
            ttfbMs: normalized.metrics.ttfbMs,
            imageBytes: normalized.metrics.imageTransferBytes,
            totalBytes: normalized.metrics.totalTransferBytes,
          },
          capturedAt: normalized.fetchedAt,
          measurement: normalized,
          resources: normalized.resources,
          remediation: plan,
        };
  }), false);

  const getUiHtml = async (): Promise<string> => {
    const candidatePaths = [
      options.uiHtmlPath,
      join(__dirname, 'ui', 'index.html'),
      join(projectRoot, 'src', 'ui', 'index.html'),
      join(projectRoot, 'dist', 'ui', 'index.html'),
    ].filter(Boolean) as string[];

    for (const p of candidatePaths) {
      try {
        return await readFile(p, 'utf8');
      } catch { /* continue */ }
    }
    return '<h1>MerchantPro Lab Control Panel</h1>';
  };

  const server = http.createServer(async (req, res) => {
    const address = server.address();
    const expectedHost = `${host}:${typeof address === 'object' && address ? address.port : port}`;
    const expectedOrigin = `http://${expectedHost}`;
    if (req.headers.host !== expectedHost ||
        (req.headers.origin !== undefined && req.headers.origin !== expectedOrigin) ||
        req.headers['sec-fetch-site'] === 'cross-site' ||
        (req.method === 'POST' && req.headers['x-merchantpro-request'] !== '1')) {
      res.writeHead(403); res.end('Zahtev nije dozvoljen.'); return;
    }
    const parsedUrl = new URL(req.url ?? '/', expectedOrigin);
    const pathname = parsedUrl.pathname;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') { res.writeHead(403); res.end(); return; }

    // Helper: read request body
    const readBody = async (): Promise<Buffer> => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 20 * 1024 * 1024) throw new Error('Zahtev prelazi ograničenje od 20 MB.');
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      return Buffer.concat(chunks);
    };

    // Helper: JSON response
    const sendJson = (status: number, data: any) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };

    try {
      // 1. Dashboard UI
      if (pathname === '/' || pathname === '/index.html') {
        const html = await getUiHtml();
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      // 2. Health & Status
      if (pathname === '/api/status') {
        sendJson(200, { status: 'ok', version: '0.1.0', mode: 'dynamic-production' });
        return;
      }

      // 3. Dynamic Manifest: GET stores
      if (pathname === '/api/manifest' && req.method === 'GET') {
        try {
          const manifest = await readManifest(manifestPath);
          sendJson(200, manifest);
        } catch {
          sendJson(200, { stores: [] });
        }
        return;
      }

      // 4. Dynamic Manifest: POST add store
      if (pathname === '/api/manifest/store' && req.method === 'POST') {
        const body = await readBody();
        const input = JSON.parse(body.toString('utf8'));
        const manifest = await readManifest(manifestPath);

        const newStore: Store = {
          id: safeId(input.id || input.name.toLowerCase().replace(/[^a-z0-9_-]/g, '-')),
          name: input.name,
          origin: input.origin,
          platform: input.platform || 'merchantpro',
          role: input.role || 'sample',
          market: input.market || 'RS',
          theme: input.theme || 'custom',
          notes: input.notes || '',
          pages: input.pages || [{ id: 'home', type: 'home', url: input.origin }],
        };

        manifest.stores.push(newStore);
        validateManifest(manifest);
        await writeJson(manifestPath, manifest);
        sendJson(200, { success: true, store: newStore, manifest });
        return;
      }

      // 5. Dynamic Benchmarks: scan data directory for real runs
      if (pathname === '/api/benchmarks' && req.method === 'GET') {
        const rows: any[] = [];
        const dataDir = dataRoot;
        try {
          const entries = await readdir(dataDir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory()) {
              const stateFile = join(dataDir, entry.name, 'state.json');
              try {
                const state = await readJson<RunState>(stateFile);
                rows.push(...benchmarkRows(state, entry.name));
              } catch { /* skip folders without state.json */ }
            }
          }
        } catch { /* ignore */ }

        sendJson(200, { rows: rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) });
        return;
      }

      if (pathname === '/api/audit/run' && req.method === 'POST') {
        try { sendJson(202, jobs.enqueue(JSON.parse((await readBody()).toString('utf8')))); }
        catch(e) { sendJson(400,{error: e instanceof Error ? e.message : 'Neispravan zahtev.'}); }
        return;
      }
      if (pathname === '/api/jobs' && req.method === 'GET') {
        sendJson(200,{jobs:jobs.list()}); return;
      }
      const jobRoute = pathname.match(/^\/api\/jobs\/([a-f0-9-]{36})(?:\/(result|cancel|retry))?$/);
      if (jobRoute) {
        const id = jobRoute[1]!; const action = jobRoute[2];
        const job = jobs.get(id);
        if (!job) { sendJson(404,{error:'Posao nije pronađen.'}); return; }
        try {
          if (!action && req.method === 'GET') sendJson(200,job);
          else if (action === 'result' && req.method === 'GET') sendJson(200,jobs.result(id));
          else if (action === 'cancel' && req.method === 'POST') sendJson(200,jobs.cancel(id));
          else if (action === 'retry' && req.method === 'POST') sendJson(202,jobs.retry(id));
          else sendJson(405,{error:'Metod nije podržan.'});
        } catch(e) { sendJson(409,{error:e instanceof Error ? e.message : 'Operacija nije uspela.'}); }
        return;
      }

      // 7. Dynamic Remediation: GET plan for specific audit or default
      if (pathname === '/api/remediation' && req.method === 'GET') {
        const fileParam = parsedUrl.searchParams.get('file');
        let lhrData: any = null;

        if (fileParam) {
          sendJson(400, { error: 'Čitanje proizvoljne putanje nije podržano; koristite poslednju sačuvanu analizu.' });
          return;
        } else {
          // Find the newest JSON in ui-audits or fallback to benchmark raw
          const candidateDirs = [
            auditsDir,
            join(projectRoot, 'data', 'kliklak-elfsight-2026-09-09-v2', 'raw'),
            join(projectRoot, 'data', 'benchmark-sr', 'raw'),
          ];
          for (const d of candidateDirs) {
            try {
              const files = await readdir(d);
              const dated = await Promise.all(files.filter(f => f.endsWith('.json') && !f.endsWith('.trace.json') && !f.endsWith('.network.json')).map(async f => ({f,time:(await stat(join(d,f))).mtimeMs})));
              const jsonFiles = dated.sort((a,b)=>b.time-a.time).map(x=>x.f);
              if (jsonFiles.length > 0) {
                lhrData = JSON.parse(await readFile(join(d, jsonFiles[0]!), 'utf8'));
                break;
              }
            } catch { /* continue */ }
          }
        }

        if (!lhrData) {
          sendJson(404, { error: 'Nema sačuvanih Lighthouse rezultata. Pokrenite analizu za bilo koji sajt.' });
          return;
        }

        const plan = generateRemediationPlan(lhrData);
        sendJson(200, plan);
        return;
      }

      // 8. Real Image Optimizer: POST image
      if (pathname === '/api/optimize' && req.method === 'POST') {
        const bodyBuffer = await readBody();
        const contentType = req.headers['content-type'] || '';
        let inputBuffer: Buffer;
        let filename = 'image.png';
        let profile: ImageProfile = 'medium';
        let format: 'webp' | 'avif' = 'webp';

        if (contentType.includes('multipart/form-data')) {
          const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
          const boundary = boundaryMatch ? (boundaryMatch[1] || boundaryMatch[2]) : '';
          if (!boundary) throw new Error('Nedostaje multipart boundary.');
          const parsed = parseMultipart(bodyBuffer, boundary);
          inputBuffer = parsed.buffer;
          filename = parsed.filename;
          if (parsed.fields.profile) profile = parsed.fields.profile as ImageProfile;
          if (parsed.fields.format) format = parsed.fields.format as 'webp' | 'avif';
        } else {
          const json = JSON.parse(bodyBuffer.toString('utf8'));
          inputBuffer = Buffer.from(json.imageBase64, 'base64');
          if (json.filename) filename = json.filename;
          if (json.profile) profile = json.profile;
          if (json.format) format = json.format;
        }

        const opt = await optimizeImage(inputBuffer, { profile, format, force: true });
        const baseName = filename.replace(/\.[^/.]+$/, '');
        const outFilename = `${baseName}.${opt.format}`;

        sendJson(200, {
          filename: outFilename,
          format: opt.format,
          width: opt.width,
          height: opt.height,
          originalBytes: opt.originalBytes,
          optimizedBytes: opt.optimizedBytes,
          savedBytes: opt.savedBytes,
          savedPercent: opt.savedPercent,
          base64: opt.buffer.toString('base64'),
        });
        return;
      }

      // 9. MerchantPro API Catalog Inventory Fetch
      if (pathname === '/api/inventory/fetch' && req.method === 'POST') {
        const body = await readBody();
        const { origin, username, secret, maxProducts = 20 } = JSON.parse(body.toString('utf8'));
        if (!origin || !username || !secret) {
          sendJson(400, { error: 'Navedite origin, username i secret za MerchantPro API.' });
          return;
        }
        const result = await inventory({
          origin,
          username,
          secret,
          maxProducts: Number(maxProducts),
          includeImages: true,
        });
        sendJson(200, result);
        return;
      }

      // 10. Rollback API
      if (pathname === '/api/rollback' && req.method === 'POST') {
        sendJson(410, { error: 'Rollback je dostupan kroz lokalnu CLI komandu rollback --job.' });
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
    } catch (err: any) {
      sendJson(500, { error: err.message || 'Serverska greška.' });
    }
  });

  try { await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(port, host, () => resolvePromise());
  }); } catch(e) { await jobs.close(); throw e; }

  jobs.start();
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const url = `http://${host}:${actualPort}`;

  return {
    server,
    url,
    close: async () => {
      await new Promise<void>((res, rej) => server.close(err => (err ? rej(err) : res())));
      await jobs.close();
    },
  };
}
