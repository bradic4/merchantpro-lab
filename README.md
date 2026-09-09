# MerchantPro Lab

Lokalni Node.js/TypeScript alat za analizu performansi prodavnica, ponovljiva merenja i pripremu optimizacija. Uključuje web panel sa trajnim redom analiza i istorijom u SQLite bazi.

## Šta radi

- Vodi manifest prodavnica, platformi, tržišta, tema i reprezentativnih URL-ova.
- Izvršava 3 ili 5 Lighthouse merenja po stranici, serijski, sa zasebnim browser profilom i hladnim browser kešom.
- Čuva originalni Lighthouse JSON, performance trace i mrežni zapis kada ih Lighthouse vrati, SHA-256 i stanje svakog pokušaja.
- Nastavlja prekinut skup bez ponavljanja završenih merenja i proverava integritet sirovih rezultata.
- Uvozi Lighthouse ili PSI JSON i prepoznaje ponovljen uvoz istog izvršavanja.
- Pravi Markdown izveštaj sa medijanom, rasponom, brojem validnih vrednosti, pokrivenošću i obrascem tri prioriteta. Razdvaja različite profile/verzije i laboratorijske od CrUX podataka.
- Čita ograničen inventar proizvoda i galerija kroz MerchantPro API. Dostupne su isključivo GET operacije.

Panel podržava pojedinačne analize, pregled rezultata, obradu slika i čitanje MerchantPro kataloga. Preporuke su kandidati za proveru, a ne garantovane uštede. Alat je namenjen lokalnom radu; javni višekorisnički hosting još nije podržan.

### Lokalni panel

```powershell
npm ci
npm run check
npm run dev -- init --manifest data/manifest-sr.json
npm run ui
```

Otvorite adresu ispisanu u terminalu. Komanda `init` namenjena je prvom pokretanju, kada manifest još ne postoji. Lokalni `data/` i `work/` nisu deo repozitorijuma. Sintetički primeri nalaze se u `examples/demo/`.

- [Red i istorija analiza](docs/audit-jobs.md)
- [Popravke pouzdanosti i ograničenja](docs/reliability-fixes.md)
- [Kontrolisani eksperimenti](docs/controlled-experiments.md)

## Pokretanje

Potreban je Node.js **22.19+** (provereno na 24.19), npm i lokalni Chrome za živa merenja. Uvoz i izveštaji ne otvaraju browser. Verzije paketa su fiksirane u `package-lock.json`.

```powershell
npm ci
npm run check
npm run dev -- help
npm run dev -- demo --out data/demo
```

Primer gotovog demonstracionog izveštaja je u `examples/demo/report.md`. Nakon build-a CLI se može pokrenuti i sa `node dist/cli.js`.

