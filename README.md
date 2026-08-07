# Wspólny kalendarz dyspozycyjności

Mobilna aplikacja internetowa do zaznaczania terminów spotkań w grupie. Interfejs działa jako statyczna PWA na GitHub Pages, natomiast zaszyfrowane pliki są przechowywane w osobnym, prywatnym repozytorium GitHub. Mały Cloudflare Worker pośredniczy w zapisie, dzięki czemu token GitHuba nie trafia do kodu strony.

## Co jest gotowe

- pełny widok miesiąca w układzie od poniedziałku do niedzieli;
- wybór profilu podobny do ekranu profili serwisów streamingowych;
- dowolna liczba profili zamiast limitu czterech osób;
- pojedyncze zaznaczanie dat oraz zaznaczanie zakresu przez przytrzymanie i przeciągnięcie;
- wspólne godziny dla wszystkich wybranych dni albo osobne godziny dla każdego dnia;
- kilka przedziałów godzinowych jednego dnia, cały dzień, notatki i emoji;
- wybierany przy tworzeniu sejfu tryb: zaznaczamy kiedy możemy albo zaznaczamy kiedy nie możemy;
- automatyczne obliczanie wspólnego przedziału dostępności wszystkich profili w obu trybach;
- osobny kolor, emoji, szyfrowane zdjęcie i motyw dla każdego profilu;
- motyw prawdziwie czarny, jasny i pudroworóżowy, bez gradientów;
- zaszyfrowany eksport całego bieżącego profilu lub wszystkich profili;
- opcjonalne dołączanie zdjęć i historii dyspozycyjności do eksportu;
- kod odzyskiwania, automatyczna blokada po bezczynności i sesje przechowywane tylko w pamięci;
- tryb lokalny do testów bez Workera i bez repozytorium danych;
- testy kryptografii, kalendarza oraz bramki API.

## Architektura

```text
GitHub Pages                          Cloudflare Worker                    prywatny GitHub
┌─────────────────────────┐          ┌─────────────────────────┐          ┌──────────────────────┐
│ HTML, CSS, JavaScript   │  HTTPS   │ sesje i ograniczanie    │ GitHub   │ bootstrap.json       │
│                        ├─────────►│ prób logowania          ├─────────►│ vault/index.enc      │
│ szyfrowanie AES-GCM     │          │ token GitHuba jako      │   API    │ vault/months/*.enc   │
│ odbywa się w przeglądarce│◄─────────┤ sekret, kontrola wersji │◄─────────┤ vault/avatars/*.enc  │
└─────────────────────────┘          └─────────────────────────┘          └──────────────────────┘
```

Do GitHuba wysyłane są wyłącznie zaszyfrowane kontenery. Nazwy profili, kolory, zdjęcia, terminy, godziny, notatki i emoji znajdują się w zaszyfrowanym indeksie lub zaszyfrowanych plikach miesięcy.

## Kryptografia

- AES-256-GCM szyfruje dane i wykrywa ich zmianę lub uszkodzenie.
- Losowy 256-bitowy klucz sejfu szyfruje właściwe dane.
- PBKDF2-HMAC-SHA-256 z 600 000 iteracji i osobną solą zabezpiecza klucz sejfu hasłem.
- HKDF-SHA-256 wyprowadza osobny klucz dla każdej ścieżki pliku.
- Każde szyfrowanie AES-GCM otrzymuje nowy, losowy 96-bitowy IV.
- Zdjęcie jest przycinane do kwadratu, zmniejszane do 512 × 512, ponownie kodowane bez metadanych i dopiero wtedy szyfrowane.
- Hasło nie występuje w kodzie źródłowym, plikach konfiguracyjnych ani workflow GitHub Actions.
- Token GitHuba, weryfikatory dostępu i sekret sesji są sekretami Cloudflare Workera.

