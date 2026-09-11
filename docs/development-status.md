# Procena plana i početna isporuka

Plan iz fajla `MerchantPro_procena_i_implementacioni_plan.md` pregledan je 8. septembra 2026. Korišćen je kao projektni materijal; preporuke i navedeni rokovi/cene nisu potvrđeni rezultati.

## Aktuelno stanje — 11. septembar 2026.

Postoje lokalni panel, SQLite red, engine slika i kontrolisani eksperimenti. Merenja obuhvataju pet MerchantPro domena i dve kontrole; proširenje sa tri prodavnice završeno je sa 27/27 uspešnih izvršavanja. Prvobitni Kliklak skup ostaje nepotpun. To nije dokaz MerchantPro-specifičnog uzroka niti uspeha automatske intervencije.

Dodata je kompatibilnost ekstrakcije sa Lighthouse 13 insights, izvoz bez kolizija i CLI inspektor stvarno učitanih slika. [Uputstvo i ograničenja](image-evidence.md). Pilot sa udaljenom primenom i vraćanjem još nije izvršen; konektor ostaje read-only.

Tekst ispod beleži početnu isporuku od 8. septembra i nije aktuelan popis funkcionalnosti/testova.

## Odluka za ovaj inkrement

Revidirani odeljak 15 jasno menja redosled: prvo uporedna analiza, zatim izbor rešenja. Odeljci za obradu slika su razrađen mogući pravac. Node.js/TypeScript CLI odgovara odeljku 8.2 i može odmah da podrži prvi istraživački ciklus.

Plan dobro razdvaja laboratorijske metrike od stvarnog iskustva i uštedu bajtova od ubrzanja. Najvažnija praktična ograničenja su nedokazana zamena slike uz očuvanje identiteta, potreba za potvrđenim povratkom i odsustvo dokaza da je pretplata pravi model. Te stavke ostaju otvorene; razvoj alata ih ne zatvara.

## Razvijeno

- Manifest i provera uzorka, porekla URL-ova i protokola.
- Serijski Lighthouse runner sa 3/5 ponavljanja, mobile/desktop profilima, stanjem, raw JSON, trace/network artefaktima i nastavkom posle prekida.
- Uvoz Lighthouse/PSI, deduplikacija, nullable metrike i čuvanje CrUX porekla.
- Izveštaj sa uporedivim grupama, medijanama i rasponom, upozorenjima i obrascem prioriteta.
- GET konektor za ograničeno čitanje kataloga i galerija sa testiranim ograničenjima zahteva i paginacijom.
- PageSpeed Insights (PSI) API klijent sa `psi` CLI komandom, rate-limitingom, eksponencijalnim backoff-om i podrškom za API ključ / PSI_API_KEY.
- Analiza resursa stranice (`resource-analysis.ts`) sa ekstrakcijom slika, LCP elemenata, render-blocking resursa i veličine DOM-a u izveštaju.
- Uporedna tabela prodavnica i prosek po platformi u Markdown izveštaju (`report.ts`).
- Sintetički primeri i 50 automatizovanih testova.

## Nije još urađeno

Nema stvarnog benchmarka MerchantPro uzorka, nezavisne provere vlasništva/platforme prodavnica, razgovora, prioriteta zasnovanih na stvarnim dokazima ni izabranog POC-a. Faza A nije završena. Nema API upisa ni intervencija u temi. Produkcijski queue, klijentski UI, naplata i višekorisnička autorizacija nisu deo ove verzije.

Detaljna automatizovana analiza `currentSrc`, prikazanih dimenzija, galerije nakon interakcije i funkcionalnih regresija kroz Playwright je sledeći tehnički korak kada se pojavi konkretan simptom. Sačuvani Lighthouse trace i network podaci podržavaju početnu ručnu dijagnostiku; ne zamenjuju taj pregled.

Sledeći potrebni ulaz je lista reprezentativnih URL-ova. Za javna merenja ne trebaju API kredencijali. Za proveru konektora potreban je namenski nalog sa pravom čitanja. Procene 180–280 sati za ceo raniji scenario ne predstavljaju obavezu ni procenu ovog početnog inkrementa.
