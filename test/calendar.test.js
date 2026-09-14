'use strict';

/**
 * The NFL calendar the clock runs on. Every instant here is checked against
 * the real 2026 schedule: Labor Day September 7, Week 1 Sunday September 13.
 */

const test = require('node:test');
const assert = require('node:assert');
const cal = require('../server/calendar');

test('Labor Day and the Week 1 Sunday', () => {
  assert.deepStrictEqual(cal.laborDay(2026), { y: 2026, m: 9, d: 7 });
  assert.deepStrictEqual(cal.week1Sunday(2026), { y: 2026, m: 9, d: 13 });
  assert.deepStrictEqual(cal.laborDay(2025), { y: 2025, m: 9, d: 1 });
  assert.deepStrictEqual(cal.week1Sunday(2025), { y: 2025, m: 9, d: 7 });
});

test('the week is numbered by its Sunday, and Monday night belongs to the week just played', () => {
  const at = (iso) => cal.nflWeekFor(new Date(iso));
  assert.strictEqual(at('2026-09-12T18:00:00Z'), 1, 'Saturday before Week 1 Sunday');
  assert.strictEqual(at('2026-09-13T20:00:00Z'), 1, 'Week 1 Sunday itself');
  assert.strictEqual(at('2026-09-15T02:00:00Z'), 1, 'Monday Night Football, 10pm ET, is still week 1');
  assert.strictEqual(at('2026-09-15T10:00:00Z'), 2, 'Tuesday morning is week 2');
  assert.strictEqual(at('2026-09-20T17:00:00Z'), 2, 'Week 2 Sunday');
  assert.strictEqual(at('2026-12-27T17:00:00Z'), 16);
  assert.strictEqual(at('2026-07-04T17:00:00Z'), null, 'July is nobody\'s week');
});

test('lock time is Sunday 12:55 Eastern, whichever side of the clock change', () => {
  assert.strictEqual(cal.lockAtFor(1, 2026).toISOString(), '2026-09-13T16:55:00.000Z', 'EDT: UTC-4');
  assert.strictEqual(cal.lockAtFor(10, 2026).toISOString(), '2026-11-15T17:55:00.000Z', 'EST after Nov 1: UTC-5');
  assert.strictEqual(cal.lockAtFor(1, 2026, '13:00').toISOString(), '2026-09-13T17:00:00.000Z');
});

test('a week opens the Tuesday before its Sunday', () => {
  assert.strictEqual(cal.openAtFor(2, 2026).toISOString(), '2026-09-15T10:00:00.000Z', 'Tue Sep 15, 6am EDT');
  assert.strictEqual(cal.openAtFor(1, 2026).toISOString(), '2026-09-08T10:00:00.000Z');
});

test('Eastern wall-clock to UTC survives the DST boundary', () => {
  assert.strictEqual(cal.etToUtc(2026, 3, 8, 12, 0).toISOString(), '2026-03-08T16:00:00.000Z', 'spring forward day, noon EDT');
  assert.strictEqual(cal.etToUtc(2026, 11, 1, 12, 0).toISOString(), '2026-11-01T17:00:00.000Z', 'fall back day, noon EST');
});
