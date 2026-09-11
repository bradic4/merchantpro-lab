import test from 'node:test';
import assert from 'node:assert/strict';
import { auditScripts } from '../src/script-audit.js';

test('auditScripts detects third-party widgets, trackers, high CPU, and render-blocking scripts', () => {
  const fakeLhr = {
    requestedUrl: 'https://www.kliklak.rs/',
    audits: {
      'network-requests': {
        details: {
          items: [
            { url: 'https://www.kliklak.rs/bundle.js', mimeType: 'application/javascript', transferSize: 40000 },
            { url: 'https://universe-static.elfsightcdn.com/app-releases/ai-chatbot/index.js', mimeType: 'application/javascript', transferSize: 50000 },
            { url: 'https://mc.yandex.ru/metrika/tag.js', mimeType: 'application/javascript', transferSize: 35000 },
            { url: 'https://heavy-cdn.example/huge-lib.js', mimeType: 'application/javascript', transferSize: 180000 },
            { url: 'https://www.kliklak.rs/blocking.js', mimeType: 'application/javascript', transferSize: 10000 },
          ],
        },
      },
      'bootup-time': {
        details: {
          items: [
            { url: 'https://universe-static.elfsightcdn.com/app-releases/ai-chatbot/index.js', scripting: 350, duration: 400 },
            { url: 'https://www.kliklak.rs/bundle.js', scripting: 50, duration: 60 },
          ],
        },
      },
      'render-blocking-resources': {
        details: {
          items: [
            { url: 'https://www.kliklak.rs/blocking.js', wastedMs: 200 },
          ],
        },
      },
    },
  };

  const result = auditScripts(fakeLhr);
  assert.ok(result);
  assert.equal(result.totalScripts, 5);
  assert.equal(result.thirdPartyScripts, 3);
  assert.ok(result.totalMainThreadMs >= 350);

  // Widget check
  const widgetIssue = result.issues.find(i => i.type === 'heavy-widget');
  assert.ok(widgetIssue);
  assert.match(widgetIssue.suggestion, /data-elfsight-app-lazy/);

  // Tracker check
  const trackerIssue = result.issues.find(i => i.type === 'deferrable-tracker');
  assert.ok(trackerIssue);
  assert.equal(trackerIssue.domain, 'mc.yandex.ru');

  // Heavy bundle check
  const bundleIssue = result.issues.find(i => i.type === 'heavy-bundle');
  assert.ok(bundleIssue);
  assert.equal(bundleIssue.domain, 'heavy-cdn.example');

  // High CPU check
  const cpuIssue = result.issues.find(i => i.type === 'high-cpu');
  assert.ok(cpuIssue);

  // Sync blocking check
  const blockingIssue = result.issues.find(i => i.type === 'sync-blocking');
  assert.ok(blockingIssue);
});

test('auditScripts handles missing audits gracefully', () => {
  assert.equal(auditScripts(null), null);
  assert.equal(auditScripts({}), null);
});
