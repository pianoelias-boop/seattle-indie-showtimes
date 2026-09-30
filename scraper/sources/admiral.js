// Historic Admiral Theater, West Seattle (Far Away Entertainment).
//
// farawayentertainment.com is a MobileMovieGoing front end over an RTS box
// office. The page itself is empty; its JS posts JSON to
// api-v3.mobilemoviegoing.cloud, and so do we:
//
//   getShowtimesByDayDisplay.php {eid, pos_route, date: 'YYYYMMDD', mode: 'byDay', location}
//     -> { error, validDates: { YYYYMMDD: bool, … a year out }, films: [film + screenings] }
//
// One call for today gives the list of dates that have shows at this location;
// then one call per date. Each film carries synopsis, runtime (seconds),
// rating, genres, director and a poster, so no per-film page requests are needed.
//
// Quirks:
// - The API answers 403 unless the request has a browser User-Agent (lib/http.js
//   sends one) and Origin: https://www.farawayentertainment.com.
// - screening.startTime is the local wall-clock time written as if it were UTC
//   (the site does DateTime.fromSeconds(t, {zone: 'utc'}) and reads the fields).
// - The exhibitor id (eid) and the location ids are read from the home page
//   each run, with the values seen in Sept 2026 as a fallback.

import { fetchRaw, getText, mapLimit } from '../lib/http.js';
import { seattleISO, seattleToday } from '../lib/time.js';
import { htmlToText, oneLine } from '../lib/text.js';

const SITE = 'https://www.farawayentertainment.com';
const API = 'https://api-v3.mobilemoviegoing.cloud/include/app/';
const THEATER_PAGE = `${SITE}/movie-theatres/seattle/washington/admiral-theater`;
const HORIZON_DAYS = 35; // the feed lists Met Opera dates a year out; keep ~5 weeks

const FALLBACK = {
  eid: 'efbc509c-5e9b-4178-8dc6-a2e635ba8057',
  locationId: '00001-00001-00002', // MMG location id ("sites.siteID")
  siteId: '903045', // RTS site id; screenings carry it as siteID
  posRoute: 1, // 1/5/6 = RTS, 2 = Omniterm, 3 = Veezi
  posWebUrl: '',
};

// Attributes the site leaves off its showtime buttons (master.js excludeAttributeMap).
const HIDDEN_ATTRS = {
  1: new Set([8192, 16384]),
  2: new Set([32, 64, 1024, 4096, 8192]),
  3: new Set([16, 32, 64, 128, 256, 1024, 2048, 8192, 32768, 262144, 4194304, 8388608, 16777216, 67108864]),
};
// Placeholder "we'll play this, schedule to come" showings (master.js noShowsYet).
const PLACEHOLDER_ATTRS = { 3: new Set([4]) };

// ---------------------------------------------------------------- config

async function discoverConfig() {
  const cfg = { ...FALLBACK };
  try {
    const html = await getText(`${SITE}/`);
    const eid = html.match(/\bconst\s+eid\s*=\s*['"]([0-9a-f-]{36})['"]/i);
    if (eid) cfg.eid = eid[1];
    const sitesJson = html.match(/\bconst\s+sites\s*=\s*(\[[\s\S]*?\]);/);
    if (sitesJson) {
      const sites = JSON.parse(sitesJson[1]);
      const admiral =
        sites.find((s) => s?.location_slug === 'admiral-theater') ||
        sites.find((s) => /admiral/i.test(s?.location_name || '') && /seattle/i.test(s?.location_city || ''));
      if (admiral?.location_id && admiral?.location_site_id) {
        cfg.locationId = String(admiral.location_id);
        cfg.siteId = String(admiral.location_site_id);
        if (admiral.pos_route) cfg.posRoute = Number(admiral.pos_route) || cfg.posRoute;
        const webActive = admiral.pos_web_active === true || String(admiral.pos_web_active) === '1';
        cfg.posWebUrl = webActive && admiral.pos_web_url ? String(admiral.pos_web_url).trim() : '';
      }
    }
  } catch (err) {
    console.warn(`admiral: home page config lookup failed, using stored ids (${err.message})`);
  }
  return cfg;
}

async function post(endpoint, body) {
  const res = await fetchRaw(API + endpoint, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      Origin: SITE,
      Accept: 'application/json, */*;q=0.5',
      'Content-Type': 'text/plain;charset=UTF-8',
    },
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`admiral: non-JSON reply from ${endpoint}: ${text.slice(0, 120)}`);
  }
}

