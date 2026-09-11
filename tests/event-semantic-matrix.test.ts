import test from 'node:test';
import assert from 'node:assert/strict';
import { SmartEventBuffer } from '../src/event-buffer.js';

test('Semantic Event Matrix: verifies 100% mapping across GA4, Meta, and TikTok', () => {
  const buffer = new SmartEventBuffer();

  const sampleItem = {
    item_id: 'SKU-5499',
    item_name: 'Baštenska Stolica Premium',
    price: 5499,
    quantity: 1,
  };

  // 1. Page load
  buffer.push('google', 'page_view', ['event', 'page_view', { page_title: 'Proizvod' }]);
  buffer.push('meta', 'PageView', ['track', 'PageView']);
  buffer.push('tiktok', 'page', ['page']);

  // 2. Product view
  buffer.push('google', 'view_item', ['event', 'view_item', { currency: 'RSD', value: 5499, items: [sampleItem] }]);
  buffer.push('meta', 'ViewContent', ['track', 'ViewContent', { content_ids: ['SKU-5499'], content_name: 'Baštenska Stolica Premium', value: 5499, currency: 'RSD' }]);
  buffer.push('tiktok', 'ViewContent', ['track', 'ViewContent', { content_id: 'SKU-5499', value: 5499, currency: 'RSD' }]);

  // 3. Add to Cart (Fast interaction)
  buffer.push('google', 'add_to_cart', ['event', 'add_to_cart', { currency: 'RSD', value: 5499, items: [sampleItem] }]);
  buffer.push('meta', 'AddToCart', ['track', 'AddToCart', { content_ids: ['SKU-5499'], value: 5499, currency: 'RSD' }]);
  buffer.push('tiktok', 'AddToCart', ['track', 'AddToCart', { content_id: 'SKU-5499', value: 5499, currency: 'RSD' }]);

  // 4. View Cart
  buffer.push('google', 'view_cart', ['event', 'view_cart', { currency: 'RSD', value: 5499, items: [sampleItem] }]);

  // 5. Checkout
  buffer.push('google', 'begin_checkout', ['event', 'begin_checkout', { currency: 'RSD', value: 5499, items: [sampleItem] }]);
  buffer.push('meta', 'InitiateCheckout', ['track', 'InitiateCheckout', { num_items: 1, value: 5499, currency: 'RSD' }]);
  buffer.push('tiktok', 'InitiateCheckout', ['track', 'InitiateCheckout', { value: 5499, currency: 'RSD' }]);

  // 6. Purchase
  const purchasePayload = {
    transaction_id: 'ORD-12345',
    value: 5499,
    currency: 'RSD',
    items: [sampleItem],
  };
  buffer.push('google', 'purchase', ['event', 'purchase', purchasePayload]);
  buffer.push('meta', 'Purchase', ['track', 'Purchase', { content_ids: ['SKU-5499'], value: 5499, currency: 'RSD' }]);
  buffer.push('tiktok', 'CompletePayment', ['track', 'CompletePayment', { content_id: 'SKU-5499', value: 5499, currency: 'RSD' }]);

  // VERIFY COUNTS ACROSS MATRIX
  const ga4Events = buffer.getEvents('google');
  const metaEvents = buffer.getEvents('meta');
  const tiktokEvents = buffer.getEvents('tiktok');

  assert.equal(ga4Events.length, 6, 'GA4 must have all 6 lifecycle events');
  assert.equal(metaEvents.length, 5, 'Meta must have 5 events (no view_cart)');
  assert.equal(tiktokEvents.length, 5, 'TikTok must have 5 events (no view_cart)');

  // VERIFY SEMANTIC VALUES IN PURCHASE EVENT
  const ga4Purchase = ga4Events.find(e => e.eventName === 'purchase')!;
  assert.equal(ga4Purchase.args[2].transaction_id, 'ORD-12345');
  assert.equal(ga4Purchase.args[2].value, 5499);
  assert.equal(ga4Purchase.args[2].currency, 'RSD');

  const metaPurchase = metaEvents.find(e => e.eventName === 'Purchase')!;
  assert.equal(metaPurchase.args[2].value, 5499);
  assert.equal(metaPurchase.args[2].currency, 'RSD');

  const tiktokPurchase = tiktokEvents.find(e => e.eventName === 'CompletePayment')!;
  assert.equal(tiktokPurchase.args[2].value, 5499);
  assert.equal(tiktokPurchase.args[2].currency, 'RSD');

  // FLUSH AND VERIFY FLUSH COUNTS
  const flushedGA4: any[] = [];
  const flushedMeta: any[] = [];
  const flushedTikTok: any[] = [];

  buffer.flush('google', (...args) => flushedGA4.push(args));
  buffer.flush('meta', (...args) => flushedMeta.push(args));
  buffer.flush('tiktok', (...args) => flushedTikTok.push(args));

  assert.equal(flushedGA4.length, 6);
  assert.equal(flushedMeta.length, 5);
  assert.equal(flushedTikTok.length, 5);

  // Verify that all events are marked flushed and second flush sends ZERO duplicates
  assert.equal(buffer.flush('google', () => {}), 0, 'Second flush must send 0 duplicate events');
  assert.equal(buffer.flush('meta', () => {}), 0, 'Second flush must send 0 duplicate events');
  assert.equal(buffer.flush('tiktok', () => {}), 0, 'Second flush must send 0 duplicate events');
});

