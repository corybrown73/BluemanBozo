'use strict';

/**
 * The NFL calendar, in Eastern time, so the app knows what week it is without
 * anyone telling it.
 *
 * Week 1 kicks off the Thursday after Labor Day; its Sunday is Labor Day + 6.
 * A "week" here runs Tuesday through Monday night — Monday Night Football
 * belongs to the week that just played, not the one about to open — and is
 * numbered by its Sunday. Everything is computed in America/New_York and
 * handed back as UTC instants, because a lock time of "Sunday 12:55" means
 * the same kickoff whether the phone reading it is in Boston or Denver.
 */

const TZ = 'America/New_York';
const DAY = 86400000;

/** Year, month, day, weekday, hour, minute of an instant, as an Eastern clock reads it. */
function etParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short', hour: 'numeric', minute: 'numeric',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[get('weekday')];
  return { y: +get('year'), m: +get('month'), d: +get('day'), weekday: wd, hh: +get('hour'), mm: +get('minute') };
}

/**
 * An Eastern wall-clock time as a UTC instant. Two passes: guess with the
 * offset of the moment, then correct by however far the guess's Eastern
 * reading landed from what was asked — which is how DST takes care of itself.
 */
function etToUtc(y, m, d, hh = 0, mm = 0) {
  let guess = Date.UTC(y, m - 1, d, hh, mm);
  for (let i = 0; i < 2; i += 1) {
    const p = etParts(new Date(guess));
    const readBack = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
    const want = Date.UTC(y, m - 1, d, hh, mm);
    guess += want - readBack;
  }
  return new Date(guess);
}

/** Labor Day: the first Monday of September. */
function laborDay(year) {
  const first = new Date(Date.UTC(year, 8, 1));
  const shift = (8 - first.getUTCDay()) % 7; // days until Monday
  return { y: year, m: 9, d: 1 + shift };
}

/** The Sunday of NFL week 1 — Labor Day plus six days — as a calendar date. */
function week1Sunday(seasonYear) {
  const ld = laborDay(seasonYear);
  const s = new Date(Date.UTC(ld.y, ld.m - 1, ld.d + 6));
  return { y: s.getUTCFullYear(), m: s.getUTCMonth() + 1, d: s.getUTCDate() };
}

/** The Sunday of week N as a calendar date. */
function sundayOfWeek(weekNumber, seasonYear) {
  const w1 = week1Sunday(seasonYear);
  const s = new Date(Date.UTC(w1.y, w1.m - 1, w1.d + 7 * (weekNumber - 1)));
  return { y: s.getUTCFullYear(), m: s.getUTCMonth() + 1, d: s.getUTCDate() };
}

/** The season a date belongs to: July onward is the coming season. */
function seasonYearOf(date) {
  const p = etParts(date);
  return p.m <= 6 ? p.y - 1 : p.y;
}

/**
 * The Sunday of the Tuesday-to-Monday window an instant falls in, as a
 * calendar date. Monday belongs to the Sunday just gone.
 */
function sundayOf(date) {
  const p = etParts(date);
  const ahead = p.weekday === 1 ? -1 : (7 - p.weekday) % 7; // Mon → yesterday, Sun → today, else next Sunday
  const s = new Date(Date.UTC(p.y, p.m - 1, p.d + ahead));
  return { y: s.getUTCFullYear(), m: s.getUTCMonth() + 1, d: s.getUTCDate() };
}

/** Which NFL week an instant is in: 1–22, or null outside the season. */
function nflWeekFor(date) {
  const season = seasonYearOf(date);
  const w1 = week1Sunday(season);
  const sun = sundayOf(date);
  const diff = Math.round((Date.UTC(sun.y, sun.m - 1, sun.d) - Date.UTC(w1.y, w1.m - 1, w1.d)) / (7 * DAY));
  const week = diff + 1;
  return week >= 1 && week <= 22 ? week : null;
}

/** When week N's picks lock: its Sunday at the given Eastern time (default 12:55). */
function lockAtFor(weekNumber, seasonYear, time = '12:55') {
  const [hh, mm] = String(time || '12:55').split(':').map((n) => parseInt(n, 10));
  const s = sundayOfWeek(weekNumber, seasonYear);
  return etToUtc(s.y, s.m, s.d, Number.isFinite(hh) ? hh : 12, Number.isFinite(mm) ? mm : 55);
}

/** When week N should open for picks: the Tuesday before its Sunday, at the given Eastern hour. */
function openAtFor(weekNumber, seasonYear, hour = 6) {
  const s = sundayOfWeek(weekNumber, seasonYear);
  const tue = new Date(Date.UTC(s.y, s.m - 1, s.d - 5));
  return etToUtc(tue.getUTCFullYear(), tue.getUTCMonth() + 1, tue.getUTCDate(), hour, 0);
}

/** "Sun, Sep 13, 12:55 PM ET" */
function fmtEt(date) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(date) + ' ET';
}

module.exports = {
  TZ, etParts, etToUtc, laborDay, week1Sunday, sundayOfWeek, seasonYearOf, sundayOf, nflWeekFor,
  lockAtFor, openAtFor, fmtEt,
};
