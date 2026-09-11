type JsonObject = Record<string, unknown>;

const object = (value: unknown): JsonObject | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
const string = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null;
const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

export interface ScriptIssue {
  type: 'heavy-bundle' | 'sync-blocking' | 'high-cpu' | 'deferrable-tracker' | 'heavy-widget';
  severity: 'critical' | 'warning' | 'info';
  url: string;
  domain: string;
  transferBytes: number | null;
  mainThreadMs: number | null;
  details: string;
  suggestion: string;
}

export interface ScriptAuditResult {
  totalScripts: number;
  thirdPartyScripts: number;
  totalThirdPartyBytes: number;
  totalMainThreadMs: number;
  issues: ScriptIssue[];
  summary: string;
}

const KNOWN_WIDGETS: Array<{ match: (url: string, host: string) => boolean; name: string; suggestion: string }> = [
  {
    match: (url, host) => host.includes('elfsight') || url.includes('ai-chatbot'),
    name: 'Elfsight Widget / Chatbot',
    suggestion: "Odložiti inicijalizaciju do prve interakcije korisnika (postaviti data-elfsight-app-lazy='first-activity' ili učitati na scroll/klik). Dokazano smanjuje TBT za preko 20%.",
  },
  {
    match: (_, host) => host.includes('tawk.to') || host.includes('smartsupp') || host.includes('livechat') || host.includes('crisp.chat'),
    name: 'Live Chat Widget',
    suggestion: 'Učitati chat widget asinhrono tek na korisnički klik ili idle callback, umesto sinhronog preuzimanja pri prvom učitavanju.',
  },
];

const DEFERRABLE_TRACKERS: Array<{ domain: string; name: string }> = [
  { domain: 'mc.yandex.ru', name: 'Yandex Metrika' },
  { domain: 'retargeting.app', name: 'Retargeting Tracker' },
  { domain: 'retargeting.biz', name: 'Retargeting.biz' },
  { domain: 'ct.pinterest.com', name: 'Pinterest Tag' },
  { domain: 'connect.facebook.net', name: 'Facebook Pixel' },
  { domain: 'analytics.tiktok.com', name: 'TikTok Pixel' },
  { domain: 'static.hotjar.com', name: 'Hotjar' },
  { domain: 'www.clarity.ms', name: 'Microsoft Clarity' },
];

/**
 * Audits third-party scripts, widgets, CPU execution cost (main thread), and bundle sizes.
 */
