// Smart Deferral Vercel Node.js Serverless & Edge Handler v0.3.0
// Multi-tenant Commercial Architecture: Client Dashboard, Admin Panel, Remote Controls, & Persistent Telemetry
import http from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// --- CONFIG & SECRETS ---
const SESSION_SECRET = process.env.SESSION_SECRET || 'merchantpro-lab-auth-secret-key-v1-dev';
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// --- AUTH UTILS ---
function hashPassword(password, salt) {
  const actualSalt = salt || randomBytes(16).toString('hex');
  const hmac = createHmac('sha256', actualSalt);
  hmac.update(password);
  const hash = hmac.digest('hex');
  return { hash: hash, salt: actualSalt };
}

function verifyPassword(password, expectedHash, salt) {
  const res = hashPassword(password, salt);
  const hashBuf = Buffer.from(res.hash, 'hex');
  const expBuf = Buffer.from(expectedHash, 'hex');
  if (hashBuf.length !== expBuf.length) return false;
  return timingSafeEqual(hashBuf, expBuf);
}

function createSessionToken(user) {
  const session = {
    userId: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    storeId: user.storeId,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  };
  const payloadStr = Buffer.from(JSON.stringify(session)).toString('base64url');
  const signature = createHmac('sha256', SESSION_SECRET).update(payloadStr).digest('base64url');
  return payloadStr + '.' + signature;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const payloadStr = parts[0];
  const signature = parts[1];
  if (!payloadStr || !signature) return null;

  const expectedSig = createHmac('sha256', SESSION_SECRET).update(payloadStr).digest('base64url');
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;

  try {
    const jsonStr = Buffer.from(payloadStr, 'base64url').toString('utf8');
    const session = JSON.parse(jsonStr);
    if (session.expiresAt < Date.now()) return null;
    return session;
  } catch (_) {
    return null;
  }
}

function parseCookies(req) {
  const list = {};
  const rc = req.headers.cookie;
  if (rc) {
    rc.split(';').forEach(function(cookie) {
      const parts = cookie.split('=');
      list[parts.shift().trim()] = decodeURI(parts.join('='));
    });
  }
  return list;
}

function getSessionFromReq(req) {
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7).trim();
    const s = verifySessionToken(token);
    if (s) return s;
  }
  const cookies = parseCookies(req);
  if (cookies.sd_session) {
    return verifySessionToken(cookies.sd_session);
  }
  return null;
}

// --- DATABASE & MULTI-TENANT STATE ---
const adminAuth = hashPassword('admin123', 'admin_salt_fixed');
const clientAuth = hashPassword('client123', 'client_salt_fixed');

const db = {
  stores: {
    volimsvojdom: {
      id: 'volimsvojdom',
      name: 'VolimSvojDom.rs',
      domain: 'www.volimsvojdom.rs',
      platform: 'merchantpro',
      status: 'live',
      canaryPercent: 1, // 1% Domestic Canary
      killSwitch: false,
      vendors: { meta: true, gtm: true, tiktok: true },
      baselineBlockingMs: 11300,
      optimizedBlockingMs: 6900,
      createdAt: '2026-09-08T00:00:00.000Z',
      updatedAt: new Date().toISOString()
    },
    baldino: {
      id: 'baldino',
      name: 'Baldino.rs',
      domain: 'baldino.rs',
      platform: 'shopify',
      status: 'pilot',
      canaryPercent: 0,
      killSwitch: false,
      vendors: { meta: true, gtm: true, tiktok: false },
      baselineBlockingMs: 8400,
      optimizedBlockingMs: 4850,
      createdAt: '2026-09-10T00:00:00.000Z',
      updatedAt: new Date().toISOString()
    }
  },
  users: {
    'admin@merchantpro.lab': {
      id: 'usr_admin',
      email: 'admin@merchantpro.lab',
      passwordHash: adminAuth.hash,
      salt: adminAuth.salt,
      name: 'Ivan (Administrator)',
      role: 'ADMIN',
      storeId: null
    },
    'client@volimsvojdom.rs': {
      id: 'usr_client',
      email: 'client@volimsvojdom.rs',
      passwordHash: clientAuth.hash,
      salt: clientAuth.salt,
      name: 'VolimSvojDom Tim',
      role: 'CLIENT',
      storeId: 'volimsvojdom'
    }
  },
  telemetry: []
};

