// Majestic Bay Theatres (Ballard).
//
// majesticbay.com is a Gatsby site on the Webedia / BoxOffice "website
// manager" platform, with Veezi as the ticketing system behind it. The site's
// own serverless functions return JSON, so no HTML scraping is needed:
//   GET /api/gatsby-source-boxofficeapi/schedule
//       ?theaters={"id":"X05TV","timeZone":"America/Los_Angeles"}&from=…&to=…
//     -> { X05TV: { schedule: { <movieId>: { <date>: [showtime, …] } } } }
//        Each showtime has startsAt (local, no offset), tags (e.g.
//        Showtime.Event.SpecialEvent for the special screenings page) and a
//        Veezi purchase link.
//   GET /api/gatsby-source-boxofficeapi/movies?ids=…&ids=…
//     -> title, synopsis, runtime (seconds), director, cast, certificate,
//        release date, poster and stills for each movie.
// The special screenings page (/special-screenings/) is the same schedule
// filtered on the SpecialEvent tag, so one schedule request covers both.
// Movie page paths and the site's own categories ("Retro Night") come from
// Gatsby's static-query JSON; if that fails we build the path ourselves.

import { getJSON, getText, mapLimit } from '../lib/http.js';
import { localStringToISO, toSeattleISO, seattleToday } from '../lib/time.js';
import { htmlToText, cleanText, oneLine } from '../lib/text.js';

const BASE = 'https://www.majesticbay.com';
const API = `${BASE}/api/gatsby-source-boxofficeapi`;
const DEFAULT_THEATER = 'X05TV'; // <meta name="bocms:theater:id">
const TZ = 'America/Los_Angeles';
const DAYS_AHEAD = 35;

// ---------------------------------------------------------------- dates

const pad = (n) => String(n).padStart(2, '0');

function addDays({ y, m, d }, days) {
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

function startISO(startsAt) {
  const s = String(startsAt || '');
  if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(s)) return toSeattleISO(s);
  return localStringToISO(s);
}

// ---------------------------------------------------------------- requests

async function fetchSchedule(theaterId, from, to) {
  const qs = new URLSearchParams({
    theaters: JSON.stringify({ id: theaterId, timeZone: TZ }),
    from: `${from}T00:00:00`,
    to: `${to}T23:59:59`,
  });
  const data = await getJSON(`${API}/schedule?${qs}`);
  const entry = data?.[theaterId];
  if (!entry || typeof entry !== 'object' || !entry.schedule || typeof entry.schedule !== 'object') {
    throw new Error(`Majestic Bay: schedule response has no "${theaterId}.schedule"`);
  }
  return entry.schedule;
}

async function discoverTheaterId() {
  const html = await getText(`${BASE}/`);
  const id = html.match(/name="bocms:theater:id"\s+content="([^"]+)"/)?.[1];
  if (!id) throw new Error('Majestic Bay: theater id meta tag not found');
  return id;
}

const moviesUrl = (ids) => `${API}/movies?${ids.map((id) => `ids=${encodeURIComponent(id)}`).join('&')}`;

async function fetchMovies(ids) {
  const byId = new Map();
  const chunks = [];
  for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));
  for (const chunk of chunks) {
    try {
      const list = await getJSON(moviesUrl(chunk));
      if (!Array.isArray(list)) throw new Error('movies response is not a list');
      for (const m of list) if (m?.id != null) byId.set(String(m.id), m);
    } catch (err) {
      console.warn(`majestic-bay: movies batch failed (${err.message}); fetching one by one`);
      await mapLimit(chunk, 3, async (id) => {
        try {
          const list = await getJSON(moviesUrl([id]));
          const m = Array.isArray(list) ? list[0] : null;
          if (m?.id != null) byId.set(String(m.id), m);
        } catch (e) {
          console.warn(`majestic-bay: movie ${id} failed: ${e.message}`);
        }
      });
    }
  }
  return byId;
}