export function auditScripts(lhr: unknown): ScriptAuditResult | null {
  const root = object(lhr);
  if (!root) return null;
  const audits = object(root.audits);
  if (!audits) return null;

  const targetUrl = string(root.requestedUrl) ?? string(root.finalUrl) ?? '';
  let targetHost = '';
  try {
    if (targetUrl) targetHost = new URL(targetUrl).hostname;
  } catch { /* ignore */ }

  const networkAudit = object(audits['network-requests']);
  const rawNetworkItems = object(networkAudit?.details)?.items;
  const networkItems: unknown[] = Array.isArray(rawNetworkItems) ? rawNetworkItems : [];

  // Bootup time audit (CPU execution time)
  const bootupAudit = object(audits['bootup-time']);
  const rawBootupItems = object(bootupAudit?.details)?.items;
  const bootupItems: unknown[] = Array.isArray(rawBootupItems) ? rawBootupItems : [];
  const cpuByUrl = new Map<string, number>();
  for (const b of bootupItems) {
    const item = object(b);
    if (!item) continue;
    const url = string(item.url);
    const ms = finite(item.scripting) ?? finite(item.duration);
    if (url && ms) cpuByUrl.set(url, ms);
  }

  // Render-blocking resources
  const blockingAudit = object(audits['render-blocking-insight']) ?? object(audits['render-blocking-resources']);
  const rawBlockingItems = object(blockingAudit?.details)?.items;
  const blockingItems: unknown[] = Array.isArray(rawBlockingItems) ? rawBlockingItems : [];
  const blockingUrls = new Set<string>();
  for (const b of blockingItems) {
    const item = object(b);
    const u = string(item?.url);
    if (u) blockingUrls.add(u);
  }

  const issues: ScriptIssue[] = [];
  let totalScripts = 0;
  let thirdPartyScripts = 0;
  let totalThirdPartyBytes = 0;
  let totalMainThreadMs = 0;

  for (const item of networkItems) {
    const req = object(item);
    if (!req) continue;
    const url = string(req.url);
    if (!url) continue;
    const mimeType = string(req.mimeType) ?? '';
    const resourceType = string(req.resourceType);

    const isJs = mimeType.includes('javascript') || resourceType === 'script' || url.endsWith('.js') || url.includes('.js?');
    if (!isJs) continue;

    totalScripts++;
    const transferSize = finite(req.transferSize);
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch { /* ignore */ }

    const isThirdParty = targetHost ? (host && host !== targetHost && !host.endsWith('.' + targetHost)) : true;
    const cpuMs = cpuByUrl.get(url) ?? null;

    if (cpuMs) totalMainThreadMs += cpuMs;

    if (isThirdParty) {
      thirdPartyScripts++;
      if (transferSize) totalThirdPartyBytes += transferSize;

      // 1. Check known heavy widgets
      for (const widget of KNOWN_WIDGETS) {
        if (widget.match(url, host)) {
          issues.push({
            type: 'heavy-widget',
            severity: 'critical',
            url,
            domain: host,
            transferBytes: transferSize,
            mainThreadMs: cpuMs,
            details: `Detektovan vidžet: ${widget.name}. Zauzima prenos i troši procesorsko vreme.`,
            suggestion: widget.suggestion,
          });
        }
      }

      // 2. Check deferrable marketing trackers
      for (const tracker of DEFERRABLE_TRACKERS) {
        if (host === tracker.domain || host.endsWith('.' + tracker.domain)) {
          issues.push({
            type: 'deferrable-tracker',
            severity: 'warning',
            url,
            domain: host,
            transferBytes: transferSize,
            mainThreadMs: cpuMs,
            details: `Marketinški tracker: ${tracker.name} (${host}).`,
            suggestion: `Odložiti učitavanje skripte pomoću requestIdleCallback() ili setTimeout nakon inicijalnog prikaza stranice.`,
          });
        }
      }

      // 3. Heavy third-party bundle (> 75 kB)
      if (transferSize && transferSize > 75_000) {
        issues.push({
          type: 'heavy-bundle',
          severity: transferSize > 200_000 ? 'critical' : 'warning',
          url,
          domain: host,
          transferBytes: transferSize,
          mainThreadMs: cpuMs,
          details: `Veliki eksterni JS paket (${(transferSize / 1024).toFixed(1)} kB) sa domena ${host}.`,
          suggestion: 'Proveriti potrebu za celim paketom ili zameniti lakšom alternativom / učitati asinhrono.',
        });
      }
    }

    // 4. Render-blocking script
    if (blockingUrls.has(url)) {
      issues.push({
        type: 'sync-blocking',
        severity: 'critical',
        url,
        domain: host,
        transferBytes: transferSize,
        mainThreadMs: cpuMs,
        details: `Skripta blokira renderovanje stranice (parser-blocking).`,
        suggestion: `Dodati defer ili async atribut na <script> oznaku u šablonu.`,
      });
    }

    // 5. High CPU script (> 150 ms main thread time)
    if (cpuMs && cpuMs > 150) {
      issues.push({
        type: 'high-cpu',
        severity: 'warning',
        url,
        domain: host,
        transferBytes: transferSize,
        mainThreadMs: cpuMs,
        details: `Skripta provodi ${Math.round(cpuMs)} ms na glavnoj niti (CPU blokiranje).`,
        suggestion: 'Optimizovati izvršavanje, podeliti duge zadatke (long tasks) ili odložiti izvršenje.',
      });
    }
  }

  const summary = `Ukupno skripti: ${totalScripts} (${thirdPartyScripts} eksternih). Eksterni prenos: ${(totalThirdPartyBytes / 1024).toFixed(1)} kB. Ukupno CPU vreme: ${Math.round(totalMainThreadMs)} ms. Izdvojeno ${issues.length} stavki za proveru.`;

  return {
    totalScripts,
    thirdPartyScripts,
    totalThirdPartyBytes,
    totalMainThreadMs,
    issues,
    summary,
  };
}
