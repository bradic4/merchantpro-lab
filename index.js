// Smart Deferral Vercel Node.js Serverless & Edge Handler
// Self-contained, zero-dependency, works natively with Vercel Node.js

function resolveCohort(ctx) {
  var query = ctx.query || {};
  var rawCountry = (query.force_country || ctx.country || 'unknown').toUpperCase();
  var ua = ctx.userAgent || '';
  var isSearchEngine = /Googlebot|bingbot|yandex|duckduckbot|baiduspider/i.test(ua);

  if (query.no_defer === '1') {
    return { cohort: 'kill_switched', shouldDefer: false, country: rawCountry };
  }
  if (isSearchEngine) {
    return { cohort: 'search_engine_baseline', shouldDefer: false, country: rawCountry };
  }
  if (query.canary === '1') {
    return { cohort: 'forced_canary', shouldDefer: true, country: rawCountry };
  }
  if (query.canary === '0') {
    return { cohort: 'baseline', shouldDefer: false, country: rawCountry };
  }
  if (rawCountry === 'RS') {
    return { cohort: 'baseline', shouldDefer: false, country: rawCountry };
  } else {
    return { cohort: 'foreign_canary', shouldDefer: true, country: rawCountry };
  }
}

function generateScript(ctx) {
  var resolution = resolveCohort(ctx);
  var cohort = resolution.cohort;
  var shouldDefer = resolution.shouldDefer;
  var country = resolution.country;
  var host = ctx.host || 'merchantpro-lab.vercel.app';
  var beaconUrl = 'https://' + host + '/api/telemetry';

  return '/**\n' +
    ' * Smart Deferral Edge Runtime v0.2.2\n' +
    ' * Country: ' + country + ' | Cohort: ' + cohort + ' | Defer: ' + shouldDefer + '\n' +
    ' */\n' +
    '(function(window, document) {\n' +
    '  "use strict";\n' +
    '  function safeGetSession(key) {\n' +
    '    try { return (typeof window !== "undefined" && window.sessionStorage) ? window.sessionStorage.getItem(key) : null; }\n' +
    '    catch (_) { return null; }\n' +
    '  }\n' +
    '  function safeSetSession(key, val) {\n' +
    '    try { if (typeof window !== "undefined" && window.sessionStorage) window.sessionStorage.setItem(key, val); }\n' +
    '    catch (_) {}\n' +
    '  }\n' +
    '  function safeRemoveSession(key) {\n' +
    '    try { if (typeof window !== "undefined" && window.sessionStorage) window.sessionStorage.removeItem(key); }\n' +
    '    catch (_) {}\n' +
    '  }\n' +
    '  var urlParams = window.location.search || "";\n' +
    '  if (urlParams.indexOf("canary=1") !== -1) safeSetSession("__sdForced", "1");\n' +
    '  if (urlParams.indexOf("canary=0") !== -1) safeRemoveSession("__sdForced");\n' +
    '  if (urlParams.indexOf("no_defer=1") !== -1) safeSetSession("__sdKillSwitch", "1");\n' +
    '  if (urlParams.indexOf("no_defer=0") !== -1) safeRemoveSession("__sdKillSwitch");\n' +
    '  var isKillSwitched = window.SMART_DEFERRAL_ENABLED === false || urlParams.indexOf("no_defer=1") !== -1 || safeGetSession("__sdKillSwitch") === "1";\n' +
    '  var isCanaryForced = urlParams.indexOf("canary=1") !== -1 || safeGetSession("__sdForced") === "1";\n' +
    '  var activeCohort = isKillSwitched ? "kill_switched" : (isCanaryForced ? "forced_canary" : "' + cohort + '");\n' +
    '  var shouldDefer = (activeCohort === "forced_canary" || activeCohort === "foreign_canary");\n' +
    '  var beaconUrl = "' + beaconUrl + '";\n' +
    '  window.__sdTelemetry = {\n' +
    '    version: "0.2.2-edge",\n' +
    '    cohort: activeCohort,\n' +
    '    country: "' + country + '",\n' +
    '    mode: shouldDefer ? "smart_deferral_canary" : "immediate_fallback",\n' +
    '    meta: "idle",\n' +
    '    gtm: "idle",\n' +
    '    tiktok: "idle",\n' +
    '    errors: [],\n' +
    '    eventsBuffered: 0,\n' +
    '    longTaskBlockingMs: 0,\n' +
    '    startTime: Date.now()\n' +
    '  };\n' +
    '  function sendBeaconPayload(type, payload) {\n' +
    '    if (typeof navigator !== "undefined" && navigator.sendBeacon && beaconUrl) {\n' +
    '      try {\n' +
    '        var body = JSON.stringify(Object.assign({\n' +
    '          type: type,\n' +
    '          cohort: activeCohort,\n' +
    '          country: "' + country + '",\n' +
    '          url: window.location.href,\n' +
    '          timestamp: Date.now()\n' +
    '        }, payload));\n' +
    '        navigator.sendBeacon(beaconUrl, body);\n' +
    '      } catch (_) {}\n' +
    '    }\n' +
    '  }\n' +
    '  function recordFailure(vendor, err) {\n' +
    '    var errObj = { vendor: vendor, error: String(err) };\n' +
    '    window.__sdTelemetry[vendor] = "failed";\n' +
    '    window.__sdTelemetry.errors.push(errObj);\n' +
    '    sendBeaconPayload("error", errObj);\n' +
    '    try { window.dispatchEvent(new CustomEvent("sd_vendor_failure", { detail: errObj })); } catch (_) {}\n' +
    '  }\n' +
    '  if (typeof PerformanceObserver !== "undefined") {\n' +
    '    try {\n' +
    '      var po = new PerformanceObserver(function(list) {\n' +
    '        var entries = list.getEntries();\n' +
    '        for (var i = 0; i < entries.length; i++) {\n' +
    '          if (entries[i].duration > 50) {\n' +
    '            window.__sdTelemetry.longTaskBlockingMs += Math.round(entries[i].duration - 50);\n' +
    '          }\n' +
    '        }\n' +
    '      });\n' +
    '      po.observe({ type: "longtask", buffered: true });\n' +
    '    } catch (_) {}\n' +
    '  }\n' +
    '  var pingSent = false;\n' +
    '  function sendExitPing() {\n' +
    '    if (pingSent) return;\n' +
    '    pingSent = true;\n' +
    '    try {\n' +
    '      window.dataLayer = window.dataLayer || [];\n' +
    '      window.dataLayer.push({\n' +
    '        event: "smart_deferral_telemetry",\n' +
    '        sd_cohort: window.__sdTelemetry.cohort,\n' +
    '        sd_country: window.__sdTelemetry.country,\n' +
    '        sd_mode: window.__sdTelemetry.mode,\n' +
    '        sd_meta: window.__sdTelemetry.meta,\n' +
    '        sd_gtm: window.__sdTelemetry.gtm,\n' +
    '        sd_tiktok: window.__sdTelemetry.tiktok,\n' +
    '        sd_errors_count: window.__sdTelemetry.errors.length,\n' +
    '        sd_events_buffered: window.__sdTelemetry.eventsBuffered,\n' +
    '        sd_long_task_blocking_ms: window.__sdTelemetry.longTaskBlockingMs\n' +
    '      });\n' +
    '    } catch (_) {}\n' +
    '    sendBeaconPayload("session_summary", {\n' +
    '      meta: window.__sdTelemetry.meta,\n' +
    '      gtm: window.__sdTelemetry.gtm,\n' +
    '      tiktok: window.__sdTelemetry.tiktok,\n' +
    '      errorsCount: window.__sdTelemetry.errors.length,\n' +
    '      eventsBuffered: window.__sdTelemetry.eventsBuffered,\n' +
    '      longTaskBlockingMs: window.__sdTelemetry.longTaskBlockingMs\n' +
    '    });\n' +
    '  }\n' +
    '  window.addEventListener("visibilitychange", function() {\n' +
    '    if (document.visibilityState === "hidden") sendExitPing();\n' +
    '  });\n' +
    '  window.addEventListener("pagehide", sendExitPing);\n' +
    '  if (!shouldDefer) return;\n' +
    '  window.fbq = window.fbq || function() {\n' +
    '    var args = Array.prototype.slice.call(arguments);\n' +
    '    if (window.fbq.queue) window.fbq.queue.push(args);\n' +
    '    window.__sdTelemetry.eventsBuffered++;\n' +
    '  };\n' +
    '  window.fbq.queue = window.fbq.queue || [];\n' +
    '  window.fbq.loaded = true;\n' +
    '  window.fbq.version = "2.0";\n' +
    '  window.fbq.agent = "plshopmania";\n' +
    '  window.dataLayer = window.dataLayer || [];\n' +
    '  if (typeof window.gtag !== "function") {\n' +
    '    window.gtag = function() {\n' +
    '      window.dataLayer.push(Array.prototype.slice.call(arguments));\n' +
    '      window.__sdTelemetry.eventsBuffered++;\n' +
    '    };\n' +
    '  }\n' +
    '  window.TiktokAnalyticsObject = "ttq";\n' +
    '  var ttq = window.ttq = window.ttq || [];\n' +
    '  ttq.methods = ["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie","holdConsent","revokeConsent","grantConsent"];\n' +
    '  ttq.setAndDefer = function(t, e) {\n' +
    '    t[e] = function() {\n' +
    '      t.push([e].concat(Array.prototype.slice.call(arguments, 0)));\n' +
    '      window.__sdTelemetry.eventsBuffered++;\n' +
    '    };\n' +
    '  };\n' +
    '  for (var i = 0; i < ttq.methods.length; i++) ttq.setAndDefer(ttq, ttq.methods[i]);\n' +
    '  ttq.instance = function(t) {\n' +
    '    var e = ttq._i && ttq._i[t] ? ttq._i[t] : [];\n' +
    '    for (var n = 0; n < ttq.methods.length; n++) ttq.setAndDefer(e, ttq.methods[n]);\n' +
    '    return e;\n' +
    '  };\n' +
    '  ttq.load = function() {};\n' +
    '  ttq.page();\n' +
    '  var deferredNodes = [];\n' +
    '  var isFlushed = false;\n' +
    '  function isDeferredScript(src) {\n' +
    '    if (!src || typeof src !== "string") return false;\n' +
    '    return src.indexOf("fbevents.js") !== -1 ||\n' +
    '           src.indexOf("googletagmanager.com/gtm.js") !== -1 ||\n' +
    '           src.indexOf("analytics.tiktok.com") !== -1;\n' +
    '  }\n' +
    '  function getVendor(src) {\n' +
    '    if (src.indexOf("fbevents.js") !== -1) return "meta";\n' +
    '    if (src.indexOf("googletagmanager.com/gtm.js") !== -1) return "gtm";\n' +
    '    if (src.indexOf("analytics.tiktok.com") !== -1) return "tiktok";\n' +
    '    return "unknown";\n' +
    '  }\n' +
    '  var origAppendChild = Node.prototype.appendChild;\n' +
    '  var origInsertBefore = Node.prototype.insertBefore;\n' +
    '  Node.prototype.appendChild = function(child) {\n' +
    '    if (!isFlushed && child && child.tagName === "SCRIPT" && isDeferredScript(child.src)) {\n' +
    '      var vendor = getVendor(child.src);\n' +
    '      window.__sdTelemetry[vendor] = "deferred";\n' +
    '      deferredNodes.push({ parent: this, node: child });\n' +
    '      return child;\n' +
    '    }\n' +
    '    return origAppendChild.apply(this, arguments);\n' +
    '  };\n' +
    '  Node.prototype.insertBefore = function(newNode, referenceNode) {\n' +
    '    if (!isFlushed && newNode && newNode.tagName === "SCRIPT" && isDeferredScript(newNode.src)) {\n' +
    '      var vendor = getVendor(newNode.src);\n' +
    '      window.__sdTelemetry[vendor] = "deferred";\n' +
    '      deferredNodes.push({ parent: this, node: newNode, ref: referenceNode });\n' +
    '      return newNode;\n' +
    '    }\n' +
    '    return origInsertBefore.apply(this, arguments);\n' +
    '  };\n' +
    '  function flush() {\n' +
    '    if (isFlushed) return;\n' +
    '    isFlushed = true;\n' +
    '    Node.prototype.appendChild = origAppendChild;\n' +
    '    Node.prototype.insertBefore = origInsertBefore;\n' +
    '    deferredNodes.forEach(function(item) {\n' +
    '      var vendor = getVendor(item.node.src);\n' +
    '      window.__sdTelemetry[vendor] = "loading";\n' +
    '      item.node.onload = function() { window.__sdTelemetry[vendor] = "loaded"; };\n' +
    '      item.node.onerror = function(err) { recordFailure(vendor, err); };\n' +
    '      if (item.ref) { origInsertBefore.call(item.parent, item.node, item.ref); }\n' +
    '      else { origAppendChild.call(item.parent, item.node); }\n' +
    '    });\n' +
    '  }\n' +
    '  var userEvents = ["touchstart", "scroll", "click", "keydown", "mousemove"];\n' +
    '  function onUserAction() {\n' +
    '    flush();\n' +
    '    userEvents.forEach(function(evt) { window.removeEventListener(evt, onUserAction, { passive: true }); });\n' +
    '  }\n' +
    '  userEvents.forEach(function(evt) { window.addEventListener(evt, onUserAction, { passive: true, once: true }); });\n' +
    '  window.addEventListener("load", function() {\n' +
    '    if ("requestIdleCallback" in window) {\n' +
    '      requestIdleCallback(flush, { timeout: 3500 });\n' +
    '    } else {\n' +
    '      setTimeout(flush, 3000);\n' +
    '    }\n' +
    '  });\n' +
    '})(window, document);\n';
}

