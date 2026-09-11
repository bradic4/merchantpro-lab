# Dokazi isporuke slika — 11. septembar 2026.

## Prikupljanje

Posle `npm run build`, za odabrani javni proizvod:

```powershell
node dist/cli.js inspect-images --url https://shop.example/product --label A --out data/product-A --width 412 --height 823 --dpr 1.75
```

Direktorijum mora biti nov, a njegov roditelj mora postojati. Komanda otvara poseban headless Chrome i beleži samo javnu stranicu; nema prijave niti izmena kataloga. Za proveru galerije operator može dodati `--gallery-selector "CSS_SELEKTOR_DUGMETA"`. Selektor mora biti prethodno proveren kao kontrola galerije: alat će zaista kliknuti taj element. Čuvaju se odvojeni initial i gallery snimci; nema automatskog scrollovanja ili prihvatanja kolačića.

Svaki snimak sadrži currentSrc, srcset, sizes, natural i prikazane dimenzije, mobilni DPR, URL, datum, Chrome/UA i uslove keša. CDP beleži status, MIME, encodedDataLength, odabrana cache zaglavlja i SHA-256 tela odgovora; sharp čita stvarni format i dimenzije iz već primljenog tela. To nije dodatno preuzimanje slike koje bi moglo dobiti drugačiju CDN varijantu.

Screenshot i JSON su povezani SHA-256 manifestom. Nedostajuće telo, neuspeh dekodiranja, nezavršen zahtev ili slike iz CSS-a/iframe-a nisu dokaz nulte veličine. Inspekcija je ograničena na img elemente glavnog dokumenta. DOM naturalWidth može biti korigovan za gustinu; decodedWidth označava piksele stvarnog fajla nakon EXIF orijentacije. Telo odgovora i mrežni prenos su različite veličine; encodedDataLength može uključivati protokolski overhead.

Browser cache je isključen, service worker zaobiđen; CDN keš ostaje izvan kontrole. Posmatranje je jednu sekundu nakon load/klika; dinamičke ili lazy slike mogu ostati bez dokaza. Ovo nije Lighthouse rezultat i ne meri ubrzanje.

## Poređenje

```powershell
node dist/cli.js compare-images --before data/product-B/initial.json --after data/product-C/initial.json --index 0 --out data/image-comparison.json
```

Komanda proverava manifest i screenshot heševe. Različiti URL-ovi, profil/browser, interakcija, prikazane dimenzije, keširani odgovori ili nedostajući podaci blokiraju numeričko poređenje. Operator mora proveriti da DOM index predstavlja istu sliku na oba snimka. Razlika prenetih bajtova je opažanje jednog para, ne automatska tvrdnja o uspehu ili LCP dobitku.

## Priprema kandidata

`optimize-images` sada zapisuje svaki poziv u novi `job-UUID` podfolder unutar --out. Imena sadrže redni broj; originalne putanje i heševi ostaju u manifestu. Isti basename ili ponovljen poziv ne prepisuju ranije kandidate. originalDimensions su dimenzije iz metapodataka originalnog fajla (pre EXIF rotacije); optimizedDimensions su dimenzije izlaza.

## Pilot

1. Dogovoriti jedan proizvod i kategoriju, vlasnika promene i backup celog stanja galerije.
2. A: postojeće stanje; B: ponovo učitan isti neizmenjeni izvor; C: naš kandidat; restored: vraćeno početno stanje.
3. Ručno primeniti dogovorene promene kroz pristup trgovca. Konektor ostaje GET-only.
4. Za svako stanje ponoviti isti mobilni profil, proveriti CDN isporuku i vizuelni kvalitet; Lighthouse merenja izvršiti zasebno više puta.
5. Proveriti glavnu sliku, thumbnail, galeriju, zoom i vraćanje. Ako B i C daju isti rezultat, dodatna korist našeg procesiranja nije dokazana.

Lighthouse 13 fixture testira stvarne insight strukture. Kada insight daje samo skraćeni snippet, čuvamo selector i tagName, a URL ostaje null. Zbir trajanja render-blocking zahteva nije TBT niti zbir ostvarivih ušteda.
