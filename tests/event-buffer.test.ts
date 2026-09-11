import test from 'node:test';
import assert from 'node:assert/strict';
import { SmartEventBuffer, generateSmartBufferSnippet } from '../src/event-buffer.js';

test('SmartEventBuffer captures full ecommerce lifecycle in FIFO order with zero loss', () => {
  const buffer = new SmartEventBuffer();

  // 1. page_view (Immediate upon landing)
  buffer.push('meta', 'PageView', ['track', 'PageView']);
  buffer.push('google', 'page_view', ['event', 'page_view', { page_location: 'https://store.example/item' }]);

  // 2. view_item (Product details rendered)
  const productData = { item_id: 'SKU-12345', item_name: 'Premium Baštenska Kanta', price: 4500, currency: 'RSD' };
  buffer.push('meta', 'ViewContent', ['track', 'ViewContent', { content_ids: ['SKU-12345'], value: 4500, currency: 'RSD' }]);
  buffer.push('google', 'view_item', ['event', 'view_item', { items: [productData] }]);

  // 3. add_to_cart (EARLY user click at 400ms before scripts are loaded!)
  buffer.push('meta', 'AddToCart', ['track', 'AddToCart', { content_ids: ['SKU-12345'], value: 4500, currency: 'RSD' }]);
  buffer.push('google', 'add_to_cart', ['event', 'add_to_cart', { items: [productData] }]);

  // 4. view_cart
  buffer.push('google', 'view_cart', ['event', 'view_cart', { items: [productData] }]);

  // 5. begin_checkout
  buffer.push('meta', 'InitiateCheckout', ['track', 'InitiateCheckout', { num_items: 1, value: 4500, currency: 'RSD' }]);
  buffer.push('google', 'begin_checkout', ['event', 'begin_checkout', { items: [productData] }]);

  // 6. purchase
  const orderData = { transaction_id: 'ORD-9876', value: 4500, currency: 'RSD', items: [productData] };
  buffer.push('meta', 'Purchase', ['track', 'Purchase', { value: 4500, currency: 'RSD' }]);
  buffer.push('google', 'purchase', ['event', 'purchase', orderData]);

  const metaEvents = buffer.getEvents('meta');
  const googleEvents = buffer.getEvents('google');

  // Verify zero loss: exactly 5 Meta events and 6 Google events
  assert.equal(metaEvents.length, 5);
  assert.equal(googleEvents.length, 6);

  // Verify FIFO sequence for Meta
  assert.deepEqual(metaEvents.map(e => e.eventName), [
    'PageView',
    'ViewContent',
    'AddToCart',
    'InitiateCheckout',
    'Purchase',
  ]);

  // Verify FIFO sequence for Google
  assert.deepEqual(googleEvents.map(e => e.eventName), [
    'page_view',
    'view_item',
    'add_to_cart',
    'view_cart',
    'begin_checkout',
    'purchase',
  ]);

  // Simulate deferred SDK loading and flushing to Meta fbq
  const flushedMetaCalls: any[] = [];
  const mockFbq = (...args: any[]) => flushedMetaCalls.push(args);
  const flushedCount = buffer.flush('meta', mockFbq);

  assert.equal(flushedCount, 5);
  assert.equal(flushedMetaCalls.length, 5);
  assert.equal(flushedMetaCalls[2][1], 'AddToCart'); // AddToCart was preserved and executed!

  // Check stats: 5 flushed, 6 pending (Google not flushed yet)
  const stats = buffer.getStats();
  assert.equal(stats.total, 11);
  assert.equal(stats.flushed, 5);
  assert.equal(stats.pending, 6);
});

test('SmartEventBuffer prevents duplicate event injections', () => {
  const buffer = new SmartEventBuffer();

  const ev1 = buffer.push('meta', 'PageView', ['track', 'PageView']);
  const ev2 = buffer.push('meta', 'PageView', ['track', 'PageView']); // Identical call

  assert.ok(ev1 !== null);
  assert.equal(ev2, null); // Duplicate blocked
  assert.equal(buffer.getEvents('meta').length, 1);
});

test('generateSmartBufferSnippet produces valid script', () => {
  const snippet = generateSmartBufferSnippet();
  assert.match(snippet, /window\.fbq/);
  assert.match(snippet, /window\.dataLayer/);
  assert.match(snippet, /window\.ttq/);
});
