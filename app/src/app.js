import {
  addMonths,
  CALENDAR_MODES,
  commonAvailability,
  formatDateLong,
  formatDateShort,
  formatMinuteInterval,
  formatMonthTitle,
  formatPlan,
  getDateRange,
  getMonthGrid,
  isProfileAvailable,
  isPlanMarked,
  monthKeyFromDate,
  normalizeCalendarMode,
  normalizePlan,
  sortDateKeys,
  todayKey,
  todayMonth,
} from './calendar.js';
import { createEncryptedExport } from './crypto.js';
import { assertCryptoSupport, isLocalHostname } from './platform-crypto.js';
import { processAvatar } from './image.js';
import { clearDiagnostics, createDiagnosticsText, diagnosticLog } from './logger.js';
import { createStorage } from './storage.js';
import {
  $, button, downloadBlob, element, formatFileSize, normalizeHexColor, sanitizeFilename,
  setBusy, showToast,
} from './utils.js';
import { MissingVaultError, Vault } from './vault.js';

const THEMES = ['black', 'light', 'pink'];
const THEME_LABELS = { black: 'Czarny', light: 'Jasny', pink: 'Pudrowy róż' };
const COLOR_PALETTE = ['#ff7aa8', '#62d0ff', '#84e19a', '#ffbf69', '#b79cff', '#f27676', '#43d8c9', '#ffd166'];

const MARKING_MODE_COPY = Object.freeze({
  [CALENDAR_MODES.AVAILABILITY]: Object.freeze({
    setupTitle: 'Zaznaczamy, kiedy możemy',
    setupDescription: 'Kolor na dniu oznacza, że dana osoba może się wtedy spotkać.',
    selectionAction: 'Ustaw, kiedy mogę',
    markedAria: 'Osób z zaznaczoną dostępnością',
    legendTitle: 'Kiedy możemy',
    legendDescription: 'Kolory oznaczają zadeklarowaną dostępność',
    modeLabel: 'Tryb: zaznaczamy, kiedy możemy się spotkać',
    saveButton: 'Zapisz, kiedy mogę',
    savedToast: 'Dostępność została zapisana.',
    saveError: 'Nie udało się zapisać dostępności.',
    editorTitle: 'Kiedy mogę',
    previewHint: 'Sprawdź dostępność całej grupy',
    activeSwitch: 'Mogę się spotkać tego dnia',
    allDaySwitch: 'Mogę cały dzień',
    clearedMessage: 'Ten dzień nie jest oznaczony jako dostępny.',
  }),
  [CALENDAR_MODES.UNAVAILABILITY]: Object.freeze({
    setupTitle: 'Zaznaczamy, kiedy nie możemy',
    setupDescription: 'Brak oznaczenia znaczy „mogę”. Kolor pokazuje tylko zablokowane dni lub godziny.',
    selectionAction: 'Ustaw, kiedy nie mogę',
    markedAria: 'Osób z zaznaczoną niedostępnością',
    legendTitle: 'Kiedy nie możemy',
    legendDescription: 'Kolory oznaczają zablokowane terminy',
    modeLabel: 'Tryb: zaznaczamy tylko, kiedy nie możemy się spotkać',
    saveButton: 'Zapisz, kiedy nie mogę',
    savedToast: 'Niedostępność została zapisana.',
    saveError: 'Nie udało się zapisać niedostępności.',
    editorTitle: 'Kiedy nie mogę',
    previewHint: 'Brak wpisu oznacza wolny dzień',
    activeSwitch: 'Nie mogę się spotkać tego dnia',
    allDaySwitch: 'Nie mogę cały dzień',
    clearedMessage: 'Brak blokady — w tym dniu możesz się spotkać.',
  }),
});

function markingModeCopy(mode) {
  return MARKING_MODE_COPY[normalizeCalendarMode(mode)];
}

