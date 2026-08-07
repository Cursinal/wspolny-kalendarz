# Model bezpieczeństwa

## Chronione zasoby

- nazwy i ustawienia profili;
- terminy, godziny i notatki;
- zdjęcia profilowe;
- klucz sejfu;
- token GitHuba;
- weryfikatory dostępu i sekret podpisujący sesje.

## Założenia

- GitHub Pages i kod frontendu są publiczne;
- prywatne repozytorium sejfu nie jest traktowane jako jedyna warstwa ochrony;
- członkowie grupy znający wspólne hasło są wzajemnie zaufani;
- urządzenie użytkownika i połączenie HTTPS nie są przejęte;
- Cloudflare oraz GitHub mogą obserwować metadane ruchu i commitów, ale nie zawartość zaszyfrowanych plików.

## Zastosowane zabezpieczenia

- AES-256-GCM z uwierzytelnieniem;
- unikatowy losowy IV dla każdej operacji szyfrowania;
- osobne klucze plików wyprowadzane przez HKDF z ich ścieżek;
- PBKDF2-HMAC-SHA-256 z 600 000 iteracji i losową solą;
- niezależne opakowanie klucza sejfu hasłem i kodem odzyskiwania;
- CSP bez skryptów inline i bez skryptów z obcych domen;
- token API przechowywany wyłącznie w pamięci JavaScript;
- ścisła lista originów CORS;
- walidacja ścieżek, rozmiaru, Base64 i rewizji SHA;
- limit nieudanych logowań przez Cloudflare KV;
- sekret GitHuba poza repozytorium i przeglądarką;
- zdjęcia dekodowane, skalowane i ponownie kodowane przed szyfrowaniem;
- brak zapisu odszyfrowanych danych w `localStorage`.

## Czego system nie ukrywa

- faktu istnienia aplikacji;
- kodu i użytych algorytmów;
- liczby oraz czasu commitów w repozytorium sejfu;
- przybliżonych rozmiarów zaszyfrowanych plików;
- adresów IP i metadanych sieciowych widocznych dostawcom;
- danych na ekranie po odblokowaniu.

## Najważniejsze ryzyka

### Słabe hasło

Napastnik mający kopię `bootstrap.json` oraz zaszyfrowanego indeksu może testować hasła offline. Ograniczenie prób Workera wtedy nie pomaga. Użyj długiej, unikalnej frazy.

### Wspólne konto bezpieczeństwa

Profile nie są oddzielnymi tożsamościami. Wariant z prawdziwym rozdzieleniem uprawnień wymaga indywidualnych kluczy lub passkeys i innego modelu dystrybucji klucza sejfu.

### Historia Git

Usunięcie pliku nie usuwa jego wcześniejszych rewizji. Pełna rotacja po odebraniu komuś dostępu oznacza:

1. wygenerowanie nowego klucza sejfu;
2. ponowne zaszyfrowanie bieżących danych;
3. wysłanie ich do nowego prywatnego repozytorium bez starej historii;
4. zmianę tokenu Workera i konfiguracji repozytorium;
5. usunięcie starego repozytorium, z zastrzeżeniem istniejących klonów.

### Łańcuch dostaw

Frontend nie używa bibliotek runtime. Workflow i wdrożenie Workera nadal korzystają z GitHub Actions oraz aktualnie pobieranego Wranglera. Dla środowiska o wyższym ryzyku należy przypiąć akcje do pełnych SHA commitów i kontrolować wersję CLI.

## Rotacja

- Token GitHuba: utwórz nowy, ustaw `GITHUB_TOKEN` w Workerze, sprawdź działanie, unieważnij stary.
- Hasło bez odebrania dostępu: obecna wersja nie ma jeszcze interfejsu rewrapowania; wygeneruj nowy sejf i przenieś dane.
- Pełne odebranie dostępu: wykonaj pełną rotację klucza i repozytorium opisaną powyżej.
- Sekret sesji: ustaw nowy `SESSION_SECRET_B64`; wszystkie istniejące sesje natychmiast przestaną działać.
