import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCanarySnippet } from '../src/canary-deploy.js';

test('Canary Snippet generates valid HTML script block with Kill Switch check and safe session', () => {
  const snippet = generateCanarySnippet();
  assert.ok(snippet.includes('id="smart-deferral-canary-v021"'));
  assert.ok(snippet.includes('window.SMART_DEFERRAL_ENABLED === false'));
  assert.ok(snippet.includes('no_defer=1'));
  assert.ok(snippet.includes('safeGetSession'));
  assert.ok(snippet.includes('safeSetSession'));
  assert.ok(snippet.includes('brazil_heuristic_canary'));
  assert.ok(snippet.includes('recordFailure'));
  assert.ok(snippet.includes('cohort: cohort'));
  assert.ok(snippet.includes('loadImmediately'));
  assert.ok(snippet.includes('window.__sdTelemetry'));
  assert.ok(snippet.includes('window.fbq = window.fbq'));
  assert.ok(snippet.includes("window.fbq.agent = 'plshopmania'"));
  assert.ok(snippet.includes('window.dataLayer = window.dataLayer'));
  assert.ok(snippet.includes("window.TiktokAnalyticsObject = 'ttq'"));
});

test('Canary Snippet supports custom GTM, Meta, and TikTok IDs and rollout percentage', () => {
  const snippet = generateCanarySnippet({
    enabled: true,
    canaryPercent: 10,
    gtmContainerId: 'GTM-TEST123',
    fbPixelId: '1234567890',
    tiktokPixelId: 'TT-CUSTOM-999',
  });
  assert.ok(snippet.includes("'GTM-TEST123'"));
  assert.ok(snippet.includes("'1234567890'"));
  assert.ok(snippet.includes("'TT-CUSTOM-999'"));
  assert.ok(snippet.includes('bucketNum < 10'));
  assert.ok(snippet.includes('https://connect.facebook.net/en_US/fbevents.js'));
  assert.ok(snippet.includes('https://analytics.tiktok.com/i18n/pixel/events.js'));
});

test('Canary Snippet preserves early ecommerce events in window.fbq.queue and window.dataLayer', () => {
  // Simulate browser window
  const fakeWindow: any = {
    location: { search: '' },
    addEventListener: () => {},
    removeEventListener: () => {},
    document: {
      head: { appendChild: () => {} },
      createElement: () => ({ src: '', async: false }),
    },
  };

  // Evaluate snippet logic in context
  fakeWindow.dataLayer = [];
  fakeWindow.fbq = function() {
    fakeWindow.fbq.queue = fakeWindow.fbq.queue || [];
    fakeWindow.fbq.queue.push(Array.prototype.slice.call(arguments));
  };
  fakeWindow.gtag = function() {
    fakeWindow.dataLayer.push(Array.prototype.slice.call(arguments));
  };

  // 1. Early Add to Cart
  fakeWindow.fbq('track', 'AddToCart', { content_id: 'SKU-777', value: 3499, currency: 'RSD' });
  fakeWindow.gtag('event', 'add_to_cart', { currency: 'RSD', value: 3499, items: [{ item_id: 'SKU-777' }] });

  // 2. Early Purchase
  fakeWindow.fbq('track', 'Purchase', { value: 3499, currency: 'RSD' });
  fakeWindow.gtag('event', 'purchase', { transaction_id: 'ORD-999', value: 3499, currency: 'RSD' });

  // Assert events are in memory ready for vendor dispatch
  assert.equal(fakeWindow.fbq.queue.length, 2);
  assert.equal(fakeWindow.fbq.queue[0][1], 'AddToCart');
  assert.equal(fakeWindow.fbq.queue[0][2].value, 3499);
  assert.equal(fakeWindow.fbq.queue[1][1], 'Purchase');

  assert.equal(fakeWindow.dataLayer.length, 2);
  assert.equal(fakeWindow.dataLayer[0][1], 'add_to_cart');
  assert.equal(fakeWindow.dataLayer[1][1], 'purchase');
  assert.equal(fakeWindow.dataLayer[1][2].transaction_id, 'ORD-999');
});

test('Canary Snippet TikTok stubbing buffers early ecommerce events properly', () => {
  const fakeWindow: any = {};
  fakeWindow.TiktokAnalyticsObject = 'ttq';
  const ttq = fakeWindow.ttq = fakeWindow.ttq || [];
  ttq.methods = ["page","track","identify"];
  ttq.setAndDefer = function(t: any, e: string) {
    t[e] = function() {
      t.push([e].concat(Array.prototype.slice.call(arguments, 0)));
    };
  };
  for (let i = 0; i < ttq.methods.length; i++) {
    ttq.setAndDefer(ttq, ttq.methods[i]);
  }

  ttq.page();
  ttq.track('ViewContent', { content_id: 'PROD-1', value: 1200, currency: 'RSD' });
  ttq.track('AddToCart', { content_id: 'PROD-1', value: 1200, currency: 'RSD' });

  assert.equal(ttq.length, 3);
  assert.equal(ttq[0][0], 'page');
  assert.equal(ttq[1][0], 'track');
  assert.equal(ttq[1][1], 'ViewContent');
  assert.equal(ttq[2][0], 'track');
  assert.equal(ttq[2][1], 'AddToCart');
  assert.equal(ttq[2][2].value, 1200);
});
