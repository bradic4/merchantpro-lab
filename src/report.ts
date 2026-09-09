import type { LabMetrics, Measurement, RunState } from './domain.js';
import type { FieldData, FieldSnapshot } from './measurements.js';

export function summarize(values: (number | null)[]): { count: number; median: number | null; min: number | null; max: number | null } {
  const valid = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  if (!valid.length) return { count: 0, median: null, min: null, max: null };
  const middle = Math.floor(valid.length / 2);
  return { count: valid.length, median: valid.length % 2 ? valid[middle]! : (valid[middle - 1]! + valid[middle]!) / 2, min: valid[0]!, max: valid[valid.length - 1]! };
}

export function groupMeasurements(measurements: Measurement[]): Measurement[][] {
  const groups = new Map<string, Measurement[]>();
  for (const measurement of measurements) {
    const key = JSON.stringify([measurement.storeId, measurement.pageId, measurement.device, measurement.source,
      measurement.settingsHash, measurement.lighthouseVersion, measurement.browserVersion,
      measurement.browserVersion === 'unknown' ? measurement.id : '', measurement.finalUrl]);
    const group = groups.get(key) ?? [];
    group.push(measurement);
    groups.set(key, group);
  }
  return [...groups.values()];
}

const singleLine = (value: unknown): string => String(value ?? '').replace(/[\r\n\u0000-\u001f]+/g, ' ');
// Entity encoding prevents source metadata from introducing Markdown links or HTML.
const escape = (value: unknown): string => singleLine(value).replace(/[&<>\[\]`*_\\|]/g, character => `&#${character.charCodeAt(0)};`);
const code = (value: unknown): string => `\`${singleLine(value).replace(/`/g, "'").replace(/\|/g, '/')}\``;
const rawLink = (measurement: Measurement): string => {
  const path = measurement.rawFile.replace(/\\/g, '/');
  return /^raw\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/.test(path)
    ? `[${escape(measurement.id)}](<${path}>)` : `${escape(measurement.id)} (neispravna putanja sirovog rezultata)`;
};
const format = (value: number | null, decimals = 0): string => value === null ? '—' : value.toFixed(decimals);
const metricDefinitions: [keyof LabMetrics, string, number][] = [
  ['performance', 'Performance /100', 1], ['lcpMs', 'LCP (ms)', 0], ['cls', 'CLS', 3],
  ['tbtMs', 'TBT (ms)', 0], ['fcpMs', 'FCP (ms)', 0], ['ttfbMs', 'TTFB (ms)', 0],
  ['imageTransferBytes', 'Slike (bajtovi)', 0], ['totalTransferBytes', 'Ukupan prenos (bajtovi)', 0],
];

function fieldRow(measurement: Measurement, source: string, snapshot: FieldSnapshot | null): string {
  const period = snapshot?.collectionPeriod === null || snapshot?.collectionPeriod === undefined
    ? 'Period nije naveden u izvornom odgovoru' : JSON.stringify(snapshot.collectionPeriod);
  const available = snapshot?.available ? 'Podaci dostupni u izvornom JSON-u' : 'Nema dovoljno podataka u uvezenom odgovoru';
  return `| ${rawLink(measurement)} | ${source} | ${escape(snapshot?.scope ?? 'nema')} | ${escape(snapshot?.id ?? 'nije naveden')} | ${escape(period)} | ${available} |`;
}

