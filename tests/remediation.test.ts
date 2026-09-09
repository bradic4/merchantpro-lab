import test from 'node:test';
import assert from 'node:assert/strict';
import { generateRemediationPlan } from '../src/remediation.js';

test('generateRemediationPlan detects desktop images, heavy images, and Elfsight chatbot', () => {
  const fakeLhr = {
    configSettings: { formFactor: 'mobile' },
    requestedUrl: 'https://www.kliklak.rs/',
    fetchTime: '2026-09-09T08:00:00Z',
    categories: {
      performance: { score: 0.28 },
    },
    audits: {
      'largest-contentful-paint': { numericValue: 27500 },
      'total-blocking-time': { numericValue: 38000 },
      'resource-summary': {
        details: {
          items: [
            { resourceType: 'total', transferSize: 7500000 },
            { resourceType: 'image', transferSize: 4900000 },
          ],
        },
      },
      'network-requests': {
        details: {
          items: [
            { url: 'https://c.cdnmp.net/241860914/p/l/8/intex-bazen.jpg', mimeType: 'image/jpeg', transferSize: 150000 },
            { url: 'https://c.cdnmp.net/241860914/p/l/1/stolice.jpg', mimeType: 'image/jpeg', transferSize: 120000 },
            { url: 'https://c.cdnmp.net/241860914/custom/cat_thumb_488.png', mimeType: 'image/png', transferSize: 1350000 },
            { url: 'https://universe-static.elfsightcdn.com/app-releases/ai-chatbot/index.js', mimeType: 'application/javascript', transferSize: 45000 },
            { url: 'https://mc.yandex.ru/metrika/tag.js', mimeType: 'application/javascript', transferSize: 35000 },
          ],
        },
      },
    },
  };

  const plan = generateRemediationPlan(fakeLhr);

  assert.equal(plan.storeUrl, 'https://www.kliklak.rs/');
  assert.equal(plan.score, 28);
  assert.equal(plan.lcpMs, 27500);
  assert.equal(plan.tbtMs, 38000);

  // Issues check
  const desktopImgIssue = plan.issues.find(i => i.type === 'desktop-image-on-mobile');
  assert.ok(desktopImgIssue);
  assert.equal(desktopImgIssue.affectedUrls.length, 2);
  assert.match(desktopImgIssue.remediationSnippet, /<picture>/);

  const heavyImgIssue = plan.issues.find(i => i.type === 'heavy-image');
  assert.ok(heavyImgIssue);
  assert.match(heavyImgIssue.affectedUrls[0] ?? '', /cat_thumb_488\.png/);

  const elfsightIssue = plan.issues.find(i => i.type === 'blocking-chatbot');
  assert.ok(elfsightIssue);
  assert.match(elfsightIssue.remediationSnippet, /first-activity/);

  const trackerIssue = plan.issues.find(i => i.type === 'blocking-tracker');
  assert.ok(trackerIssue);
  assert.match(trackerIssue.remediationSnippet, /requestIdleCallback/);

  // Markdown check
  assert.match(plan.markdownReport, /# Akcioni plan optimizacije i SEO sanacije/);
  assert.match(plan.markdownReport, /27\.5 s/);
});
