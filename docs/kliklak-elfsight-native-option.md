# Kandidat za sledeći test: postojeći Elfsight lazy režim

Status: **predlog za test, nije primenjeno na prodavnici**. Nije izmeren njegov učinak. A/B test blokiranja resursa ne predstavlja test ove izmene.

Javni HTML Kliklak početne strane pregledan 9. septembra 2026. već sadrži `data-elfsight-app-lazy` sa praznom vrednošću. Widget se dodaje u `document.body` na DOMContentLoaded. Platformski loader se učitava sa `async`.

U tada preuzetom javnom `https://static.elfsight.com/platform/platform.js` loader-u:

- prazna vrednost mapira se u režim `enabled`;
- `enabled` prati i IntersectionObserver i prvu aktivnost;
- `first-activity` prati događaje scroll, mousemove, touchstart, keydown i click;
- `in-viewport` prati vidljivost.

Ovo objašnjava zašto sam lazy atribut ne znači da widget mora čekati korisnikov zahtev. Nije dokaz koji je tačan okidač bio na Kliklaku: to treba povezati sa trace-om događaja i geometrijom elementa.

Minimalni kandidat je promena prazne vrednosti u `first-activity`; tačan diff je u `kliklak-elfsight-candidate.patch`. Taj režim je opažen u trenutnom javnom loader kodu. Opšti članak podrške dokumentuje lazy atribut, ali ne predstavlja potvrdu dugoročne podrške za svaku vrednost; za produkciju potvrditi ponašanje sa dobavljačem i na test nalogu.

## Provera kandidata

1. Pet uporedivih osnovnih i pet izmenjenih merenja, odvojeno od eksperimenta potpunog blokiranja.
2. Pre aktivnosti proveriti da glavni chatbot bundle nije preuzet niti izvršen.
3. Na mobilnom dodir/skrol, a na desktopu miš i tastatura moraju pokrenuti widget tačno jednom, bez grešaka.
4. Otvoriti chatbot i proveriti prikaz; slanje poruke nije deo ovog testa bez posebnog dogovora.
5. Proveriti pretragu, navigaciju, LCP, CLS i kašnjenje tokom prve aktivnosti. Odlaganje može premestiti trošak na prvu interakciju, pa niži početni TBT nije dovoljan dokaz boljeg iskustva.
6. Povratak je vraćanje prethodne vrednosti atributa uz proveru da druga osoba u međuvremenu nije menjala instalacioni kod.

Ako prva aktivnost pokrene veliki posao u nepovoljnom trenutku, drugi kandidat je učitavanje na eksplicitan klik na lagano chat dugme. To je druga intervencija i zahteva posebnu proveru funkcije i pristupačnosti.

Izvori: [Elfsight uputstvo za PageSpeed](https://help.elfsight.com/article/1099-how-to-improve-pagespeed-score-of-a-page-with-our-widget), [javni loader](https://static.elfsight.com/platform/platform.js), javni HTML [Kliklak](https://www.kliklak.rs/). Izvorni sadržaj je posmatran kao podatak za analizu, bez izvršavanja preuzetog loader-a u našem programu.