function getStoreMetrics(storeId, windowHours = 24) {
  const store = db.stores[storeId];
  if (!store) return null;
  const cutoff = Date.now() - windowHours * 3600 * 1000;
  const sessions = db.telemetry.filter(t => t.storeId === storeId && t.timestamp >= cutoff);

  let totalSessions = sessions.length;
  let optimizedSessions = 0;
  let baselineSessions = 0;
  let crawlerSessions = 0;
  let totalErrors = 0;
  const countryBreakdown = {};

  for (const s of sessions) {
    if (s.cohort && s.cohort.includes('canary')) optimizedSessions++;
    else if (s.cohort === 'search_engine_baseline') crawlerSessions++;
    else baselineSessions++;

    totalErrors += (s.errorsCount || 0);
    const c = s.country || 'unknown';
    countryBreakdown[c] = (countryBreakdown[c] || 0) + 1;
  }

  const reductionPercent = store.baselineBlockingMs > 0
    ? Math.round(((store.optimizedBlockingMs - store.baselineBlockingMs) / store.baselineBlockingMs) * 1000) / 10
    : 0;

  return {
    storeId: storeId,
    totalSessions: totalSessions,
    optimizedSessions: optimizedSessions,
    baselineSessions: baselineSessions,
    crawlerSessions: crawlerSessions,
    totalErrors: totalErrors,
    baselineBlockingMs: store.baselineBlockingMs,
    optimizedBlockingMs: store.optimizedBlockingMs,
    reductionPercent: reductionPercent,
    recentSessions: sessions.slice(-50).sort((a, b) => b.timestamp - a.timestamp),
    countryBreakdown: countryBreakdown
  };
}

