import { readFile } from 'node:fs/promises';
import type { Manifest, Store } from './domain.js';

export function safeId(value: unknown, label = 'id'): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) {
    throw new Error(`${label}: koristite 1–64 mala slova, cifre, _ ili -.`);
  }
  return value;
}
function nonempty(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}: obavezna tekstualna vrednost.`);
}
export function publicUrl(value: unknown): URL {
  nonempty(value, 'URL');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('URL nije ispravan.'); }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
    hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') ||
    !hostname.includes('.') || /^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(':')) {
    throw new Error('Koristite javni HTTPS URL bez pristupnih podataka ili fragmenta.');
  }
  return url;
}
export function validateManifest(input: unknown): Manifest {
  const value = input as Manifest;
  if (!value || value.schemaVersion !== 1) throw new Error('Manifest mora imati schemaVersion: 1.');
  nonempty(value.name, 'name');
  const p = value.protocol;
  if (!p || !['mobile', 'desktop'].includes(p.device) || ![3, 5].includes(p.runs) ||
    p.consent !== 'no-interaction' || p.browserCache !== 'cold' ||
    !['unknown', 'warmed-by-preflight'].includes(p.cdnCache)) {
    throw new Error('Neispravan protokol: mobile/desktop, 3/5 ponavljanja, cold cache i no-interaction consent.');
  }
  nonempty(p.location, 'protocol.location');
  if (typeof p.notes !== 'string') throw new Error('protocol.notes mora biti tekst.');
  if (!Array.isArray(value.stores)) throw new Error('stores mora biti niz.');
  const ids = new Set<string>(); const origins = new Set<string>();
  for (const store of value.stores) {
    safeId(store.id, 'store.id'); nonempty(store.name, 'store.name');
    if (ids.has(store.id)) throw new Error(`Dupli store.id: ${store.id}`);
    ids.add(store.id);
    const origin = publicUrl(store.origin);
    if (origin.pathname !== '/' || origin.search) throw new Error('store.origin mora biti samo HTTPS domen.');
    if (origins.has(origin.origin)) throw new Error('Isti domen ne može predstavljati dve nezavisne prodavnice.');
    origins.add(origin.origin);
    if (!['merchantpro', 'shopify', 'woocommerce', 'other'].includes(store.platform) ||
      !['sample', 'control', 'clean-test'].includes(store.role)) throw new Error('Nepoznata platforma ili uloga prodavnice.');
    for (const key of ['market', 'theme', 'notes'] as const) {
      if (typeof store[key] !== 'string') throw new Error(`store.${key} mora biti tekst; koristite unknown kada podatak nije poznat.`);
    }
    if (!Array.isArray(store.pages) || store.pages.length === 0) throw new Error(`Prodavnica ${store.id} nema stranice.`);
    const pageIds = new Set<string>(); const urls = new Set<string>();
    for (const page of store.pages) {
      safeId(page.id, 'page.id');
      if (pageIds.has(page.id)) throw new Error(`Dupli page.id u ${store.id}.`);
      pageIds.add(page.id);
      if (!['home', 'category', 'product'].includes(page.type)) throw new Error('Nepoznat tip stranice.');
      const url = publicUrl(page.url);
      if (url.origin !== origin.origin) throw new Error(`Stranica ${page.id} ne pripada domenu prodavnice.`);
      if (urls.has(url.href)) throw new Error('Isti URL se ne sme ponoviti u jednoj prodavnici.');
      urls.add(url.href);
    }
  }
  return value;
}
export async function readManifest(path: string): Promise<Manifest> {
  return validateManifest(JSON.parse(await readFile(path, 'utf8')));
}
export function coverageWarnings(manifest: Manifest): string[] {
  const warnings: string[] = [];
  const counts = (platform: Store['platform'], role: Store['role']) => manifest.stores.filter(s => s.platform === platform && s.role === role).length;
  if (counts('merchantpro', 'sample') < 10) warnings.push('Predloženi uzorak: 10 MerchantPro prodavnica.');
  if (counts('shopify', 'control') < 2 || counts('woocommerce', 'control') < 2) warnings.push('Predložena kontrola: 2 Shopify i 2 WooCommerce prodavnice.');
  for (const store of manifest.stores) {
    for (const type of ['home', 'category', 'product']) {
      if (!store.pages.some(p => p.type === type)) warnings.push(`${store.id}: nedostaje ${type} URL.`);
    }
  }
  if (manifest.protocol.location === 'unknown') warnings.push('Mesto izvršavanja nije navedeno; uporedivost je ograničena.');
  return warnings;
}
export function emptyManifest(): Manifest {
  return { schemaVersion: 1, name: 'MerchantPro — faza A', protocol: {
    device: 'mobile', runs: 3, location: 'unknown', consent: 'no-interaction',
    browserCache: 'cold', cdnCache: 'unknown', notes: 'Upisati lokaciju i uslove pre merenja. Ne menja se stanje cookie banera.'
  }, stores: [] };
}
