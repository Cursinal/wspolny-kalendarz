const STORAGE_KEY = 'friends-calendar-diagnostics-v1';
const MAX_ENTRIES = 300;

function storage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function readEntries() {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeDetails(details) {
  try {
    return JSON.parse(JSON.stringify(details, (_key, value) => {
      if (value instanceof Error) {
        return {
          name: value.name,
          message: value.message,
          stack: value.stack,
        };
      }
      if (typeof value === 'string' && value.length > 2_000) return `${value.slice(0, 2_000)}…`;
      return value;
    }));
  } catch {
    return { serializationError: true };
  }
}

export function diagnosticLog(event, details = {}) {
  const entry = {
    time: new Date().toISOString(),
    event: String(event),
    details: safeDetails(details),
  };
  const entries = readEntries();
  entries.push(entry);
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
  } catch {
    // Diagnostyka nie może blokować działania aplikacji, np. przy pełnym localStorage.
  }
  globalThis.console?.debug('[kalendarz]', entry.event, entry.details);
}

export function clearDiagnostics() {
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // Brak dostępu do localStorage nie powinien powodować kolejnego błędu.
  }
}

export function createDiagnosticsText() {
  const locationLabel = globalThis.location
    ? `${globalThis.location.protocol}//${globalThis.location.host}${globalThis.location.pathname}`
    : 'brak';
  const userAgent = globalThis.navigator?.userAgent || 'brak';
  const header = [
    'Wspólny termin — log diagnostyczny',
    `Wygenerowano: ${new Date().toISOString()}`,
    `Adres aplikacji: ${locationLabel}`,
    `Przeglądarka: ${userAgent}`,
    '',
  ];
  const lines = readEntries().map((entry) => (
    `${entry.time}  ${entry.event}  ${JSON.stringify(entry.details)}`
  ));
  return `${[...header, ...lines].join('\n')}\n`;
}