// Gatsby static queries: movie paths, the site's movie categories, and a
// fallback title list. Best effort only.
async function fetchStaticData() {
  const out = { paths: new Map(), titles: new Map(), categoriesByMovie: new Map() };
  try {
    const page = await getJSON(`${BASE}/page-data/special-screenings/page-data.json`);
    const hashes = Array.isArray(page?.staticQueryHashes) ? page.staticQueryHashes : [];
    const results = await mapLimit(hashes, 3, (h) =>
      getJSON(`${BASE}/page-data/sq/d/${encodeURIComponent(h)}.json`).catch(() => null),
    );
    const categoryLabels = new Map();
    const movieCategoryIds = new Map();
    for (const r of results) {
      const d = r?.data;
      if (!d) continue;
      for (const m of d.allMovie?.nodes || []) {
        if (m?.id == null) continue;
        const id = String(m.id);
        if (m.path) out.paths.set(id, m.path);
        if (m.title) out.titles.set(id, m.title);
        const cats = (m.editorialization?.categories || []).map((c) => c?.category?.id).filter(Boolean);
        movieCategoryIds.set(id, cats);
      }
      for (const c of d.allMovieCategory?.nodes || []) {
        if (!c?.id || !c.label) continue;
        categoryLabels.set(c.id, oneLine(c.label));
        for (const mid of c.movies || []) {
          const id = String(mid);
          if (!out.categoriesByMovie.has(id)) out.categoriesByMovie.set(id, new Set());
          out.categoriesByMovie.get(id).add(oneLine(c.label));
        }
      }
    }
    for (const [id, cats] of movieCategoryIds) {
      for (const cid of cats) {
        const label = categoryLabels.get(cid);
        if (!label) continue; // NEW, PREVIEW and other built-in buckets
        if (!out.categoriesByMovie.has(id)) out.categoriesByMovie.set(id, new Set());
        out.categoriesByMovie.get(id).add(label);
      }
    }
  } catch (err) {
    console.warn(`majestic-bay: static data unavailable (${err.message}); building movie paths locally`);
  }
  return out;
}

// ---------------------------------------------------------------- titles

const SMALL_WORDS = new Set(
  'a an and as at but by for from in into nor of on or over per the to up via vs vs. with yet'.split(' '),
);
const ROMAN = /^(?=[ivx])(x{0,3})(ix|iv|v?i{0,3})$/i;

function capitalize(word) {
  return word.replace(/(^|[-‐/])([^\p{L}\p{N}]*)(\p{L})/gu, (_, sep, punct, ch) => sep + punct + ch.toUpperCase());
}

function titleCase(str) {
  const tokens = str.toLowerCase().split(/(\s+)/);
  const words = tokens.filter((t) => t && !/^\s+$/.test(t));
  let wi = 0;
  let prevEndsClause = true;
  return tokens
    .map((tok) => {
      if (!tok || /^\s+$/.test(tok)) return tok;
      const isFirst = wi === 0 || prevEndsClause;
      const isLast = wi === words.length - 1;
      wi++;
      prevEndsClause = /[:.!?–—]$/.test(tok);
      const bare = tok.replace(/[^\p{L}\p{N}.]/gu, '');
      if (bare === 'i' || (ROMAN.test(bare) && bare.length > 0)) return tok.toUpperCase();
      if (!isFirst && !isLast && SMALL_WORDS.has(bare)) return tok;
      return capitalize(tok);
    })
    .join('');
}

function isAllCaps(str) {
  const letters = str.replace(/[^A-Za-z]/g, '');
  if (letters.length < 2 || /[a-z]/.test(str)) return false;
  if (!/\s/.test(str.trim()) && letters.length <= 3) return false; // "RRR", "JFK"
  return true;
}

function tidyNote(s) {
  let n = oneLine(s || '').replace(/^[\s,;:&+|–—-]+|[\s,;:|–—!-]+$/g, '').replace(/^\(|\)$/g, '').trim();
  if (!n) return null;
  if (isAllCaps(n)) n = n.charAt(0) + n.slice(1).toLowerCase();
  if (/^open[- ]?cap/i.test(n)) return 'Open captions';
  if (/^closed[- ]?cap/i.test(n)) return 'Closed captions';
  const mm = n.match(/^(?:in\s+|on\s+)?((?:16|35|70)\s?mm)$/i);
  if (mm) return mm[1].replace(/\s/g, '').toLowerCase();
  return n;
}

