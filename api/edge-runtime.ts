/**
 * Smart Deferral Edge Runtime Engine (Vercel Edge & Serverless)
 * Handles IP Geo-detection (RS -> Baseline, Foreign -> Canary),
 * script generation with DOM interceptor, and beacon telemetry.
 */

export interface EdgeGeoContext {
  country: string;
  ip: string;
  host: string;
  url: string;
  userAgent: string;
  query: Record<string, string>;
}

export interface EdgeCanaryConfig {
  forcedCohort?: string;
  defaultCountry?: string;
  idleTimeoutMs?: number;
}

export function resolveCohort(ctx: EdgeGeoContext): { cohort: string; shouldDefer: boolean; country: string } {
  const query = ctx.query;
  const rawCountry = (query.force_country || ctx.country || 'unknown').toUpperCase();
  const ua = ctx.userAgent || '';
  const isSearchEngine = /Googlebot|bingbot|yandex|duckduckbot|baiduspider/i.test(ua);

  // 1. Kill Switch
  if (query.no_defer === '1') {
    return { cohort: 'kill_switched', shouldDefer: false, country: rawCountry };
  }

  // 2. Search Engine Crawler
  if (isSearchEngine) {
    return { cohort: 'search_engine_baseline', shouldDefer: false, country: rawCountry };
  }

  // 3. Forced Canary (via query ?canary=1)
  if (query.canary === '1') {
    return { cohort: 'forced_canary', shouldDefer: true, country: rawCountry };
  }

  // 4. Forced Baseline (via query ?canary=0)
  if (query.canary === '0') {
    return { cohort: 'baseline', shouldDefer: false, country: rawCountry };
  }

  // 5. Geo-Targeting Rule:
  // Serbia (RS) -> 100% Baseline (safe domestic traffic)
  // Outside Serbia (BR, US, DE, BD, etc.) -> Foreign Canary (bot & international stress test)
  if (rawCountry === 'RS') {
    return { cohort: 'baseline', shouldDefer: false, country: rawCountry };
  } else {
    return { cohort: 'foreign_canary', shouldDefer: true, country: rawCountry };
  }
}

