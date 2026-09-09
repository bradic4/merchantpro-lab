# Kontrolisano blokiranje dodatka u laboratoriji

Komanda `experiment` poredi isti URL u pet vremenski susednih parova. A učitava stranicu normalno; B blokira precizan prefiks putanje eksternog dodatka preko Lighthouse `blockedUrlPatterns`. Redosled je AB, BA, AB, BA, AB. Sve ostalo ostaje u istom zabeleženom profilu, uz hladan browser keš. CDN stanje ostaje nepoznato.

```powershell
npm run build
node dist/cli.js experiment --config examples/kliklak-elfsight-experiment.json --out data/kliklak-elfsight-2026-09-09
```

Posle prekida dodajte `--resume`, sa istim config fajlom i izlaznim folderom. Postojeća uspešna merenja proveravaju se SHA-256 hash-om. Ako ostane `.run.lock` posle nasilnog prekida, prvo proverite da proces iz tog fajla više ne radi. Ponovljeni pokušaj neuspešnog člana para može vremenski udaljiti par; za završnu potvrdu prednost ima nova neprekinuta serija.

Za potvrđen par neophodno je da osnovni test zabeleži uspešno učitavanje i izvršavanje ciljnog skripta, a B test stvarnu CDP blokadu `inspector`, bez učitavanja i izvršavanja tog resursa. Puko odsustvo skripte nije dokaz. Takođe se proveravaju podešavanja (osim jedine namerne razlike), browser/Lighthouse verzije, konačni URL i upozorenja o nepotpunom učitavanju. Metapodaci CPU benchmarka ostaju vidljivi za procenu promena opterećenja lokalnog računara.

`experiment.json` sadrži stanje, metrike i proveru intervencije. `raw/` sadrži originalne Lighthouse rezultate; `artifacts/` mrežni zapis i trace; `report.md` poređenje i raspon. Izveštaj se osvežava posle svakog pokušaja. Ništa se ne menja na udaljenoj prodavnici.

Prvi unapred definisan prag za dijagnostiku chatbota je medijana relativnog smanjenja TBT od najmanje 20%, medijana apsolutnog smanjenja najmanje 500 ms i isti smer u najmanje četiri od pet parova. Uz to proveriti LCP i CLS; ovaj mali uzorak sam ne dokazuje statističku značajnost. Blokada uklanja funkciju chatbota. Pozitivan rezultat znači kandidat za zaseban test učitavanja na zahtev ili drugu intervenciju sa očuvanom funkcionalnošću, ne dozvolu za automatsko uklanjanje iz prodavnice.

Ova komanda trenutno testira jedan URL i jedan resursni prefiks. Ne izvodi masovnu optimizaciju, promene teme, API upise, testove košarice ili proveru stvarnog INP-a korisnika.