test('Evil User Scenario: ultra-fast interaction before tracker init (0ms -> 500ms -> 900ms -> 1300ms -> 2000ms -> 5000ms SDK load)', async () => {
  const buffer = new SmartEventBuffer();
  const timeline: Array<{ timeMs: number; event: string }> = [];

  // Simulated clock
  let simTime = 0;

  // 0ms: Page opened
  simTime = 0;
  buffer.push('google', 'page_view', ['event', 'page_view']);
  buffer.push('meta', 'PageView', ['track', 'PageView']);
  timeline.push({ timeMs: simTime, event: 'page_view' });

  // 500ms: User clicks product
  simTime = 500;
  buffer.push('google', 'view_item', ['event', 'view_item', { item_id: 'SKU-999' }]);
  timeline.push({ timeMs: simTime, event: 'view_item' });

  // 900ms: User clicks Add to Cart
  simTime = 900;
  buffer.push('google', 'add_to_cart', ['event', 'add_to_cart', { item_id: 'SKU-999', price: 3200 }]);
  buffer.push('meta', 'AddToCart', ['track', 'AddToCart', { content_ids: ['SKU-999'], value: 3200 }]);
  timeline.push({ timeMs: simTime, event: 'add_to_cart' });

  // 1300ms: User opens cart
  simTime = 1300;
  buffer.push('google', 'view_cart', ['event', 'view_cart', { value: 3200 }]);
  timeline.push({ timeMs: simTime, event: 'view_cart' });

  // 2000ms: User begins checkout
  simTime = 2000;
  buffer.push('google', 'begin_checkout', ['event', 'begin_checkout', { value: 3200 }]);
  buffer.push('meta', 'InitiateCheckout', ['track', 'InitiateCheckout', { value: 3200 }]);
  timeline.push({ timeMs: simTime, event: 'begin_checkout' });

  // 5000ms: Trackers become eligible to initialize!
  simTime = 5000;
  timeline.push({ timeMs: simTime, event: 'sdk_initialized' });

  // AT THIS POINT (5000ms), SDK FINALLY LOADS AND FLUSHES:
  const replayGA4: string[] = [];
  const replayMeta: string[] = [];

  buffer.flush('google', (...args) => replayGA4.push(args[1])); // eventName is args[1]
  buffer.flush('meta', (...args) => replayMeta.push(args[1]));

  // VERIFY COMPLETE REPLAY IN EXACT CHRONOLOGICAL ORDER
  assert.deepEqual(replayGA4, [
    'page_view',
    'view_item',
    'add_to_cart',
    'view_cart',
    'begin_checkout',
  ], 'GA4 must replay all events in exact FIFO order');

  assert.deepEqual(replayMeta, [
    'PageView',
    'AddToCart',
    'InitiateCheckout',
  ], 'Meta must replay all events in exact FIFO order');

  // Verify no events were dropped or mangled during the 5000ms deferral window
  const stats = buffer.getStats();
  assert.equal(stats.total, 8);
  assert.equal(stats.flushed, 8);
  assert.equal(stats.pending, 0);
});