export default function handler(req, res) {
  var host = req.headers.host || 'merchantpro-lab.vercel.app';
  var url = new URL(req.url, 'https://' + host);
  var pathname = url.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  // 1. Script delivery: /sd.js
  if (pathname === '/sd.js' || pathname === '/api/sd') {
    var query = {};
    url.searchParams.forEach(function(val, key) { query[key] = val; });
    var country = (query.force_country || req.headers['x-vercel-ip-country'] || 'unknown').toUpperCase();
    var ctx = {
      country: country,
      host: host,
      url: url.href,
      userAgent: req.headers['user-agent'] || '',
      query: query
    };

    var script = generateScript(ctx);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
    res.setHeader('Vary', 'x-vercel-ip-country');
    res.end(script);
    return;
  }

  // 2. Telemetry beacon: /api/telemetry
  if (pathname === '/api/telemetry') {
    var body = '';
    req.on('data', function(chunk) { body += chunk; });
    req.on('end', function() {
      try {
        var data = body ? JSON.parse(body) : {};
        console.log('[SD_TELEMETRY]', JSON.stringify(Object.assign({
          loggedAt: new Date().toISOString(),
          country: req.headers['x-vercel-ip-country'] || 'unknown',
          clientIp: req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown'
        }, data)));
      } catch (_) {}
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  // 3. Status page for root /
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end('<!DOCTYPE html><html><head><meta charset="utf-8"><title>Smart Deferral Edge Engine</title><style>body{font-family:sans-serif;background:#0f172a;color:#f8fafc;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{background:#1e293b;padding:2.5rem;border-radius:12px;border:1px solid #334155;max-width:500px}h1{color:#38bdf8;font-size:1.5rem}.badge{background:#065f46;color:#34d399;padding:3px 8px;border-radius:9999px;font-size:.8rem;font-weight:600}p{color:#94a3b8}code{background:#0f172a;padding:3px 6px;border-radius:4px;color:#f43f5e}a{color:#38bdf8}</style></head><body><div class="card"><div class="badge">&#9679; OPERATIONAL</div><h1>Smart Deferral Edge Engine</h1><p>Automated IP Geo-Targeted Script Delivery &amp; RUM Telemetry Beacon.</p><ul><li><strong>Script:</strong> <a href="/sd.js"><code>/sd.js</code></a></li><li><strong>Telemetry:</strong> <code>/api/telemetry</code></li></ul></div></body></html>');
}