function clone(value) {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function materialIcon(name, className = '') {
  return element('span', {
    className: `material-icons ${className}`.trim(),
    text: name,
    attrs: { 'aria-hidden': 'true' },
  });
}

function iconButton(iconName, label, onClick, className = 'icon-button') {
  return button(materialIcon(iconName), {
    className,
    attrs: { 'aria-label': label, title: label },
    on: { click: onClick },
  });
}

function field(labelText, control, hint = '') {
  const wrapper = element('label', { className: 'field' });
  wrapper.append(element('span', { className: 'field__label', text: labelText }), control);
  if (hint) wrapper.append(element('span', { className: 'field__hint', text: hint }));
  return wrapper;
}

function switchControl(labelText, checked, onChange, description = '') {
  const input = element('input', { type: 'checkbox', checked });
  input.addEventListener('change', () => onChange(input.checked));
  return element('label', { className: 'switch-row' }, [
    element('span', { className: 'switch-row__copy' }, [
      element('span', { className: 'switch-row__label', text: labelText }),
      description ? element('span', { className: 'switch-row__description', text: description }) : null,
    ]),
    element('span', { className: 'switch' }, [input, element('span', { className: 'switch__track' })]),
  ]);
}

function emptyPlan(mode = CALENDAR_MODES.AVAILABILITY) {
  const normalizedMode = normalizeCalendarMode(mode);
  if (normalizedMode === CALENDAR_MODES.UNAVAILABILITY) {
    return {
      available: true,
      allDay: true,
      intervals: [],
      note: '',
    };
  }
  return {
    available: true,
    allDay: false,
    intervals: [{ from: '18:00', to: '22:00' }],
    note: '',
  };
}

function plansEqual(left, right) {
  return JSON.stringify(normalizePlan(left)) === JSON.stringify(normalizePlan(right));
}

function dayMessageHours(plan, mode = CALENDAR_MODES.AVAILABILITY) {
  const normalizedMode = normalizeCalendarMode(mode);
  if (!isPlanMarked(plan)) {
    return normalizedMode === CALENDAR_MODES.UNAVAILABILITY ? 'Cały dzień' : 'Brak deklaracji';
  }
  if (plan.allDay) {
    return normalizedMode === CALENDAR_MODES.UNAVAILABILITY ? 'Niedostępny cały dzień' : 'Cały dzień';
  }
  const intervals = normalizePlan(plan).intervals;
  if (!intervals.length) {
    return normalizedMode === CALENDAR_MODES.UNAVAILABILITY ? 'Brak blokad' : 'Bez godzin';
  }
  const hours = intervals.map((interval) => `${interval.from}–${interval.to}`).join(', ');
  return normalizedMode === CALENDAR_MODES.UNAVAILABILITY ? `Niedostępny: ${hours}` : hours;
}

function profileInitial(profile) {
  return profile?.name?.trim()?.[0]?.toLocaleUpperCase('pl') || '•';
}

function accentContrast(color) {
  const normalized = normalizeHexColor(color);
  const red = Number.parseInt(normalized.slice(1, 3), 16);
  const green = Number.parseInt(normalized.slice(3, 5), 16);
  const blue = Number.parseInt(normalized.slice(5, 7), 16);
  return (red * 299 + green * 587 + blue * 114) / 1000 >= 160 ? '#171716' : '#ffffff';
}

export class FriendsCalendarApp {
  constructor(config) {
    this.config = {
      apiBaseUrl: '',
      appName: 'Wspólny termin',
      lockAfterMinutes: 15,
      ...config,
    };
    this.root = $('#app');
    this.storage = createStorage(this.config.apiBaseUrl);
    this.vault = new Vault(this.storage);
    this.currentProfileId = null;
    this.currentMonth = todayMonth();
    this.monthData = null;
    this.selectedDates = new Set();
    this.calendarInteractionMode = 'browse';
    this.avatarUrls = new Map();
    this.avatarUrlPromises = new Map();
    this.avatarCacheVersion = 0;
    this.autoLockTimer = null;
    this.lastActivity = Date.now();
    this.diagnosticsInstalled = false;
    this.theme = localStorage.getItem('friends-calendar-theme') || 'black';
    if (!THEMES.includes(this.theme)) this.theme = 'black';
  }

  async start() {
    assertCryptoSupport();
    this.applyTheme(this.theme, false);
    this.installDiagnostics();
    this.installActivityListeners();
    this.registerServiceWorker();
    await this.renderLock();
  }

  installDiagnostics() {
    if (this.diagnosticsInstalled) return;
    this.diagnosticsInstalled = true;
    diagnosticLog('app_start', {
      storageMode: this.storage.mode,
      secureContext: globalThis.isSecureContext,
    });
    window.addEventListener('error', (event) => {
      diagnosticLog('window_error', {
        message: event.message,
        source: event.filename?.split('/').at(-1),
        line: event.lineno,
        column: event.colno,
        error: event.error,
      });
    });
    window.addEventListener('unhandledrejection', (event) => {
      diagnosticLog('unhandled_rejection', { reason: event.reason });
    });
  }

  registerServiceWorker() {
    // Lokalnie Service Worker tylko utrudnia debugowanie i potrafi podawać starą wersję aplikacji.
    // Produkcyjny PWA nadal działa normalnie na HTTPS (np. GitHub Pages).
    if (!('serviceWorker' in navigator) || location.protocol === 'file:' || (location.protocol === 'http:' && isLocalHostname(location.hostname))) return;
    const hadController = Boolean(navigator.serviceWorker.controller);
    let refreshing = false;
    if (hadController) {
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (refreshing) return;
        refreshing = true;
        location.reload();
      }, { once: true });
    }
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
      .then((registration) => registration.update())
      .catch(() => {});
  }

  installActivityListeners() {
    const mark = () => this.markActivity();
    for (const eventName of ['pointerdown', 'keydown', 'touchstart']) {
      document.addEventListener(eventName, mark, { passive: true });
    }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.vault.isUnlocked) {
        const timeout = Math.max(1, Number(this.config.lockAfterMinutes)) * 60_000;
        if (Date.now() - this.lastActivity >= timeout) this.lock();
        else this.scheduleAutoLock();
      }
    });
  }

  markActivity() {
    this.lastActivity = Date.now();
    if (this.vault.isUnlocked) this.scheduleAutoLock();
  }

  scheduleAutoLock() {
    clearTimeout(this.autoLockTimer);
    const timeout = Math.max(1, Number(this.config.lockAfterMinutes)) * 60_000;
    this.autoLockTimer = setTimeout(() => this.lock(), timeout);
  }

  applyTheme(theme, remember = true) {
    const selected = THEMES.includes(theme) ? theme : 'black';
    this.theme = selected;
    document.documentElement.dataset.theme = selected;
    $('meta[name="theme-color"]')?.setAttribute('content', selected === 'black' ? '#000000' : selected === 'pink' ? '#f7e8ed' : '#f4f4f2');
    if (remember) localStorage.setItem('friends-calendar-theme', selected);
  }

  applyProfileAccent(profileOrColor = null) {
    const color = typeof profileOrColor === 'string' ? profileOrColor : profileOrColor?.color;
    if (!color) {
      document.documentElement.style.removeProperty('--accent');
      document.documentElement.style.removeProperty('--accent-contrast');
      return;
    }
    const normalized = normalizeHexColor(color);
    document.documentElement.style.setProperty('--accent', normalized);
    document.documentElement.style.setProperty('--accent-contrast', accentContrast(normalized));
  }

  calendarMode() {
    return normalizeCalendarMode(this.vault.index?.group?.markingMode);
  }

  calendarModeCopy() {
    return markingModeCopy(this.calendarMode());
  }

  async renderLock(message = '') {
    this.currentProfileId = null;
    this.applyProfileAccent(null);
    this.selectedDates.clear();
    this.revokeAvatarUrls();
    const localMode = this.storage.mode === 'local';
    const vaultExists = localMode ? await this.vault.exists().catch(() => false) : true;

    let accessMode = 'password';
    const passwordInput = element('input', {
      type: 'password',
      name: 'password',
      autocomplete: 'current-password',
      required: true,
      attrs: { placeholder: 'Hasło do kalendarza', 'aria-label': 'Hasło do kalendarza' },
    });
    const revealButton = iconButton('visibility', 'Pokaż lub ukryj hasło', () => {
      passwordInput.type = passwordInput.type === 'password' ? 'text' : 'password';
      revealButton.querySelector('.material-icons').textContent = passwordInput.type === 'password'
        ? 'visibility'
        : 'visibility_off';
      passwordInput.focus();
    }, 'password-toggle');
    const submit = button('Otwórz kalendarz', { className: 'button button--primary button--large' });
    submit.type = 'submit';
    const errorBox = element('div', {
      className: `form-message ${message ? 'is-visible' : ''}`,
      text: message,
      attrs: { role: 'alert' },
    });

    const modeButton = button('Użyj kodu odzyskiwania', { className: 'text-button unlock-mode-button' });
    modeButton.addEventListener('click', () => {
      accessMode = accessMode === 'password' ? 'recovery' : 'password';
      const recoveryMode = accessMode === 'recovery';
      passwordInput.value = '';
      passwordInput.autocomplete = recoveryMode ? 'off' : 'current-password';
      passwordInput.placeholder = recoveryMode ? 'Kod odzyskiwania' : 'Hasło do kalendarza';
      passwordInput.setAttribute('aria-label', passwordInput.placeholder);
      submit.textContent = recoveryMode ? 'Odzyskaj dostęp' : 'Otwórz kalendarz';
      modeButton.textContent = recoveryMode ? 'Wróć do hasła' : 'Użyj kodu odzyskiwania';
      errorBox.classList.remove('is-visible');
      passwordInput.focus();
    });
    const form = element('form', { className: 'unlock-form' }, [
      element('div', { className: 'password-field' }, [passwordInput, revealButton]),
      errorBox,
      submit,
      modeButton,
    ]);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      errorBox.classList.remove('is-visible');
      setBusy(submit, true, 'Odszyfrowuję…');
      try {
        await this.unlock(passwordInput.value, accessMode);
        passwordInput.value = '';
      } catch (error) {
        console.error(error);
        errorBox.textContent = error.message || 'Nie udało się odblokować kalendarza.';
        errorBox.classList.add('is-visible');
        passwordInput.select();
      } finally {
        setBusy(submit, false);
      }
    });

    const themePicker = element('div', { className: 'lock-theme-picker', attrs: { 'aria-label': 'Motyw strony' } });
    for (const theme of THEMES) {
      const themeButton = button(THEME_LABELS[theme], {
        className: `theme-dot theme-dot--${theme} ${this.theme === theme ? 'is-active' : ''}`,
        attrs: { 'aria-pressed': String(this.theme === theme) },
        on: {
          click: () => {
            this.applyTheme(theme);
            themePicker.querySelectorAll('button').forEach((node) => {
              const active = node === themeButton;
              node.classList.toggle('is-active', active);
              node.setAttribute('aria-pressed', String(active));
            });
          },
        },
      });
      themePicker.append(themeButton);
    }

    const statusText = localMode
      ? (vaultExists ? 'Tryb lokalny · dane są zaszyfrowane na tym urządzeniu' : 'Tryb lokalny · pierwsze logowanie utworzy nowy sejf')
      : 'Tryb wspólny · zaszyfrowane dane są synchronizowane przez GitHub';

    this.root.replaceChildren(element('main', { className: 'lock-screen' }, [
      element('div', { className: 'lock-backdrop-mark', text: '31' }),
      element('section', { className: 'unlock-card' }, [
        element('div', { className: 'brand-mark' }, materialIcon('event_available')),
        element('p', { className: 'eyebrow', text: 'PRYWATNY KALENDARZ' }),
        element('h1', { text: this.config.appName }),
        element('p', { className: 'lead', text: 'Znajdźcie dzień i godzinę, które pasują wszystkim.' }),
        form,
        element('p', { className: 'security-note', text: statusText }),
        themePicker,
      ]),
    ]));
    setTimeout(() => passwordInput.focus(), 60);
  }

  async unlock(credential, accessMode = 'password') {
    try {
      if (accessMode === 'recovery') await this.vault.unlockWithRecovery(credential);
      else await this.vault.unlock(credential);
      this.lastActivity = Date.now();
      this.scheduleAutoLock();
      await this.renderProfiles();
    } catch (error) {
      if (error instanceof MissingVaultError && this.storage.mode === 'local' && accessMode === 'password') {
        this.renderLocalSetup(credential);
        return;
      }
      throw error;
    }
  }

  renderLocalSetup(password) {
    const passwordConfirmation = element('input', {
      type: 'password',
      required: true,
      minLength: 8,
      autocomplete: 'new-password',
      attrs: { placeholder: 'Powtórz hasło użyte na ekranie blokady' },
    });
    const groupInput = element('input', {
      type: 'text',
      required: true,
      maxLength: 60,
      value: 'Nasz kalendarz',
      autocomplete: 'off',
    });
    const profilesInput = element('textarea', {
      rows: 4,
      required: true,
      attrs: { placeholder: 'Każda osoba w osobnej linii' },
    });
    profilesInput.value = 'Osoba 1\nOsoba 2\nOsoba 3\nOsoba 4';
    const markingModeFieldset = element('fieldset', { className: 'marking-mode-fieldset' }, [
      element('legend', { text: 'Co zaznaczamy na kalendarzu?' }),
    ]);
    for (const mode of [CALENDAR_MODES.AVAILABILITY, CALENDAR_MODES.UNAVAILABILITY]) {
      const copy = markingModeCopy(mode);
      const input = element('input', {
        type: 'radio',
        name: 'markingMode',
        value: mode,
        checked: mode === CALENDAR_MODES.AVAILABILITY,
      });
      markingModeFieldset.append(element('label', { className: 'marking-mode-option' }, [
        input,
        element('span', { className: 'marking-mode-option__indicator', attrs: { 'aria-hidden': 'true' } }),
        element('span', { className: 'marking-mode-option__copy' }, [
          element('strong', { text: copy.setupTitle }),
          element('span', { text: copy.setupDescription }),
        ]),
      ]));
    }
    const submit = button('Utwórz zaszyfrowany sejf', { className: 'button button--primary button--large' });
    submit.type = 'submit';
    const back = button('Wróć', {
      className: 'button button--ghost',
      on: { click: () => this.renderLock() },
    });
    const errorBox = element('div', { className: 'form-message', attrs: { role: 'alert' } });
    const form = element('form', { className: 'setup-form' }, [
      field('Potwierdź hasło', passwordConfirmation, 'Hasło ma co najmniej 8 znaków i nie zostanie zapisane.'),
      field('Nazwa grupy', groupInput),
      markingModeFieldset,
      field('Profile', profilesInput, 'Nazwy można później zmienić. System nie ma limitu czterech osób.'),
      errorBox,
      element('div', { className: 'button-row' }, [back, submit]),
    ]);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (password.length < 8) {
        errorBox.textContent = 'Hasło musi mieć co najmniej 8 znaków.';
        errorBox.classList.add('is-visible');
        return;
      }
      if (passwordConfirmation.value !== password) {
        errorBox.textContent = 'Potwierdzenie hasła nie jest takie samo.';
        errorBox.classList.add('is-visible');
        passwordConfirmation.select();
        return;
      }
      setBusy(submit, true, 'Tworzę sejf…');
      try {
        const names = profilesInput.value.split(/\n|,/).map((value) => value.trim()).filter(Boolean);
        const markingMode = form.elements.markingMode?.value || CALENDAR_MODES.AVAILABILITY;
        const result = await this.vault.create(password, groupInput.value, names, markingMode);
        this.lastActivity = Date.now();
        this.scheduleAutoLock();
        await this.showRecoveryCode(result.recoveryCode);
        await this.renderProfiles();
      } catch (error) {
        errorBox.textContent = error.message || 'Nie udało się utworzyć sejfu.';
        errorBox.classList.add('is-visible');
      } finally {
        setBusy(submit, false);
      }
    });

    this.root.replaceChildren(element('main', { className: 'setup-screen' }, [
      element('section', { className: 'setup-card' }, [
        element('p', { className: 'eyebrow', text: 'PIERWSZE URUCHOMIENIE' }),
        element('h1', { text: 'Utwórz swój kalendarz' }),
        element('p', { className: 'lead', text: 'Hasło nie zostanie zapisane. Posłuży do zaszyfrowania losowego klucza sejfu.' }),
        form,
      ]),
    ]));
  }

  async showRecoveryCode(recoveryCode) {
    const dialog = $('#recovery-dialog');
    dialog.replaceChildren();
    const checkbox = element('input', { type: 'checkbox' });
    const continueButton = button('Mam zapisany kod', { className: 'button button--primary', disabled: true });
    const downloadButton = button('Pobierz kod jako plik', {
      className: 'button button--secondary',
      on: {
        click: () => downloadBlob(
          new Blob([`Kod odzyskiwania kalendarza:\n\n${recoveryCode}\n\nPrzechowuj go poza repozytorium GitHub.`], { type: 'text/plain;charset=utf-8' }),
          'kod-odzyskiwania-kalendarza.txt',
        ),
      },
    });
    checkbox.addEventListener('change', () => { continueButton.disabled = !checkbox.checked; });
    continueButton.addEventListener('click', () => dialog.close());
    dialog.addEventListener('cancel', (event) => {
      if (!checkbox.checked) event.preventDefault();
    }, { once: true });
    dialog.append(element('section', { className: 'modal-card' }, [
      element('p', { className: 'eyebrow', text: 'WAŻNE' }),
      element('h2', { text: 'Zapisz kod odzyskiwania' }),
      element('p', { className: 'modal-copy', text: 'To jedyna awaryjna droga do danych po utracie hasła. Kod nie jest zapisywany w aplikacji.' }),
      element('code', { className: 'recovery-code', text: recoveryCode }),
      downloadButton,
      element('label', { className: 'check-row' }, [checkbox, element('span', { text: 'Kod został zapisany w bezpiecznym miejscu.' })]),
      continueButton,
    ]));
    dialog.showModal();
    await new Promise((resolve) => dialog.addEventListener('close', resolve, { once: true }));
  }

  async renderProfiles() {
    this.selectedDates.clear();
    this.applyProfileAccent(null);
    const profiles = this.vault.index.profiles;
    const grid = element('div', { className: 'profile-grid' });
    for (const profile of profiles) {
      const card = element('button', {
        type: 'button',
        className: 'profile-card',
        attrs: { 'aria-label': `Otwórz profil ${profile.name}` },
        on: { click: () => this.selectProfile(profile.id) },
      }, [
        this.createAvatarNode(profile, 'profile-card__avatar'),
        element('span', { className: 'profile-card__name', text: profile.name }),
        element('span', { className: 'profile-card__color', attrs: { 'aria-hidden': 'true' } }),
      ]);
      card.style.setProperty('--profile-color', profile.color);
      grid.append(card);
    }
    const addCard = element('button', {
      type: 'button',
      className: 'profile-card profile-card--add',
      on: { click: () => this.openProfileSettings(null) },
    }, [
      element('span', { className: 'profile-card__avatar profile-card__avatar--add' }, materialIcon('person_add')),
      element('span', { className: 'profile-card__name', text: 'Dodaj profil' }),
    ]);
    grid.append(addCard);

    const header = element('header', { className: 'simple-header' }, [
      element('div', { className: 'brand-inline' }, [
        element('span', { className: 'brand-inline__mark' }, materialIcon('event_available')),
        element('span', { text: this.config.appName }),
      ]),
      iconButton('lock', 'Zablokuj aplikację', () => this.lock()),
    ]);

    this.root.replaceChildren(element('main', { className: 'profiles-screen' }, [
      header,
      element('section', { className: 'profiles-content' }, [
        element('p', { className: 'eyebrow', text: this.vault.index.group.name.toLocaleUpperCase('pl') }),
        element('h1', { text: profiles.length ? 'Kto teraz planuje?' : 'Dodaj pierwszy profil' }),
        element('p', { className: 'lead', text: 'Wybierz swój profil. Kolor, zdjęcie i motyw są zapisane w zaszyfrowanym sejfie.' }),
        grid,
      ]),
    ]));
  }

  async selectProfile(profileId) {
    const profile = this.vault.profile(profileId);
    if (!profile) return;
    this.currentProfileId = profileId;
    this.currentMonth = todayMonth(this.vault.index.group.timeZone);
    this.calendarInteractionMode = 'browse';
    this.selectedDates.clear();
    this.applyTheme(profile.theme || 'black');
    this.applyProfileAccent(profile);
    diagnosticLog('profile_selected', { profileId: profile.id, avatarKind: profile.avatar?.kind || 'none' });
    await this.renderCalendar(true);
  }

  async renderCalendar(force = false) {
    const profile = this.vault.profile(this.currentProfileId);
    if (!profile) {
      await this.renderProfiles();
      return;
    }
    this.applyProfileAccent(profile);
    const month = monthKeyFromDate(this.currentMonth);
    const modeCopy = this.calendarModeCopy();
    this.root.replaceChildren(this.calendarLoadingShell(profile));
    try {
      this.monthData = await this.vault.loadMonth(month, force);
    } catch (error) {
      showToast(error.message || 'Nie udało się pobrać miesiąca.', 'error');
      this.monthData = { month, entries: {} };
    }

    const shell = element('main', {
      className: `calendar-screen ${this.calendarInteractionMode === 'edit' ? 'is-edit-mode' : 'is-browse-mode'}`,
    });
    const editModeButton = element('button', {
      type: 'button',
      className: `button button--secondary button--small edit-mode-button ${this.calendarInteractionMode === 'edit' ? 'is-active' : ''}`,
      attrs: {
        'aria-pressed': String(this.calendarInteractionMode === 'edit'),
        'aria-label': this.calendarInteractionMode === 'edit' ? 'Zakończ edycję kalendarza' : 'Włącz edycję kalendarza',
      },
      on: {
        click: () => this.setCalendarInteractionMode(
          this.calendarInteractionMode === 'edit' ? 'browse' : 'edit',
        ),
      },
    }, [
      materialIcon('edit', 'edit-mode-button__icon'),
      element('span', {
        className: 'edit-mode-button__label',
        text: this.calendarInteractionMode === 'edit' ? 'Zakończ edycję' : 'Edytuj kalendarz',
      }),
    ]);
    this.editModeButton = editModeButton;
    const topbar = element('header', { className: 'calendar-topbar' }, [
      element('button', {
        type: 'button',
        className: 'current-profile',
        on: { click: () => this.renderProfiles() },
      }, [
        this.createAvatarNode(profile, 'current-profile__avatar'),
        element('span', { className: 'current-profile__copy' }, [
          element('span', { className: 'current-profile__group', text: this.vault.index.group.name }),
          element('strong', { text: profile.name }),
        ]),
      ]),
      element('div', { className: 'topbar-actions' }, [
        editModeButton,
        iconButton('sync', 'Synchronizuj', () => this.syncCurrentMonth()),
        iconButton('settings', 'Ustawienia profilu', () => this.openProfileSettings(profile.id)),
      ]),
    ]);

    const monthToolbar = element('section', { className: 'month-toolbar' }, [
      iconButton('chevron_left', 'Poprzedni miesiąc', () => this.changeMonth(-1), 'month-nav-button'),
      element('button', {
        type: 'button',
        className: 'month-title',
        on: { click: () => this.goToToday() },
      }, [
        element('span', { text: formatMonthTitle(this.currentMonth) }),
        element('small', { text: 'Dotknij, aby wrócić do dzisiaj' }),
      ]),
      iconButton('chevron_right', 'Następny miesiąc', () => this.changeMonth(1), 'month-nav-button'),
    ]);

    const calendarPanel = element('section', { className: 'calendar-panel' });
    const weekdayRow = element('div', { className: 'weekday-row', attrs: { role: 'row' } });
    for (const name of ['Pn', 'Wt', 'Śr', 'Cz', 'Pt', 'Sb', 'Nd']) {
      weekdayRow.append(element('span', { text: name, attrs: { role: 'columnheader' } }));
    }
    const grid = this.buildCalendarGrid();
    calendarPanel.append(weekdayRow, grid);

    const selectionHint = element('p', {
      className: 'selection-hint',
      text: this.calendarInteractionMode === 'edit'
        ? 'Tryb edycji: przeciągnij po dniach albo wybieraj je pojedynczo.'
        : 'Kliknij dzień, aby zobaczyć szczegóły. Przytrzymaj palcem lub kliknij prawym, aby edytować.',
    });
    this.selectionHint = selectionHint;

    const legend = this.buildProfileLegend();
    const removeSelectionButton = button('Usuń wpisy', {
      className: 'button button--danger button--small selection-remove-button',
      on: {
        click: async () => {
          setBusy(removeSelectionButton, true, 'Usuwam…');
          try {
            await this.removeAvailability(sortDateKeys(this.selectedDates));
          } catch (error) {
            showToast(error.message || 'Nie udało się usunąć dyspozycji.', 'error');
          } finally {
            setBusy(removeSelectionButton, false);
          }
        },
      },
    });
    this.selectionRemoveButton = removeSelectionButton;
    const selectionToolbar = element('div', { className: 'selection-toolbar', attrs: { 'aria-live': 'polite' } }, [
      element('div', { className: 'selection-toolbar__copy' }, [
        element('strong', { className: 'selection-count', text: '0 dni' }),
        element('span', { text: 'zaznaczonych' }),
      ]),
      element('div', { className: 'selection-toolbar__actions' }, [
        button('Wyczyść', { className: 'button button--ghost button--small', on: { click: () => this.clearSelection() } }),
        removeSelectionButton,
        button('Dalej', {
          className: 'button button--primary button--small',
          attrs: { title: modeCopy.selectionAction, 'aria-label': `${modeCopy.selectionAction} — przejdź dalej` },
          on: { click: () => this.openAvailabilityEditor() },
        }),
      ]),
    ]);
    this.selectionToolbar = selectionToolbar;

    const bottomNav = element('nav', { className: 'bottom-nav', attrs: { 'aria-label': 'Nawigacja' } }, [
      button('Profile', { className: 'bottom-nav__item', on: { click: () => this.renderProfiles() } }),
      button('Dzisiaj', { className: 'bottom-nav__item is-active', on: { click: () => this.goToToday() } }),
      button('Ustawienia', { className: 'bottom-nav__item', on: { click: () => this.openProfileSettings(profile.id) } }),
      button('Zablokuj', { className: 'bottom-nav__item', on: { click: () => this.lock() } }),
    ]);

    shell.append(topbar, monthToolbar, calendarPanel, selectionHint, legend, selectionToolbar, bottomNav);
    this.root.replaceChildren(shell);
    this.attachCalendarSelection(grid);
    this.updateInteractionModeUi();
    this.updateSelectionUi();
  }

  calendarLoadingShell(profile) {
    return element('main', { className: 'calendar-screen' }, [
      element('header', { className: 'calendar-topbar' }, [
        element('div', { className: 'current-profile' }, [
          this.createAvatarNode(profile, 'current-profile__avatar'),
          element('strong', { text: profile.name }),
        ]),
      ]),
      element('div', { className: 'calendar-loading' }, [
        element('span', { className: 'spinner', attrs: { 'aria-hidden': 'true' } }),
        element('p', { text: 'Odszyfrowuję miesiąc…' }),
      ]),
    ]);
  }

  buildCalendarGrid() {
    const grid = element('div', { className: 'calendar-grid', attrs: { role: 'grid', 'aria-label': formatMonthTitle(this.currentMonth) } });
    const today = todayKey(this.vault.index.group.timeZone);
    const profiles = this.vault.index.profiles;
    const profileIds = profiles.map((profile) => profile.id);
    const mode = this.calendarMode();
    for (const item of getMonthGrid(this.currentMonth)) {
      const entries = this.monthData.entries?.[item.key] || {};
      const markedProfiles = profiles.filter((profile) => isPlanMarked(entries[profile.id]));
      const availableProfiles = profiles.filter((profile) => isProfileAvailable(entries[profile.id], mode));
      const common = commonAvailability(entries, profileIds, mode);
      const intervalLabel = common.length ? formatMinuteInterval(common[0]) : '';
      const allProfilesDeclared = profiles.length > 0 && markedProfiles.length === profiles.length;
      const isGroupMatch = allProfilesDeclared && common.length > 0;
      const profileSummaries = availableProfiles.map((availableProfile) => {
        const plan = entries[availableProfile.id];
        const note = String(plan?.note || '').trim();
        return `${availableProfile.name}: ${formatPlan(plan, mode)}${note ? `. Notatka: ${note}` : ''}`;
      });
      let ariaSummary;
      if (mode === CALENDAR_MODES.UNAVAILABILITY && markedProfiles.length === 0) {
        ariaSummary = `Dostępnych osób: ${availableProfiles.length}. Nikt nie zaznaczył niedostępności. Wszyscy mogą cały dzień.`;
      } else if (common.length) {
        ariaSummary = `Dostępnych osób: ${availableProfiles.length}. Wspólny wolny czas: ${intervalLabel}.`;
      } else {
        ariaSummary = `Dostępnych osób: ${availableProfiles.length}. Brak wspólnego wolnego czasu.`;
      }
      if (profileSummaries.length) ariaSummary += ` ${profileSummaries.join('. ')}.`;
      if (isGroupMatch) ariaSummary += ' Dopasowanie dla całej grupy.';
      const cell = element('button', {
        type: 'button',
        className: [
          'day-cell',
          mode === CALENDAR_MODES.UNAVAILABILITY ? 'day-cell--unavailability' : '',
          !item.inCurrentMonth ? 'is-outside' : '',
          item.key === today ? 'is-today' : '',
          isGroupMatch ? 'is-group-match' : '',
          this.selectedDates.has(item.key) ? 'is-selected' : '',
        ].filter(Boolean).join(' '),
        dataset: { date: item.key },
        attrs: {
          role: 'gridcell',
          'aria-label': `${formatDateLong(item.key)}. ${ariaSummary}`,
          'aria-pressed': String(this.selectedDates.has(item.key)),
          disabled: !item.inCurrentMonth,
        },
      });
      cell.append(element('span', { className: 'day-cell__number', text: item.day }));
      const profileAvatars = element('span', { className: 'day-cell__profiles', attrs: { 'aria-hidden': 'true' } });
      for (const availableProfile of availableProfiles.slice(0, 4)) {
        profileAvatars.append(this.createAvatarNode(availableProfile, 'day-cell__avatar'));
      }
      if (availableProfiles.length > 4) {
        profileAvatars.append(element('span', { className: 'day-cell__more', text: `+${availableProfiles.length - 4}` }));
      }
      cell.append(profileAvatars);
      const summary = element('span', { className: 'day-cell__summary', attrs: { 'aria-hidden': 'true' } });
      if (availableProfiles.length) {
        summary.append(element('span', {
          className: 'available-count',
          text: String(availableProfiles.length),
          attrs: { title: `Dostępnych osób: ${availableProfiles.length}` },
        }));
      }
      cell.append(summary);
      grid.append(cell);
    }
    return grid;
  }

  buildProfileLegend() {
    const mode = this.calendarMode();
    const copy = markingModeCopy(mode);
    const list = element('div', { className: 'profile-legend' });
    for (const profile of this.vault.index.profiles) {
      const item = element('span', { className: 'profile-legend__item' }, [
        element('span', { className: 'profile-legend__dot' }),
        element('span', { text: profile.name }),
      ]);
      item.querySelector('.profile-legend__dot').style.backgroundColor = profile.color;
      list.append(item);
    }
    return element('section', { className: 'legend-section' }, [
      element('div', { className: 'legend-section__title' }, [
        element('strong', { text: copy.legendTitle }),
        element('span', { text: copy.legendDescription }),
      ]),
      element('p', {
        className: `marking-mode-note ${mode === CALENDAR_MODES.UNAVAILABILITY ? 'marking-mode-note--blocked' : ''}`,
        text: copy.modeLabel,
      }),
      list,
    ]);
  }

  setCalendarInteractionMode(mode, notify = true) {
    const nextMode = mode === 'edit' ? 'edit' : 'browse';
    const changed = nextMode !== this.calendarInteractionMode;
    this.calendarInteractionMode = nextMode;
    if (nextMode === 'browse') this.selectedDates.clear();
    this.updateInteractionModeUi();
    this.updateSelectionUi();
    if (notify && changed) {
      diagnosticLog('calendar_interaction_mode_changed', { mode: nextMode });
      showToast(
        nextMode === 'edit' ? 'Włączono tryb edycji.' : 'Włączono tryb przeglądania.',
        'info',
      );
    }
  }

  updateInteractionModeUi() {
    const editing = this.calendarInteractionMode === 'edit';
    const shell = this.root.querySelector('.calendar-screen');
    shell?.classList.toggle('is-edit-mode', editing);
    shell?.classList.toggle('is-browse-mode', !editing);
    if (this.editModeButton) {
      this.editModeButton.classList.toggle('is-active', editing);
      this.editModeButton.setAttribute('aria-pressed', String(editing));
      this.editModeButton.setAttribute(
        'aria-label',
        editing ? 'Zakończ edycję kalendarza' : 'Włącz edycję kalendarza',
      );
      const label = this.editModeButton.querySelector('.edit-mode-button__label');
      if (label) label.textContent = editing ? 'Zakończ edycję' : 'Edytuj kalendarz';
    }
    if (this.selectionHint) {
      this.selectionHint.textContent = editing
        ? 'Tryb edycji: przeciągnij po dniach albo wybieraj je pojedynczo.'
        : 'Kliknij dzień, aby zobaczyć szczegóły. Przytrzymaj palcem lub kliknij prawym, aby edytować.';
    }
  }

  attachCalendarSelection(grid) {
    let pointerState = null;
    let lastPointerCompletion = 0;
    let suppressClickUntil = 0;
    let longPressTimer = null;

    const dayFromEvent = (event) => {
      const target = event.target.closest?.('.day-cell:not(:disabled)');
      return target?.dataset.date ? target : null;
    };

    const cancelLongPress = () => {
      if (longPressTimer) clearTimeout(longPressTimer);
      longPressTimer = null;
    };

    const selectDateForEditing = (date, replace = false) => {
      if (replace) this.selectedDates = new Set([date]);
      else this.selectedDates.add(date);
      this.updateSelectionUi();
    };

    const beginDrag = (event) => {
      const target = dayFromEvent(event);
      if (!target || event.button > 0 || event.isPrimary === false) return;

      if (this.calendarInteractionMode === 'browse') {
        if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
        pointerState = {
          id: event.pointerId,
          start: target.dataset.date,
          startX: event.clientX,
          startY: event.clientY,
        };
        cancelLongPress();
        longPressTimer = setTimeout(() => {
          if (!pointerState || pointerState.id !== event.pointerId) return;
          const date = pointerState.start;
          pointerState = null;
          longPressTimer = null;
          suppressClickUntil = performance.now() + 900;
          this.setCalendarInteractionMode('edit');
          selectDateForEditing(date, true);
          navigator.vibrate?.(18);
        }, 520);
        return;
      }

      grid.setPointerCapture?.(event.pointerId);
      pointerState = {
        id: event.pointerId,
        start: target.dataset.date,
        current: target.dataset.date,
        startX: event.clientX,
        startY: event.clientY,
        dragging: false,
        base: new Set(this.selectedDates),
        selecting: !this.selectedDates.has(target.dataset.date),
      };
    };

    const moveDrag = (event) => {
      if (!pointerState || pointerState.id !== event.pointerId) return;
      const distance = Math.hypot(event.clientX - pointerState.startX, event.clientY - pointerState.startY);
      if (this.calendarInteractionMode === 'browse') {
        if (distance > 10) {
          cancelLongPress();
          pointerState = null;
          suppressClickUntil = performance.now() + 350;
        }
        return;
      }
      if (!pointerState.dragging) {
        const threshold = event.pointerType === 'touch' ? 7 : 4;
        if (distance > threshold) {
          pointerState.dragging = true;
          navigator.vibrate?.(12);
          this.applyDragRange(pointerState);
        }
      }
      if (!pointerState.dragging) return;
      event.preventDefault();
      const pointed = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('.day-cell:not(:disabled)');
      if (pointed?.dataset.date && pointed.dataset.date !== pointerState.current) {
        pointerState.current = pointed.dataset.date;
        this.applyDragRange(pointerState);
      }
    };

    const finishDrag = (event) => {
      if (!pointerState || pointerState.id !== event.pointerId) return;
      cancelLongPress();
      if (this.calendarInteractionMode === 'browse') {
        pointerState = null;
        return;
      }
      const completed = pointerState;
      if (grid.hasPointerCapture?.(event.pointerId)) grid.releasePointerCapture(event.pointerId);
      pointerState = null;
      if (!completed.dragging) {
        this.selectedDates = new Set(completed.base);
        if (completed.selecting) this.selectedDates.add(completed.start);
        else this.selectedDates.delete(completed.start);
      }
      this.finishSelectionInteraction();
      lastPointerCompletion = performance.now();
    };

    grid.addEventListener('pointerdown', beginDrag);
    grid.addEventListener('pointermove', moveDrag);
    grid.addEventListener('pointerup', finishDrag);
    grid.addEventListener('pointercancel', (event) => {
      cancelLongPress();
      if (grid.hasPointerCapture?.(event.pointerId)) grid.releasePointerCapture(event.pointerId);
      pointerState = null;
    });
    grid.addEventListener('contextmenu', (event) => {
      const target = dayFromEvent(event);
      if (!target) return;
      event.preventDefault();
      const wasBrowsing = this.calendarInteractionMode === 'browse';
      this.setCalendarInteractionMode('edit');
      selectDateForEditing(target.dataset.date, wasBrowsing);
      suppressClickUntil = performance.now() + 500;
    });
    grid.addEventListener('click', (event) => {
      if (performance.now() < suppressClickUntil || performance.now() - lastPointerCompletion < 500) return;
      const target = dayFromEvent(event);
      if (!target) return;
      if (this.calendarInteractionMode === 'browse') {
        this.openDayDetails(target.dataset.date);
        return;
      }
      if (this.selectedDates.has(target.dataset.date)) this.selectedDates.delete(target.dataset.date);
      else this.selectedDates.add(target.dataset.date);
      this.finishSelectionInteraction();
    });
    grid.addEventListener('keydown', (event) => {
      if (!['Enter', ' '].includes(event.key)) return;
      const target = dayFromEvent(event);
      if (!target) return;
      event.preventDefault();
      if (this.calendarInteractionMode === 'browse') {
        this.openDayDetails(target.dataset.date);
        return;
      }
      if (this.selectedDates.has(target.dataset.date)) this.selectedDates.delete(target.dataset.date);
      else this.selectedDates.add(target.dataset.date);
      this.finishSelectionInteraction();
    });
  }

  applyDragRange(state) {
    const range = getDateRange(state.start, state.current);
    this.selectedDates = new Set(state.base);
    for (const date of range) {
      if (state.selecting) this.selectedDates.add(date);
      else this.selectedDates.delete(date);
    }
    this.updateSelectionUi();
  }

  updateSelectionUi() {
    document.querySelectorAll('.day-cell[data-date]').forEach((cell) => {
      const selected = this.selectedDates.has(cell.dataset.date);
      cell.classList.toggle('is-selected', selected);
      cell.setAttribute('aria-pressed', String(selected));
    });
    if (!this.selectionToolbar) return;
    const count = this.selectedDates.size;
    const editing = this.calendarInteractionMode === 'edit';
    this.selectionToolbar.classList.toggle('is-visible', editing && count > 0);
    const label = count === 1 ? '1 dzień' : count < 5 ? `${count} dni` : `${count} dni`;
    this.selectionToolbar.querySelector('.selection-count').textContent = label;
    if (this.selectionRemoveButton) {
      const existingEntryCount = [...this.selectedDates].filter((date) => (
        isPlanMarked(this.monthData?.entries?.[date]?.[this.currentProfileId])
      )).length;
      this.selectionRemoveButton.hidden = existingEntryCount === 0;
      this.selectionRemoveButton.textContent = existingEntryCount === 1 ? 'Usuń wpis' : 'Usuń wpisy';
    }
  }

  finishSelectionInteraction() {
    if (this.calendarInteractionMode === 'edit' && this.selectedDates.size === 0) {
      this.setCalendarInteractionMode('browse');
      return;
    }
    this.updateSelectionUi();
  }

  clearSelection() {
    this.selectedDates.clear();
    if (this.calendarInteractionMode === 'edit') {
      this.setCalendarInteractionMode('browse');
      return;
    }
    this.updateSelectionUi();
  }

  async changeMonth(amount) {
    this.currentMonth = addMonths(this.currentMonth, amount);
    this.selectedDates.clear();
    await this.renderCalendar(true);
  }

  async goToToday() {
    this.currentMonth = todayMonth(this.vault.index.group.timeZone);
    this.selectedDates.clear();
    await this.renderCalendar(true);
  }

  async syncCurrentMonth() {
    try {
      await this.vault.refreshIndex();
      await this.renderCalendar(true);
      showToast('Kalendarz jest zsynchronizowany.', 'success');
    } catch (error) {
      showToast(error.message || 'Synchronizacja nie powiodła się.', 'error');
    }
  }

  openDayDetails(date) {
    const dialog = $('#availability-dialog');
    if (dialog.open) dialog.close();
    dialog.replaceChildren();
    const mode = this.calendarMode();
    const profiles = this.vault.index.profiles;
    const entries = this.monthData.entries?.[date] || {};
    const currentPlan = entries[this.currentProfileId];
    const hasCurrentEntry = isPlanMarked(currentPlan);
    const common = commonAvailability(entries, profiles.map((profile) => profile.id), mode);
    const availableCount = profiles.filter((profile) => isProfileAvailable(entries[profile.id], mode)).length;
    const availableLabel = availableCount === 1
      ? '1 osoba dostępna'
      : availableCount >= 2 && availableCount <= 4
        ? `${availableCount} osoby dostępne`
        : `${availableCount} osób dostępnych`;
    diagnosticLog('day_details_opened', { date, availableCount, profileCount: profiles.length });

    const overview = element('section', { className: 'day-details-overview' }, [
      element('strong', {
        text: availableCount ? availableLabel : 'Nikt nie jest dostępny',
      }),
      element('span', {
        text: common.length
          ? `Wspólny czas: ${common.map(formatMinuteInterval).join(', ')}`
          : 'Brak wspólnego wolnego czasu',
      }),
    ]);

    const conversation = element('div', {
      className: 'day-conversation',
      attrs: { 'aria-label': `Dyspozycyjność: ${formatDateLong(date)}` },
    });
    for (const person of profiles) {
      const plan = entries[person.id];
      const marked = isPlanMarked(plan);
      const row = element('section', {
        className: [
          'day-message',
          person.id === this.currentProfileId ? 'is-current-profile' : '',
          !marked && mode === CALENDAR_MODES.AVAILABILITY ? 'is-empty' : '',
        ].filter(Boolean).join(' '),
      });
      row.style.setProperty('--profile-color', person.color);
      const name = element('div', { className: 'day-message__name' }, [
        element('strong', { text: person.name }),
        person.id === this.currentProfileId
          ? element('span', { className: 'day-message__you', text: 'Ty' })
          : null,
      ]);
      const note = String(plan?.note || '').trim();
      const message = element('div', {
        className: `day-message__bubble ${mode === CALENDAR_MODES.UNAVAILABILITY && marked ? 'is-blocked' : ''}`,
      }, [
        element('span', { className: 'day-message__text' }, [
          element('strong', { className: 'day-message__hours', text: dayMessageHours(plan, mode) }),
          note ? element('span', { className: 'day-message__separator', text: ', ' }) : null,
          note ? element('span', { className: 'day-message__note', text: note }) : null,
        ]),
      ]);
      row.append(name, this.createAvatarNode(person, 'day-message__avatar'), message);
      conversation.append(row);
    }

    const editButton = button(hasCurrentEntry ? 'Edytuj mój wpis' : 'Dodaj mój wpis', {
      className: 'button button--primary',
      on: {
        click: () => {
          dialog.close();
          this.setCalendarInteractionMode('edit');
          this.selectedDates = new Set([date]);
          this.updateSelectionUi();
          this.openAvailabilityEditor();
        },
      },
    });
    const footerActions = [];
    if (hasCurrentEntry) {
      const removeButton = button('Usuń mój wpis', {
        className: 'button button--danger',
        on: {
          click: async () => {
            setBusy(removeButton, true, 'Usuwam…');
            try {
              await this.removeAvailability([date], dialog);
            } catch (error) {
              showToast(error.message || 'Nie udało się usunąć dyspozycji.', 'error');
              setBusy(removeButton, false);
            }
          },
        },
      });
      footerActions.push(removeButton);
    }
    footerActions.push(editButton);

    dialog.append(element('section', { className: 'sheet-card day-details-card' }, [
      element('div', { className: 'sheet-handle', attrs: { 'aria-hidden': 'true' } }),
      element('header', { className: 'sheet-header' }, [
        element('div', {}, [
          element('p', { className: 'eyebrow', text: 'SZCZEGÓŁY DNIA' }),
          element('h2', { text: formatDateLong(date) }),
        ]),
        iconButton('close', 'Zamknij', () => dialog.close()),
      ]),
      overview,
      conversation,
      element('footer', { className: 'sheet-footer day-details-footer' }, footerActions),
    ]));
    dialog.showModal();
  }

  async removeAvailability(dates, dialog = null) {
    const profile = this.vault.profile(this.currentProfileId);
    if (!profile) return;
    const datesWithEntries = sortDateKeys(dates).filter((date) => (
      isPlanMarked(this.monthData?.entries?.[date]?.[profile.id])
    ));
    if (!datesWithEntries.length) return;
    const changes = Object.fromEntries(datesWithEntries.map((date) => [date, {
      available: false,
      allDay: false,
      intervals: [],
      note: '',
    }]));
    await this.vault.setAvailability(profile.id, changes);
    diagnosticLog('availability_removed', { profileId: profile.id, dates: datesWithEntries });
    if (dialog?.open) dialog.close();
    this.selectedDates.clear();
    if (this.calendarInteractionMode === 'edit') this.setCalendarInteractionMode('browse');
    await this.renderCalendar(true);
    showToast(
      datesWithEntries.length === 1 ? 'Wpis został usunięty.' : `Usunięto wpisy z ${datesWithEntries.length} dni.`,
      'success',
    );
  }

  openAvailabilityEditor() {
    const dates = sortDateKeys(this.selectedDates);
    if (!dates.length) return;
    const profile = this.vault.profile(this.currentProfileId);
    const mode = this.calendarMode();
    const copy = markingModeCopy(mode);
    const dialog = $('#availability-dialog');
    dialog.replaceChildren();

    const existingPlans = Object.fromEntries(dates.map((date) => [
      date,
      clone(this.monthData.entries?.[date]?.[profile.id] || emptyPlan(mode)),
    ]));
    const values = Object.values(existingPlans);
    let sameForAll = values.every((plan) => plansEqual(plan, values[0]));
    let sharedPlan = clone(values[0] || emptyPlan(mode));
    let individualPlans = existingPlans;

    const editorRegion = element('div', { className: 'availability-editor-region' });
    const renderEditors = () => {
      editorRegion.replaceChildren();
      if (sameForAll) {
        editorRegion.append(element('section', { className: 'plan-card' }, [
          element('div', { className: 'plan-card__heading' }, [
            element('strong', { text: dates.length === 1 ? formatDateLong(dates[0]) : `${dates.length} zaznaczonych dni` }),
            element('span', { text: dates.length === 1 ? '' : `${formatDateShort(dates[0])} – ${formatDateShort(dates.at(-1))}` }),
          ]),
          this.buildPlanEditor(sharedPlan, (next) => { sharedPlan = next; }, false, mode),
        ]));
      } else {
        for (const date of dates) {
          editorRegion.append(element('section', { className: 'plan-card plan-card--compact' }, [
            element('div', { className: 'plan-card__heading' }, [element('strong', { text: formatDateLong(date) })]),
            this.buildPlanEditor(individualPlans[date], (next) => { individualPlans[date] = next; }, true, mode),
          ]));
        }
      }
    };

    const sameSwitch = switchControl(
      'Te same godziny dla wszystkich dni',
      sameForAll,
      (checked) => {
        if (!checked && sameForAll) {
          individualPlans = Object.fromEntries(dates.map((date) => [date, clone(sharedPlan)]));
        }
        if (checked && !sameForAll) sharedPlan = clone(individualPlans[dates[0]] || emptyPlan(mode));
        sameForAll = checked;
        renderEditors();
      },
      'Wyłącz, aby ustawić inne godziny dla każdego dnia.',
    );

    const saveButton = button(copy.saveButton, { className: 'button button--primary button--large' });
    saveButton.addEventListener('click', async () => {
      try {
        const datePlans = {};
        for (const date of dates) {
          const candidate = sameForAll ? sharedPlan : individualPlans[date];
          datePlans[date] = this.validatePlan(candidate, date);
        }
        setBusy(saveButton, true, 'Szyfruję i zapisuję…');
        await this.vault.setAvailability(profile.id, datePlans);
        dialog.close();
        this.clearSelection();
        await this.renderCalendar(true);
        showToast(copy.savedToast, 'success');
      } catch (error) {
        showToast(error.message || copy.saveError, 'error');
      } finally {
        setBusy(saveButton, false);
      }
    });

    const header = element('header', { className: 'sheet-header' }, [
      element('div', {}, [
        element('p', { className: 'eyebrow', text: profile.name.toLocaleUpperCase('pl') }),
        element('h2', { text: dates.length === 1 ? copy.editorTitle : `${copy.editorTitle} · ${dates.length} dni` }),
      ]),
      iconButton('close', 'Zamknij', () => dialog.close()),
    ]);

    dialog.append(element('section', { className: 'sheet-card' }, [
      element('div', { className: 'sheet-handle', attrs: { 'aria-hidden': 'true' } }),
      header,
      this.buildGroupPreview(dates),
      sameSwitch,
      editorRegion,
      element('footer', { className: 'sheet-footer' }, [
        button('Anuluj', { className: 'button button--ghost', on: { click: () => dialog.close() } }),
        saveButton,
      ]),
    ]));
    renderEditors();
    dialog.showModal();
  }

  buildGroupPreview(dates) {
    const mode = this.calendarMode();
    const copy = markingModeCopy(mode);
    const details = element('details', {
      className: 'group-preview',
      attrs: { open: dates.length === 1 },
    });
    details.append(element('summary', {}, [
      element('span', { text: 'Podgląd grupy' }),
      element('span', { className: 'group-preview__hint', text: copy.previewHint }),
    ]));
    const body = element('div', { className: 'group-preview__body' });
    for (const date of dates) {
      const entries = this.monthData.entries?.[date] || {};
      const common = commonAvailability(entries, this.vault.index.profiles.map((profile) => profile.id), mode);
      const day = element('section', { className: 'group-preview__day' }, [
        element('div', { className: 'group-preview__date' }, [
          element('strong', { text: formatDateLong(date) }),
          common.length ? element('span', {
            className: 'common-pill',
            text: `${mode === CALENDAR_MODES.UNAVAILABILITY ? 'Wszyscy wolni' : 'Wszyscy'}: ${formatMinuteInterval(common[0])}`,
          }) : null,
        ]),
      ]);
      for (const profile of this.vault.index.profiles) {
        const plan = entries[profile.id];
        const marked = isPlanMarked(plan);
        const statusClass = [
          'group-preview__status',
          mode === CALENDAR_MODES.UNAVAILABILITY && marked ? 'group-preview__status--blocked' : '',
          mode === CALENDAR_MODES.AVAILABILITY && !marked ? 'muted' : '',
        ].filter(Boolean).join(' ');
        const row = element('div', { className: 'group-preview__row' }, [
          element('span', { className: 'group-preview__person' }, [
            element('span', { className: 'profile-legend__dot' }),
            element('span', { text: profile.name }),
          ]),
          element('span', { className: statusClass, text: formatPlan(plan, mode) }),
        ]);
        row.querySelector('.profile-legend__dot').style.backgroundColor = profile.color;
        day.append(row);
        const note = String(plan?.note || '').trim();
        if (note) {
          const noteBubble = element('p', { className: 'group-preview__note', text: note });
          noteBubble.style.setProperty('--profile-color', profile.color);
          day.append(noteBubble);
        }
      }
      body.append(day);
    }
    details.append(body);
    return details;
  }

  buildPlanEditor(initialPlan, onChange, compact = false, mode = this.calendarMode()) {
    const normalizedMode = normalizeCalendarMode(mode);
    const copy = markingModeCopy(normalizedMode);
    const basePlan = emptyPlan(normalizedMode);
    let plan = {
      ...basePlan,
      ...clone(initialPlan),
      intervals: clone(initialPlan?.intervals || basePlan.intervals),
    };
    const root = element('div', { className: `plan-editor ${compact ? 'plan-editor--compact' : ''}` });

    const emit = () => onChange(clone(plan));
    const render = () => {
      root.replaceChildren();
      root.append(switchControl(copy.activeSwitch, plan.available !== false, (checked) => {
        const wasMarked = plan.available !== false;
        plan.available = checked;
        if (checked && !wasMarked) {
          if (normalizedMode === CALENDAR_MODES.UNAVAILABILITY && !plan.intervals?.length) plan.allDay = true;
          if (normalizedMode === CALENDAR_MODES.AVAILABILITY && !plan.allDay && !plan.intervals?.length) {
            plan.intervals = clone(basePlan.intervals);
          }
        }
        emit();
        render();
      }));
      if (plan.available === false) {
        root.append(element('p', { className: 'muted plan-editor__empty', text: copy.clearedMessage }));
        return;
      }
      root.append(switchControl(copy.allDaySwitch, Boolean(plan.allDay), (checked) => {
        plan.allDay = checked;
        emit();
        render();
      }));
      if (!plan.allDay) {
        const intervals = element('div', { className: 'interval-list' });
        plan.intervals = plan.intervals?.length ? plan.intervals : [{ from: '18:00', to: '22:00' }];
        plan.intervals.forEach((interval, index) => {
          const from = element('input', { type: 'time', value: interval.from || '18:00', attrs: { 'aria-label': 'Od godziny' } });
          const to = element('input', { type: 'time', value: interval.to || '22:00', attrs: { 'aria-label': 'Do godziny' } });
          from.addEventListener('input', () => { plan.intervals[index].from = from.value; emit(); });
          to.addEventListener('input', () => { plan.intervals[index].to = to.value; emit(); });
          const remove = iconButton('delete', 'Usuń przedział', () => {
            plan.intervals.splice(index, 1);
            emit();
            render();
          }, 'interval-remove');
          remove.disabled = plan.intervals.length === 1;
          intervals.append(element('div', { className: 'interval-row' }, [
            element('span', { className: 'interval-label', text: 'od' }),
            from,
            element('span', { className: 'interval-label', text: 'do' }),
            to,
            remove,
          ]));
        });
        const addInterval = button([
          materialIcon('add', 'button__icon'),
          element('span', { text: 'Dodaj kolejny przedział' }),
        ], {
          className: 'text-button button-with-icon',
          on: {
            click: () => {
              plan.intervals.push({ from: '18:00', to: '22:00' });
              emit();
              render();
            },
          },
        });
        root.append(intervals, addInterval);
      }
      const note = element('input', {
        type: 'text',
        maxLength: 240,
        value: plan.note || '',
        attrs: { placeholder: 'Opcjonalna notatka lub emoji 🙂' },
      });
      note.addEventListener('input', () => { plan.note = note.value; emit(); });
      root.append(field('Notatka', note));
    };
    render();
    emit();
    return root;
  }

  validatePlan(candidate, date) {
    const normalized = normalizePlan(candidate);
    if (!normalized.available) return normalized;
    if (!normalized.allDay && normalized.intervals.length === 0) {
      throw new Error(`Ustaw poprawny przedział godzin dla: ${formatDateShort(date)}.`);
    }
    return normalized;
  }

  async openProfileSettings(profileId) {
    const isNew = !profileId;
    const existing = isNew ? null : this.vault.profile(profileId);
    if (!isNew && !existing) return;
    const dialog = $('#settings-dialog');
    dialog.replaceChildren();
    const originalTheme = this.theme;
    const originalAccent = document.documentElement.style.getPropertyValue('--accent');
    let saved = false;
    let selectedTheme = existing?.theme || this.theme;
    let selectedColor = existing?.color || COLOR_PALETTE[this.vault.index.profiles.length % COLOR_PALETTE.length];
    let pendingAvatar = null;
    let pendingAvatarUrl = null;
    let removeAvatar = false;

    const nameInput = element('input', {
      type: 'text',
      required: true,
      maxLength: 40,
      value: existing?.name || '',
      attrs: { placeholder: 'Nazwa profilu', autocomplete: 'off' },
    });
    const emojiInput = element('input', {
      type: 'text',
      maxLength: 8,
      value: existing?.avatar?.kind === 'emoji' ? existing.avatar.emoji : '🙂',
      attrs: { placeholder: '🙂', 'aria-label': 'Emoji profilu' },
    });
    const colorInput = element('input', { type: 'color', value: selectedColor, attrs: { 'aria-label': 'Kolor profilu' } });
    const avatarPreview = element('div', { className: 'settings-avatar-preview' });
    const renderAvatarPreview = () => {
      avatarPreview.replaceChildren();
      if (pendingAvatarUrl) {
        avatarPreview.append(element('img', { src: pendingAvatarUrl, alt: '' }));
      } else if (existing && !removeAvatar) {
        avatarPreview.append(this.createAvatarNode(existing, 'settings-avatar-preview__avatar'));
      } else {
        avatarPreview.append(element('span', { className: 'settings-avatar-preview__emoji', text: emojiInput.value || '🙂' }));
      }
      avatarPreview.style.setProperty('--profile-color', selectedColor);
    };
    emojiInput.addEventListener('input', renderAvatarPreview);

    const avatarInput = element('input', {
      type: 'file',
      accept: 'image/jpeg,image/png,image/webp,image/heic,image/heif',
      className: 'file-picker__input',
      attrs: { 'aria-label': 'Wybierz zdjęcie profilowe' },
    });
    const avatarPicker = element('label', { className: 'button button--secondary file-picker' }, [
      element('span', { text: 'Wybierz zdjęcie' }),
      avatarInput,
    ]);
    const avatarStatus = element('span', { className: 'field__hint', text: 'Zdjęcie zostanie przycięte, pozbawione metadanych i zaszyfrowane.' });
    avatarInput.addEventListener('change', async () => {
      const file = avatarInput.files?.[0];
      if (!file) return;
      avatarStatus.textContent = 'Przetwarzam zdjęcie…';
      try {
        pendingAvatar = await processAvatar(file);
        if (pendingAvatarUrl) URL.revokeObjectURL(pendingAvatarUrl);
        pendingAvatarUrl = URL.createObjectURL(new Blob([pendingAvatar.bytes], { type: pendingAvatar.type }));
        removeAvatar = false;
        avatarStatus.textContent = `${formatFileSize(pendingAvatar.bytes.length)} po przetworzeniu · zostanie zaszyfrowane przed zapisem`;
        renderAvatarPreview();
      } catch (error) {
        avatarInput.value = '';
        avatarStatus.textContent = error.message;
      }
    });

    const removeAvatarButton = button('Użyj emoji zamiast zdjęcia', {
      className: 'text-button',
      on: {
        click: () => {
          pendingAvatar = null;
          if (pendingAvatarUrl) URL.revokeObjectURL(pendingAvatarUrl);
          pendingAvatarUrl = null;
          removeAvatar = true;
          avatarInput.value = '';
          renderAvatarPreview();
        },
      },
    });

    const colorPalette = element('div', { className: 'color-palette' });
    const updateColor = (color) => {
      selectedColor = normalizeHexColor(color, selectedColor);
      colorInput.value = selectedColor;
      colorPalette.querySelectorAll('button').forEach((node) => node.classList.toggle('is-active', node.dataset.color === selectedColor));
      this.applyProfileAccent(selectedColor);
      renderAvatarPreview();
    };
    colorInput.addEventListener('input', () => updateColor(colorInput.value));
    for (const color of COLOR_PALETTE) {
      const colorButton = button('', {
        className: `color-swatch ${selectedColor === color ? 'is-active' : ''}`,
        dataset: { color },
        attrs: { 'aria-label': `Wybierz kolor ${color}` },
        on: { click: () => updateColor(color) },
      });
      colorButton.style.backgroundColor = color;
      colorPalette.append(colorButton);
    }
    colorPalette.append(colorInput);

    const themePicker = element('div', { className: 'theme-segments' });
    for (const theme of THEMES) {
      const themeButton = button(THEME_LABELS[theme], {
        className: `theme-segment theme-segment--${theme} ${selectedTheme === theme ? 'is-active' : ''}`,
        attrs: { 'aria-pressed': String(selectedTheme === theme) },
        on: {
          click: () => {
            selectedTheme = theme;
            themePicker.querySelectorAll('button').forEach((node) => {
              const active = node === themeButton;
              node.classList.toggle('is-active', active);
              node.setAttribute('aria-pressed', String(active));
            });
            this.applyTheme(theme);
          },
        },
      });
      themePicker.append(themeButton);
    }

    const saveButton = button(isNew ? 'Dodaj profil' : 'Zapisz ustawienia', { className: 'button button--primary button--large' });
    const restoreTheme = () => {
      if (!saved) {
        this.applyTheme(originalTheme);
        this.applyProfileAccent(originalAccent || null);
      }
    };
    const cancelButton = button('Anuluj', {
      className: 'button button--ghost',
      on: {
        click: () => {
          restoreTheme();
          dialog.close();
        },
      },
    });

    const form = element('form', { className: 'settings-form' }, [
      element('section', { className: 'settings-profile-block' }, [
        avatarPreview,
        element('div', { className: 'settings-profile-fields' }, [
          field('Nazwa profilu', nameInput, 'Możesz używać emoji.'),
          field('Emoji zastępcze', emojiInput, 'Pojawi się, gdy profil nie ma zdjęcia.'),
        ]),
      ]),
      field('Zdjęcie profilowe', element('div', { className: 'file-field' }, [avatarPicker, removeAvatarButton, avatarStatus])),
      field('Kolor profilu', colorPalette),
      field('Motyw dla tego profilu', themePicker, 'Motyw zostanie zapamiętany na koncie i na tym urządzeniu.'),
    ]);

    const groupModeCopy = this.calendarModeCopy();
    form.append(element('section', { className: 'calendar-mode-summary' }, [
      element('strong', { text: 'Tryb kalendarza' }),
      element('p', { text: groupModeCopy.modeLabel }),
      element('small', { text: 'To ustawienie dotyczy całej grupy i jest wybierane podczas tworzenia sejfu.' }),
    ]));

    form.append(element('section', { className: 'export-settings diagnostics-settings' }, [
      element('div', { className: 'section-heading' }, [
        element('div', {}, [
          element('h3', { text: 'Diagnostyka' }),
          element('p', { text: 'Log jest zapisywany tylko na tym urządzeniu i nie zawiera hasła ani treści zdjęć.' }),
        ]),
      ]),
      element('div', { className: 'export-buttons' }, [
        button('Pobierz log TXT', {
          className: 'button button--secondary',
          on: {
            click: () => {
              diagnosticLog('diagnostics_download');
              downloadBlob(
                new Blob([createDiagnosticsText()], { type: 'text/plain;charset=utf-8' }),
                `kalendarz-logi-${new Date().toISOString().slice(0, 10)}.txt`,
              );
            },
          },
        }),
        button('Wyczyść log', {
          className: 'button button--ghost',
          on: {
            click: () => {
              clearDiagnostics();
              diagnosticLog('diagnostics_cleared');
              showToast('Log diagnostyczny został wyczyszczony.', 'success');
            },
          },
        }),
      ]),
    ]));

    if (!isNew) {
      form.append(element('section', { className: 'export-settings' }, [
        element('div', { className: 'section-heading' }, [
          element('div', {}, [
            element('h3', { text: 'Pobieranie ustawień' }),
            element('p', { text: 'Eksport jest ponownie szyfrowany osobnym hasłem i może zawierać zdjęcia oraz dostępność.' }),
          ]),
        ]),
        element('div', { className: 'export-buttons' }, [
          button('Pobierz cały mój profil', { className: 'button button--secondary', on: { click: () => this.openExportDialog('current') } }),
          button('Pobierz wszystkie profile', { className: 'button button--secondary', on: { click: () => this.openExportDialog('all') } }),
        ]),
      ]));
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = nameInput.value.trim();
      if (!name) {
        showToast('Podaj nazwę profilu.', 'error');
        return;
      }
      setBusy(saveButton, true, isNew ? 'Dodaję…' : 'Szyfruję i zapisuję…');
      try {
        let targetId = profileId;
        if (isNew) {
          const created = await this.vault.addProfile(name);
          targetId = created.id;
        }
        const targetBeforeAvatarChange = this.vault.profile(targetId);
        const emojiAvatar = { kind: 'emoji', emoji: (emojiInput.value || '🙂').slice(0, 8) };
        const profilePatch = {
          name,
          color: selectedColor,
          theme: selectedTheme,
        };
        if (targetBeforeAvatarChange?.avatar?.kind !== 'file') profilePatch.avatar = emojiAvatar;
        await this.vault.updateProfile(targetId, profilePatch);
        if (pendingAvatar) {
          await this.vault.saveAvatar(targetId, pendingAvatar.bytes, pendingAvatar.type);
          this.clearAvatarCache();
        } else if (removeAvatar && targetBeforeAvatarChange?.avatar?.kind === 'file') {
          await this.vault.removeAvatar(targetId, emojiAvatar.emoji);
          this.clearAvatarCache();
        }
        this.currentProfileId = targetId;
        saved = true;
        this.applyTheme(selectedTheme);
        this.applyProfileAccent(this.vault.profile(targetId));
        dialog.close();
        await this.renderCalendar(true);
        showToast(isNew ? 'Profil został dodany.' : 'Ustawienia profilu zostały zapisane.', 'success');
      } catch (error) {
        showToast(error.message || 'Nie udało się zapisać profilu.', 'error');
      } finally {
        setBusy(saveButton, false);
      }
    });

    saveButton.addEventListener('click', () => form.requestSubmit());
    dialog.addEventListener('cancel', restoreTheme, { once: true });
    dialog.addEventListener('close', () => {
      restoreTheme();
      if (pendingAvatarUrl) URL.revokeObjectURL(pendingAvatarUrl);
    }, { once: true });

    dialog.append(element('section', { className: 'sheet-card' }, [
      element('div', { className: 'sheet-handle', attrs: { 'aria-hidden': 'true' } }),
      element('header', { className: 'sheet-header' }, [
        element('div', {}, [
          element('p', { className: 'eyebrow', text: isNew ? 'NOWA OSOBA' : 'PROFIL' }),
          element('h2', { text: isNew ? 'Dodaj profil' : 'Ustawienia profilu' }),
        ]),
        iconButton('close', 'Zamknij', () => {
          restoreTheme();
          dialog.close();
        }),
      ]),
      form,
      element('footer', { className: 'sheet-footer' }, [cancelButton, saveButton]),
    ]));
    renderAvatarPreview();
    dialog.showModal();
  }

  async openExportDialog(scope) {
    const dialog = $('#export-dialog');
    dialog.replaceChildren();
    const password = element('input', {
      type: 'password',
      required: true,
      minLength: 8,
      autocomplete: 'new-password',
      attrs: { placeholder: 'Nowe hasło eksportu' },
    });
    const confirmation = element('input', {
      type: 'password',
      required: true,
      minLength: 8,
      autocomplete: 'new-password',
      attrs: { placeholder: 'Powtórz hasło' },
    });
    const includeAvatars = element('input', { type: 'checkbox', checked: true });
    const includeAvailability = element('input', { type: 'checkbox', checked: false });
    const exportButton = button('Utwórz zaszyfrowany plik', { className: 'button button--primary button--large' });
    exportButton.type = 'submit';
    const form = element('form', { className: 'export-form' }, [
      field('Hasło do pliku', password, 'Nie musi być takie samo jak hasło kalendarza. Minimum 8 znaków.'),
      field('Powtórz hasło', confirmation),
      element('label', { className: 'check-row' }, [includeAvatars, element('span', { text: 'Dołącz zaszyfrowane zdjęcia profilowe' })]),
      element('label', { className: 'check-row' }, [includeAvailability, element('span', { text: 'Dołącz historię dyspozycyjności' })]),
      exportButton,
    ]);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (password.value !== confirmation.value) {
        showToast('Hasła eksportu nie są takie same.', 'error');
        return;
      }
      if (password.value.length < 8) {
        showToast('Hasło eksportu musi mieć co najmniej 8 znaków.', 'error');
        return;
      }
      setBusy(exportButton, true, 'Zbieram i szyfruję…');
      try {
        const ids = scope === 'all'
          ? this.vault.index.profiles.map((profile) => profile.id)
          : [this.currentProfileId];
        const payload = await this.vault.buildProfilesExport(ids, {
          includeAvatars: includeAvatars.checked,
          includeAvailability: includeAvailability.checked,
        });
        const encrypted = await createEncryptedExport(password.value, payload);
        const currentProfile = this.vault.profile(this.currentProfileId);
        const baseName = scope === 'all'
          ? `${sanitizeFilename(this.vault.index.group.name)}-profile`
          : `${sanitizeFilename(currentProfile.name)}-profil`;
        downloadBlob(
          new Blob([JSON.stringify(encrypted, null, 2)], { type: 'application/json;charset=utf-8' }),
          `${baseName}-${new Date().toISOString().slice(0, 10)}.kalendarz.enc.json`,
        );
        dialog.close();
        showToast('Zaszyfrowany eksport został pobrany.', 'success');
      } catch (error) {
        showToast(error.message || 'Nie udało się przygotować eksportu.', 'error');
      } finally {
        password.value = '';
        confirmation.value = '';
        setBusy(exportButton, false);
      }
    });

    dialog.append(element('section', { className: 'modal-card' }, [
      element('header', { className: 'modal-header' }, [
        element('div', {}, [
          element('p', { className: 'eyebrow', text: 'ZASZYFROWANY EKSPORT' }),
          element('h2', { text: scope === 'all' ? 'Pobierz wszystkie profile' : 'Pobierz cały profil' }),
        ]),
        iconButton('close', 'Zamknij', () => dialog.close()),
      ]),
      element('p', { className: 'modal-copy', text: 'Plik zawiera wybrane ustawienia w zaszyfrowanym kontenerze AES-GCM. Hasło nie jest zapisywane.' }),
      form,
    ]));
    dialog.showModal();
    setTimeout(() => password.focus(), 30);
  }

  createAvatarNode(profile, className = '') {
    const avatar = element('span', {
      className: `avatar ${className}`.trim(),
      attrs: { 'aria-hidden': 'true' },
    });
    avatar.style.setProperty('--profile-color', profile.color);
    if (profile.avatar?.kind === 'emoji') {
      avatar.textContent = profile.avatar.emoji || profileInitial(profile);
      return avatar;
    }
    avatar.textContent = profileInitial(profile);
    avatar.classList.add('is-loading');
    this.hydrateAvatar(profile, avatar);
    return avatar;
  }

  async hydrateAvatar(profile, node) {
    const path = profile.avatar?.path;
    if (!path) {
      node.classList.remove('is-loading');
      diagnosticLog('avatar_path_missing', { profileId: profile.id, nodeClass: node.className });
      return;
    }
    try {
      let url = this.avatarUrls.get(path);
      if (!url) {
        let pendingUrl = this.avatarUrlPromises.get(path);
        if (!pendingUrl) {
          const cacheVersion = this.avatarCacheVersion;
          diagnosticLog('avatar_load_start', { profileId: profile.id, path });
          pendingUrl = this.vault.readAvatar(profile).then((avatar) => {
            if (!avatar) {
              diagnosticLog('avatar_file_missing', { profileId: profile.id, path });
              return null;
            }
            if (cacheVersion !== this.avatarCacheVersion) {
              diagnosticLog('avatar_load_stale', { profileId: profile.id, path });
              return null;
            }
            const avatarUrl = URL.createObjectURL(new Blob([avatar.bytes], { type: avatar.contentType }));
            this.avatarUrls.set(path, avatarUrl);
            diagnosticLog('avatar_load_success', {
              profileId: profile.id,
              path,
              contentType: avatar.contentType,
              bytes: avatar.bytes.length,
            });
            return avatarUrl;
          }).finally(() => this.avatarUrlPromises.delete(path));
          this.avatarUrlPromises.set(path, pendingUrl);
        }
        url = await pendingUrl;
        if (!url) {
          node.classList.remove('is-loading');
          return;
        }
      }
      const image = element('img', {
        src: url,
        alt: '',
        on: {
          error: () => diagnosticLog('avatar_render_error', {
            profileId: profile.id,
            path,
            nodeClass: node.className,
          }),
        },
      });
      node.replaceChildren(image);
      node.classList.remove('is-loading');
    } catch (error) {
      node.classList.remove('is-loading');
      diagnosticLog('avatar_load_error', {
        profileId: profile.id,
        path,
        nodeClass: node.className,
        error,
      });
    }
  }

  clearAvatarCache() {
    this.revokeAvatarUrls();
  }

  revokeAvatarUrls() {
    this.avatarCacheVersion += 1;
    this.avatarUrlPromises.clear();
    for (const url of this.avatarUrls.values()) URL.revokeObjectURL(url);
    this.avatarUrls.clear();
  }

  async lock() {
    clearTimeout(this.autoLockTimer);
    this.revokeAvatarUrls();
    document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close());
    this.vault.lock();
    await this.renderLock('Kalendarz został zablokowany.');
  }
}