Implementacja celowo używa natywnego Web Crypto API i nie ładuje zewnętrznej biblioteki kryptograficznej na ekranie logowania. Web Crypto wymaga bezpiecznego kontekstu: produkcyjną aplikację na telefonie otwieraj przez adres `https://` GitHub Pages. Adres typu `http://192.168.x.x`, bezpośrednie otwarcie przez `file://` oraz niektóre wbudowane przeglądarki komunikatorów mogą blokować `crypto.subtle`. Aplikacja wykrywa ten stan i pokazuje instrukcję zamiast technicznego błędu JavaScript.

## Szybki test lokalny

Wymagany jest Node.js 22 lub nowszy. Sam frontend nie ma zależności npm.

```bash
npm run dev
```

Serwer wypisze jeden właściwy adres: `http://localhost:8080/`. Użyj **dokładnie** tego adresu na komputerze. Nie zmieniaj go na `https://` i nie używaj `http://[::]:8080/` z komunikatu `python -m http.server`. Lokalny serwer developerski celowo działa po HTTP, a `localhost` jest specjalnym, zaufanym kontekstem przeglądarki, więc Web Crypto jest tam dostępne.

W trybie developerskim aplikacja wyrejestrowuje stare Service Workery i czyści wyłącznie własny cache statyczny, żeby wcześniejsza wersja PWA nie blokowała poprawek. Pliki są serwowane z `Cache-Control: no-store`.

Na telefonie `http://192.168.1.20:8080` nie jest `localhost` i nie powinien być używany do prawdziwych danych. **Nie zamieniaj tego adresu na `https://192.168.1.20:8080`** — serwer HTTP nie zna TLS i wypisze wtedy błędy w rodzaju `Bad request version` oraz bajty zaczynające się od `\x16\x03\x01`. Do telefonu użyj wdrożonego adresu GitHub Pages HTTPS albo zaufanego tunelu HTTPS.

Przy pierwszym uruchomieniu dowolne hasło mające co najmniej osiem znaków utworzy lokalny, zaszyfrowany sejf w IndexedDB. Kreator poprosi również o wybór sposobu zaznaczania. Ten wariant służy do sprawdzenia interfejsu na jednym urządzeniu i nie synchronizuje znajomych.

Testy i kontrola źródeł:

```bash
npm test
npm run check
```

## Wdrożenie produkcyjne

### 1. Utwórz dwa repozytoria

1. Repozytorium aplikacji, np. `wspolny-kalendarz`. Może być publiczne, ponieważ nie zawiera danych ani sekretów.
2. Prywatne repozytorium sejfu, np. `wspolny-kalendarz-vault`. Podczas tworzenia zaznacz dodanie pliku README, aby istniała gałąź `main`.

Nie umieszczaj katalogu `generated-vault` w repozytorium aplikacji. Jest objęty `.gitignore`.

### 2. Wygeneruj zaszyfrowany sejf

```bash
npm run setup:vault
```

Skrypt poprosi w terminalu o:

- wspólne hasło i jego potwierdzenie;
- nazwę grupy;
- sposób zaznaczania: kiedy możemy albo kiedy nie możemy;
- początkowe profile.

Hasło nie jest wypisywane i nie jest zapisywane. Powstaną:

```text
generated-vault/bootstrap.json
generated-vault/vault/index.enc
worker-secrets.generated.env
recovery-code.generated.txt
```

Przenieś `recovery-code.generated.txt` do bezpiecznego miejsca poza repozytoriami. Plik `worker-secrets.generated.env` usuń po ustawieniu sekretów Workera albo przechowuj wyłącznie lokalnie.

Ponowne wygenerowanie plików wymaga świadomego nadpisania:

```bash
npm run setup:vault -- --force
```

### 3. Wyślij sejf do prywatnego repozytorium

Utwórz fine-grained personal access token GitHuba ograniczony wyłącznie do repozytorium sejfu. Wymagane uprawnienie repozytorium to `Contents: Read and write`.

Linux lub macOS:

```bash
GITHUB_TOKEN='TOKEN_TYLKO_DO_SEJFU' \
GITHUB_OWNER='twoj-login' \
GITHUB_REPO='wspolny-kalendarz-vault' \
npm run upload:vault
```

