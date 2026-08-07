# Architektura aplikacji

## Komponenty

### 1. Statyczna PWA

Katalog `app` jest publikowany bez procesu budowania. Nie ma zależności zewnętrznych ani sekretów. Przeglądarka odpowiada za:

- wyprowadzenie klucza z hasła;
- odszyfrowanie klucza sejfu;
- szyfrowanie i odszyfrowywanie plików;
- przetworzenie zdjęć;
- interfejs profili i kalendarza;
- łączenie zmian po konflikcie rewizji.

W trybie lokalnym ta sama warstwa zapisuje zaszyfrowane bajty w IndexedDB.

### 2. Cloudflare Worker

Worker nie odszyfrowuje zawartości sejfu. Odpowiada za:

- weryfikację wspólnego hasła lub kodu odzyskiwania;
- wydanie podpisanej, ośmiogodzinnej sesji;
- ograniczenie nieudanych prób według adresu IP;
- sprawdzenie dozwolonych originów;
- walidację ścieżek i rozmiarów;
- przechowanie tokenu GitHuba jako sekretu;
- optymistyczną kontrolę współbieżności przez SHA pliku.

### 3. Prywatne repozytorium sejfu

```text
bootstrap.json
vault/
  index.enc
  months/
    <nieprzewidywalny-identyfikator-miesiąca>.enc
  avatars/
    <losowy-identyfikator>.enc
```

`bootstrap.json` zawiera wersję schematu, sole, parametry KDF, zaszyfrowany klucz sejfu oraz ścieżkę indeksu. Nie zawiera nazw profili ani kalendarza.

`vault/index.enc` po odszyfrowaniu zawiera grupę, profile, kolory, ustawienia motywów, odwołania do awatarów i mapę miesięcy na nieprzewidywalne ścieżki plików.

Każdy plik miesiąca zawiera wpisy profili pogrupowane według lokalnej daty w strefie `Europe/Warsaw`.

## Przepływ odblokowania

```text
hasło
  ├─► Worker: weryfikacja HMAC + limit prób ─► krótka sesja API
  └─► PBKDF2 w przeglądarce ─► klucz opakowujący ─► losowy klucz sejfu
                                                       │
                                                       └─► HKDF(path) ─► AES-GCM pliku
```

Sesja API nie daje możliwości odszyfrowania danych. Klucz sejfu nie jest wysyłany do Workera ani GitHuba.

## Zapis i konflikty

1. Klient pobiera plik razem z jego GitHub SHA.
2. Odszyfrowuje i modyfikuje dane lokalnie.
3. Szyfruje nową wersję z nowym IV.
4. Wysyła zaszyfrowane bajty i oczekiwany SHA.
5. Worker porównuje SHA z aktualnym plikiem.
6. Przy zgodności wykonuje zapis przez GitHub Contents API.
7. Przy konflikcie klient pobiera nowszą wersję i wykonuje trójstronne scalanie względem wersji, którą wcześniej odczytał.
8. Zmiany dotyczące różnych profili są zachowywane; `updatedAt` rozstrzyga dopiero równoczesną zmianę tego samego rekordu.
9. Klient szyfruje wynik i ponawia zapis z aktualnym SHA.

Ścieżka nowego miesiąca jest deterministyczna dla danego sejfu, ale nie ujawnia nazwy miesiąca: powstaje z kluczowanego HMAC. Dzięki temu dwa urządzenia tworzące ten sam miesiąc jednocześnie trafiają do tego samego zaszyfrowanego pliku. Podział na miesiące ogranicza konflikty: edycja sierpnia nie dotyka pliku września.

## Model dostępności

```json
{
  "available": true,
  "allDay": false,
  "intervals": [
    { "from": "18:00", "to": "22:00" }
  ],
  "note": "Po pracy 🙂",
  "updatedAt": "2026-08-07T18:42:00.000Z"
}
```

Godziny są wartościami lokalnymi. Aplikacja nie zamienia ich na UTC, ponieważ opisują dyspozycyjność dnia grupy, a nie pojedynczy globalny timestamp.

## Eksporty

Eksport nie kopiuje istniejącego kontenera. Tworzy nowy dokument logiczny, a następnie szyfruje go nową solą, nowym IV i hasłem eksportu. Może obejmować jeden profil albo wszystkie profile, a opcjonalnie również awatary i historię dyspozycyjności.
