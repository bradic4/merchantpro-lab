import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.js';

test('server starts, responds to status, benchmarks, and serves dashboard', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'server-test-'));
  const handle = await startServer({ port: 0, dataDirectory: dir });
  try {
    const baseUrl = handle.url;

    // Test GET /
    const htmlRes = await fetch(`${baseUrl}/`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.match(html, /MerchantPro Lab/);

    // Test GET /api/status
    const statusRes = await fetch(`${baseUrl}/api/status`);
    assert.equal(statusRes.status, 200);
    const statusJson = await statusRes.json();
    assert.equal(statusJson.status, 'ok');

    // Test GET /api/benchmarks
    const benchRes = await fetch(`${baseUrl}/api/benchmarks`);
    assert.equal(benchRes.status, 200);
    const benchJson = await benchRes.json();
    assert.ok(Array.isArray(benchJson.rows));
    assert.ok(benchJson.rows.every((r: any) => r.pageId && r.device));
  } finally {
    await handle.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('server /api/optimize endpoint optimizes base64 image', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'server-test-'));
  const handle = await startServer({ port: 0, dataDirectory: dir });
  try {
    const sampleBuffer = await sharp({
      create: { width: 1000, height: 600, channels: 3, background: { r: 100, g: 150, b: 200 } },
    })
      .png()
      .toBuffer();

    const payload = {
      imageBase64: sampleBuffer.toString('base64'),
      filename: 'hero-banner.png',
      profile: 'thumb',
      format: 'webp',
    };

    const res = await fetch(`${handle.url}/api/optimize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-MerchantPro-Request': '1' },
      body: JSON.stringify(payload),
    });

    assert.equal(res.status, 200);
    const json = await res.json();

    assert.equal(json.filename, 'hero-banner.webp');
    assert.equal(json.format, 'webp');
    assert.equal(json.width, 320);
    assert.ok(json.savedBytes > 0);
    assert.ok(typeof json.base64 === 'string');
  } finally {
    await handle.close();
    await rm(dir, { recursive: true, force: true });
  }
});
