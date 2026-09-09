# Trajne analize u lokalnom panelu

Pokretanje: `npm run ui`. U kartici Analizator stranice nalazi se „Red i istorija analiza”. Slanje URL-a odmah vraća ID posla; zatvaranje taba ne prekida merenje. Panel na tri sekunde osvežava statuse i omogućava otvaranje sačuvanog rezultata.

## Ponašanje reda

- queued → running → succeeded ili failed; izvršava se jedna analiza istovremeno.
- Najviše 20 poslova može čekati ili biti u obradi. Istorija prikazuje poslednjih 200; ostali se ne brišu iz baze.
- Posao koji čeka može se otkazati. Aktivno Lighthouse merenje nema dugme za otkazivanje u ovoj verziji; koristi postojeći vremenski limit capture funkcije.
- Nakon pada procesa aktivan posao postaje interrupted. Korisnik ga ponavlja kao novi posao sa parentId vezom ka prethodnom pokušaju. Ostali queued poslovi nastavljaju automatski.
- Uspešan status i prikazivi rezultat upisuju se u istom SQLite iskazu. Sirovi Lighthouse, trace i network fajlovi imaju ID posla u nazivu; merenje sadrži pravi SHA-256 sirovog izveštaja i verzije/profil.
- Jedan servis upravlja bazom. Drugi servis sa istim data direktorijumom odbija start dok je vlasnički PID aktivan. Ovo je lokalna implementacija za jedan računar, ne distribuirani worker sistem.
- Jedan posao predstavlja jedno merenje, ne benchmark sa tri ponavljanja. Za kontrolisane eksperimente ostaju postojeće CLI komande.

## Skladište i API

SQLite: data/audit-jobs.sqlite (WAL, synchronous FULL). Artefakti: data/ui-audits. Za ručni backup prvo zaustaviti servis, pa sačuvati ceo data direktorijum; ne kopirati samo glavnu SQLite datoteku tokom rada.

POST /api/audit/run → 202 sa poslom; GET /api/jobs → istorija; GET /api/jobs/:id → status; GET /api/jobs/:id/result → rezultat ili 409; POST /api/jobs/:id/cancel i /retry → operacija. POST zahteva X-MerchantPro-Request: 1 kao i ostali lokalni API pozivi.

Ranije JSON analize nisu automatski migrirane u novu istoriju. Stari benchmark rezultati ostaju u svojoj kartici. Za javni hosting i dalje su potrebni autentikacija, izolacija korisnika i mrežna ograničenja; provera URL-a nije potpuna SSRF zaštita od DNS-a i preusmeravanja.

Testovi pokrivaju restart servera, stvarni nagli izlazak zasebnog procesa, čuvanje rezultata, serijsko izvršavanje, zabranu drugog vlasnika, greške, otkazivanje i vezu ponovljenog pokušaja.