const TRAILING_ADDONS = [
  /\s*[-–—:|,]?\s*\(?\b(?:in|on)\s+((?:16|35|70)\s?mm)\)?$/i,
  /\s*[-–—:|,]\s*((?:16|35|70)\s?mm)$/i,
  /\s*\(((?:16|35|70)\s?mm)\)$/i,
  /\s*[-–—:|,]?\s*\(?\s*(open[- ]?cap(?:tion(?:ed|s)?)?)\s*\)?$/i,
  /\s*[-–—:|,]?\s*\(?\s*(closed[- ]?cap(?:tion(?:ed|s)?)?)\s*\)?$/i,
  /\s*[-–—:|,]?\s*\(?\s*((?:\+|w\/|with)\s*(?:a\s+)?(?:live\s+)?(?:q\s?&\s?a|q\s+and\s+a|discussion|panel|conversation|intro(?:duction)?|filmmakers?|directors?)\b[^()]*)\)?$/i,
  /\s*[-–—:|,]?\s*\(?\s*(sensory[- ]friendly(?:\s+screening)?)\s*\)?$/i,
  /\s*[-–—:|,]?\s*\(?\s*((?:\d+(?:st|nd|rd|th)\s+anniversary(?:\s+(?:screening|edition|re-?release))?))\s*\)?$/i,
  /\s*[-–—:|,]?\s*\(?\s*((?:new\s+)?4k\s+restoration|restored)\s*\)?$/i,
  /\s*[-–—:|]\s*((?:family|kids?|retro|classic|throwback|cult)\s+(?:movie\s+)?(?:morning|night|matinee|screening)s?)$/i,
];

const SERIES_PREFIX = /^((?:[^:]*\b(?:presents?|series|showcase|spotlight|festival|night|nights|club|retrospective|celebration|tribute|matinee|morning|classics?|throwback)\b)[^:]*):\s+(.+)$/i;

const stripYear = (t) => oneLine(t || '').replace(/\s*\((?:18|19|20)\d{2}\)\s*$/, '').trim();
const yearIn = (t) => {
  const m = oneLine(t || '').match(/\((18[89]\d|19\d\d|20\d\d)\)\s*$/);
  return m ? +m[1] : undefined;
};
const norm = (s) => s.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ');

// The site can override a film's title for an event, e.g. "Our 25th
// Anniversary Celebration: Singin' in the Rain & Documentary Screening!".
// When the underlying film title sits inside it, use that and keep the rest
// as notes.
function parseTitle(movie) {
  const display = oneLine(movie.title || movie.exhibitor?.title || movie.locale?.title || movie.originalTitle || '');
  const notes = [];
  let title = display;
  let year = yearIn(display);

  const candidates = [movie.locale?.title, movie.originalTitle]
    .map((c) => ({ raw: oneLine(c || ''), bare: stripYear(c) }))
    .filter((c) => c.bare.length >= 2);
  for (const c of candidates) {
    const i = norm(display).indexOf(norm(c.bare));
    if (i === -1 || norm(display) === norm(c.bare) || norm(stripYear(display)) === norm(c.bare)) continue;
    const before = display.slice(0, i);
    const after = display.slice(i + c.bare.length).replace(/^\s*\((?:18|19|20)\d{2}\)/, '');
    notes.push(tidyNote(before));
    for (const part of after.split(/\s+(?:&|\+|and)\s+/i)) notes.push(tidyNote(part.replace(/^\s*(?:w\/|with)\s+/i, '')));
    title = display.slice(i, i + c.bare.length);
    year = year ?? yearIn(c.raw);
    break;
  }

  for (let guard = 0; guard < 6; guard++) {
    const before = title;
    const y = yearIn(title);
    if (y) {
      year = year ?? y;
      title = stripYear(title);
    }
    for (const re of TRAILING_ADDONS) {
      const m = title.match(re);
      if (m && m.index > 0) {
        notes.push(tidyNote(m[1]));
        title = title.slice(0, m.index).trim();
      }
    }
    const sm = title.match(SERIES_PREFIX);
    if (sm && sm[2].trim().length >= 2) {
      notes.push(tidyNote(sm[1]));
      title = sm[2].trim();
    }
    if (title === before) break;
  }

  title = title.replace(/[\s,;:–—-]+$/, '').trim() || display;
  title = isAllCaps(title) ? titleCase(title) : fixStartCase(title);
  return { title, year, notes: notes.filter(Boolean) };
}

