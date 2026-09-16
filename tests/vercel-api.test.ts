import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCohort, generateEdgeScript, type EdgeGeoContext } from '../src/edge-runtime.js';

test('resolveCohort sends Serbia (RS) visitors directly to baseline (zero commercial risk)', () => {
  const ctx: EdgeGeoContext = {
    country: 'RS',
    ip: '109.92.1.1',
    host: 'merchantpro-lab.vercel.app',
    url: 'https://merchantpro-lab.vercel.app/sd.js',
    userAgent: 'Mozilla/5.0 Chrome/120',
    query: {},
  };

  const res = resolveCohort(ctx);
  assert.equal(res.cohort, 'baseline');
  assert.equal(res.shouldDefer, false);
  assert.equal(res.country, 'RS');
});

test('resolveCohort sends Foreign countries (BR, US, DE, BD) into foreign_canary', () => {
  const foreignCountries = ['BR', 'US', 'DE', 'BD'];
  for (const country of foreignCountries) {
    const ctx: EdgeGeoContext = {
      country,
      ip: '177.1.1.1',
      host: 'merchantpro-lab.vercel.app',
      url: 'https://merchantpro-lab.vercel.app/sd.js',
      userAgent: 'Mozilla/5.0 Chrome/120',
      query: {},
    };
    const res = resolveCohort(ctx);
    assert.equal(res.cohort, 'foreign_canary');
    assert.equal(res.shouldDefer, true);
    assert.equal(res.country, country);
  }
});

test('resolveCohort respects ?canary=1 override even for RS visitors', () => {
  const ctx: EdgeGeoContext = {
    country: 'RS',
    ip: '109.92.1.1',
    host: 'merchantpro-lab.vercel.app',
    url: 'https://merchantpro-lab.vercel.app/sd.js?canary=1',
    userAgent: 'Mozilla/5.0 Chrome/120',
    query: { canary: '1' },
  };

  const res = resolveCohort(ctx);
  assert.equal(res.cohort, 'forced_canary');
  assert.equal(res.shouldDefer, true);
});

test('resolveCohort respects ?no_defer=1 kill switch for any country', () => {
  const ctx: EdgeGeoContext = {
    country: 'BR',
    ip: '177.1.1.1',
    host: 'merchantpro-lab.vercel.app',
    url: 'https://merchantpro-lab.vercel.app/sd.js?no_defer=1',
    userAgent: 'Mozilla/5.0 Chrome/120',
    query: { no_defer: '1' },
  };

  const res = resolveCohort(ctx);
  assert.equal(res.cohort, 'kill_switched');
  assert.equal(res.shouldDefer, false);
});

test('resolveCohort sends search engine crawlers to search_engine_baseline', () => {
  const crawlers = [
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    'Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)',
  ];

  for (const ua of crawlers) {
    const ctx: EdgeGeoContext = {
      country: 'BR',
      ip: '66.249.66.1',
      host: 'merchantpro-lab.vercel.app',
      url: 'https://merchantpro-lab.vercel.app/sd.js',
      userAgent: ua,
      query: {},
    };
    const res = resolveCohort(ctx);
    assert.equal(res.cohort, 'search_engine_baseline');
    assert.equal(res.shouldDefer, false);
  }
});

test('generateEdgeScript generates valid JS containing DOM interceptor and telemetry URL', () => {
  const ctx: EdgeGeoContext = {
    country: 'BR',
    ip: '177.1.1.1',
    host: 'custom-domain.vercel.app',
    url: 'https://custom-domain.vercel.app/sd.js',
    userAgent: 'Mozilla/5.0 Chrome/120',
    query: {},
  };

  const script = generateEdgeScript(ctx);
  assert.ok(script.includes('Smart Deferral Edge Runtime'));
  assert.ok(script.includes('Country: BR'));
  assert.ok(script.includes('Cohort: foreign_canary'));
  assert.ok(script.includes('https://custom-domain.vercel.app/api/telemetry'));
  assert.ok(script.includes('Node.prototype.appendChild'));
  assert.ok(script.includes('Node.prototype.insertBefore'));
  assert.ok(script.includes('window.fbq = window.fbq'));
  assert.ok(script.includes('window.dataLayer = window.dataLayer'));
  assert.ok(script.includes('window.TiktokAnalyticsObject'));
  assert.ok(script.includes('sd_long_task_blocking_ms'));
});
