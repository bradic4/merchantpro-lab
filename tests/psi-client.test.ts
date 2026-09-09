import assert from 'node:assert/strict';
import test from 'node:test';
import { PsiClient, PsiError, validatePsiUrl, fetchPsi, type PsiOptions } from '../src/psi-client.js';

const defaults: PsiOptions = { url: 'https://example.com', strategy: 'mobile' };
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers });

function harness(responses: Array<Response | Error>, overrides: Partial<PsiOptions> = {}) {
  let time = Date.parse('2026-09-08T12:00:00Z');
  const requests: Array<{ url: URL; options: RequestInit; at: number }> = [];
  const waits: number[] = [];
  const fetch: typeof globalThis.fetch = async (input, options) => {
    requests.push({ url: new URL(String(input)), options: options!, at: time });
    const response = responses.shift();
    assert.ok(response, 'Unexpected extra request');
    if (response instanceof Error) throw response;
    return response;
  };
  const client = new PsiClient({ ...defaults, ...overrides }, {
    fetch, now: () => time, sleep: async ms => { waits.push(ms); time += ms; }, timeoutMs: 10000
  });
  return { client, requests, waits };
}

function code(expected: string) {
  return (error: unknown) => {
    assert.ok(error instanceof PsiError);
    assert.equal(error.code, expected);
    if (defaults.apiKey) {
      assert.ok(!error.message.includes(defaults.apiKey));
    }
    return true;
  };
}

test('validates URL correctly', () => {
  assert.equal(validatePsiUrl('https://example.com/'), 'https://example.com/');
  assert.equal(validatePsiUrl('https://example.com/path?q=1'), 'https://example.com/path?q=1');
  for (const value of ['http://example.com', 'https://user:pass@example.com', 'https://localhost', 'https://192.168.1.1']) {
    assert.throws(() => validatePsiUrl(value), code('INVALID_URL'), value);
  }
});

test('valid PSI response is returned correctly', async () => {
  const { client, requests, waits } = harness([json({ lighthouseResult: { categories: { performance: { score: 0.9 } } } })]);
  const result = await client.fetchPsi();
  assert.equal(requests.length, 1);
  assert.deepEqual(result, { lighthouseResult: { categories: { performance: { score: 0.9 } } } });

  const url = requests[0].url;
  assert.equal(url.searchParams.get('url'), 'https://example.com/');
  assert.equal(url.searchParams.get('strategy'), 'mobile');
  assert.equal(url.searchParams.get('category'), 'performance');
  assert.ok(!url.searchParams.has('key'));
});

test('API key is included in request URL when provided', async () => {
  const { client, requests } = harness([json({})], { apiKey: 'secret-key-123' });
  await client.fetchPsi();
  assert.equal(requests[0].url.searchParams.get('key'), 'secret-key-123');
});

test('API key is NOT included when not provided', async () => {
  const { client, requests } = harness([json({})]);
  await client.fetchPsi();
  assert.ok(!requests[0].url.searchParams.has('key'));
});

test('rate limiting paces every request', async () => {
  const { client, requests, waits } = harness([json({}), json({})]);
  await client.fetchPsi();
  await client.fetchPsi();
  assert.equal(requests.length, 2);
  assert.deepEqual(waits, [1000]);
});

test('HTTP 429 retries with Retry-After', async () => {
  const { client, requests, waits } = harness([json({}, 429, { 'Retry-After': '3' }), json({})]);
  await client.fetchPsi();
  assert.equal(requests.length, 2);
  assert.deepEqual(waits, [3000]);
});

test('HTTP 5xx retries with exponential backoff', async () => {
  const { client, requests, waits } = harness([json({}, 500), json({}, 502), json({}, 503)]);
  await assert.rejects(client.fetchPsi(), code('RETRY_EXHAUSTED'));
  assert.equal(requests.length, 3);
  assert.deepEqual(waits, [2000, 4000]); // attempt 0 retry (2000), attempt 1 retry (4000)
});

test('HTTP 400/403 errors not retried', async () => {
  const { client, requests } = harness([json({}, 400)]);
  await assert.rejects(client.fetchPsi(), code('HTTP_ERROR'));
  assert.equal(requests.length, 1);
});

test('timeout handling', async () => {
  const client = new PsiClient(defaults, {
    timeoutMs: 10,
    fetch: async (_input, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(new Error('AbortError')), { once: true });
    })
  });
  await assert.rejects(client.fetchPsi(), code('TIMEOUT'));
});

test('API key not exposed in error messages', async () => {
  const { client } = harness([new TypeError('Network failed with secret-key-123')], { apiKey: 'secret-key-123' });
  await assert.rejects(client.fetchPsi(), (err) => {
    assert.ok(err instanceof PsiError);
    assert.ok(!err.message.includes('secret-key-123'));
    assert.ok(err.message.includes('[redacted]'));
    return true;
  });
});
