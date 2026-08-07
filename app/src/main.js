import { FriendsCalendarApp } from './app.js';
import { CryptoUnavailableError } from './platform-crypto.js';

const root = document.querySelector('#app');

function renderStartupError(error) {
  if (!root) return;
  const main = document.createElement('main');
  main.className = 'setup-screen';
  const card = document.createElement('section');
  card.className = 'setup-card startup-error-card';
  const eyebrow = document.createElement('p');
  eyebrow.className = 'eyebrow';
  eyebrow.textContent = error instanceof CryptoUnavailableError ? 'WYMAGANE BEZPIECZNE POŁĄCZENIE' : 'BŁĄD URUCHAMIANIA';
  const heading = document.createElement('h1');
  heading.textContent = error instanceof CryptoUnavailableError
    ? (error.code === 'INSECURE_CONTEXT' ? 'Na telefonie użyj HTTPS' : 'Popraw adres uruchomienia')
    : 'Nie udało się uruchomić aplikacji';
  const copy = document.createElement('p');
  copy.className = 'lead';
  copy.textContent = error?.message || 'Odśwież stronę i spróbuj ponownie.';
  card.append(eyebrow, heading, copy);

  if (error instanceof CryptoUnavailableError) {
    const help = document.createElement('div');
    help.className = 'startup-error-help';
    const lineOne = document.createElement('p');
    lineOne.textContent = error.code === 'WILDCARD_HOST'
      ? 'Jeżeli kliknąłeś adres http://[::]:8080/ pokazany przez serwer, zamknij go i wpisz ręcznie http://localhost:8080/.'
      : 'Na komputerze do testów użyj dokładnie http://localhost:8080/. Na telefonie adres http://192.168.x.x:8080 nie jest bezpiecznym kontekstem — użyj GitHub Pages HTTPS albo tunelu HTTPS.';
    const lineTwo = document.createElement('p');
    lineTwo.textContent = 'Nie dopisuj https:// do lokalnego serwera HTTP. Ciąg znaków \x16\x03\x01 w logu oznacza próbę połączenia TLS z serwerem, który rozumie tylko HTTP.';
    help.append(lineOne, lineTwo);
    card.append(help);
  }

  main.append(card);
  root.replaceChildren(main);
}

if (window.top !== window.self) {
  if (root) root.textContent = 'Dla bezpieczeństwa otwórz kalendarz bezpośrednio w nowej karcie.';
} else {
  const app = new FriendsCalendarApp(window.APP_CONFIG || {});
  app.start().catch((error) => {
    console.error(error);
    renderStartupError(error);
  });
}
