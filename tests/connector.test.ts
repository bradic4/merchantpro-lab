import assert from 'node:assert/strict';
import test from 'node:test';
import { MerchantProClient, MerchantProError, retryDelay, validateOrigin, type InventoryOptions } from '../src/connector.js';

const defaults: InventoryOptions = { origin: 'https://store.example.com', username: 'api-user', secret: 'private-secret', maxProducts: 3, includeImages: false };
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers });
function page(data: unknown[], total = data.length, next: string | null = null, start = 0, limit = Math.max(1, data.length)) {
  return json({ data, meta: { count: { total, current: data.length, start, limit }, links: { next } } });
}
function harness(responses: Array<Response | Error>, overrides: Partial<InventoryOptions> = {}) {
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
  const client = new MerchantProClient({ ...defaults, ...overrides }, {
    fetch, now: () => time, sleep: async milliseconds => { waits.push(milliseconds); time += milliseconds; },
  });
  return { client, requests, waits };
}
function code(expected: string) {
  return (error: unknown) => {
    assert.ok(error instanceof MerchantProError);
    assert.equal(error.code, expected);
    assert.ok(!error.message.includes(defaults.secret));
    assert.ok(!error.message.includes(defaults.username));
    return true;
  };
}

test('canonical HTTPS store origin only; no paths, credentials, local hosts or IP literals', () => {
  assert.equal(validateOrigin('https://STORE.example.com/'), 'https://store.example.com');
  for (const value of ['http://store.example.com', 'https://x:y@store.example.com', 'https://store.example.com/path',
    'https://store.example.com/a/..', 'https://store.example.com/?q=1', 'https://store.example.com/?',
    'https://store.example.com/#', 'https://store.example.com:8443', 'https://localhost', 'https://foo.localhost',
    'https://foo.local', 'https://127.0.0.1', 'https://2130706433', 'https://[::1]', 'https://192.168.1.2']) {
    assert.throws(() => validateOrigin(value), code('INVALID_ORIGIN'), value);
  }
});

test('invalid limits and credential formats fail before any network request', () => {
  for (const maxProducts of [0, -1, 1.5, 1001, NaN]) assert.throws(() => new MerchantProClient({ ...defaults, maxProducts }), code('INVALID_OPTIONS'));
  assert.throws(() => new MerchantProClient({ ...defaults, requestIntervalMs: 0 }), code('INVALID_OPTIONS'));
  assert.throws(() => new MerchantProClient({ ...defaults, username: 'user:colon' }), code('INVALID_CREDENTIALS'));
  assert.throws(() => new MerchantProClient({ ...defaults, secret: 'bad\r\nvalue' }), code('INVALID_CREDENTIALS'));
});

test('GET inventory follows documented offset metadata, clamps remaining limit, and paces every request', async () => {
  const { client, requests, waits } = harness([
    page([{ id: 1, name: 'First' }, { id: 2, name: 'Second' }], 3, '/api/v2/products?start=2&limit=2', 0, 2),
    page([{ id: 3, name: 'Third' }], 3, null, 2, 1),
  ]);
  const result = await client.inventory();
  assert.equal(result.complete, true);
  assert.equal(result.totalAvailable, 3);
  assert.deepEqual(result.products.map(product => product.id), [1, 2, 3]);
  assert.equal(result.requests, 2);
  assert.deepEqual(requests.map(request => request.url.searchParams.get('start')), ['0', '2']);
  assert.deepEqual(requests.map(request => request.url.searchParams.get('limit')), ['3', '1']);
  assert.deepEqual(waits, [2000]);
  for (const request of requests) {
    assert.equal(request.options.method, 'GET');
    assert.equal(request.options.redirect, 'error');
    const headers = new Headers(request.options.headers);
    assert.equal(headers.get('Accept'), 'application/json');
    assert.equal(headers.get('Authorization'), `Basic ${Buffer.from('api-user:private-secret').toString('base64')}`);
    assert.equal(request.url.origin, defaults.origin);
    assert.ok(!request.url.toString().includes(defaults.secret));
    assert.equal(request.options.body, undefined);
  }
});

test('product cap reports incomplete inventory and never requests the next page', async () => {
  const { client, requests } = harness([page([{ id: 1 }, { id: 2 }], 10, '/api/v2/products?start=2&limit=2')], { maxProducts: 2 });
  const result = await client.inventory();
  assert.equal(result.products.length, 2);
  assert.equal(result.complete, false);
  assert.equal(requests.length, 1);
});

test('image GET returns a bare array; only documented image fields are exported', async () => {
  const { client, requests } = harness([
    page([{ id: 4, name: 'Product', api_secret: defaults.secret, meta_fields: { hidden: true } }]),
    json([{ id: 555, url: 'https://cdn.example.com/image.jpg', caption: 'Caption', dimensions: { l: { w: 1200, h: 1000 } }, custom_secret: defaults.secret }]),
  ], { includeImages: true });
  const result = await client.inventory();
  assert.equal(requests[1].url.pathname, '/api/v2/products/4/images');
  assert.deepEqual(result.products[0], { id: 4, name: 'Product', images: [{ id: 555, url: 'https://cdn.example.com/image.jpg', caption: 'Caption', dimensions: { l: { h: 1000, w: 1200 } } }] });
  assert.ok(!JSON.stringify(result).includes(defaults.secret));
  assert.ok(!JSON.stringify(client).includes(defaults.secret));
});

