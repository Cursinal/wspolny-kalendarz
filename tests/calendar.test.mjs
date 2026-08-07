import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CALENDAR_MODES,
  commonAvailability,
  getDateRange,
  getMonthGrid,
  isProfileAvailable,
  normalizePlan,
  parseMonthKey,
} from '../app/src/calendar.js';

test('siatka miesiąca ma 42 pola i zaczyna się od poniedziałku', () => {
  const grid = getMonthGrid(parseMonthKey('2026-08'));
  assert.equal(grid.length, 42);
  assert.equal(grid[0].date.getDay(), 1);
  assert.equal(grid.filter((item) => item.inCurrentMonth).length, 31);
});

test('zakres dat działa również od końca do początku', () => {
  assert.deepEqual(getDateRange('2026-08-05', '2026-08-02'), [
    '2026-08-02',
    '2026-08-03',
    '2026-08-04',
    '2026-08-05',
  ]);
});

test('wspólna dostępność przecina wiele przedziałów', () => {
  const entries = {
    a: { available: true, intervals: [{ from: '17:00', to: '22:00' }] },
    b: { available: true, intervals: [{ from: '18:30', to: '20:00' }, { from: '21:00', to: '23:00' }] },
    c: { available: true, intervals: [{ from: '18:00', to: '21:30' }] },
  };
  assert.deepEqual(commonAvailability(entries, ['a', 'b', 'c']), [
    { from: 1110, to: 1200 },
    { from: 1260, to: 1290 },
  ]);
});

test('niepoprawne i odwrócone godziny są odrzucane', () => {
  assert.deepEqual(normalizePlan({
    available: true,
    intervals: [
      { from: '22:00', to: '18:00' },
      { from: '18:00', to: '21:00' },
      { from: 'x', to: '20:00' },
    ],
  }).intervals, [{ from: '18:00', to: '21:00' }]);
});


test('tryb niedostępności traktuje pusty dzień jako dostępny cały dzień', () => {
  assert.deepEqual(commonAvailability({}, ['a', 'b'], CALENDAR_MODES.UNAVAILABILITY), [
    { from: 0, to: 1440 },
  ]);
});

test('tryb niedostępności odejmuje blokady wszystkich osób', () => {
  const entries = {
    a: { available: true, intervals: [{ from: '10:00', to: '12:00' }] },
    b: { available: true, intervals: [{ from: '14:00', to: '16:00' }] },
  };
  assert.deepEqual(commonAvailability(entries, ['a', 'b'], CALENDAR_MODES.UNAVAILABILITY), [
    { from: 0, to: 600 },
    { from: 720, to: 840 },
    { from: 960, to: 1440 },
  ]);
});

test('całodniowa blokada jednej osoby usuwa wspólną dostępność', () => {
  const entries = {
    a: { available: true, allDay: true, intervals: [] },
  };
  assert.deepEqual(commonAvailability(entries, ['a', 'b'], CALENDAR_MODES.UNAVAILABILITY), []);
});

test('licznik osób dostępnych uwzględnia tryb kalendarza', () => {
  assert.equal(isProfileAvailable(undefined, CALENDAR_MODES.AVAILABILITY), false);
  assert.equal(isProfileAvailable({ available: true, allDay: true }, CALENDAR_MODES.AVAILABILITY), true);
  assert.equal(isProfileAvailable(undefined, CALENDAR_MODES.UNAVAILABILITY), true);
  assert.equal(isProfileAvailable({ available: true, allDay: true }, CALENDAR_MODES.UNAVAILABILITY), false);
  assert.equal(isProfileAvailable({
    available: true,
    intervals: [{ from: '10:00', to: '12:00' }],
  }, CALENDAR_MODES.UNAVAILABILITY), true);
});
