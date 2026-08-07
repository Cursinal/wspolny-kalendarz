# Zmiany w wersji 1.1.0

## Naprawiono uruchamianie na telefonie

- Wszystkie operacje kryptograficzne przechodzą przez jedną warstwę zgodności Web Crypto.
- Obsługiwane są `crypto.subtle` oraz starszy alias WebKit `crypto.webkitSubtle`.
- Aplikacja wykrywa `http://` poza `localhost`, `file://` i brak Web Crypto przed próbą odblokowania sejfu.
- Zamiast błędu `undefined is not an object (evaluating 'crypto.subtle.importKey')` wyświetlana jest instrukcja otwarcia aplikacji przez HTTPS.
- Service worker wymusza sprawdzenie aktualizacji i usuwa stare wersje cache.

## Dodano dwa sposoby zaznaczania

Tryb wybiera się przy tworzeniu sejfu:

1. **Kiedy możemy** — oznaczenia to dostępność; brak wpisu to brak deklaracji.
2. **Kiedy nie możemy** — oznaczenia to blokady; brak wpisu oznacza możliwość spotkania przez cały dzień.

W drugim trybie aplikacja odejmuje zablokowane przedziały każdej osoby i pokazuje wspólny wolny czas. Tryb jest zapisany wewnątrz zaszyfrowanego indeksu, dołączany do eksportów oraz zachowywany podczas synchronizacji.

Starsze sejfy bez informacji o trybie otwierają się jako „kiedy możemy”, więc aktualizacja nie zmienia znaczenia wcześniejszych wpisów.