export function generateEdgeScript(ctx: EdgeGeoContext, config: EdgeCanaryConfig = {}): string {
  const { cohort, shouldDefer, country } = resolveCohort(ctx);
  const idleTimeout = config.idleTimeoutMs || 3500;
  const protocol = ctx.url.startsWith('http://') ? 'http:' : 'https:';
  const beaconHost = ctx.host || 'merchantpro-lab.vercel.app';
  const beaconUrl = `${protocol}//${beaconHost}/api/telemetry`;

  return `/**
 * Smart Deferral Edge Runtime v0.2.2
 * Country: ${country} | Cohort: ${cohort} | Defer: ${shouldDefer}
 */
(function(window, document) {
  'use strict';

  // --- SAFE STORAGE HELPERS ---
  function safeGetSession(key) {
    try {
      return (typeof window !== 'undefined' && window.sessionStorage) ? window.sessionStorage.getItem(key) : null;
    } catch (_) { return null; }
  }
  function safeSetSession(key, val) {
    try {
      if (typeof window !== 'undefined' && window.sessionStorage) window.sessionStorage.setItem(key, val);
    } catch (_) {}
  }
  function safeRemoveSession(key) {
    try {
      if (typeof window !== 'undefined' && window.sessionStorage) window.sessionStorage.removeItem(key);
    } catch (_) {}
  }

  // Session flags override
  var urlParams = window.location.search || '';
  if (urlParams.indexOf('canary=1') !== -1) safeSetSession('__sdForced', '1');
  if (urlParams.indexOf('canary=0') !== -1) safeRemoveSession('__sdForced');
  if (urlParams.indexOf('no_defer=1') !== -1) safeSetSession('__sdKillSwitch', '1');
  if (urlParams.indexOf('no_defer=0') !== -1) safeRemoveSession('__sdKillSwitch');

  var isKillSwitched = window.SMART_DEFERRAL_ENABLED === false ||
    urlParams.indexOf('no_defer=1') !== -1 ||
    safeGetSession('__sdKillSwitch') === '1';

  var isCanaryForced = urlParams.indexOf('canary=1') !== -1 ||
    safeGetSession('__sdForced') === '1';

  var activeCohort = isKillSwitched ? 'kill_switched' : (isCanaryForced ? 'forced_canary' : '${cohort}');
  var shouldDefer = (activeCohort === 'forced_canary' || activeCohort === 'foreign_canary');

  // --- TELEMETRY & BEACON ---
  var beaconUrl = '${beaconUrl}';
  window.__sdTelemetry = {
    version: '0.2.2-edge',
    cohort: activeCohort,
    country: '${country}',
    mode: shouldDefer ? 'smart_deferral_canary' : 'immediate_fallback',
    meta: 'idle',
    gtm: 'idle',
    tiktok: 'idle',
    errors: [],
    eventsBuffered: 0,
    longTaskBlockingMs: 0,
    startTime: Date.now()
  };

  function sendBeaconPayload(type, payload) {
    if (typeof navigator !== 'undefined' && navigator.sendBeacon && beaconUrl) {
      try {
        var body = JSON.stringify(Object.assign({
          type: type,
          cohort: activeCohort,
          country: '${country}',
          url: window.location.href,
          timestamp: Date.now()
        }, payload));
        navigator.sendBeacon(beaconUrl, body);
      } catch (_) {}
    }
  }

  function recordFailure(vendor, err) {
    var errObj = { vendor: vendor, error: String(err) };
    window.__sdTelemetry[vendor] = 'failed';
    window.__sdTelemetry.errors.push(errObj);
    sendBeaconPayload('error', errObj);
    try {
      window.dispatchEvent(new CustomEvent('sd_vendor_failure', { detail: errObj }));
    } catch (_) {}
  }

  // Long-task RUM monitoring
  if (typeof PerformanceObserver !== 'undefined') {
    try {
      var po = new PerformanceObserver(function(list) {
        var entries = list.getEntries();
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].duration > 50) {
            window.__sdTelemetry.longTaskBlockingMs += Math.round(entries[i].duration - 50);
          }
        }
      });
      po.observe({ type: 'longtask', buffered: true });
    } catch (_) {}
  }

  // GA4 Field Ping on page exit
  var pingSent = false;
  function sendExitPing() {
    if (pingSent) return;
    pingSent = true;
    try {
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push({
        event: 'smart_deferral_telemetry',
        sd_cohort: window.__sdTelemetry.cohort,
        sd_country: window.__sdTelemetry.country,
        sd_mode: window.__sdTelemetry.mode,
        sd_meta: window.__sdTelemetry.meta,
        sd_gtm: window.__sdTelemetry.gtm,
        sd_tiktok: window.__sdTelemetry.tiktok,
        sd_errors_count: window.__sdTelemetry.errors.length,
        sd_events_buffered: window.__sdTelemetry.eventsBuffered,
        sd_long_task_blocking_ms: window.__sdTelemetry.longTaskBlockingMs
      });
    } catch (_) {}
    sendBeaconPayload('session_summary', {
      meta: window.__sdTelemetry.meta,
      gtm: window.__sdTelemetry.gtm,
      tiktok: window.__sdTelemetry.tiktok,
      errorsCount: window.__sdTelemetry.errors.length,
      eventsBuffered: window.__sdTelemetry.eventsBuffered,
      longTaskBlockingMs: window.__sdTelemetry.longTaskBlockingMs
    });
  }
  window.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'hidden') sendExitPing();
  });
  window.addEventListener('pagehide', sendExitPing);

  // --- IF NOT DEFERRED: DIRECT PASS-THROUGH (BASELINE / SERBIA) ---
  if (!shouldDefer) {
    return;
  }

  // --- SMART DEFERRAL: EVENT STUBS & DOM INTERCEPTOR ---

  // 1. Meta fbq stub
  window.fbq = window.fbq || function() {
    var args = Array.prototype.slice.call(arguments);
    if (window.fbq.queue) window.fbq.queue.push(args);
    window.__sdTelemetry.eventsBuffered++;
  };
  window.fbq.queue = window.fbq.queue || [];
  window.fbq.loaded = true;
  window.fbq.version = '2.0';
  window.fbq.agent = 'plshopmania';

  // 2. Google dataLayer & gtag stub
  window.dataLayer = window.dataLayer || [];
  if (typeof window.gtag !== 'function') {
    window.gtag = function() {
      window.dataLayer.push(Array.prototype.slice.call(arguments));
      window.__sdTelemetry.eventsBuffered++;
    };
  }

  // 3. TikTok ttq stub
  window.TiktokAnalyticsObject = 'ttq';
  var ttq = window.ttq = window.ttq || [];
  ttq.methods = ["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie","holdConsent","revokeConsent","grantConsent"];
  ttq.setAndDefer = function(t, e) {
    t[e] = function() {
      t.push([e].concat(Array.prototype.slice.call(arguments, 0)));
      window.__sdTelemetry.eventsBuffered++;
    };
  };
  for (var i = 0; i < ttq.methods.length; i++) {
    ttq.setAndDefer(ttq, ttq.methods[i]);
  }
  ttq.instance = function(t) {
    var e = ttq._i && ttq._i[t] ? ttq._i[t] : [];
    for (var n = 0; n < ttq.methods.length; n++) ttq.setAndDefer(e, ttq.methods[n]);
    return e;
  };
  ttq.load = function() {};
  ttq.page();

  // --- DOM INTERCEPTOR FOR MERCHANTPRO SCRIPTS ---
  var deferredNodes = [];
  var isFlushed = false;

  function isDeferredScript(src) {
    if (!src || typeof src !== 'string') return false;
    return src.indexOf('connect.facebook.net') !== -1 ||
           src.indexOf('googletagmanager.com/gtm.js') !== -1 ||
           src.indexOf('analytics.tiktok.com') !== -1;
  }

  function getVendor(src) {
    if (src.indexOf('connect.facebook.net') !== -1) return 'meta';
    if (src.indexOf('googletagmanager.com/gtm.js') !== -1) return 'gtm';
    if (src.indexOf('analytics.tiktok.com') !== -1) return 'tiktok';
    return 'unknown';
  }

  var origAppendChild = Node.prototype.appendChild;
  var origInsertBefore = Node.prototype.insertBefore;

  Node.prototype.appendChild = function(child) {
    if (!isFlushed && child && child.tagName === 'SCRIPT' && isDeferredScript(child.src)) {
      var vendor = getVendor(child.src);
      window.__sdTelemetry[vendor] = 'deferred';
      deferredNodes.push({ parent: this, node: child });
      return child;
    }
    return origAppendChild.apply(this, arguments);
  };

  Node.prototype.insertBefore = function(newNode, referenceNode) {
    if (!isFlushed && newNode && newNode.tagName === 'SCRIPT' && isDeferredScript(newNode.src)) {
      var vendor = getVendor(newNode.src);
      window.__sdTelemetry[vendor] = 'deferred';
      deferredNodes.push({ parent: this, node: newNode, ref: referenceNode });
      return newNode;
    }
    return origInsertBefore.apply(this, arguments);
  };

  // --- FLUSH TRIGGER ---
  function flush() {
    if (isFlushed) return;
    isFlushed = true;

    // Restore original DOM methods
    Node.prototype.appendChild = origAppendChild;
    Node.prototype.insertBefore = origInsertBefore;

    deferredNodes.forEach(function(item) {
      var vendor = getVendor(item.node.src);
      window.__sdTelemetry[vendor] = 'loading';
      item.node.onload = function() { window.__sdTelemetry[vendor] = 'loaded'; };
      item.node.onerror = function(err) { recordFailure(vendor, err); };
      if (item.ref) {
        origInsertBefore.call(item.parent, item.node, item.ref);
      } else {
        origAppendChild.call(item.parent, item.node);
      }
    });
  }

  var userEvents = ['touchstart', 'scroll', 'click', 'keydown', 'mousemove'];
  function onUserAction() {
    flush();
    userEvents.forEach(function(evt) { window.removeEventListener(evt, onUserAction, { passive: true }); });
  }
  userEvents.forEach(function(evt) { window.addEventListener(evt, onUserAction, { passive: true, once: true }); });

  window.addEventListener('load', function() {
    if ('requestIdleCallback' in window) {
      requestIdleCallback(flush, { timeout: ${idleTimeout} });
    } else {
      setTimeout(flush, 3000);
    }
  });

})(window, document);
`;
}