Ako Windows koristi organizacioni sertifikat i Node prijavi `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, na Node 24 može se koristiti `$env:NODE_USE_SYSTEM_CA='1'` pre `npm ci`. TLS provera ostaje uključena.

## Početni uzorak

```powershell
npm run dev -- init --manifest data/sample.json
npm run dev -- add-store --manifest data/sample.json --id radnja --name "Moja radnja" --origin https://radnja.example --platform merchantpro --market RS --home https://radnja.example/ --category https://radnja.example/kategorija --product https://radnja.example/proizvod
npm run dev -- validate --manifest data/sample.json
```

Zamenite primer stvarnim URL-ovima. U manifest upišite lokaciju izvršavanja i poznatu temu; nepoznate podatke ostavite kao `unknown`. Za kontrole postavite `role: "control"` i odgovarajuću platformu. Predlog plana je 10 MerchantPro + 2 Shopify + 2 WooCommerce prodavnice. Manji početni uzorak je dozvoljen i jasno označen.

`protocol.runs` prihvata 3 ili 5; `device` je `mobile` ili `desktop`. Za dva uređaja napravite dva manifesta i dva izlazna foldera. Mrežni i CPU profil su fiksirani u runner-u i sačuvani u izvornim Lighthouse podešavanjima.

```powershell
npm run dev -- run --manifest data/sample.json --out data/benchmark
npm run dev -- run --manifest data/sample.json --out data/benchmark --resume
npm run dev -- report --state data/benchmark/state.json
```

Ako Chrome nije automatski pronađen, prosledite `--chrome "C:\Program Files\Google\Chrome\Application\chrome.exe"`. Merenja posete navedenim stranicama i učitaju njihove uobičajene resurse. Ne klikću cookie baner, pa `consent: "no-interaction"` opisuje zatečeno stanje, a ne tvrdnju da je saglasnost data ili odbijena.

`cdnCache: "unknown"` je podrazumevano. `warmed-by-preflight` izvršava dodatnu posetu svakoj stranici pre serije; to beleži pokušaj zagrevanja, **ne garantuje** CDN cache hit. Mesto izvršavanja je izjava operatora. Importovani PSI/LHR ne potvrđuje lokaciju, CDN/browser keš ili pristanak iz manifesta.

Novi run zahteva prazan izlazni folder. `--resume` zahteva isti manifest. Posle normalne greške nastavak je moguć odmah. Posle nasilnog prekida može ostati `.run.lock`: proverite da navedeni PID više ne radi i tek tada uklonite taj fajl. Završeni sirovi rezultati ostaju sačuvani; neuspešna/nepotpuna izvršavanja se ponavljaju. Ovo je zaključavanje lokalnog procesa, ne distribuirani red poslova.

## Uvoz postojećih merenja

```powershell
npm run dev -- import --manifest data/sample.json --store radnja --page home --input run1.json --input run2.json --input run3.json --out data/import
```

Koristite zaseban folder za uvoz. Ponovite komandu za kategoriju i proizvod. Potrebni su originalni Lighthouse JSON ili PSI odgovor sa `lighthouseResult`. HTML izveštaji nisu podržani. Neispravni URL-ovi, runtime greške i pogrešan uređaj se odbijaju. Nedostajuća metrika ostaje nedostupna. Duplikat se prepoznaje i kada isti LHR ima drugačije formatiran JSON ili PSI omotač; ne postaje novo nezavisno izvršavanje.

Uvoz samih metrika ne daje trace ni mrežni zapis za dijagnozu uzroka. CrUX ostaje zaseban, uz URL/origin opseg i period samo kada je prisutan u izvornim podacima.

## Katalog: konektor za čitanje

Napravite namenski MerchantPro API nalog sa potrebnim dozvolama za čitanje proizvoda. Kredencijali se uzimaju isključivo iz procesnog okruženja, sa imenom vezanim za `store.id` (velika slova; `-` postaje `_`):

```powershell
# Postavite MERCHANTPRO_RADNJA_USERNAME i MERCHANTPRO_RADNJA_SECRET
# u lokalnom procesnom okruženju, bez upisivanja u repozitorijum.
npm run dev -- inventory --manifest data/sample.json --store radnja --max-products 20 --include-images --out data/catalog.json
```

Konektor koristi dokumentovani Basic Auth preko HTTPS-a, razmak od najmanje dve sekunde, vremensko ograničenje zahteva, ograničene retry pokušaje i obradu HTTP 429. Ne prosleđuje kredencijale na redirect i ne ponavlja 401/403. Stranice inventara nisu atomski snimak: promena kataloga/paginacije može zaustaviti čitanje. Kvota drugih integracija nije poznata; pokrenite jedan inventory proces po prodavnici. Konektor je proveren lažnim HTTP odgovorima; za potvrdu na konkretnom nalogu potreban je stvarni pristup.

## Struktura i sledeći koraci

`src/manifest.ts` validira uzorak; `runner.ts` upravlja merenjima; `measurements.ts` i `report.ts` obrađuju dokaze; `storage.ts` čuva stanje; `connector.ts` je nezavisan konektor. `tests/` pokriva važne kvarove, izolaciju i oporavak.

1. Uneti stvarne prodavnice i završiti početna merenja.
2. Dopuniti [evidenciju nalaza](docs/evidence-template.md) resursima, trace dokazima, nativnim mogućnostima i razgovorima.
3. Izabrati jedan POC kada isti rešiv problem postoji na najmanje tri nezavisne prodavnice.
4. Za taj POC razviti kontrolisanu intervenciju i proveru rezultata/povratka. Image upload, brisanje, obrada, queue, PostgreSQL, NestJS, Angular i naplata pripadaju narednim inkrementima prema nalazima.

Detaljnija procena plana i trenutno stanje: [development-status.md](docs/development-status.md).

Nastavak razvoja: [kontrolisani A/B eksperimenti](docs/controlled-experiments.md) podržavaju proveru uticaja eksternog dodatka na jednom URL-u, uz potvrdu blokade u mrežnom zapisu.

Izvori: [MerchantPro API](https://docs.merchantpro.com/api/), [Products API](https://docs.merchantpro.com/api/endpoints/products/), [Lighthouse programmatic usage](https://github.com/GoogleChrome/lighthouse/blob/main/docs/readme.md), [PSI response](https://developers.google.com/speed/docs/insights/v5/reference/pagespeedapi/runpagespeed).
