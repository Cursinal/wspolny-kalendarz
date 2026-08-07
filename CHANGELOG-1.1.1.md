# 1.1.1

- Dodano `npm run dev`, który serwuje aplikację wyłącznie pod `127.0.0.1` i wypisuje poprawny adres `http://localhost:8080/`.
- Lokalny tryb developerski nie rejestruje Service Workera, usuwa stare rejestracje aplikacji i jej cache statyczny, aby nie uruchamiać starego kodu PWA.
- Dodano `boot.js`, który czyści legacy cache lokalnie przed załadowaniem modułów aplikacji.
- Dodano osobny komunikat dla błędnego adresu `http://[::]:8080/` / `0.0.0.0`.
- Komunikat dla telefonu wyjaśnia, że `https://192.168.x.x:8080` nie zadziała z serwerem HTTP.
- Cache PWA podniesiono do `friends-calendar-static-v5`.