function renderComparativeTable(state: RunState, measurements: Measurement[]): string[] {
  if (measurements.length === 0) return [];
  const lines: string[] = [
    '## Uporedna tabela prodavnica', '',
    'Svaki red je jedna stranica sa istim profilom, izvorom, verzijama i konačnim URL-om. Početne, kategorije i proizvodi se ne sabiraju. Različite grupe iste stranice ostaju zasebne; broj grupe odgovara detaljima ispod. Kolone prikazuju medijane dostupnih vrednosti, a detalji broj validnih vrednosti po metrici. Razlike među prodavnicama ne dokazuju uzrok.', '',
    '| Prodavnica | Platforma | Uloga | Stranica / grupa | Uređaj | Perf | LCP (ms) | CLS | TBT (ms) | TTFB (ms) | Slike (kB) | Ukupno (kB) | Merenja |',
    '| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const [index, storeM] of groupMeasurements(measurements).entries()) {
    const first = storeM[0]!;
    const store = state.manifest.stores.find(s => s.id === first.storeId);
    if (!store) continue;
    const planned = state.manifest.protocol.runs;
    const perf = summarize(storeM.map(m => m.metrics.performance)).median;
    const lcp = summarize(storeM.map(m => m.metrics.lcpMs)).median;
    const cls = summarize(storeM.map(m => m.metrics.cls)).median;
    const tbt = summarize(storeM.map(m => m.metrics.tbtMs)).median;
    const ttfb = summarize(storeM.map(m => m.metrics.ttfbMs)).median;
    const images = summarize(storeM.map(m => m.metrics.imageTransferBytes)).median;
    const total = summarize(storeM.map(m => m.metrics.totalTransferBytes)).median;
    lines.push(`| ${escape(store.name)} | ${escape(store.platform)} | ${escape(store.role)} | ${escape(first.pageId)} / ${index + 1} | ${first.device} | ${format(perf, 0)} | ${format(lcp, 0)} | ${format(cls, 3)} | ${format(tbt, 0)} | ${format(ttfb, 0)} | ${format(images === null ? null : images / 1000, 1)} | ${format(total === null ? null : total / 1000, 1)} | ${storeM.length}/${planned} |`);
  }
  lines.push('', '### Pokrivenost po platformi', '',
    'Ovo je broj zabeleženih prodavnica i izvršavanja. Zbirna ocena platforme se ne računa iz nejednakih i nepotpunih uzoraka.', '',
    '| Platforma | Prodavnica sa rezultatima | Uspešnih izvršavanja |',
    '| --- | ---: | ---: |');
  const platformGroups = new Map<string, { platform: string, role: string, stores: Set<string>, measurements: Measurement[] }>();
  for (const store of state.manifest.stores) {
    const storeM = measurements.filter(m => m.storeId === store.id);
    if (storeM.length === 0) continue;
    const key = `${store.platform}-${store.role}`;
    if (!platformGroups.has(key)) platformGroups.set(key, { platform: store.platform, role: store.role, stores: new Set(), measurements: [] });
    platformGroups.get(key)!.stores.add(store.id);
    platformGroups.get(key)!.measurements.push(...storeM);
  }
  for (const group of platformGroups.values()) {
    lines.push(`| ${escape(group.platform)} (${escape(group.role)}) | ${group.stores.size} | ${group.measurements.length} |`);
  }
  return lines;
}