test('known credential echoes in allowed strings are redacted', async () => {
  const auth = `Basic ${Buffer.from('api-user:private-secret').toString('base64')}`;
  const { client } = harness([page([{ id: 1, name: `echo ${defaults.secret} ${auth}` }])]);
  assert.equal((await client.inventory()).products[0].name, 'echo [redacted] [redacted]');
});

for (const status of [401, 403]) test(`HTTP ${status} stops without retry or exposing response body`, async () => {
  const { client, requests } = harness([json({ error: defaults.secret }, status)]);
  await assert.rejects(client.inventory(), error => { code('AUTHENTICATION_FAILED')(error); assert.equal((error as MerchantProError).status, status); return true; });
  assert.equal(requests.length, 1);
});

test('redirect response is never followed; fetch redirect failures are sanitized', async () => {
  const redirected = harness([new Response(null, { status: 302, headers: { Location: 'https://other.example.com/api/v2/products' } })]);
  await assert.rejects(redirected.client.inventory(), code('REDIRECT_BLOCKED'));
  assert.equal(redirected.requests.length, 1);
  assert.equal(redirected.requests[0].options.redirect, 'error');
  const failed = harness([new TypeError(`redirect with ${defaults.secret}`)]);
  await assert.rejects(failed.client.inventory(), code('NETWORK_ERROR'));
  assert.equal(failed.requests.length, 1);
});

test('429 and 503 retry with Retry-After seconds and HTTP date, maintaining request spacing', async () => {
  const { client, waits, requests } = harness([
    json({}, 429, { 'Retry-After': '3' }),
    json({}, 503, { 'Retry-After': 'Tue, 08 Sep 2026 12:00:07 GMT' }),
    page([{ id: 1 }]),
  ]);
  assert.equal((await client.inventory()).requests, 3);
  assert.deepEqual(waits, [3000, 4000]);
  assert.equal(requests[2].at - requests[0].at, 7000);
});

test('transient server errors have at most two retries and exponential delay', async () => {
  const { client, requests, waits } = harness([json({}, 500), json({}, 502), json({}, 503)]);
  await assert.rejects(client.inventory(), code('RETRY_EXHAUSTED'));
  assert.equal(requests.length, 3);
  assert.deepEqual(waits, [2000, 4000]);
});

test('long or invalid Retry-After pauses inventory without an early retry', async () => {
  for (const header of ['31', '3600', 'invalid-delay']) {
    const { client, requests } = harness([json({}, 429, { 'Retry-After': header })]);
    await assert.rejects(client.inventory(), code('RETRY_PAUSED'));
    assert.equal(requests.length, 1);
  }
  assert.equal(retryDelay('0', Date.now(), 0), 0);
});

test('short Retry-After cannot bypass the 2 second request interval', async () => {
  const { client, waits } = harness([json({}, 429, { 'Retry-After': '0' }), page([])]);
  await client.inventory();
  assert.deepEqual(waits, [2000]);
});

test('HTTP 400 and malformed JSON are never retried or returned as raw errors', async () => {
  const badRequest = harness([json({ message: defaults.secret }, 400)]);
  await assert.rejects(badRequest.client.inventory(), code('HTTP_ERROR'));
  assert.equal(badRequest.requests.length, 1);
  const badJson = harness([new Response(`invalid ${defaults.secret}`, { status: 200 })]);
  await assert.rejects(badJson.client.inventory(), code('INVALID_RESPONSE'));
  assert.equal(badJson.requests.length, 1);
});

test('request timeout aborts fetch and hides underlying errors', async () => {
  const client = new MerchantProClient(defaults, {
    timeoutMs: 10,
    fetch: async (_input, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(new Error(defaults.secret)), { once: true });
    }),
  });
  await assert.rejects(client.inventory(), code('TIMEOUT'));
});

test('response byte bound is enforced before parsing', async () => {
  const { client } = harness([json({}, 200, { 'Content-Length': String(4 * 1024 * 1024 + 1) })]);
  await assert.rejects(client.inventory(), code('RESPONSE_TOO_LARGE'));
});

test('malicious or looping pagination URLs fail without a second request', async () => {
  for (const next of ['https://evil.example.com/api/v2/products?start=1', '//evil.example.com/api/v2/products?start=1',
    '/api/v2/orders?start=1', '/api/v2/products?start=0', '/api/v2/products?start=1&start=2',
    '/api/v2/products?start=1&access_token=secret', '/api/v2/products?start=99', '/api/v2/products?start=1#fragment']) {
    const { client, requests } = harness([page([{ id: 1 }], 2, next)]);
    await assert.rejects(client.inventory(), code('INVALID_RESPONSE'));
    assert.equal(requests.length, 1);
  }
});

test('repeated IDs, missing metadata and prematurely ended collections fail explicitly', async () => {
  const duplicate = harness([page([{ id: 1 }], 2, '/api/v2/products?start=1&limit=1'), page([{ id: 1 }], 2, null, 1, 1)]);
  await assert.rejects(duplicate.client.inventory(), code('INVALID_RESPONSE'));
  const missing = harness([json({ data: [] })]);
  await assert.rejects(missing.client.inventory(), code('INVALID_RESPONSE'));
  const truncated = harness([page([{ id: 1 }], 2)]);
  await assert.rejects(truncated.client.inventory(), code('INVALID_RESPONSE'));
});