// BoxOffice often capitalizes every word ("Heart Of The Beast"); other
// listings (and the theater's own Veezi pages) say "Heart of the Beast".
const MINOR_WORDS = new Set('a an and the of in on at to for or nor but vs vs.'.split(' '));
function fixStartCase(title) {
  const words = title.split(/\s+/);
  const lettered = words.filter((w) => /\p{L}/u.test(w));
  if (lettered.length < 3 || !lettered.every((w) => /^[^\p{L}]*\p{Lu}/u.test(w))) return title;
  return words
    .map((w, i) => {
      if (i === 0 || i === words.length - 1 || /[:–—-]$/.test(words[i - 1])) return w;
      return MINOR_WORDS.has(w.toLowerCase()) && /^\p{Lu}\p{Ll}*\.?$/u.test(w) ? w.toLowerCase() : w;
    })
    .join(' ');
}

// ---------------------------------------------------------------- films

const NOT_A_FILM = /\bgift\s*cards?\b|\bprivate\s+(?:event|rental|party|screening)\b|\brentals?\b|\bclosed\s+for\b|\bworkshop\b|\bmembership\b|\bmerch(?:andise)?\b/i;

const TICKET_SENTENCE = /\b(?:tickets?|reserve (?:your|a) seat|box office|on sale|purchase|buy now|rsvp)\b/i;

