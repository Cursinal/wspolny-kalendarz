import { minuteLabel, sortIntervals, timeToMinutes } from './utils.js';

const MONTH_NAMES = [
  'styczeń', 'luty', 'marzec', 'kwiecień', 'maj', 'czerwiec',
  'lipiec', 'sierpień', 'wrzesień', 'październik', 'listopad', 'grudzień',
];

const MONTH_NAMES_GENITIVE = [
  'stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca',
  'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia',
];

const WEEKDAY_NAMES = ['niedziela', 'poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota'];

export const CALENDAR_MODES = Object.freeze({
  AVAILABILITY: 'availability',
  UNAVAILABILITY: 'unavailability',
});

export function normalizeCalendarMode(value) {
  return value === CALENDAR_MODES.UNAVAILABILITY
    ? CALENDAR_MODES.UNAVAILABILITY
    : CALENDAR_MODES.AVAILABILITY;
}

export function isPlanMarked(plan) {
  return Boolean(plan && plan.available !== false);
}

export function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function parseDateKey(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

export function monthKeyFromDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function monthKeyFromDateKey(value) {
  return value.slice(0, 7);
}

export function parseMonthKey(value) {
  const [year, month] = value.split('-').map(Number);
  return new Date(year, month - 1, 1, 12, 0, 0, 0);
}

export function addMonths(date, amount) {
  return new Date(date.getFullYear(), date.getMonth() + amount, 1, 12, 0, 0, 0);
}

export function todayKey(timeZone = 'Europe/Warsaw') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

export function todayMonth(timeZone = 'Europe/Warsaw') {
  return parseDateKey(todayKey(timeZone));
}

export function formatMonthTitle(date) {
  const name = MONTH_NAMES[date.getMonth()];
  return `${name[0].toUpperCase()}${name.slice(1)} ${date.getFullYear()}`;
}

export function formatDateLong(value) {
  const date = typeof value === 'string' ? parseDateKey(value) : value;
  return `${WEEKDAY_NAMES[date.getDay()]}, ${date.getDate()} ${MONTH_NAMES_GENITIVE[date.getMonth()]}`;
}

export function formatDateShort(value) {
  const date = typeof value === 'string' ? parseDateKey(value) : value;
  return `${date.getDate()} ${MONTH_NAMES_GENITIVE[date.getMonth()]}`;
}

export function getMonthGrid(monthDate) {
  const first = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1, 12);
  const mondayOffset = (first.getDay() + 6) % 7;
  const gridStart = new Date(first);
  gridStart.setDate(first.getDate() - mondayOffset);
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + index);
    return {
      date,
      key: dateKey(date),
      day: date.getDate(),
      inCurrentMonth: date.getMonth() === monthDate.getMonth(),
    };
  });
}

export function getDateRange(startKey, endKey) {
  const start = parseDateKey(startKey);
  const end = parseDateKey(endKey);
  const low = start <= end ? start : end;
  const high = start <= end ? end : start;
  const result = [];
  const cursor = new Date(low);
  while (cursor <= high) {
    result.push(dateKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return result;
}

export function normalizePlan(plan) {
  if (!isPlanMarked(plan)) {
    return { available: false, allDay: false, intervals: [], note: '' };
  }
  if (plan.allDay) {
    return { available: true, allDay: true, intervals: [], note: String(plan.note || '') };
  }
  return {
    available: true,
    allDay: false,
    intervals: sortIntervals(plan.intervals || []).filter((interval) => {
      const from = timeToMinutes(interval.from);
      const to = timeToMinutes(interval.to);
      return from !== null && to !== null && to > from;
    }),
    note: String(plan.note || ''),
  };
}

function planIntervals(plan) {
  if (!isPlanMarked(plan)) return [];
  if (plan.allDay) return [{ from: 0, to: 1440 }];
  return normalizePlan(plan).intervals.map((interval) => ({
    from: timeToMinutes(interval.from),
    to: timeToMinutes(interval.to),
  }));
}

function intersectTwo(left, right) {
  const result = [];
  for (const a of left) {
    for (const b of right) {
      const from = Math.max(a.from, b.from);
      const to = Math.min(a.to, b.to);
      if (to > from) result.push({ from, to });
    }
  }
  return mergeMinuteIntervals(result);
}

function mergeMinuteIntervals(intervals) {
  const sorted = [...intervals].sort((a, b) => a.from - b.from || a.to - b.to);
  const merged = [];
  for (const interval of sorted) {
    const previous = merged.at(-1);
    if (!previous || interval.from > previous.to) merged.push({ ...interval });
    else previous.to = Math.max(previous.to, interval.to);
  }
  return merged;
}

function complementMinuteIntervals(intervals) {
  const blocked = mergeMinuteIntervals(intervals)
    .map((interval) => ({
      from: Math.max(0, Math.min(1440, interval.from)),
      to: Math.max(0, Math.min(1440, interval.to)),
    }))
    .filter((interval) => interval.to > interval.from);
  const result = [];
  let cursor = 0;
  for (const interval of blocked) {
    if (interval.from > cursor) result.push({ from: cursor, to: interval.from });
    cursor = Math.max(cursor, interval.to);
  }
  if (cursor < 1440) result.push({ from: cursor, to: 1440 });
  return result;
}

function availableIntervalsForPlan(plan, mode) {
  const normalizedMode = normalizeCalendarMode(mode);
  if (normalizedMode === CALENDAR_MODES.UNAVAILABILITY) {
    if (!isPlanMarked(plan)) return [{ from: 0, to: 1440 }];
    return complementMinuteIntervals(planIntervals(plan));
  }
  return planIntervals(plan);
}

export function isProfileAvailable(plan, mode = CALENDAR_MODES.AVAILABILITY) {
  return availableIntervalsForPlan(plan, mode).length > 0;
}

export function commonAvailability(dayEntries, profileIds, mode = CALENDAR_MODES.AVAILABILITY) {
  if (!profileIds.length) return [];
  let common = null;
  for (const profileId of profileIds) {
    const intervals = availableIntervalsForPlan(dayEntries?.[profileId], mode);
    if (!intervals.length) return [];
    common = common === null ? intervals : intersectTwo(common, intervals);
    if (!common.length) return [];
  }
  return common;
}

export function formatMinuteInterval(interval) {
  if (interval.from === 0 && interval.to === 1440) return 'cały dzień';
  return `${minuteLabel(interval.from)}–${minuteLabel(interval.to)}`;
}

export function formatPlan(plan, mode = CALENDAR_MODES.AVAILABILITY) {
  const normalizedMode = normalizeCalendarMode(mode);
  if (!isPlanMarked(plan)) {
    return normalizedMode === CALENDAR_MODES.UNAVAILABILITY
      ? 'może cały dzień'
      : 'brak deklaracji';
  }
  const prefix = normalizedMode === CALENDAR_MODES.UNAVAILABILITY ? 'nie może' : 'może';
  if (plan.allDay) return `${prefix} cały dzień`;
  const intervals = normalizePlan(plan).intervals;
  if (!intervals.length) return normalizedMode === CALENDAR_MODES.UNAVAILABILITY ? 'brak blokad' : 'bez godzin';
  return `${prefix} ${intervals.map((interval) => `${interval.from}–${interval.to}`).join(', ')}`;
}

export function sortDateKeys(values) {
  return [...values].sort((a, b) => a.localeCompare(b));
}