PowerShell:

```powershell
$env:GITHUB_TOKEN = 'TOKEN_TYLKO_DO_SEJFU'
$env:GITHUB_OWNER = 'twoj-login'
$env:GITHUB_REPO = 'wspolny-kalendarz-vault'
npm run upload:vault
```

Token jest używany przez proces i nie jest zapisywany przez skrypt.

### 4. Skonfiguruj Cloudflare Workera

Edytuj `worker/wrangler.jsonc`:

```jsonc
"GITHUB_OWNER": "twoj-login",
"GITHUB_REPO": "wspolny-kalendarz-vault",
"GITHUB_BRANCH": "main",
"FRONTEND_ORIGINS": "https://twoj-login.github.io"
```

`FRONTEND_ORIGINS` zawiera origin, czyli protokół i domenę bez ścieżki repozytorium. Przy własnej domenie wpisz ją zamiast domeny GitHub Pages. Kilka originów można oddzielić przecinkami.

Zaloguj Wrangler do Cloudflare:

```bash
npx wrangler@latest login
```

Wdróż Worker, przekazując token GitHuba wyłącznie przez zmienną środowiskową. Skrypt połączy go z czterema wygenerowanymi sekretami w tymczasowym pliku, wyśle komplet razem z kodem i natychmiast usunie plik tymczasowy.

Linux lub macOS:

```bash
GITHUB_TOKEN='TOKEN_TYLKO_DO_SEJFU' npm run deploy:worker
```

PowerShell:

```powershell
$env:GITHUB_TOKEN = 'TOKEN_TYLKO_DO_SEJFU'
npm run deploy:worker
```

Nie wpisuj tokenu ani wygenerowanych sekretów do `worker/wrangler.jsonc`. Późniejsze wdrożenia samego kodu mogą używać `npm --prefix worker run deploy`; istniejące sekrety pozostają wtedy przypisane do Workera.

Konfiguracja zawiera binding `RATE_LIMIT` bez identyfikatora. Aktualny Wrangler może automatycznie utworzyć namespace KV podczas wdrożenia i zapisać jego identyfikator w konfiguracji. Jeżeli Twoje środowisko tego nie zrobi, utwórz namespace KV ręcznie i dodaj jego `id` do bindingu.

### 5. Połącz stronę z Workerem

Po wdrożeniu skopiuj adres Workera i wpisz go w `app/config.js`:

```js
window.APP_CONFIG = Object.freeze({
  apiBaseUrl: 'https://twoj-worker.twoj-subdomain.workers.dev',
  appName: 'Wspólny termin',
  lockAfterMinutes: 15,
});
```

Puste `apiBaseUrl` zawsze oznacza lokalny tryb IndexedDB.

### 6. Włącz GitHub Pages

Workflow `.github/workflows/pages.yml` publikuje katalog `app` bez kompilacji. W repozytorium aplikacji wybierz:

```text
Settings → Pages → Build and deployment → Source: GitHub Actions
```

Następnie wypchnij projekt na gałąź `main`. Każda zmiana w katalogu `app` uruchomi ponowną publikację.

## Dwa tryby zaznaczania

Tryb jest wybierany dla całego sejfu podczas jego tworzenia:

- **Zaznaczamy, kiedy możemy** — brak wpisu oznacza brak deklaracji, a kolorowa kropka oznacza dostępność użytkownika. Wspólna dostępność jest przecięciem zaznaczonych godzin wszystkich profili.
- **Zaznaczamy, kiedy nie możemy** — brak wpisu oznacza możliwość spotkania przez cały dzień, a kolorowy romb oznacza blokadę całego dnia albo określonych godzin. Aplikacja odejmuje blokady wszystkich osób i pokazuje pozostały wspólny wolny czas.

Starszy sejf bez pola trybu jest automatycznie otwierany w dotychczasowym trybie „kiedy możemy”. Trybu nie można przełączyć jednym przyciskiem po utworzeniu sejfu, ponieważ odwróciłoby to znaczenie całej zapisanej historii. Aby rozpocząć pracę w drugim trybie, utwórz nowy sejf i świadomie przenieś potrzebne dane.