// --- DYNAMIC SCRIPT GENERATOR ---
function resolveCohort(ctx, store) {
  const query = ctx.query || {};
  const rawCountry = (query.force_country || ctx.country || 'unknown').toUpperCase();
  const ua = ctx.userAgent || '';
  const isSearchEngine = /Googlebot|bingbot|yandex|duckduckbot|baiduspider/i.test(ua);

  if (query.no_defer === '1' || (store && store.killSwitch)) {
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

function generateScript(ctx, store) {
  const storeConfig = store || db.stores.volimsvojdom;
  const resolution = resolveCohort(ctx, storeConfig);
  const cohort = resolution.cohort;
  const shouldDefer = resolution.shouldDefer;
  const country = resolution.country;
  const host = ctx.host || 'merchantpro-lab.vercel.app';
  const beaconUrl = 'https://' + host + '/api/telemetry';

  const rsCanaryPercent = (typeof storeConfig.canaryPercent === 'number') ? storeConfig.canaryPercent : 1;
  const isKillSwitchedByStore = Boolean(storeConfig.killSwitch);
  const vendors = storeConfig.vendors || { meta: true, gtm: true, tiktok: true };

  return '/**\n' +
    ' * Smart Deferral Edge Runtime v0.3.0\n' +
    ' * Store: ' + storeConfig.id + ' | Country: ' + country + ' | Cohort: ' + cohort + ' | CanaryRate: ' + rsCanaryPercent + '%\n' +
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
    '  if (urlParams.indexOf("domestic=1") !== -1) safeSetSession("__sdDomesticCohort", "domestic_canary");\n' +
    '  if (urlParams.indexOf("domestic=0") !== -1) safeRemoveSession("__sdDomesticCohort");\n' +
    '  var isKillSwitched = window.SMART_DEFERRAL_ENABLED === false || ' + isKillSwitchedByStore + ' || urlParams.indexOf("no_defer=1") !== -1 || safeGetSession("__sdKillSwitch") === "1";\n' +
    '  var isCanaryForced = urlParams.indexOf("canary=1") !== -1 || safeGetSession("__sdForced") === "1";\n' +
    '  var isCanaryDisabled = urlParams.indexOf("canary=0") !== -1;\n' +
    '  var activeCohort = isKillSwitched ? "kill_switched" : (isCanaryForced ? "forced_canary" : "' + cohort + '");\n' +
    '  if (!isKillSwitched && !isCanaryForced && !isCanaryDisabled && "' + country + '" === "RS") {\n' +
    '    var storedCohort = safeGetSession("__sdDomesticCohort");\n' +
    '    if (storedCohort) {\n' +
    '      activeCohort = storedCohort;\n' +
    '    } else {\n' +
    '      var roll = Math.random() * 100;\n' +
    '      activeCohort = (roll < ' + rsCanaryPercent + ') ? "domestic_canary" : "baseline";\n' +
    '      safeSetSession("__sdDomesticCohort", activeCohort);\n' +
    '    }\n' +
    '  }\n' +
    '  var shouldDefer = (activeCohort === "forced_canary" || activeCohort === "foreign_canary" || activeCohort === "domestic_canary");\n' +
    '  var beaconUrl = "' + beaconUrl + '";\n' +
    '  window.__sdTelemetry = {\n' +
    '    version: "0.3.0-edge",\n' +
    '    storeId: "' + storeConfig.id + '",\n' +
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
    '          storeId: "' + storeConfig.id + '",\n' +
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
    '        sd_store: "' + storeConfig.id + '",\n' +
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
    '    var isMeta = ' + vendors.meta + ' && src.indexOf("fbevents.js") !== -1;\n' +
    '    var isGtm = ' + vendors.gtm + ' && src.indexOf("googletagmanager.com/gtm.js") !== -1;\n' +
    '    var isTiktok = ' + vendors.tiktok + ' && src.indexOf("analytics.tiktok.com") !== -1;\n' +
    '    return isMeta || isGtm || isTiktok;\n' +
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

function loadHtmlFile(filename) {
  const p1 = join(__dirname, 'ui', filename);
  if (existsSync(p1)) return readFileSync(p1, 'utf8');
  const p2 = join(__dirname, 'src/ui', filename);
  if (existsSync(p2)) return readFileSync(p2, 'utf8');
  return null;
}

// --- MAIN HANDLER ---
export default function handler(req, res) {
  const host = req.headers.host || 'merchantpro-lab.vercel.app';
  const url = new URL(req.url, 'https://' + host);
  const pathname = url.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  // Helper: Read JSON Body
  function readJsonBody(callback) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const json = body ? JSON.parse(body) : {};
        callback(null, json);
      } catch (err) {
        callback(err, null);
      }
    });
  }

  // Helper: JSON Response
  function sendJson(statusCode, data) {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(data));
  }

  // Helper: HTML Response
  function sendHtml(html) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(html);
  }

  // --- UI ROUTES ---
  if (pathname === '/login') {
    const html = loadHtmlFile('login.html');
    if (html) return sendHtml(html);
  }

  if (pathname === '/dashboard') {
    const html = loadHtmlFile('dashboard.html');
    if (html) return sendHtml(html);
  }

  if (pathname === '/admin') {
    const html = loadHtmlFile('admin.html');
    if (html) return sendHtml(html);
  }

  // --- 1. SCRIPT DELIVERY: /sd.js ---
  if (pathname === '/sd.js' || pathname === '/api/sd') {
    const query = {};
    url.searchParams.forEach((val, key) => { query[key] = val; });
    const storeId = query.store || 'volimsvojdom';
    const store = db.stores[storeId] || db.stores.volimsvojdom;

    const country = (query.force_country || req.headers['x-vercel-ip-country'] || 'unknown').toUpperCase();
    const ctx = {
      country: country,
      host: host,
      url: url.href,
      userAgent: req.headers['user-agent'] || '',
      query: query
    };

    const script = generateScript(ctx, store);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
    res.setHeader('Vary', 'x-vercel-ip-country');
    res.end(script);
    return;
  }

  // --- 2. TELEMETRY BEACON: /api/telemetry ---
  if (pathname === '/api/telemetry') {
    readJsonBody((_, data) => {
      const payload = data || {};
      const storeId = payload.storeId || 'volimsvojdom';
      const country = req.headers['x-vercel-ip-country'] || payload.country || 'unknown';
      const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';

      // Persist into memory store
      const sessionEntry = {
        id: 'tel_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
        storeId: storeId,
        timestamp: payload.timestamp || Date.now(),
        cohort: payload.cohort || 'unknown',
        country: country,
        clientIp: clientIp,
        url: payload.url || 'unknown',
        longTaskBlockingMs: payload.longTaskBlockingMs || 0,
        errorsCount: payload.errorsCount || 0,
        eventsBuffered: payload.eventsBuffered || 0,
        meta: payload.meta || 'idle',
        gtm: payload.gtm || 'idle',
        tiktok: payload.tiktok || 'idle'
      };

      db.telemetry.push(sessionEntry);
      if (db.telemetry.length > 5000) db.telemetry.shift();

      // Log for Vercel console log stream
      console.log('[SD_TELEMETRY]', JSON.stringify(Object.assign({
        loggedAt: new Date().toISOString(),
        country: country,
        clientIp: clientIp
      }, payload)));

      sendJson(200, { ok: true, id: sessionEntry.id });
    });
    return;
  }

  // --- 3. AUTH API ---
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    readJsonBody((_, body) => {
      const email = (body.email || '').toLowerCase().trim();
      const password = body.password || '';
      const user = db.users[email];
      if (!user || !verifyPassword(password, user.passwordHash, user.salt)) {
        return sendJson(401, { error: 'Pogrešna e-mail adresa ili lozinka.' });
      }

      const token = createSessionToken(user);
      res.setHeader('Set-Cookie', `sd_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 86400}`);
      sendJson(200, {
        ok: true,
        token: token,
        user: { id: user.id, email: user.email, name: user.name, role: user.role, storeId: user.storeId }
      });
    });
    return;
  }

  if (pathname === '/api/auth/me') {
    const session = getSessionFromReq(req);
    if (!session) return sendJson(401, { error: 'Niste prijavljeni.' });
    return sendJson(200, { user: session });
  }

  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    res.setHeader('Set-Cookie', 'sd_session=; Path=/; HttpOnly; Max-Age=0');
    return sendJson(200, { ok: true });
  }

  // --- 4. CLIENT API (TENANT ISOLATED) ---
  if (pathname === '/api/client/overview') {
    const session = getSessionFromReq(req);
    if (!session) return sendJson(401, { error: 'Neautorizovan pristup.' });

    const storeId = session.role === 'ADMIN' ? (url.searchParams.get('store') || 'volimsvojdom') : session.storeId;
    if (!storeId) return sendJson(400, { error: 'Nedostaje store identifikator.' });

    // Enforce tenant isolation
    if (session.role === 'CLIENT' && session.storeId !== storeId) {
      return sendJson(403, { error: 'Zabranjen pristup tuđoj prodavnici (Tenant Isolation).' });
    }

    const store = db.stores[storeId];
    if (!store) return sendJson(404, { error: 'Prodavnica nije pronađena.' });
    const metrics = getStoreMetrics(storeId, 24);

    return sendJson(200, { store: store, metrics: metrics });
  }

  // --- 5. ADMIN API (ADMIN ROLE ONLY) ---
  if (pathname.startsWith('/api/admin/')) {
    const session = getSessionFromReq(req);
    if (!session) return sendJson(401, { error: 'Prijavite se kao administrator.' });
    if (session.role !== 'ADMIN') return sendJson(403, { error: 'Samo administrator ima pristup ovom resursu.' });

    // GET /api/admin/stores
    if (pathname === '/api/admin/stores' && req.method === 'GET') {
      const storesList = Object.values(db.stores).map(s => {
        const m = getStoreMetrics(s.id, 24);
        return Object.assign({}, s, {
          totalSessions: m.totalSessions,
          totalErrors: m.totalErrors
        });
      });
      return sendJson(200, { stores: storesList });
    }

    // GET /api/admin/stores/:id
    const storeDetailMatch = pathname.match(/^\/api\/admin\/stores\/([a-zA-Z0-9_-]+)$/);
    if (storeDetailMatch && req.method === 'GET') {
      const storeId = storeDetailMatch[1];
      const store = db.stores[storeId];
      if (!store) return sendJson(404, { error: 'Prodavnica ne postoji.' });
      const metrics = getStoreMetrics(storeId, 24);
      return sendJson(200, { store: store, metrics: metrics });
    }

    // POST /api/admin/stores/:id/config
    const storeConfigMatch = pathname.match(/^\/api\/admin\/stores\/([a-zA-Z0-9_-]+)\/config$/);
    if (storeConfigMatch && req.method === 'POST') {
      const storeId = storeConfigMatch[1];
      const store = db.stores[storeId];
      if (!store) return sendJson(404, { error: 'Prodavnica ne postoji.' });

      readJsonBody((_, body) => {
        if (typeof body.canaryPercent === 'number') store.canaryPercent = body.canaryPercent;
        if (typeof body.killSwitch === 'boolean') store.killSwitch = body.killSwitch;
        if (body.status) store.status = body.status;
        if (body.vendors) {
          store.vendors = Object.assign({}, store.vendors, body.vendors);
        }
        store.updatedAt = new Date().toISOString();
        return sendJson(200, { ok: true, store: store });
      });
      return;
    }
  }

  // --- ROOT / FALLBACK STATUS PAGE ---
  if (pathname === '/') {
    // If logged in, redirect to appropriate view
    const session = getSessionFromReq(req);
    if (session) {
      res.statusCode = 302;
      res.setHeader('Location', session.role === 'ADMIN' ? '/admin' : '/dashboard');
      res.end();
      return;
    }
    // Otherwise redirect to login
    res.statusCode = 302;
    res.setHeader('Location', '/login');
    res.end();
    return;
  }

  sendJson(404, { error: 'Not Found' });
}
