window.APP_CONFIG = Object.freeze({
  // W produkcji wpisz adres wdrożonego Cloudflare Workera, np.:
  // apiBaseUrl: 'https://twoj-worker.example.workers.dev',
  // Puste pole uruchamia zaszyfrowany tryb lokalny w IndexedDB.
  apiBaseUrl: 'https://wspolny-kalendarz-api.intywnapindolcia.workers.dev',
  appName: 'Wspólny termin',
  lockAfterMinutes: 15,
});