## Aktualizacja aplikacji na telefonie

Po wypchnięciu nowej wersji na GitHub Pages otwórz dokładny adres zaczynający się od `https://`. Service worker pobiera aktualizację bez używania starej pamięci podręcznej i po jej aktywowaniu przeładowuje aplikację. Gdy ikona dodana wcześniej do ekranu głównego nadal uruchamia starą wersję, usuń tę ikonę, otwórz stronę ponownie w Safari lub Chrome i dodaj ją do ekranu głównego jeszcze raz.

## Pobieranie ustawień profilu i profili

W kalendarzu otwórz `Ustawienia profilu`, a następnie:

- `Pobierz cały mój profil` — eksportuje bieżący profil;
- `Pobierz wszystkie profile` — eksportuje całą listę profili.

Przed pobraniem można zdecydować, czy plik ma zawierać:

- zdjęcia profilowe;
- historię dyspozycyjności ze wszystkich zapisanych miesięcy.

Eksport otrzymuje osobne hasło i jest zapisywany jako `*.kalendarz.enc.json`. Hasło eksportu nie jest przechowywane.

Aby odszyfrować taki plik lokalnie:

```bash
npm run decrypt:export -- /sciezka/do/pliku.kalendarz.enc.json
```

Skrypt zapisze `profiles.json` oraz odtworzone zdjęcia w katalogu `decrypted-export`. Ten katalog również jest ignorowany przez Git.

## Istotne ograniczenia bezpieczeństwa

1. **Siła ochrony zależy od hasła.** Repozytorium zawiera dane pozwalające sprawdzać próby hasła offline. PBKDF2 je spowalnia, ale krótkiej, przewidywalnej frazy nie zmieni w silny sekret.
2. **Wspólne hasło oznacza wspólne zaufanie.** Profile rozróżniają osoby w interfejsie, ale nie są osobnymi kontami. Osoba znająca wspólne hasło może technicznie wybrać dowolny profil.
3. **Git zachowuje historię.** Usunięty zaszyfrowany termin lub awatar może pozostać w starszym commicie. Pełne odebranie dostępu wymaga nowego klucza sejfu i migracji aktualnych danych do nowego repozytorium bez starej historii.
4. **Worker widzi dane logowania chwilowo podczas logowania przez TLS.** Nie zapisuje ich ani nie loguje, ale nie jest to protokół typu zero-knowledge.
5. **Po odblokowaniu dane istnieją w pamięci urządzenia.** Użytkownik z dostępem do odblokowanej przeglądarki może je zobaczyć lub zrobić zrzut ekranu.
6. **KV ogranicza próby, ale nie zastępuje mocnego hasła.** Szyfrowane pliki mogą zostać skopiowane i atakowane poza aplikacją.

Więcej szczegółów znajduje się w [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) i [docs/SECURITY.md](docs/SECURITY.md).

## Struktura projektu

```text
app/                         statyczna PWA publikowana na GitHub Pages
  src/app.js                 interfejs i przepływy użytkownika
  src/calendar.js            obliczenia kalendarza i części wspólnych
  src/platform-crypto.js     kontrola HTTPS i zgodności Web Crypto
  src/crypto.js              Web Crypto, sejf i eksporty
  src/storage.js             IndexedDB albo zdalne API
  src/vault.js               zaszyfrowany model danych i synchronizacja
worker/                      Cloudflare Worker z GitHub Contents API
scripts/                     konfiguracja, upload, wdrożenie i eksport
tests/                       testy Node.js
.github/workflows/pages.yml  publikacja GitHub Pages
```

## Licencja

Kod jest dostępny na licencji MIT. Nie stanowi audytowanego produktu kryptograficznego. Przed przechowywaniem danych o wysokiej wrażliwości przeprowadź niezależny przegląd bezpieczeństwa.
