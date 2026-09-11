import test from 'node:test';
import assert from 'node:assert/strict';
import { auditResponsiveImages } from '../src/responsive-audit.js';

test('auditResponsiveImages detects /p/l/ on mobile and calculates savings', () => {
  const fakeLhr = {
    configSettings: { formFactor: 'mobile' },
    requestedUrl: 'https://www.prodavnica.rs/',
    audits: {
      'largest-contentful-paint-element': {
        details: {
          items: [{ url: 'https://c.cdnmp.net/123/p/l/hero.webp' }],
        },
      },
      'network-requests': {
        details: {
          items: [
            { url: 'https://c.cdnmp.net/123/p/l/hero.webp', mimeType: 'image/webp', transferSize: 100000 },
            { url: 'https://c.cdnmp.net/123/p/l/product1.webp', mimeType: 'image/webp', transferSize: 200000 },
            { url: 'https://c.cdnmp.net/123/p/m/product2.webp', mimeType: 'image/webp', transferSize: 40000 },
          ],
        },
      },
    },
  };

  const result = auditResponsiveImages(fakeLhr);
  assert.ok(result);
  assert.equal(result.totalImages, 3);
  assert.equal(result.merchantProImages, 3);
  assert.equal(result.device, 'mobile');

  // Should have detected oversized-variant issues for /p/l/
  const oversized = result.issues.filter(i => i.type === 'oversized-variant');
  assert.equal(oversized.length, 2);
  assert.ok(result.totalEstimatedSavingsBytes > 0);
});

test('auditResponsiveImages detects late LCP image missing preload', () => {
  const items: any[] = [];
  // 15 script/css items first
  for (let i = 0; i < 15; i++) {
    items.push({ url: `https://www.prodavnica.rs/asset-${i}.js`, mimeType: 'application/javascript', transferSize: 5000 });
  }
  // Then the LCP image
  items.push({ url: 'https://c.cdnmp.net/123/p/l/hero.webp', mimeType: 'image/webp', transferSize: 120000 });

  const fakeLhr = {
    configSettings: { formFactor: 'mobile' },
    requestedUrl: 'https://www.prodavnica.rs/',
    audits: {
      'largest-contentful-paint-element': {
        details: {
          items: [{ url: 'https://c.cdnmp.net/123/p/l/hero.webp' }],
        },
      },
      'network-requests': {
        details: { items },
      },
    },
  };

  const result = auditResponsiveImages(fakeLhr);
  assert.ok(result);
  const lcpIssue = result.issues.find(i => i.type === 'lcp-not-preloaded');
  assert.ok(lcpIssue);
  assert.equal(lcpIssue.severity, 'critical');
  assert.match(lcpIssue.suggestion, /<link rel="preload"/);
});

test('auditResponsiveImages returns null gracefully for invalid inputs', () => {
  assert.equal(auditResponsiveImages(null), null);
  assert.equal(auditResponsiveImages({}), null);
});
