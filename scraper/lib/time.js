// Everything the scrapers produce is in Seattle local time, written as an ISO
// string with the right offset for that date (PDT -07:00 or PST -08:00).

export const TZ = 'America/Los_Angeles';

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function seattleParts(date) {
  const parts = {};
  for (const p of partsFormatter.formatToParts(date)) parts[p.type] = p.value;
  return {
    y: +parts.year,
    m: +parts.month,
    d: +parts.day,
    hh: +parts.hour,
    mm: +parts.minute,
    ss: +parts.second,
  };
}

// Minutes Seattle is ahead of UTC at this instant (negative: -420 or -480).
function offsetMinutes(date) {
  const p = seattleParts(date);
  const asUTC = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
  return Math.round((asUTC - date.getTime()) / 60000);
}

const pad = (n) => String(n).padStart(2, '0');

function formatOffset(min) {
  const sign = min < 0 ? '-' : '+';
  const abs = Math.abs(min);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

// A wall-clock time in Seattle -> '2026-10-01T19:30:00-07:00'.
// month is 1-12.
export function seattleISO(y, m, d, hh = 0, mm = 0) {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let off = offsetMinutes(new Date(guess));
  let utc = guess - off * 60000;
  const off2 = offsetMinutes(new Date(utc));
  if (off2 !== off) {
    off = off2;
    utc = guess - off * 60000;
  }
  return `${y}-${pad(m)}-${pad(d)}T${pad(hh)}:${pad(mm)}:00${formatOffset(off)}`;
}

// Any instant (Date, epoch ms, or an ISO string with Z or an offset) ->
// the same instant written in Seattle local time.
export function toSeattleISO(input) {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return null;
  const p = seattleParts(date);
  return seattleISO(p.y, p.m, p.d, p.hh, p.mm);
}

// An ISO-ish string with no offset ('2026-10-01T19:30' or '2026-10-01 19:30:00')
// that the source means as Seattle local time.
export function localStringToISO(str) {
  const m = String(str).match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/);
  if (!m) return null;
  return seattleISO(+m[1], +m[2], +m[3], +m[4], +m[5]);
}

// '7:30 PM', '7:30pm', '7pm', '19:30', '7:30 p.m.' -> { hh, mm } (24h), or null.
export function parseClock(str) {
  const s = String(str).toLowerCase().replace(/\./g, '').trim();
  const m = s.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?/);
  if (!m) return null;
  let hh = +m[1];
  const mm = m[2] ? +m[2] : 0;
  const ampm = m[3];
  if (ampm) {
    if (hh === 12) hh = 0;
    if (ampm.startsWith('p')) hh += 12;
  } else if (!m[2]) {
    return null; // a bare number isn't a time
  }
  if (hh > 23 || mm > 59) return null;
  return { hh, mm };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// 'Oct', 'October', 'oct.' -> 10, or null.
export function monthNumber(name) {
  const i = MONTHS.indexOf(String(name).toLowerCase().slice(0, 3));
  return i === -1 ? null : i + 1;
}

// Today's date in Seattle.
export function seattleToday() {
  const p = seattleParts(new Date());
  return { y: p.y, m: p.m, d: p.d };
}

// For listings that print 'Fri, Oct 3' with no year: the year that puts the
// date closest to now (a listing is never more than a few months out).
export function inferYear(m, d) {
  const today = seattleToday();
  const now = Date.UTC(today.y, today.m - 1, today.d);
  let best = today.y;
  let bestDiff = Infinity;
  for (const y of [today.y - 1, today.y, today.y + 1]) {
    const diff = Math.abs(Date.UTC(y, m - 1, d) - now);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = y;
    }
  }
  return best;
}

// 'Friday, October 3, 2026' / 'Fri Oct 3' / 'Oct 3' / '10/3/2026' -> { y, m, d }, or null.
export function parseDate(str) {
  const s = String(str).trim();
  let m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return { y: +m[1], m: +m[2], d: +m[3] };
  m = s.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (m) {
    const month = +m[1];
    const day = +m[2];
    let y = m[3] ? +m[3] : inferYear(month, day);
    if (y < 100) y += 2000;
    return { y, m: month, d: day };
  }
  m = s.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/);
  if (m && monthNumber(m[1])) {
    const month = monthNumber(m[1]);
    const day = +m[2];
    return { y: m[3] ? +m[3] : inferYear(month, day), m: month, d: day };
  }
  return null;
}