function stripTicketTalk(text) {
  return cleanText(text)
    .split(/\n{2,}/)
    .map((para) =>
      (para.match(/[^.!?]+(?:[.!?]+["”’)]*|$)\s*/g) || [para])
        .filter((sentence) => !TICKET_SENTENCE.test(sentence))
        .join('')
        .trim(),
    )
    .filter(Boolean)
    .join('\n\n');
}

function yearOf(dateStr) {
  const y = +String(dateStr || '').slice(0, 4);
  return Number.isInteger(y) && y > 1880 && y < 2100 ? y : undefined;
}

function personName(p) {
  return oneLine([p?.firstName, p?.lastName].filter(Boolean).join(' '));
}

function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
    out[k] = v;
  }
  return out;
}

function buildFilm(m, parsed) {
  try {
    const loc = m.locale || {};
    const exh = m.exhibitor || {};
    const filmSyn = cleanText(htmlToText(loc.synopsis || '') || '');
    const eventSyn = exh.synopsis ? stripTicketTalk(htmlToText(exh.synopsis)) : '';
    let description = [eventSyn, filmSyn].filter(Boolean);
    if (description.length === 2 && norm(description[0]) === norm(description[1])) description = [description[0]];
    let desc = description.join('\n\n');
    if (!desc && m.synopsis) desc = stripTicketTalk(htmlToText(m.synopsis));

    const secs = Number(m.runtime);
    const runtime = Number.isFinite(secs) && secs > 0 ? Math.round(secs / 60) : undefined;

    const release = m.release || m.releases?.[0]?.releasedAt;
    const year = parsed.year ?? yearOf(release);

    let directors = Array.isArray(m.direction) ? m.direction.map(oneLine).filter(Boolean) : [];
    if (!directors.length) directors = (m.directors?.nodes || []).map((n) => personName(n?.person)).filter(Boolean);

    const rating = oneLine(m.certificate || m.releases?.[0]?.rating?.certificate || '') || undefined;
    const genres = oneLine(m.genres || '')
      .split(/\s*,\s*/)
      .filter(Boolean)
      .map((g) => (isAllCaps(g) || g === g.toLowerCase() ? titleCase(g) : g));
    const image = m.poster || loc.poster?.url || m.pictures?.[0] || m.heroImages?.[0] || undefined;

    return compact({
      description: desc || undefined,
      runtime: runtime && runtime < 1000 ? runtime : undefined,
      year: year && year > 1880 && year < 2100 ? year : undefined,
      director: directors.join(', ') || undefined,
      rating,
      genres,
      image: /^https?:\/\//.test(image || '') ? image : undefined,
    });
  } catch (err) {
    console.warn(`majestic-bay: could not read details for "${m?.title}": ${err.message}`);
    return {};
  }
}

// Showtime tags -> notes. Digital projection is the default and internal
// flags (AlmostSoldOut, …) change by the hour, so both are left out.
function tagNote(tag) {
  const t = String(tag || '');
  if (!t || /^Internal\./.test(t)) return null;
  if (/^Format\.Projection\.(?:Digital|Standard|2D)$/i.test(t)) return null;
  if (t === 'Showtime.Event.SpecialEvent') return null; // handled with categories
  if (/35\s?mm/i.test(t)) return '35mm';
  if (/70\s?mm/i.test(t)) return '70mm';
  if (/16\s?mm/i.test(t)) return '16mm';
  if (/\b3D$/i.test(t)) return '3D';
  if (/OpenCaption/i.test(t)) return 'Open captions';
  if (/ClosedCaption/i.test(t)) return 'Closed captions';
  if (/SensoryFriendly/i.test(t)) return 'Sensory friendly';
  if (/FamilyFriendly/i.test(t)) return 'Family Movie Morning';
  if (/Q(?:and|&)?A$/i.test(t)) return 'Q&A';
  const last = t.split('.').pop();
  if (!/^(?:Showtime|Format)\./.test(t) || !last) return null;
  const words = last.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

function ticketUrl(showtime) {
  const entries = Array.isArray(showtime?.data?.ticketing) ? showtime.data.ticketing : [];
  const pick = (pred) => entries.find(pred)?.urls?.find((u) => /^https?:\/\//.test(u || ''));
  return (
    pick((e) => e?.provider === 'default' && e?.type === 'DESKTOP') ||
    pick((e) => e?.provider !== 'relay') ||
    pick(() => true) ||
    undefined
  );
}

function slugify(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((x) => {
    if (!x) return false;
    const k = x.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------------------------------------------------------------- scrape

export default {
  id: 'majestic-bay',

  async scrape() {
    const today = seattleToday();
    const first = addDays(today, 0);
    const last = addDays(today, DAYS_AHEAD);

    let theaterId = DEFAULT_THEATER;
    let schedule;
    try {
      schedule = await fetchSchedule(theaterId, first, last);
    } catch (err) {
      const found = await discoverTheaterId().catch(() => null);
      if (!found || found === theaterId) throw err;
      console.warn(`majestic-bay: theater id changed to ${found}`);
      theaterId = found;
      schedule = await fetchSchedule(theaterId, first, last);
    }

    const movieIds = Object.keys(schedule);
    if (!movieIds.length) return [];

    const [movies, statics] = await Promise.all([fetchMovies(movieIds), fetchStaticData()]);

    const films = new Map();
    const out = [];

    for (const movieId of movieIds) {
      let f = films.get(movieId);
      if (!f) {
        const m = movies.get(movieId) || (statics.titles.has(movieId) ? { id: movieId, title: statics.titles.get(movieId) } : null);
        if (!m?.title && !m?.locale?.title) {
          console.warn(`majestic-bay: no title for movie ${movieId}; skipping its showtimes`);
          continue;
        }
        if (NOT_A_FILM.test(m.title || '')) continue;
        const parsed = parseTitle(m);
        const path = statics.paths.get(movieId) || `/movies/${movieId}-${slugify(m.title || parsed.title)}`;
        const exhSyn = oneLine(m.exhibitor?.synopsis || '');
        f = {
          title: parsed.title,
          notes: parsed.notes,
          free: /\b(?:complimentary|free (?:admission|screening|event|of charge)|tickets are free|admission is free)\b/i.test(exhSyn),
          categories: [...(statics.categoriesByMovie.get(movieId) || [])],
          film: buildFilm(m, parsed),
          url: `${BASE}${path.replace(/\/?$/, '/')}`,
        };
        films.set(movieId, f);
      }

      const days = schedule[movieId];
      if (!days || typeof days !== 'object') continue;
      for (const list of Object.values(days)) {
        if (!Array.isArray(list)) continue;
        for (const st of list) {
          try {
            const start = startISO(st?.startsAt);
            if (!start) continue;
            const day = start.slice(0, 10);
            if (day < first || day > last) continue;

            const tags = Array.isArray(st.tags) ? st.tags : [];
            const special = tags.includes('Showtime.Event.SpecialEvent');
            const notes = [...f.notes, ...tags.map(tagNote)];
            if (special) {
              notes.push(...f.categories);
              if (!notes.filter(Boolean).length) notes.push('Special screening');
            }
            if (f.free) notes.push('Free');

            const screening = { theater: 'majestic-bay', title: f.title, start, url: f.url };
            const tickets = ticketUrl(st);
            if (tickets) screening.tickets = tickets;
            const clean = dedupe(notes);
            if (clean.length) screening.notes = clean;
            if (Object.keys(f.film).length) screening.film = f.film;
            out.push(screening);
          } catch (err) {
            console.warn(`majestic-bay: skipped a showtime of ${movieId}: ${err.message}`);
          }
        }
      }
    }

    out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.title.localeCompare(b.title)));
    return out;
  },
};