export function renderReport(state: RunState): string {
  const measurements = state.items.flatMap(item => item.status === 'succeeded' && item.measurement ? [item.measurement] : []);
  const failed = state.items.filter(item => item.status === 'failed');
  const outstanding = state.items.filter(item => item.status === 'pending' || item.status === 'running');
  const manifest = state.manifest;
  const protocol = manifest.protocol;
  const lines = [
    `# MerchantPro Lab — ${escape(manifest.name)}`, '',
    ...(state.kind === 'demo' ? ['> **DEMO — SINTETIČKI PODACI.** Ovaj izveštaj demonstrira alat; ne sadrži stvarna merenja prodavnica i ne dokazuje probleme platforme.', ''] : []),
    `Pokretanje: ${code(state.id)} · Vrsta: ${code(state.kind)} · Status: **${escape(state.status)}**`, '',
    `Uspešna izvršavanja: **${measurements.length}/${state.items.length}**; neuspešna: **${failed.length}**; nedovršena: **${outstanding.length}**.`, '',
    ...(measurements.length !== state.items.length ? ['**Uzorak je nepotpun.** Nedostajuća i neuspešna merenja nisu uključena u medijane. Za ponovljiv nalaz završiti planirani broj uporedivih izvršavanja.', ''] : []),
    '## Protokol i poreklo', '',
    `Manifest SHA-256: ${code(state.manifestHash)}. Nastalo: ${escape(state.createdAt)}. Ažurirano: ${escape(state.updatedAt)}.`, '',
    `Planirano: ${protocol.runs} izvršavanja po stranici; profil ${code(protocol.device)}; lokacija ${code(protocol.location)}; pristanak ${code(protocol.consent)}; browser keš ${code(protocol.browserCache)}; CDN keš ${code(protocol.cdnCache)}.`, '',
    `Beleške protokola: ${escape(protocol.notes) || 'nisu navedene'}.`, '',
    ...(state.kind === 'import' ? ['Kod uvoza, lokacija, browser/CDN keš i pristanak iz manifesta predstavljaju izjavu operatora; uvezeni LHR/PSI JSON ne potvrđuje te uslove. Lokacija izvršavanja i stanje keša PSI testa su nepoznati. Isti zabeleženi profil ne potvrđuje iste stvarne uslove merenja.', ''] : []),
    'Trace i mrežni zapis alat čuva samo pri live prikupljanju, kada ih Lighthouse vrati. Uspešno merenje ili oporavak posle prekida ne garantuju da su opcioni artefakti dostupni; proveriti sadržaj direktorijuma `artifacts/`. Uvoz LHR/PSI rezultata ne dodaje trace i mrežni zapis, a same metrike ne potvrđuju uzrok problema.', '',
    'Rezultati se grupišu po prodavnici, stranici, uređaju, izvoru, SHA-256 podešavanja, verzijama Lighthouse-a i browsera, i konačnom URL-u. Nepoznata verzija browsera ostaje zasebno izvršavanje. Različiti profili se ne spajaju.', '',
    '## Pokrivenost uzorka', '',
    '| Prodavnica | Platforma / uloga | Tržište / tema | Stranice sa rezultatom | Uspešna / planirana izvršavanja |',
    '| --- | --- | --- | ---: | ---: |',
  ];
  for (const store of manifest.stores) {
    const recorded = measurements.filter(measurement => measurement.storeId === store.id);
    lines.push(`| ${escape(store.name)} | ${escape(store.platform)} / ${escape(store.role)} | ${escape(store.market)} / ${escape(store.theme)} | ${new Set(recorded.map(measurement => measurement.pageId)).size}/${store.pages.length} | ${recorded.length}/${store.pages.length * protocol.runs} |`);
  }
  lines.push('', 'Cilj uzorka iz plana: 10 MerchantPro prodavnica, 4 kontrole (oko 2 Shopify i 2 WooCommerce), i čist test nalog kada je dostupan; po jedna početna, kategorija i proizvod. Ova tabela prikazuje ostvarenu pokrivenost, bez tvrdnje da su kontrole sadržajno uporedive.', '');
  lines.push(...renderComparativeTable(state, measurements));
  lines.push('', '## Laboratorijska merenja', '',
    'Za svaku metriku prikazani su medijana, minimum, maksimum i broj validnih vrednosti. Crtica znači da nema validnog merenja. TBT je laboratorijska metrika; navigacioni Lighthouse rezultat ne daje INP stvarnih korisnika. TTFB dolazi iz audita `server-response-time`, a prenos iz `resource-summary`; sirovi JSON čuva metod i detalje.', '');
  const groups = groupMeasurements(measurements);
  if (!measurements.length) lines.push('Još nema uspešnih merenja.', '');
  else {
    lines.push('### Uporedni pregled', '', 'Svaki red predstavlja zasebnu grupu sa istim zabeleženim profilom. Broj grupe vodi do detalja ispod; razlike među redovima nisu dokaz zajedničkog uzroka. LCP prikazuje medijanu [minimum–maksimum], ostale kolone medijanu. Uz vrednost je broj validnih merenja n; kB = 1.000 bajtova.', '',
      '| Grupa | Prodavnica / stranica | Uređaj / izvor | Izvršavanja | LCP (ms), n | CLS, n | TBT (ms), n | Slike (kB), n |',
      '| --- | --- | --- | ---: | --- | --- | --- | --- |');
    for (const [index, group] of groups.entries()) {
      const first = group[0]!;
      const store = manifest.stores.find(store => store.id === first.storeId);
      const summaryCell = (key: keyof LabMetrics, decimals: number, divisor = 1, range = false): string => {
        const summary = summarize(group.map(measurement => measurement.metrics[key]));
        if (summary.median === null) return '—, n=0';
        return `${format(summary.median / divisor, decimals)}${range ? ` [${format(summary.min! / divisor, decimals)}–${format(summary.max! / divisor, decimals)}]` : ''}, n=${summary.count}`;
      };
      lines.push(`| ${index + 1} | ${escape(store?.name ?? first.storeId)} / ${escape(first.pageId)} | ${first.device} / ${first.source} | ${group.length}/${protocol.runs} | ${summaryCell('lcpMs', 0, 1, true)} | ${summaryCell('cls', 3)} | ${summaryCell('tbtMs', 0)} | ${summaryCell('imageTransferBytes', 1, 1000)} |`);
    }
    lines.push('');
  }
  for (const [index, group] of groups.entries()) {
    const first = group[0]!;
    const store = manifest.stores.find(store => store.id === first.storeId);
    const page = store?.pages.find(page => page.id === first.pageId);
    lines.push(`### ${index + 1}. ${escape(store?.name ?? first.storeId)} / ${escape(page?.type ?? first.pageId)} / ${first.device}`, '',
      `Stranica: ${escape(first.requestedUrl)}. Konačni URL: ${escape(first.finalUrl)}.`, '',
      `Izvor: ${code(first.source)}; Lighthouse ${code(first.lighthouseVersion)}; browser ${code(first.browserVersion)}; podešavanja SHA-256 ${code(first.settingsHash)}.`, '',
      `Izvršavanja u istoj zabeleženoj grupi: **${group.length}/${protocol.runs}**${group.length < protocol.runs ? ' — nepotpuno za planirani protokol' : ''}.`, '',
      '| Metrika | Medijana | Minimum | Maksimum | Validne vrednosti |', '| --- | ---: | ---: | ---: | ---: |');
    for (const [key, label, decimals] of metricDefinitions) {
      const summary = summarize(group.map(measurement => measurement.metrics[key]));
      lines.push(`| ${label} | ${format(summary.median, decimals)} | ${format(summary.min, decimals)} | ${format(summary.max, decimals)} | ${summary.count}/${group.length} |`);
    }
    lines.push('', `Izvori: ${group.map(rawLink).join(', ')}.`, '');
  }
  lines.push('## Podaci stvarnih korisnika — odvojeno od laboratorije', '',
    'Podaci iz `loadingExperience` i `originLoadingExperience` ostaju odvojeni. URL, origin ili nepoznat opseg i eksplicitno dostupni periodi prikazani su ispod. Period bez datuma se ne izračunava iz datuma laboratorijskog testa. Odsustvo podataka ne dokazuje brzinu ni sporost. [PSI objašnjenje](https://developers.google.com/speed/docs/insights/v5/about).', '');
  const fieldMeasurements = measurements.filter(measurement => measurement.fieldData !== null);
  if (!fieldMeasurements.length) lines.push('Nema podataka stvarnih korisnika u ovom pokretanju; lokalni Lighthouse ih ne prikuplja.', '');
  else {
    lines.push('| Izvršavanje | Polje izvora | Opseg | ID iz izvora | Period iz izvora | Dostupnost |', '| --- | --- | --- | --- | --- | --- |');
    for (const measurement of fieldMeasurements) {
      const field = measurement.fieldData as FieldData;
      lines.push(fieldRow(measurement, 'loadingExperience', field.url ?? null), fieldRow(measurement, 'originLoadingExperience', field.origin ?? null));
    }
    lines.push('');
  }

  lines.push('## Analiza resursa', '', 'Ova analiza potiče od jednog izvršavanja, pogledajte izvorni JSON rezultat za kompletan trace i sve zahteve.', '');
  const resourceMeasurements = measurements.filter(m => m.resources !== null);
  if (!resourceMeasurements.length) lines.push('Nema podataka o resursima u ovom pokretanju.', '');
  else {
    for (const m of resourceMeasurements) {
      const r = m.resources!;
      lines.push(`### Izvršavanje: ${code(m.id)} (${escape(m.requestedUrl)})`, '');
      lines.push(`DOM elementi: **${r.domElements !== null ? r.domElements : 'nepoznato'}** · Ukupno zahteva: **${r.totalRequests !== null ? r.totalRequests : 'nepoznato'}**`, '');

      if (r.images.length > 0) {
        lines.push('#### Slike', '', '| URL | MIME tip | Prenos (kB) | LCP |', '| --- | --- | ---: | --- |');
        for (const img of r.images) {
          const truncatedUrl = img.url.length > 80 ? img.url.substring(0, 77) + '...' : img.url;
          lines.push(`| ${escape(truncatedUrl)} | ${escape(img.mimeType ?? 'nepoznato')} | ${img.transferSize !== null ? format(img.transferSize / 1000, 1) : '—'} | ${img.isLcpElement ? '**DA**' : ''} |`);
        }
        lines.push('');
      } else {
        lines.push('Nema slika u mrežnim zahtevima.', '');
      }

      if (r.blockingResources.length > 0) {
        lines.push('#### Blokirajući resursi', '', '| URL | Izgubljeno vreme (ms) |', '| --- | ---: |');
        for (const res of r.blockingResources) {
          const truncatedUrl = res.url.length > 80 ? res.url.substring(0, 77) + '...' : res.url;
          lines.push(`| ${escape(truncatedUrl)} | ${res.wastedMs !== null ? format(res.wastedMs, 0) : '—'} |`);
        }
        lines.push('');
      } else {
        lines.push('Nema render-blocking resursa.', '');
      }
    }
  }

  lines.push('## Upozorenja i neuspešna izvršavanja', '');
  const warnings = measurements.flatMap(measurement => measurement.warnings.map(warning => `- ${code(measurement.id)}: ${escape(warning)}`));
  lines.push(...warnings, ...failed.map(item => `- ${code(item.id)}: ${escape(item.error ?? 'nepoznata greška')}`), ...outstanding.map(item => `- ${code(item.id)}: ${escape(item.status)} — nije završeno.`));
  if (!warnings.length && !failed.length && !outstanding.length) lines.push('Nema zabeleženih upozorenja.');
  lines.push('', '## Evidencija sirovih rezultata', '', '| Izvršavanje | Datum testa | Izvorni JSON | SHA-256 |', '| --- | --- | --- | --- |');
  for (const measurement of measurements) lines.push(`| ${code(measurement.id)} | ${escape(measurement.fetchedAt)} | ${rawLink(measurement)} | ${code(measurement.rawSha256)} |`);
  lines.push('', '## Tri prioriteta — obrazac za potvrdu dokazima', '',
    'Merenja su početak analize. Popuniti nalaze nakon pregleda resursa, trace-a, nativnih mogućnosti i razgovora. Razlika skorova između platformi ne utvrđuje uzrok. **G1 ostaje nepotvrđen** dok isti rešiv problem nije dokazan na najmanje tri nezavisne prodavnice i proverene nativne mogućnosti.', '',
    '| Prioritet | Simptom i URL dokaza | Resurs / mogući vlasnik uzroka | Nezavisne prodavnice | Nativna opcija i dostupna izmena | Uticaj, pouzdanost i rizik | Interes kupca / sledeći test |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    '| 1 | Za utvrđivanje | Za proveru | Nije potvrđeno | Za proveru | Nije ocenjeno | Za proveru |',
    '| 2 | Za utvrđivanje | Za proveru | Nije potvrđeno | Za proveru | Nije ocenjeno | Za proveru |',
    '| 3 | Za utvrđivanje | Za proveru | Nije potvrđeno | Za proveru | Nije ocenjeno | Za proveru |', '',
    'Za izabrani POC zapisati jednu intervenciju, kontrolne stranice, pristup potreban za izmenu, način vraćanja, glavno merilo i unapred dogovoren prag koristi. Matrica dostupnih intervencija i mapa uzroka popunjavaju se ručno uz ovaj izveštaj.', '',
    'Dokumentacija za proveru: [MerchantPro API](https://docs.merchantpro.com/api/), [Themes API](https://docs.merchantpro.com/api/endpoints/themes/), [Lighthouse skor](https://developer.chrome.com/docs/lighthouse/performance/performance-scoring), [analiza LCP-a](https://web.dev/articles/optimize-lcp).', '');
  return lines.join('\n');
}
