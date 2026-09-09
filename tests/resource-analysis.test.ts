import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeResources } from '../src/resource-analysis.js';

test('analyzeResources extracts images, LCP, blocking, DOM', () => {
  const lhr = {
    audits: {
      'network-requests': {
        details: {
          items: [
            { url: 'https://example.com/img1.jpg', mimeType: 'image/jpeg', transferSize: 1000, resourceSize: 1500, protocol: 'h2', statusCode: 200 },
            { url: 'https://example.com/script.js', mimeType: 'application/javascript', transferSize: 500, resourceSize: 500, protocol: 'h2', statusCode: 200 },
            { url: 'https://example.com/img2.webp', mimeType: 'image/webp', transferSize: 2000, resourceSize: 2000, protocol: 'h2', statusCode: 200 }
          ]
        }
      },
      'largest-contentful-paint-element': {
        details: {
          items: [
            {
              url: 'https://example.com/img2.webp',
              node: { nodeName: 'IMG' },
              type: 'image'
            }
          ]
        }
      },
      'render-blocking-resources': {
        details: {
          items: [
            { url: 'https://example.com/script.js', wastedMs: 150, totalBytes: 500 }
          ]
        }
      },
      'dom-size': {
        numericValue: 450
      }
    }
  };

  const result = analyzeResources(lhr);
  assert.ok(result);

  assert.equal(result.totalRequests, 3);
  assert.equal(result.images.length, 2);
  assert.equal(result.images[0]!.url, 'https://example.com/img1.jpg');
  assert.equal(result.images[0]!.isLcpElement, false);

  assert.equal(result.images[1]!.url, 'https://example.com/img2.webp');
  assert.equal(result.images[1]!.isLcpElement, true);

  assert.equal(result.totalImageBytes, 3000);

  assert.deepEqual(result.lcpElement, {
    url: 'https://example.com/img2.webp',
    type: 'image',
    tagName: 'IMG'
  });

  assert.equal(result.blockingResources.length, 1);
  assert.equal(result.blockingResources[0]!.url, 'https://example.com/script.js');
  assert.equal(result.totalBlockingMs, 150);

  assert.equal(result.domElements, 450);
});

test('analyzeResources handles missing audits gracefully', () => {
  assert.equal(analyzeResources({}), null);
  assert.equal(analyzeResources({ audits: {} }), null);
});

test('analyzeResources handles malformed audit data gracefully', () => {
  const lhr = {
    audits: {
      'network-requests': { details: { items: 'not-an-array' } },
      'largest-contentful-paint-element': { details: { items: [ null, 'string' ] } },
      'render-blocking-resources': { details: 'string' },
      'dom-size': { numericValue: 'not-a-number' }
    }
  };

  const result = analyzeResources(lhr);
  assert.ok(result);
  assert.equal(result.totalRequests, 0);
  assert.equal(result.images.length, 0);
  assert.equal(result.totalImageBytes, 0);
  assert.equal(result.lcpElement, null);
  assert.equal(result.blockingResources.length, 0);
  assert.equal(result.totalBlockingMs, 0);
  assert.equal(result.domElements, null);
});

test('analyzeResources falls back to largest-contentful-paint for LCP', () => {
  const lhr = {
    audits: {
      'largest-contentful-paint': {
        details: {
          items: [
            {
              url: 'https://example.com/hero.jpg',
              node: { nodeName: 'DIV' },
              type: 'text'
            }
          ]
        }
      }
    }
  };

  const result = analyzeResources(lhr);
  assert.ok(result);
  assert.deepEqual(result.lcpElement, {
    url: 'https://example.com/hero.jpg',
    type: 'text',
    tagName: 'DIV'
  });
});
