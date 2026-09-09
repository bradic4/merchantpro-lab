# Popravke pouzdanosti — 9. septembar 2026.

- Rollback preskače izvozne poslove koji nisu menjali original. Za zamenu originala zahteva da trenutni SHA-256 odgovara optimizovanom rezultatu; naknadne izmene prijavljuje kao konflikt. Stari manifesti bez optimizovanog heša ne odobravaju prepisivanje. Backup čuva tačno bajtove koje je pipeline obradio.
- HTTP rollback je uklonjen (410). Koristiti lokalno `node dist/cli.js rollback --job PUTANJA`. Tokom vraćanja fajlove ne menjati drugim programom.
- Panel sluša samo na localhost/127.0.0.1, proverava Host i Origin i zahteva X-MerchantPro-Request: 1 za POST. UI sam šalje zaglavlje. Nema CORS pristupa sa drugih sajtova; telo zahteva ograničeno je na 20 MB. Proizvoljne putanje u remediation endpointu nisu podržane.
- Tekstualne vrednosti iz kataloga i nazivi slika se HTML-escape-uju; spoljne veze prihvataju samo HTTP/HTTPS.
- Tabela isključuje demo podatke i razdvaja serije, stranice, uređaje, settings hash, verzije, izvor i završni URL. Prikazuje datum i pokrivenost, čuva nule i razlikuje odsutni skor.
- Preporuke su kandidati za proveru. URL resursa nije dokaz CPU troška, sinhronog učitavanja ili uštede. First-activity zahteva zaseban eksperiment i proveru prve interakcije.
- Resize koristi dimenzije posle EXIF rotacije. Srcset sadrži jedinstvene širine. Animirane/višestranične slike se odbijaju umesto tihog gubitka frejmova. Negativna ušteda ostaje vidljiva.

Provera: npm run check (67 testova, typecheck i build). Server testovi koriste privremene direktorijume. Nisu vršene izmene na prodavnicama niti novi udaljeni Lighthouse eksperimenti.
