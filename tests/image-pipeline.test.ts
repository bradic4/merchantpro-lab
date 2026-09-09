import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { optimizeImage, generateResponsiveSet } from '../src/image-pipeline.js';

test('optimizeImage resizes and converts large PNG to WebP', async () => {
  // Create a 1200x800 test PNG
  const inputBuffer = await sharp({
    create: { width: 1200, height: 800, channels: 3, background: { r: 200, g: 100, b: 50 } },
  })
    .png()
    .toBuffer();

  const result = await optimizeImage(inputBuffer, { profile: 'thumb' });

  assert.equal(result.skipped, false);
  assert.equal(result.format, 'webp');
  assert.equal(result.width, 320);
  // Aspect ratio preserved: 1200x800 -> 320x213
  assert.equal(result.height, 213);
  assert.ok(result.optimizedBytes < result.originalBytes);
  assert.ok(result.savedBytes > 0);
  assert.ok(result.savedPercent > 0);
});

test('optimizeImage skips images that are already small and within limits', async () => {
  // Create a tiny 100x100 webp
  const tinyBuffer = await sharp({
    create: { width: 100, height: 100, channels: 3, background: { r: 50, g: 50, b: 50 } },
  })
    .webp({ quality: 80 })
    .toBuffer();

  const result = await optimizeImage(tinyBuffer, { profile: 'large' });

  assert.equal(result.skipped, true);
  assert.ok(result.skipReason?.includes('već optimalne'));
  assert.equal(result.savedBytes, 0);
});

test('generateResponsiveSet creates thumb, medium, large variants and valid srcset', async () => {
  const inputBuffer = await sharp({
    create: { width: 1800, height: 1200, channels: 4, background: { r: 10, g: 150, b: 200, alpha: 0.8 } },
  })
    .png()
    .toBuffer();

  const set = await generateResponsiveSet(inputBuffer, 'product-image.png');

  assert.equal(set.variants.length, 3);
  const [thumb, medium, large] = set.variants;

  assert.equal(thumb?.profile, 'thumb');
  assert.equal(thumb?.width, 320);
  assert.equal(thumb?.filename, 'product-image-thumb.webp');

  assert.equal(medium?.profile, 'medium');
  assert.equal(medium?.width, 800);
  assert.equal(medium?.filename, 'product-image-medium.webp');

  assert.equal(large?.profile, 'large');
  assert.equal(large?.width, 1600);
  assert.equal(large?.filename, 'product-image-large.webp');

  assert.match(set.suggestedSrcset, /product-image-thumb\.webp 320w/);
  assert.match(set.suggestedSrcset, /product-image-medium\.webp 800w/);
  assert.match(set.suggestedSrcset, /product-image-large\.webp 1600w/);
  assert.ok(set.suggestedSizes.includes('320px'));
});
