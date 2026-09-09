# MerchantPro Lab — SINTETIČKI DEMO — bez stvarnih prodavnica

> **DEMO — SINTETIČKI PODACI.** Ovaj izveštaj demonstrira alat; ne sadrži stvarna merenja prodavnica i ne dokazuje probleme platforme.

Pokretanje: `af2293d2-9e10-43e9-ada4-29908e36d1d4` · Vrsta: `demo` · Status: **completed**

Uspešna izvršavanja: **9/9**; neuspešna: **0**; nedovršena: **0**.

## Protokol i poreklo

Manifest SHA-256: `3fca3b985a4592c3dee7e63da27f4090c5a01ce5930d79497fd7453bf1431768`. Nastalo: 2026-09-08T06:54:43.224Z. Ažurirano: 2026-09-08T06:54:43.390Z.

Planirano: 3 izvršavanja po stranici; profil `mobile`; lokacija `synthetic`; pristanak `no-interaction`; browser keš `cold`; CDN keš `unknown`.

Beleške protokola: Izmišljene vrednosti služe isključivo za demonstraciju alata..

Trace i mrežni zapis alat čuva samo pri live prikupljanju, kada ih Lighthouse vrati. Uspešno merenje ili oporavak posle prekida ne garantuju da su opcioni artefakti dostupni; proveriti sadržaj direktorijuma `artifacts/`. Uvoz LHR/PSI rezultata ne dodaje trace i mrežni zapis, a same metrike ne potvrđuju uzrok problema.

Rezultati se grupišu po prodavnici, stranici, uređaju, izvoru, SHA-256 podešavanja, verzijama Lighthouse-a i browsera, i konačnom URL-u. Nepoznata verzija browsera ostaje zasebno izvršavanje. Različiti profili se ne spajaju.

## Pokrivenost uzorka

| Prodavnica | Platforma / uloga | Tržište / tema | Stranice sa rezultatom | Uspešna / planirana izvršavanja |
| --- | --- | --- | ---: | ---: |
| Demo prodavnica (izmišljena) | merchantpro / sample | unknown / unknown | 3/3 | 9/9 |

Cilj uzorka iz plana: 10 MerchantPro prodavnica, 4 kontrole (oko 2 Shopify i 2 WooCommerce), i čist test nalog kada je dostupan; po jedna početna, kategorija i proizvod. Ova tabela prikazuje ostvarenu pokrivenost, bez tvrdnje da su kontrole sadržajno uporedive.

## Laboratorijska merenja

Za svaku metriku prikazani su medijana, minimum, maksimum i broj validnih vrednosti. Crtica znači da nema validnog merenja. TBT je laboratorijska metrika; navigacioni Lighthouse rezultat ne daje INP stvarnih korisnika. TTFB dolazi iz audita `server-response-time`, a prenos iz `resource-summary`; sirovi JSON čuva metod i detalje.

### Uporedni pregled

Svaki red predstavlja zasebnu grupu sa istim zabeleženim profilom. Broj grupe vodi do detalja ispod; razlike među redovima nisu dokaz zajedničkog uzroka. LCP prikazuje medijanu [minimum–maksimum], ostale kolone medijanu. Uz vrednost je broj validnih merenja n; kB = 1.000 bajtova.

| Grupa | Prodavnica / stranica | Uređaj / izvor | Izvršavanja | LCP (ms), n | CLS, n | TBT (ms), n | Slike (kB), n |
| --- | --- | --- | ---: | --- | --- | --- | --- |
| 1 | Demo prodavnica (izmišljena) / home | mobile / lighthouse | 3/3 | 3600 [3400–3800], n=3 | 0.100, n=3 | 280, n=3 | 970.0, n=3 |
| 2 | Demo prodavnica (izmišljena) / category | mobile / lighthouse | 3/3 | 3700 [3500–3900], n=3 | 0.100, n=3 | 280, n=3 | 970.0, n=3 |
| 3 | Demo prodavnica (izmišljena) / product | mobile / lighthouse | 3/3 | 3800 [3600–4000], n=3 | 0.100, n=3 | 280, n=3 | 970.0, n=3 |

### 1. Demo prodavnica (izmišljena) / home / mobile

Stranica: https://demo.invalid/. Konačni URL: https://demo.invalid/.

Izvor: `lighthouse`; Lighthouse `13.4.1`; browser `130.0.0.0`; podešavanja SHA-256 `58fbd035fb3dfba3671ea69d7bf8738cd3f019b8f555e4ed5c5c98902e0f94f2`.

Izvršavanja u istoj zabeleženoj grupi: **3/3**.

| Metrika | Medijana | Minimum | Maksimum | Validne vrednosti |
| --- | ---: | ---: | ---: | ---: |
| Performance /100 | 52.0 | 51.0 | 53.0 | 3/3 |
| LCP (ms) | 3600 | 3400 | 3800 | 3/3 |
| CLS | 0.100 | 0.090 | 0.110 | 3/3 |
| TBT (ms) | 280 | 260 | 300 | 3/3 |
| FCP (ms) | 2000 | 1900 | 2100 | 3/3 |
| TTFB (ms) | 450 | 440 | 460 | 3/3 |
| Slike (bajtovi) | 970000 | 960000 | 980000 | 3/3 |
| Ukupan prenos (bajtovi) | 1520000 | 1510000 | 1530000 | 3/3 |