const dayData = (cfg, date) =>
  post('getShowtimesByDayDisplay.php', {
    eid: cfg.eid,
    pos_route: cfg.posRoute,
    date,
    mode: 'byDay',
    location: cfg.locationId,
  });

// ---------------------------------------------------------------- dates

const pad = (n) => String(n).padStart(2, '0');
const ymdKey = (y, m, d) => `${y}${pad(m)}${pad(d)}`;

function addDaysKey({ y, m, d }, days) {
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return ymdKey(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

// startTime is Seattle wall-clock time encoded as a UTC epoch.
function startISO(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return null;
  const t = new Date(n * 1000);
  return seattleISO(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), t.getUTCHours(), t.getUTCMinutes());
}

// ---------------------------------------------------------------- titles

const SMALL_WORDS = new Set(
  'a an and as at but by en for from if in into nor of off on or per the to up via vs with'.split(' '),
);

function titleCase(str) {
  let first = true;
  return str
    .toLowerCase()
    .split(/(\s+)/)
    .map((word) => {
      if (/^\s+$/.test(word) || !word) return word;
      const upper = word.toUpperCase();
      const bare = upper.replace(/[^A-Z0-9]/g, '');
      let out;
      const core = word.replace(/^[^a-z0-9]+|[^a-z0-9.]+$/g, '');
      if (bare.length > 1 && /^X{0,3}(IX|IV|V?I{0,3})$/.test(bare)) out = upper; // II, IV, XII
      else if (/^([a-z]\.){2,}[a-z]?$/.test(core)) out = upper; // U.N.C.L.E.
      else if (/\d/.test(core) && /[a-z]/.test(core) && !/^\d+(st|nd|rd|th|s)$/.test(core)) out = upper; // M3GAN, 3D
      else if (!first && SMALL_WORDS.has(word.replace(/[^a-z]/g, '')) && !/[:.!?]$/.test(word)) out = word;
      else
        out = word
          .replace(/(^|[-/("‘“])([a-z])/g, (_, p, c) => p + c.toUpperCase())
          .replace(/^([OD])(['’])([a-z])/, (_, a, q, c) => a + q + c.toUpperCase()); // O'Brien
      // Words after a colon or dash start fresh.
      first = /[:–—-]$/.test(word);
      return out;
    })
    .join('');
}

// Add-ons that describe the showing, not the film.
const ADDON =
  /^(?:3-?D|2-?D|4K|35\s?mm|70\s?mm|16\s?mm|IMAX(?:\s3D)?|Dolby(?:\s(?:Cinema|Atmos|Vision))?|RPX|D-?BOX|HFR|Open[\s-]?Cap(?:tion(?:ed|s)?)?|OC|CC|Closed[\s-]?Cap(?:tion(?:ed|s)?)?|Captioned|Subtitled|Dubbed|(?:with\s)?Q\s?&\s?A.*|Q\s?and\s?A.*|Encore(?:\s(?:Presentation|Screening))?|Re-?release|(?:\d+(?:st|nd|rd|th)\s)?Anniversary(?:\s(?:Edition|Re-?release|Screening))?|Sensory[\s-]Friendly(?:\sScreening)?|(?:Special\s)?(?:Advance|Early(?:\sAccess)?)\sScreening|Early\sAccess|Fan\sEvent|Double\sFeature|Sing-?along|Quote-?along)$/i;

const TRAILING_WORD_ADDON =
  /\s+(3D|2D|IMAX|Open[\s-]Caption(?:ed)?|Encore|Sing-?along|Q\s?&\s?A)$/i;

function cleanTitle(raw) {
  let t = oneLine(raw || '');
  const notes = [];
  let year;
  if (t && /[A-Z]/.test(t) && !/[a-z]/.test(t)) t = titleCase(t);

  // "It's a Wonderful Life (1946) West Seattle Food Bank Drive"
  const y = t.match(/^(.+?)\s*\((\d{4})\)\s*(.*)$/);
  if (y && +y[2] > 1880 && +y[2] < 2100) {
    t = y[1].trim();
    year = +y[2];
    const rest = y[3].replace(/^[\s:|–—-]+/, '').trim();
    if (rest) notes.push(rest);
  }

  let prev;
  do {
    prev = t;
    let m = t.match(/^(.+?)\s*[([]([^()[\]]+)[)\]]\s*$/); // "Title (3D)"
    if (m && ADDON.test(m[2].trim())) {
      notes.unshift(m[2].trim());
      t = m[1].trim();
      continue;
    }
    m = t.match(/^(.+?)\s+[-–—:|]\s*([^-–—:|]+)$/); // "Title - Encore", "Title: Open Caption"
    if (m && ADDON.test(m[2].trim())) {
      notes.unshift(m[2].trim());
      t = m[1].trim();
      continue;
    }
    m = t.match(TRAILING_WORD_ADDON); // "Carmen Encore"
    if (m && t.length > m[0].length + 1) {
      notes.unshift(m[1]);
      t = t.slice(0, -m[0].length).trim();
      continue;
    }
    m = t.match(/^[([]?(3D|2D|IMAX|OC|Open Caption(?:ed)?)[)\]]?\s*[-–:]?\s+(.+)$/i); // "3D Title"
    if (m) {
      notes.unshift(m[1]);
      t = m[2].trim();
    }
  } while (t !== prev && t);

  return { title: t.replace(/[\s:|–—-]+$/, '').trim(), notes, year };
}

// ---------------------------------------------------------------- film details

function jsonList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const v = JSON.parse(value);
    return Array.isArray(v) ? v : [];
  } catch {
    return value.split(',');
  }
}

const strings = (value) =>
  jsonList(value)
    .map((s) => (typeof s === 'string' ? oneLine(s) : ''))
    .filter(Boolean);

function normalizeRating(r) {
  const s = oneLine(r || '').toUpperCase().replace(/\s+/g, '');
  if (!s || s === 'NULL' || s === 'NONE') return undefined;
  if (/^PG-?13$/.test(s)) return 'PG-13';
  if (/^NC-?17$/.test(s)) return 'NC-17';
  if (/^(NR|UR|NOTRATED|UNRATED)$/.test(s)) return 'NR';
  if (/^(G|PG|R)$/.test(s)) return s;
  return oneLine(r);
}

const isHttp = (u) => typeof u === 'string' && /^https?:\/\//.test(u.trim());

function filmDetails(film, cleaned, todayUTC) {
  const f = {};
  try {
    const desc = htmlToText(film.Synopsis || '');
    if (desc) f.description = desc;

    const secs = parseInt(film.Runtime, 10);
    const runtime = Math.round(secs / 60);
    if (Number.isInteger(runtime) && runtime > 0 && runtime < 1000) f.runtime = runtime;

    // ReleaseDate is the booking date for repertory and custom titles
    // (Rocky Horror says 2026), so trust it only for current TMDB-backed films.
    if (cleaned.year) f.year = cleaned.year;
    else {
      const rel = String(film.ReleaseDate || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
      const tmdbBacked = /^\d+$/.test(String(film.tCode || ''));
      const reissue = cleaned.notes.some((n) => /encore|anniversary|re-?release/i.test(n));
      if (rel && tmdbBacked && !reissue) {
        const days = (Date.UTC(+rel[1], +rel[2] - 1, +rel[3]) - todayUTC) / 86400000;
        if (days > -180 && days < 400) f.year = +rel[1];
      }
    }

    const directors = strings(film.Director);
    if (directors.length) f.director = directors.join(', ');

    const rating = normalizeRating(film.Rating);
    if (rating) f.rating = rating;

    const genres = strings(film.Genre);
    if (genres.length) f.genres = genres;

    const image = [film.OneSheet, film.OneSheetLarge, film.backdropImage].find(isHttp);
    if (image) f.image = image.trim();
  } catch (err) {
    console.warn(`admiral: film details for "${film?.dispName}" failed (${err.message})`);
  }
  return Object.keys(f).length ? f : undefined;
}

function filmNotes(film) {
  const notes = [];
  if (film.special_advance_screening) notes.push('Special advance screening');
  for (const key of ['showtimelabel', 'presented_by', 'sponsored_by']) {
    const v = typeof film[key] === 'string' ? oneLine(film[key]) : '';
    if (!v || /^null$/i.test(v)) continue;
    if (key === 'presented_by' && !/^presented/i.test(v)) notes.push(`Presented by ${v}`);
    else if (key === 'sponsored_by' && !/^sponsored/i.test(v)) notes.push(`Sponsored by ${v}`);
    else notes.push(v);
  }
  return notes;
}

// ---------------------------------------------------------------- screenings

const hasAttr = (s, map) =>
  (s.attributes || []).some((a) => a && map[a.infoClass]?.has(Number(a.infoId)));

function screeningNotes(s) {
  const notes = [];
  for (const a of s.attributes || []) {
    if (!a?.title || HIDDEN_ATTRS[a.infoClass]?.has(Number(a.infoId))) continue;
    notes.push(oneLine(a.title));
  }
  if (s.aud_info?.plfName) notes.push(oneLine(s.aud_info.plfName));
  if (Number(s.isSoldOut) === 1) notes.push('Sold out');
  return notes;
}

function ticketUrl(cfg, s, film) {
  if (Number(s.isSoldOut) === 1 || s.embargoActive === true || Number(s.sell) === 0) return undefined;
  if (cfg.posWebUrl) return cfg.posWebUrl + encodeURIComponent(String(s.id));
  return `${SITE}/Tickets/${cfg.locationId}/${s.id}/${film.id}`;
}

// ---------------------------------------------------------------- scrape

async function scrape() {
  const cfg = await discoverConfig();
  const today = seattleToday();
  const todayKey = ymdKey(today.y, today.m, today.d);
  const lastKey = addDaysKey(today, HORIZON_DAYS);
  const todayUTC = Date.UTC(today.y, today.m - 1, today.d);

  const first = await dayData(cfg, todayKey);
  if (!first || typeof first !== 'object') throw new Error('admiral: unrecognized showtimes reply');
  if (first.error === true || first.error === 'true') {
    throw new Error(`admiral: API error "${first.error_message || 'unknown'}"`);
  }
  if (!first.validDates || typeof first.validDates !== 'object') {
    throw new Error('admiral: showtimes reply has no validDates; API format changed?');
  }

  const dates = Object.keys(first.validDates)
    .filter((k) => first.validDates[k] === true && /^\d{8}$/.test(k) && k >= todayKey && k <= lastKey)
    .sort();
  if (!dates.length) return [];

  const failures = [];
  const replies = await mapLimit(dates, 3, async (date) => {
    if (date === todayKey && first.current_date === todayKey) return first;
    try {
      const r = await dayData(cfg, date);
      if (r?.error === true || r?.error === 'true') throw new Error(r.error_message || 'API error');
      return r;
    } catch (err) {
      failures.push(`${date}: ${err.message}`);
      return null;
    }
  });
  if (failures.length) console.warn(`admiral: ${failures.length} day(s) failed: ${failures.join('; ')}`);
  if (failures.length === dates.length) throw new Error(`admiral: every showtimes request failed (${failures[0]})`);

  const films = new Map(); // film id -> { title, notes, film, url }
  const seen = new Set();
  const out = [];

  for (const reply of replies) {
    if (!reply) continue;
    if (reply.films != null && !Array.isArray(reply.films)) {
      console.warn(`admiral: unexpected films field for ${reply.current_date}`);
      continue;
    }
    for (const film of reply.films || []) {
      try {
        if (!film || !Array.isArray(film.screenings) || !film.screenings.length) continue;

        let info = films.get(film.id);
        if (!info) {
          const cleaned = cleanTitle(film.dispName || film.shortCode || '');
          info = {
            title: cleaned.title,
            notes: [...cleaned.notes, ...filmNotes(film)],
            film: filmDetails(film, cleaned, todayUTC),
            url: film.slug ? `${THEATER_PAGE}/movies/${encodeURIComponent(film.slug)}` : THEATER_PAGE,
          };
          films.set(film.id, info);
        }
        if (!info.title) continue;

        for (const s of film.screenings) {
          try {
            if (!s || s.id == null || seen.has(s.id)) continue;
            if (String(s.siteID) !== cfg.siteId) continue; // another Far Away theater
            if (hasAttr(s, PLACEHOLDER_ATTRS)) continue;
            const embargo = s.embargoActive ?? film.embargoActive;
            const hide = s.hide_embargo ?? film.hide_embargo;
            if (embargo && hide) continue; // the site hides these showings too

            const start = startISO(s.startTime ?? s.startTimeUtc);
            if (!start) continue;
            const dayKey = start.slice(0, 10).replace(/-/g, '');
            if (dayKey < todayKey || dayKey > lastKey) continue;
            seen.add(s.id);

            const notes = [...new Set([...info.notes, ...screeningNotes(s)])];
            const screening = { theater: 'admiral', title: info.title, start, url: info.url };
            const tickets = ticketUrl(cfg, s, film);
            if (tickets) screening.tickets = tickets;
            if (notes.length) screening.notes = notes;
            if (info.film) screening.film = info.film;
            out.push(screening);
          } catch (err) {
            console.warn(`admiral: skipped a showing of "${info.title}" (${err.message})`);
          }
        }
      } catch (err) {
        console.warn(`admiral: skipped film "${film?.dispName}" (${err.message})`);
      }
    }
  }

  out.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
  return out;
}

export default {
  id: 'admiral',
  scrape,
};
