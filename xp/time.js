const { DateTime } = require('luxon');

const FB_INSIGHTS_TZ = 'America/Los_Angeles'; // Meta Page Insights day boundary
const IG_INSIGHTS_TZ = 'UTC';

const todayIn = (tz) => DateTime.now().setZone(tz).toISODate();
const isoDate = (d) => (typeof d === 'string' ? d : DateTime.fromJSDate(d).toISODate());

// Start-of-day / end-of-day unix seconds in a timezone
const dayStartUnix = (isoDay, tz) => Math.floor(DateTime.fromISO(isoDay, { zone: tz }).startOf('day').toSeconds());
const dayEndUnix   = (isoDay, tz) => Math.floor(DateTime.fromISO(isoDay, { zone: tz }).endOf('day').toSeconds());

// Meta returns time-series values with end_time = end of the period.
// The day that value belongs to is end_time - 1 day, in the insights timezone.
function dateFromEndTime(endTime, tz) {
  return DateTime.fromISO(endTime).setZone(tz).minus({ days: 1 }).toISODate();
}

// ---------------------------------------------------------------------------
// Insights-day detection
//
// Every period=day value carries an end_time at the boundary of the account's insights day,
// always rendered in +0000: "2026-09-08T07:00:00+0000" is midnight America/Los_Angeles.
// The offset is therefore recoverable from the UTC hour alone.
//
// This exists because IG_INSIGHTS_TZ asserted UTC for every Instagram account and nothing ever
// checked. At least one account closes its day on Pacific time, so the total_value requests —
// which built their windows from UTC midnights — asked for the wrong 24 hours and stored the
// answer under the day they had asked for. Every views/engagements/profile_views value landed
// one day late. Detect the boundary from the data instead of declaring it.
// ---------------------------------------------------------------------------
function offsetHoursFromEndTime(endTime) {
  const h = DateTime.fromISO(endTime).toUTC().hour;
  if (!Number.isFinite(h)) return null;
  // midnight local == (-offset) o'clock UTC. Hours past noon mean a positive offset.
  return h === 0 ? 0 : h <= 12 ? -h : 24 - h;
}

const zoneFromOffsetHours = (o) => (o === null || o === undefined || o === 0 ? 'UTC' : `UTC${o > 0 ? '+' : ''}${o}`);

// The exact unix window of the insights day a bucket describes, taken from Meta's own boundary
// rather than rebuilt from a timezone name. Immune to DST: each day carries its own edge.
//
// Meta sums every insights day whose END instant lies inside [since, until]. So one day is
// (e - 86400, e]: `since` one second after the previous day's end (e - 86400 is also the instant the
// PREVIOUS day closes; asking with since = 2026-09-04T07:00:00Z returned 3 September), and `until`
// exactly at this day's end.
//
// Until 18 Sep `until` was e - 1, which leaves the day's own end outside the window: Meta answered
// every past day with an empty result, the sync kept whatever partial value it had read while the day
// was still running, and Instagram views / interactions / profile views were stored far too low
// (one client, 14 Sep: 51 stored, 3,100 on Meta). Checked 18 Sep against the reach series: with
// (e - 86400, e] total_value reach equals the series value on every day tested.
function dayWindowFromEndTime(endTime) {
  const e = Math.floor(DateTime.fromISO(endTime).toSeconds());
  return { since: e - 86400 + 1, until: e };
}

// The same window for a day with no series bucket yet (typically the day still running), built from
// the detected insights zone: (start, end] of that day. The old [start, end - 1s] held the PREVIOUS
// day's end instead of this one's, so today's row was filled with yesterday's partial totals.
const dayWindowInZone = (isoDay, tz) => ({ since: dayStartUnix(isoDay, tz) + 1, until: dayEndUnix(isoDay, tz) + 1 });

function* eachDay(startIso, endIso) {
  let d = DateTime.fromISO(startIso);
  const end = DateTime.fromISO(endIso);
  while (d <= end) { yield d.toISODate(); d = d.plus({ days: 1 }); }
}

// Split [start,end] into windows of at most n days (IG insights cap since/until at 30 days)
function chunkRange(startIso, endIso, n = 30) {
  const out = [];
  let s = DateTime.fromISO(startIso);
  const end = DateTime.fromISO(endIso);
  while (s <= end) {
    const e = DateTime.min(s.plus({ days: n - 1 }), end);
    out.push([s.toISODate(), e.toISODate()]);
    s = e.plus({ days: 1 });
  }
  return out;
}

const daysAgo = (n, tz) => DateTime.now().setZone(tz).minus({ days: n }).toISODate();
const toLocalDate = (iso, tz) => DateTime.fromISO(iso).setZone(tz).toISODate();

module.exports = { DateTime, FB_INSIGHTS_TZ, IG_INSIGHTS_TZ, todayIn, isoDate, dayStartUnix, dayEndUnix,
  dateFromEndTime, offsetHoursFromEndTime, zoneFromOffsetHours, dayWindowFromEndTime, dayWindowInZone,
  eachDay, chunkRange, daysAgo, toLocalDate };
