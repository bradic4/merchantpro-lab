/**
 * Smart Deferral v0.2.1 — Platform-Agnostic Ecommerce Tracking Runtime
 * Production-Safe Canary Deployment Architecture
 * 
 * Production Gates:
 * 1. Immediate fallback mode designed to preserve baseline tracking behavior.
 * 2. Sticky Canary Bucketing via sessionStorage (deterministic session assignment).
 * 3. Cohort tracking in window.__sdTelemetry (canary vs baseline vs kill_switched).
 * 4. Exact vendor endpoint equivalence (GTM gtm.start, Meta plshopmania agent, TikTok events.js).
 * 5. Telemetry with onload/onerror failure resilience.
 */

export interface CanaryRuntimeConfig {
  enabled?: boolean;
  canaryPercent?: number; // 0-100% (default 100 on test, 10 on production canary)
  gtmContainerId?: string;
  fbPixelId?: string;
  tiktokPixelId?: string;
  idleTimeoutMs?: number;
}

export function generateCanarySnippet(config: CanaryRuntimeConfig = {}): string {
  const gtmId = config.gtmContainerId ? `'${config.gtmContainerId}'` : "window.gtm_container_id || 'GTM-P28JKP5'";
  const fbId = config.fbPixelId ? `'${config.fbPixelId}'` : "window.fb_pixel_id || '1268341434894870'";
  const ttId = config.tiktokPixelId ? `'${config.tiktokPixelId}'` : "window.tiktok_pixel_id || '7147654266948502534'";
  const idleTimeout = config.idleTimeoutMs || 3500;
  const canaryPercent = config.canaryPercent !== undefined ? config.canaryPercent : 100;

  return `<!-- === SMART DEFERRAL v0.2.1 CANARY (PLATFORM-AGNOSTIC RUNTIME) === -->
<script id="smart-deferral-canary-v021">
(function(window, document) {
  'use strict';

  // --- TRAFFIC ALLOCATION & STICKY CANARY BUCKETING ---
  var urlParams = window.location.search || '';
  
  // URL parameters can set or clear session flags
  try {
    if (window.sessionStorage) {
      if (urlParams.indexOf('canary=1') !== -1) window.sessionStorage.setItem('__sdForced', '1');
      if (urlParams.indexOf('canary=0') !== -1) window.sessionStorage.removeItem('__sdForced');
      if (urlParams.indexOf('no_defer=1') !== -1) window.sessionStorage.setItem('__sdKillSwitch', '1');
      if (urlParams.indexOf('no_defer=0') !== -1) window.sessionStorage.removeItem('__sdKillSwitch');
    }
  } catch (e) {}

  var isKillSwitched = window.SMART_DEFERRAL_ENABLED === false || 
    urlParams.indexOf('no_defer=1') !== -1 || 
    (window.sessionStorage && window.sessionStorage.getItem('__sdKillSwitch') === '1');

  var isCanaryForced = urlParams.indexOf('canary=1') !== -1 || 
    (window.sessionStorage && window.sessionStorage.getItem('__sdForced') === '1');
  
  // Sticky session assignment via sessionStorage (fallback to random if storage blocked)
  var bucket = null;
  try {
    bucket = window.sessionStorage ? window.sessionStorage.getItem('__sdBucket') : null;
    if (bucket === null) {
      bucket = String(Math.floor(Math.random() * 100));
      if (window.sessionStorage) {
        window.sessionStorage.setItem('__sdBucket', bucket);
      }
    }
  } catch (e) {
    bucket = String(Math.floor(Math.random() * 100));
  }

  var bucketNum = Number(bucket);
  var inCanaryGroup = isCanaryForced || (bucketNum < ${canaryPercent});
  var cohort = isKillSwitched ? 'kill_switched' : (inCanaryGroup ? 'canary' : 'baseline');
  var shouldDefer = !isKillSwitched && inCanaryGroup;

  // --- TELEMETRY & STATUS STORE ---
  window.__sdTelemetry = {
    version: '0.2.1',
    cohort: cohort,
    bucket: bucketNum,
    mode: 'evaluating',
    meta: 'idle',
    gtm: 'idle',
    tiktok: 'idle',
    errors: [],
    eventsBuffered: 0,
    startTime: Date.now()
  };

  // --- IMMEDIATE FALLBACK MODE (PRESERVES BASELINE TRACKING BEHAVIOR) ---
  // If Canary is OFF, kill-switched, or user in baseline cohort, scripts execute immediately
  function loadImmediately() {
    window.__sdTelemetry.mode = 'immediate_fallback';
    loadMetaScript();
    loadGtmScript();
    loadTikTokScript();
  }

  // --- VENDOR SCRIPT INJECTORS WITH ONLOAD/ONERROR TELEMETRY ---
  function loadMetaScript() {
    if (window.__sdTelemetry.meta !== 'idle') return;
    window.__sdTelemetry.meta = 'loading';
    var fbId = ${fbId};
    if (fbId && window.fbq) {
      window.fbq('init', fbId);
    }
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://connect.facebook.net/en_US/fbevents.js';
    s.onload = function() { window.__sdTelemetry.meta = 'loaded'; };
    s.onerror = function(err) {
      window.__sdTelemetry.meta = 'failed';
      window.__sdTelemetry.errors.push({ vendor: 'meta', error: String(err) });
    };
    document.head.appendChild(s);
  }

  function loadGtmScript() {
    if (window.__sdTelemetry.gtm !== 'idle') return;
    window.__sdTelemetry.gtm = 'loading';
    
    // GTM Standard Bootstrap: gtm.start + event: gtm.js
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({ 'gtm.start': new Date().getTime(), event: 'gtm.js' });

    var gtmId = ${gtmId};
    if (gtmId) {
      var s = document.createElement('script');
      s.async = true;
      s.src = 'https://www.googletagmanager.com/gtm.js?id=' + encodeURIComponent(gtmId);
      s.onload = function() { window.__sdTelemetry.gtm = 'loaded'; };
      s.onerror = function(err) {
        window.__sdTelemetry.gtm = 'failed';
        window.__sdTelemetry.errors.push({ vendor: 'gtm', error: String(err) });
      };
      document.head.appendChild(s);
    }
  }

  function loadTikTokScript() {
    if (window.__sdTelemetry.tiktok !== 'idle') return;
    window.__sdTelemetry.tiktok = 'loading';
    var ttId = ${ttId};
    if (ttId) {
      var s = document.createElement('script');
      s.type = 'text/javascript';
      s.async = true;
      s.src = 'https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=' + encodeURIComponent(ttId) + '&lib=ttq';
      s.onload = function() { window.__sdTelemetry.tiktok = 'loaded'; };
      s.onerror = function(err) {
        window.__sdTelemetry.tiktok = 'failed';
        window.__sdTelemetry.errors.push({ vendor: 'tiktok', error: String(err) });
      };
      document.head.appendChild(s);
    }
  }

  // --- HARD GATE 1: KILL-SWITCH ACTIVE -> RUN IMMEDIATELY ---
  if (!shouldDefer) {
    loadImmediately();
    return;
  }

  // --- SMART DEFERRAL PATH (DEFERRED WITH EVENT BUFFERING) ---
  window.__sdTelemetry.mode = 'smart_deferral_canary';

  // 1. Meta fbq stub (queue in memory)
  window.fbq = window.fbq || function() {
    var args = Array.prototype.slice.call(arguments);
    if (window.fbq.queue) window.fbq.queue.push(args);
    window.__sdTelemetry.eventsBuffered++;
  };
  window.fbq.queue = window.fbq.queue || [];
  window.fbq.loaded = true;
  window.fbq.version = '2.0';
  window.fbq.agent = 'plshopmania';

  // 2. Google dataLayer stub
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
  ttq.load = function() {}; // Stubs load call; actual injection deferred below
  ttq.page(); // Initial page event safely buffered

  // Trigger flush
  var _deferredLoaded = false;
  window.__flushDeferredTrackers = function() {
    if (_deferredLoaded) return;
    _deferredLoaded = true;
    console.log('[SmartDeferral] Flushing deferred marketing stack...');
    loadMetaScript();
    loadGtmScript();
    loadTikTokScript();
  };

  // Dual Triggers: Interaction OR Post-Render Idle
  var userEvents = ['touchstart', 'scroll', 'click', 'keydown', 'mousemove'];
  function onUserAction() {
    window.__flushDeferredTrackers();
    userEvents.forEach(function(evt) { window.removeEventListener(evt, onUserAction, { passive: true }); });
  }
  userEvents.forEach(function(evt) { window.addEventListener(evt, onUserAction, { passive: true, once: true }); });

  window.addEventListener('load', function() {
    if ('requestIdleCallback' in window) {
      requestIdleCallback(window.__flushDeferredTrackers, { timeout: ${idleTimeout} });
    } else {
      setTimeout(window.__flushDeferredTrackers, 3000);
    }
  });

})(window, document);
</script>`;
}