Izvori: [4&#95;demo&#95;4&#95;home&#95;1](<raw/4_demo_4_home_1.json>), [4&#95;demo&#95;4&#95;home&#95;2](<raw/4_demo_4_home_2.json>), [4&#95;demo&#95;4&#95;home&#95;3](<raw/4_demo_4_home_3.json>).

### 2. Demo prodavnica (izmišljena) / category / mobile

Stranica: https://demo.invalid/category. Konačni URL: https://demo.invalid/category.

Izvor: `lighthouse`; Lighthouse `13.4.1`; browser `130.0.0.0`; podešavanja SHA-256 `58fbd035fb3dfba3671ea69d7bf8738cd3f019b8f555e4ed5c5c98902e0f94f2`.

Izvršavanja u istoj zabeleženoj grupi: **3/3**.

| Metrika | Medijana | Minimum | Maksimum | Validne vrednosti |
| --- | ---: | ---: | ---: | ---: |
| Performance /100 | 52.0 | 51.0 | 53.0 | 3/3 |
| LCP (ms) | 3700 | 3500 | 3900 | 3/3 |
| CLS | 0.100 | 0.090 | 0.110 | 3/3 |
| TBT (ms) | 280 | 260 | 300 | 3/3 |
| FCP (ms) | 2000 | 1900 | 2100 | 3/3 |
| TTFB (ms) | 450 | 440 | 460 | 3/3 |
| Slike (bajtovi) | 970000 | 960000 | 980000 | 3/3 |
| Ukupan prenos (bajtovi) | 1520000 | 1510000 | 1530000 | 3/3 |

Izvori: [4&#95;demo&#95;8&#95;category&#95;1](<raw/4_demo_8_category_1.json>), [4&#95;demo&#95;8&#95;category&#95;2](<raw/4_demo_8_category_2.json>), [4&#95;demo&#95;8&#95;category&#95;3](<raw/4_demo_8_category_3.json>).

### 3. Demo prodavnica (izmišljena) / product / mobile

Stranica: https://demo.invalid/product. Konačni URL: https://demo.invalid/product.

Izvor: `lighthouse`; Lighthouse `13.4.1`; browser `130.0.0.0`; podešavanja SHA-256 `58fbd035fb3dfba3671ea69d7bf8738cd3f019b8f555e4ed5c5c98902e0f94f2`.

Izvršavanja u istoj zabeleženoj grupi: **3/3**.

| Metrika | Medijana | Minimum | Maksimum | Validne vrednosti |
| --- | ---: | ---: | ---: | ---: |
| Performance /100 | 52.0 | 51.0 | 53.0 | 3/3 |
| LCP (ms) | 3800 | 3600 | 4000 | 3/3 |
| CLS | 0.100 | 0.090 | 0.110 | 3/3 |
| TBT (ms) | 280 | 260 | 300 | 3/3 |
| FCP (ms) | 2000 | 1900 | 2100 | 3/3 |
| TTFB (ms) | 450 | 440 | 460 | 3/3 |
| Slike (bajtovi) | 970000 | 960000 | 980000 | 3/3 |
| Ukupan prenos (bajtovi) | 1520000 | 1510000 | 1530000 | 3/3 |

Izvori: [4&#95;demo&#95;7&#95;product&#95;1](<raw/4_demo_7_product_1.json>), [4&#95;demo&#95;7&#95;product&#95;2](<raw/4_demo_7_product_2.json>), [4&#95;demo&#95;7&#95;product&#95;3](<raw/4_demo_7_product_3.json>).

## Podaci stvarnih korisnika — odvojeno od laboratorije

Podaci iz `loadingExperience` i `originLoadingExperience` ostaju odvojeni. URL, origin ili nepoznat opseg i eksplicitno dostupni periodi prikazani su ispod. Period bez datuma se ne izračunava iz datuma laboratorijskog testa. Odsustvo podataka ne dokazuje brzinu ni sporost. [PSI objašnjenje](https://developers.google.com/speed/docs/insights/v5/about).

Nema podataka stvarnih korisnika u ovom pokretanju; lokalni Lighthouse ih ne prikuplja.

## Upozorenja i neuspešna izvršavanja

- `4_demo_4_home_1`: SINTETIČKI DEMO: ovo nije merenje prodavnice.
- `4_demo_4_home_2`: SINTETIČKI DEMO: ovo nije merenje prodavnice.
- `4_demo_4_home_3`: SINTETIČKI DEMO: ovo nije merenje prodavnice.
- `4_demo_8_category_1`: SINTETIČKI DEMO: ovo nije merenje prodavnice.
- `4_demo_8_category_2`: SINTETIČKI DEMO: ovo nije merenje prodavnice.
- `4_demo_8_category_3`: SINTETIČKI DEMO: ovo nije merenje prodavnice.
- `4_demo_7_product_1`: SINTETIČKI DEMO: ovo nije merenje prodavnice.
- `4_demo_7_product_2`: SINTETIČKI DEMO: ovo nije merenje prodavnice.
- `4_demo_7_product_3`: SINTETIČKI DEMO: ovo nije merenje prodavnice.

## Evidencija sirovih rezultata

| Izvršavanje | Datum testa | Izvorni JSON | SHA-256 |
| --- | --- | --- | --- |
| `4_demo_4_home_1` | 2026-01-01T12:00:01.000Z | [4&#95;demo&#95;4&#95;home&#95;1](<raw/4_demo_4_home_1.json>) | `ada238ab4e4c71618d1f7c25eedfb1ae9d29a4de1b54d1694c8b6f0e134c9891` |
| `4_demo_4_home_2` | 2026-01-01T12:00:02.000Z | [4&#95;demo&#95;4&#95;home&#95;2](<raw/4_demo_4_home_2.json>) | `bb634f18b9fca876d40c7ab5c31a2f3e02f6700eccd1bdf3ee3946d2ea6ed313` |
| `4_demo_4_home_3` | 2026-01-01T12:00:03.000Z | [4&#95;demo&#95;4&#95;home&#95;3](<raw/4_demo_4_home_3.json>) | `ed7194a89e6c5d1bb8342918b9da467d687684d4ccd2a241b7e03cfdaa650173` |
| `4_demo_8_category_1` | 2026-01-01T12:01:01.000Z | [4&#95;demo&#95;8&#95;category&#95;1](<raw/4_demo_8_category_1.json>) | `48296af4b061c209924c5a7b72598f391beed0e29507aac0de240db6576a967b` |
| `4_demo_8_category_2` | 2026-01-01T12:01:02.000Z | [4&#95;demo&#95;8&#95;category&#95;2](<raw/4_demo_8_category_2.json>) | `c087d904c32bc7f945e82e0fb6911d83986278ac350693d0cf2c9ea50e2282b1` |
| `4_demo_8_category_3` | 2026-01-01T12:01:03.000Z | [4&#95;demo&#95;8&#95;category&#95;3](<raw/4_demo_8_category_3.json>) | `5c2170f213ea2901f228fa1c0b935cc1c9d3c66c795ce7ffbb6665b127313c41` |
| `4_demo_7_product_1` | 2026-01-01T12:02:01.000Z | [4&#95;demo&#95;7&#95;product&#95;1](<raw/4_demo_7_product_1.json>) | `652c35e2f5bcd205992de2aaeae90d8a46eb50d5506105fefe4d2aa472079b37` |
| `4_demo_7_product_2` | 2026-01-01T12:02:02.000Z | [4&#95;demo&#95;7&#95;product&#95;2](<raw/4_demo_7_product_2.json>) | `3f99243aa79f6ce390bb2892e7b8439e737e7f894dd479fc7eb8acd021b146c9` |
| `4_demo_7_product_3` | 2026-01-01T12:02:03.000Z | [4&#95;demo&#95;7&#95;product&#95;3](<raw/4_demo_7_product_3.json>) | `33426417e730acd7ca8fa7e82549def09b0a07aa3eb1969e0ce2f7d2faefa814` |

## Tri prioriteta — obrazac za potvrdu dokazima

Merenja su početak analize. Popuniti nalaze nakon pregleda resursa, trace-a, nativnih mogućnosti i razgovora. Razlika skorova između platformi ne utvrđuje uzrok. **G1 ostaje nepotvrđen** dok isti rešiv problem nije dokazan na najmanje tri nezavisne prodavnice i proverene nativne mogućnosti.

| Prioritet | Simptom i URL dokaza | Resurs / mogući vlasnik uzroka | Nezavisne prodavnice | Nativna opcija i dostupna izmena | Uticaj, pouzdanost i rizik | Interes kupca / sledeći test |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Za utvrđivanje | Za proveru | Nije potvrđeno | Za proveru | Nije ocenjeno | Za proveru |
| 2 | Za utvrđivanje | Za proveru | Nije potvrđeno | Za proveru | Nije ocenjeno | Za proveru |
| 3 | Za utvrđivanje | Za proveru | Nije potvrđeno | Za proveru | Nije ocenjeno | Za proveru |

Za izabrani POC zapisati jednu intervenciju, kontrolne stranice, pristup potreban za izmenu, način vraćanja, glavno merilo i unapred dogovoren prag koristi. Matrica dostupnih intervencija i mapa uzroka popunjavaju se ručno uz ovaj izveštaj.

Dokumentacija za proveru: [MerchantPro API](https://docs.merchantpro.com/api/), [Themes API](https://docs.merchantpro.com/api/endpoints/themes/), [Lighthouse skor](https://developer.chrome.com/docs/lighthouse/performance/performance-scoring), [analiza LCP-a](https://web.dev/articles/optimize-lcp).
