export interface DetectedIssue {
  type: 'heavy-image' | 'desktop-image-on-mobile' | 'blocking-chatbot' | 'blocking-tracker' | 'missing-lazy-loading' | 'missing-lcp-preload';
  title: string;
  description: string;
  impact: 'high' | 'medium' | 'low';
  estimatedSavings?: string;
  affectedUrls: string[];
  remediationSnippet: string;
}

export interface RemediationPlan {
  storeUrl: string;
  auditDate: string;
  score: number | null;
  lcpMs: number | null;
  tbtMs: number | null;
  totalBytes: number | null;
  imageBytes: number | null;
  issues: DetectedIssue[];
  markdownReport: string;
}

/**
 * Inspects a Lighthouse JSON object and generates actionable remediation snippets and report.
 */
export function generateRemediationPlan(lhr: any): RemediationPlan {
  const storeUrl = lhr?.requestedUrl ?? lhr?.finalUrl ?? 'Nepoznat URL';
  const auditDate = lhr?.fetchTime ?? new Date().toISOString();
  const score = typeof lhr?.categories?.performance?.score === 'number' ? Math.round(lhr.categories.performance.score * 100) : null;
  const lcpMs = lhr?.audits?.['largest-contentful-paint']?.numericValue ?? null;
  const tbtMs = lhr?.audits?.['total-blocking-time']?.numericValue ?? null;

  const networkRequests = (lhr?.audits?.['network-requests']?.details?.items ?? []) as any[];
  const resourceSummary = (lhr?.audits?.['resource-summary']?.details?.items ?? []) as any[];

  let totalBytes: number | null = null;
  let imageBytes: number | null = null;
  for (const item of resourceSummary) {
    if (item.resourceType === 'total') totalBytes = item.transferSize;
    if (item.resourceType === 'image') imageBytes = item.transferSize;
  }

  const issues: DetectedIssue[] = [];

  // 1. Detect Desktop images served on mobile (e.g. /p/l/ pattern in MerchantPro)
  const desktopImagesOnMobile = networkRequests
    .filter(r => typeof r.url === 'string' && r.url.includes('/p/l/') && r.mimeType?.startsWith('image/'))
    .map(r => r.url as string);

  if (lhr?.configSettings?.formFactor === 'mobile' && desktopImagesOnMobile.length > 0) {
    issues.push({
      type: 'desktop-image-on-mobile',
      title: 'Proveriti dimenzije slika na mobilnom prikazu',
      description: `Zabeleženo ${desktopImagesOnMobile.length} URL-ova sa /p/l/. Putanja ne dokazuje prevelike dimenzije. Uporediti stvarne dimenzije, prikazanu veličinu i DPR pre promene.`,
      impact: 'medium',
      affectedUrls: desktopImagesOnMobile.slice(0, 10),
      remediationSnippet: `<!-- Kandidat: tek nakon provere stvarnih URL-ova i dimenzija napraviti <picture> ili srcset.
Ne primenjivati lazy loading na LCP sliku. Nazivi polja zavise od teme. -->`,
    });
  }

  // 2. Detect Heavy unoptimized images (> 200 kB)
  const heavyImages = networkRequests
    .filter(r => r.mimeType?.startsWith('image/') && (r.transferSize ?? 0) > 200_000)
    .map(r => `${r.url} (${Math.round(r.transferSize / 1024)} kB)`);

  if (heavyImages.length > 0) {
    issues.push({
      type: 'heavy-image',
      title: 'Prevelike pojedinačne slike (preko 200 kB)',
      description: `Zabeleženo ${heavyImages.length} slika sa prenosom preko 200 kB. Veličina sama ne dokazuje lošu kompresiju. Uporediti dimenzije, kvalitet i probne konverzije; ušteda još nije izmerena.`,
      impact: 'medium',
      affectedUrls: heavyImages,
      remediationSnippet: `# Optimizacija pomoću merchantpro-lab alata:
node dist/cli.js optimize-images --input ./data/raw-images --out ./data/optimized-images --profile banner`,
    });
  }

  // 3. Detect Elfsight AI Chatbot
  const elfsightRequests = networkRequests.filter(
    r => typeof r.url === 'string' && r.url.startsWith('https://universe-static.elfsightcdn.com/app-releases/ai-chatbot/')
  );
  if (elfsightRequests.length > 0) {
    issues.push({
      type: 'blocking-chatbot',
      title: 'Kandidat za eksperiment: Elfsight chatbot',
      description: 'Zabeležen je zahtev za resurs chatbota. Sam zahtev ne dokazuje CPU trošak niti vreme inicijalizacije. Proveriti bootup/trace i izmeriti upareni A/B eksperiment. Blokiranje i first-activity su različite intervencije; proveriti i odziv prve interakcije.',
      impact: 'medium',
      affectedUrls: elfsightRequests.map(r => r.url),
      remediationSnippet: `// Kandidat za test na izdvojenoj kopiji, tek nakon provere postojećeg loadera: 'first-activity':
- widget.setAttribute('data-elfsight-app-lazy', '');
+ widget.setAttribute('data-elfsight-app-lazy', 'first-activity');`,
    });
  }

  // 4. Detect other heavy 3rd-party trackers
  const trackerDomains = ['mc.yandex.ru', 'retargeting.app', 'ct.pinterest.com', 'connect.facebook.net', 'google-analytics.com'];
  const detectedTrackers = networkRequests
    .filter(r => typeof r.url === 'string' && trackerDomains.some(d => { try { const h = new URL(r.url).hostname; return h === d || h.endsWith('.' + d); } catch { return false; } }))
    .map(r => r.url);

  if (detectedTrackers.length > 0) {
    issues.push({
      type: 'blocking-tracker',
      title: 'Proveriti trošak eksternih marketinških servisa',
      description: `Zabeleženo ${detectedTrackers.length} zahteva. To ne dokazuje sinhrono učitavanje ili blokiranje. Proveriti inicijatore, CPU trošak, saglasnost i zavisnosti; korist od odlaganja izmeriti eksperimentom.`,
      impact: 'medium',
      affectedUrls: detectedTrackers.slice(0, 10),
      remediationSnippet: `// Ilustracija kandidata za test; prilagoditi postojećem loaderu i saglasnosti, bez duplog učitavanja:
function loadTrackersOnIdle() {
  const trackerScripts = [
    /* URL-ovi skripti */
  ];
  trackerScripts.forEach(url => {
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    document.body.appendChild(script);
  });
}

if ('requestIdleCallback' in window) {
  requestIdleCallback(loadTrackersOnIdle, { timeout: 3000 });
} else {
  window.addEventListener('load', () => setTimeout(loadTrackersOnIdle, 2000));
}`,
    });
  }

  // Generate markdown report
  const lines: string[] = [
    `# Akcioni plan optimizacije i SEO sanacije`,
    ``,
    `**Ciljna stranica:** \`${storeUrl}\``,
    `**Datum analize:** ${auditDate}`,
    `**Trenutni Lighthouse skor:** **${score ?? '—'} / 100**`,
    ``,
    `| Ključna metrika | Trenutna vrednost | Ciljna vrednost | Status |`,
    `| --- | ---: | ---: | :---: |`,
    `| LCP (Glavni sadržaj) | ${lcpMs !== null ? (lcpMs / 1000).toFixed(1) + ' s' : '—'} | < 2.5 s | ${lcpMs === null ? '—' : lcpMs !== null && lcpMs < 2500 ? '✅ Dobro' : '❌ Kritično'} |`,
    `| TBT (ukupno blokirajuće vreme) | ${tbtMs !== null ? (tbtMs / 1000).toFixed(1) + ' s' : '—'} | < 0.3 s | ${tbtMs === null ? '—' : tbtMs !== null && tbtMs < 300 ? '✅ Dobro' : '❌ Kritično'} |`,
    `| Veličina slika | ${imageBytes !== null ? (imageBytes / 1000 / 1000).toFixed(2) + ' MB' : '—'} | < 0.5 MB | ${imageBytes === null ? '—' : imageBytes !== null && imageBytes < 500000 ? '✅ Dobro' : '❌ Preveliko'} |`,
    `| Ukupan prenos | ${totalBytes !== null ? (totalBytes / 1000 / 1000).toFixed(2) + ' MB' : '—'} | < 1.5 MB | ${totalBytes === null ? '—' : totalBytes !== null && totalBytes < 1500000 ? '✅ Dobro' : '❌ Preveliko'} |`,
    ``,
    `## Nalazi i kandidati za proveru`,
    ``,
  ];

  issues.forEach((issue, idx) => {
    lines.push(`### ${idx + 1}. ${issue.title} (Uticaj: ${issue.impact.toUpperCase()})`);
    lines.push(``);
    lines.push(issue.description);
    if (issue.estimatedSavings) {
      lines.push(``);
      lines.push(`**Procenjena ušteda:** ${issue.estimatedSavings}`);
    }
    if (issue.affectedUrls.length > 0) {
      lines.push(``);
      lines.push(`**Primeri pogođenih resursa:**`);
      issue.affectedUrls.slice(0, 5).forEach(u => lines.push(`- \`${u}\``));
    }
    lines.push(``);
    lines.push(`**Kandidat za proveru / prilagođavanje:**`);
    lines.push('```html');
    lines.push(issue.remediationSnippet);
    lines.push('```');
    lines.push(``);
  });

  return {
    storeUrl,
    auditDate,
    score,
    lcpMs,
    tbtMs,
    totalBytes,
    imageBytes,
    issues,
    markdownReport: lines.join('\n'),
  };
}
