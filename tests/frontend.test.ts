import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const executablePath = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(p => p && existsSync(p));

test('frontend preserves data boundaries, period selection, filtering and confirmed configuration writes', { skip: !executablePath }, async t => {
  const store = { id: 'store', name: 'Test prodavnica', domain: 'test.example', platform: 'merchantpro', status: 'live', killSwitch: false, canaryPercent: 1, vendors: { meta: true, gtm: true, tiktok: false } };
  const metrics: any = { totalSessions: 0, totalErrors: 0, recentSessions: [], countryBreakdown: {}, searchCrawlers: 0, baselineBlockingMs: 11300, optimizedBlockingMs: 6900 };
  // Controlled API fixtures only. SQL aggregation is separately tested against Postgres.
  const view = () => {
    const rows = metrics.recentSessions;
    const latest = rows[0];
    return { source: { kind: 'postgres', available: true }, totalSessions: null, storeStatus: null,
      summaryReports: rows.length, recordCount: rows.length, errorReports: 0,
      lastTelemetryAt: latest?.timestamp ?? null, performanceSampleCount: rows.length,
      performanceMedian: rows.length ? 120 : null, performanceP75: rows.length >= 20 ? 180 : null,
      performanceHistory: rows.length ? [{ timestamp: latest.timestamp, sampleSize: rows.length, median: 120, p75: rows.length >= 20 ? 180 : null }] : [],
      vendors: Object.fromEntries(['meta', 'gtm', 'tiktok'].map(k => [k, { latestState: latest?.[k], lastObservedAt: latest?.timestamp, fresh: latest && Date.now() - latest.timestamp < 86400000 }])),
      recentSessions: rows.map((s: any) => ({ ...s, type: 'session_summary', pageHost: 'test.example', pagePath: '/product/one' })),
    };
  };
  const writes: any[] = [];
  let role = 'CLIENT', fail = false;
  const requests: string[] = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost'); requests.push(req.url!);
    if (!url.pathname.startsWith('/api/')) {
      const name = url.pathname === '/admin' ? 'admin' : url.pathname === '/login' ? 'login' : 'dashboard';
      res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(readFileSync(new URL(`../ui/${name}.html`, import.meta.url))); return;
    }
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/auth/me') { res.end(JSON.stringify({ user: { email: 'test@example.com', role } })); return; }
    if (url.pathname.endsWith('/config')) {
      let body = ''; for await (const chunk of req) body += chunk;
      const payload = JSON.parse(body); writes.push(payload); Object.assign(store, payload);
      res.end(JSON.stringify({ ok: true, store })); return;
    }
    if (fail) { res.statusCode = 503; res.end('{}'); return; }
    if (url.pathname === '/api/admin/stores') { res.end(JSON.stringify({ stores: [{ ...store, metrics: view() }] })); return; }
    res.end(JSON.stringify({ store, metrics: view() }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const browser = await puppeteer.launch({ executablePath, headless: true }); t.after(() => browser.close());
  const page = await browser.newPage();
  const errors: string[] = []; page.on('pageerror', error => errors.push(String(error)));
  await page.goto(base + '/dashboard'); await page.waitForSelector('[data-tab="tracking"]');
  assert.equal(await page.$('.status.ok'), null, 'Empty telemetry must never be healthy');
  assert.match(await page.$eval('#detail', el => el.textContent!), /Runtime: Nema podataka/);
  assert.equal(await page.$('#config'), null);
  await page.click('[data-period="7d"]'); await page.waitForFunction(() => document.querySelector('[data-period="7d"]')?.getAttribute('aria-pressed') === 'true');
  assert.ok(requests.includes('/api/client/overview?period=7d'));
  metrics.totalSessions = 25;
  metrics.recentSessions = Array.from({ length: 25 }, (_, i) => ({ timestamp: Date.now() - i * 60000, country: 'US', cohort: 'foreign_canary', longTaskBlockingMs: i * 10, errorsCount: 0, eventsBuffered: 0, meta: 'loaded', gtm: 'loaded', tiktok: 'loaded', url: 'https://test.example/product/one' }));
  await page.click('#refresh'); await page.waitForSelector('.chart');
  assert.match(await page.$eval('#detail', el => el.textContent!), /Control\/Optimized: Nema podataka/);
  assert.doesNotMatch(await page.$eval('#sessionTable', el => el.textContent!), /Kupac|Meta crawler/);
  assert.equal(await page.$eval('.path', el => el.textContent), '/product/one');
  assert.ok(await page.$('.status.ok'), 'Explicit recent loaded states support script health');
  metrics.recentSessions[0].meta = 'failed';
  metrics.recentSessions[0].errorsCount = 2;
  metrics.recentSessions[0].url = 'javascript:alert(1)';
  metrics.recentSessions[0].country = '<img src=x onerror=alert(1)>';
  await page.click('#refresh'); await page.waitForSelector('.status.error');
  assert.equal(await page.$('#detail img'), null, 'Telemetry strings must be escaped');
  assert.equal(await page.$('a[href^="javascript:"]'), null);
  fail = true; await page.click('#refresh'); await page.waitForSelector('#retry');
  assert.match(await page.$eval('#message', el => el.textContent!), /nisu osveženi/);
  fail = false; await page.click('#retry'); await page.waitForSelector('.chart');
  // An older successful record must not keep a green status alive.
  metrics.recentSessions.forEach((s: any) => { s.timestamp = Date.now() - 172800000; s.meta = 'loaded'; });
  await page.click('#refresh'); await page.waitForFunction(() => !document.querySelector('.status.ok'));
  role = 'ADMIN'; await page.goto(base + '/admin'); await page.waitForSelector('[data-tab="config"]');
  await page.click('[data-tab="sessions"]'); await page.waitForSelector('#errorsOnly'); await page.click('#errorsOnly');
  assert.equal(await page.$$eval('#sessionTable tbody tr', rows => rows.length), 1);
  await page.click('[data-tab="config"]'); await page.click('[data-rollout="5"]'); await page.click('#vendor-tiktok');
  await page.click('#config button[type="submit"]'); await page.waitForFunction(() => document.getElementById('message')?.textContent === 'Konfiguracija je sačuvana.');
  assert.deepEqual(writes[0], { canaryPercent: 5, killSwitch: false, vendors: { meta: true, gtm: true, tiktok: true } });
  await page.click('#emergency'); await page.click('#cancel'); assert.equal(writes.length, 1);
  await page.click('#emergency'); await page.click('#confirmDisable');
  await page.waitForFunction(() => !(document.getElementById('enabled') as HTMLInputElement)?.checked);
  assert.deepEqual(writes[1], { killSwitch: true }, 'Emergency action must not apply unsaved vendor/rollout changes');
  await page.setViewport({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Mobile page must not overflow');
  await page.goto(base + '/login'); await page.waitForSelector('#loginForm');
  assert.match(await page.$eval('.loginbox', el => el.textContent!), /Nadzor performansi i tracking integracija/);
  assert.doesNotMatch(await page.content(), /client123|admin123/);
  assert.deepEqual(errors, []);
});
