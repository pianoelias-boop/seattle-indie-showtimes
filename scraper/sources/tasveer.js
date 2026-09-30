// Tasveer Film Center (the former Ark Lodge, Columbia City).
//
// filmcenter.tasveer.org is a single-page app on the Indy Systems ticketing
// platform. Its data comes from a public GraphQL endpoint on the same host,
// which answers "consumer" requests once they carry the site's numeric id:
//   POST /graphql  headers: client-type: consumer, site-id: 262
//   { datesWithShowing { value } }            -> JSON list of dates with showings
//   { showingsForDate(date: "YYYY-MM-DD") }   -> that day's showings, each with
//                                                its movie (synopsis, director,
//                                                runtime, poster, ...)
// Everything we need arrives with the showings, so there are no per-film
// requests. The site id is baked into the app bundle; if the hard-coded one
// stops working we read it from the current bundle.

import { fetchRaw, getText, mapLimit } from '../lib/http.js';
import { toSeattleISO, seattleToday } from '../lib/time.js';
import { htmlToText, oneLine, absUrl } from '../lib/text.js';

const BASE = 'https://filmcenter.tasveer.org';
const GQL = `${BASE}/graphql`;
const DEFAULT_SITE_ID = '262';
const IMG = 'https://indy-systems.imgix.net';
const POSTER_PARAMS = 'fit=crop&w=400&h=600&fm=jpeg&auto=format,compress&cs=origin';
const DAYS_AHEAD = 35;

const MOVIE_FIELDS_FULL = `id name urlSlug synopsis directedBy duration genre allGenres
  countryOfOrigin originalLanguage rating releaseDate posterImage bannerImage titleClass { name }`;
const SHOWING_FIELDS_FULL = `id time private published showingBadges { displayName } movie { ${MOVIE_FIELDS_FULL} }`;
// Fallback if the schema drops or renames one of the optional fields above.
const SHOWING_FIELDS_BASIC = 'id time movie { id name urlSlug }';

const showingsQuery = (fields) =>
  `query Showings($date: String) { showingsForDate(date: $date) { data { ${fields} } } }`;

// ---------------------------------------------------------------- GraphQL

class GqlError extends Error {}

async function gql(siteId, query, variables = {}) {
  const res = await fetchRaw(GQL, {
    method: 'POST',
    body: JSON.stringify({ query, variables }),
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'client-type': 'consumer',
      'site-id': siteId,
    },
  });
  const json = await res.json();
  const err = json?.error || json?.errors?.[0];
  if (err) throw new GqlError(`Tasveer GraphQL: ${err.message_to_log || err.message || JSON.stringify(err)}`);
  if (!json?.data) throw new GqlError('Tasveer GraphQL: response has no data');
  return json.data;
}

// The consumer app bundle carries `siteId:X,circuitId:Y` in its config, with
// X assigned like `X=isConsumer?"262":null`.
async function discoverSiteId() {
  const html = await getText(`${BASE}/`);
  const src = html.match(/src=["']?([^"' >]*\/js\/app\.[\w-]+\.js)/)?.[1];
  if (!src) throw new Error('Tasveer: app bundle not found on the home page');
  const js = await getText(absUrl(src, BASE));
  const v = js.match(/\bsiteId:([\w$]+),circuitId:/)?.[1];
  const esc = v && v.replace(/\$/g, '\\$');
  const id = esc && js.match(new RegExp(`[,;{\\s]${esc}=[\\w$!.]+\\?"(\\d+)":null`))?.[1];
  if (!id) throw new Error('Tasveer: site id not found in app bundle');
  return id;
}

// The endpoint answers for any Indy site id, so check we got Tasveer.
async function fetchDates(siteId) {
  const data = await gql(siteId, '{ currentSite { name siteTitle } datesWithShowing { value } }');
  const name = `${data?.currentSite?.name || ''} ${data?.currentSite?.siteTitle || ''}`;
  if (!/tasveer/i.test(name)) throw new Error(`Tasveer: site ${siteId} is "${name.trim()}", not Tasveer`);
  let dates = data?.datesWithShowing?.value;
  if (typeof dates === 'string') dates = JSON.parse(dates);
  if (!Array.isArray(dates)) throw new Error('Tasveer: datesWithShowing is not a list');
  return dates.filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d));
}

async function fetchShowings(siteId, date) {
  try {
    const data = await gql(siteId, showingsQuery(SHOWING_FIELDS_FULL), { date });
    return data?.showingsForDate?.data;
  } catch (err) {
    if (!(err instanceof GqlError)) throw err;
    console.warn(`tasveer: full query failed for ${date} (${err.message}); retrying with basic fields`);
    const data = await gql(siteId, showingsQuery(SHOWING_FIELDS_BASIC), { date });
    return data?.showingsForDate?.data;
  }
}

// ---------------------------------------------------------------- dates

const pad = (n) => String(n).padStart(2, '0');

function addDays({ y, m, d }, days) {
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

// ---------------------------------------------------------------- names

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
const languageNames = new Intl.DisplayNames(['en'], { type: 'language' });
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

// Language names to use instead of CLDR's (which says "Bangla" for bn).
const LANGUAGE_OVERRIDES = { bn: 'Bengali', tl: 'Tagalog', fil: 'Filipino', or: 'Odia', pa: 'Punjabi', fa: 'Persian' };

const COUNTRY_ALIASES = {
  usa: 'United States', us: 'United States', 'u.s.': 'United States', 'u.s.a.': 'United States',
  america: 'United States', uk: 'United Kingdom', 'u.k.': 'United Kingdom', britain: 'United Kingdom',
  'great britain': 'United Kingdom',
};

const COUNTRIES = new Set([
  ...Object.keys(COUNTRY_ALIASES),
  'england', 'scotland', 'wales', 'northern ireland', 'palestine', 'czech republic', 'burma',
  'south korea', 'north korea', 'hong kong', 'taiwan', 'russia', 'iran', 'syria', 'vietnam',
  'ivory coast', 'turkey', 'macedonia', 'kashmir', 'tibet',
]);
const LANGUAGES = new Set([
  'bengali', 'bangla', 'tulu', 'konkani', 'bhojpuri', 'maithili', 'santali', 'dogri', 'manipuri',
  'meitei', 'rajasthani', 'haryanvi', 'awadhi', 'chhattisgarhi', 'garhwali', 'kumaoni', 'kokborok',
  'khasi', 'mizo', 'sylheti', 'chakma', 'saraiki', 'balochi', 'hindustani', 'dari', 'farsi',
  'filipino', 'tagalog', 'cantonese', 'mandarin', 'hokkien', 'taiwanese', 'kurdish', 'sign language',
  'american sign language', 'asl', 'dhivehi', 'brahui', 'hazaragi', 'ladakhi', 'lepcha', 'nagamese',
]);
for (const a of LETTERS) {
  for (const b of LETTERS) {
    const code = a + b;
    try {
      const r = regionNames.of(code.toUpperCase());
      if (r && r.toUpperCase() !== code.toUpperCase()) COUNTRIES.add(r.toLowerCase());
    } catch { /* not a region */ }
    try {
      const l = languageNames.of(code);
      if (l && l !== code) LANGUAGES.add(l.toLowerCase());
    } catch { /* not a language */ }
  }
}

function regionName(code) {
  if (!code || typeof code !== 'string') return undefined;
  const c = code.trim();
  if (!/^[A-Za-z]{2}$/.test(c)) return c || undefined;
  try {
    const n = regionNames.of(c.toUpperCase());
    return n && n.toUpperCase() !== c.toUpperCase() ? n : undefined;
  } catch {
    return undefined;
  }
}

function languageName(code) {
  if (!code || typeof code !== 'string') return undefined;
  const c = code.trim().toLowerCase();
  if (LANGUAGE_OVERRIDES[c]) return LANGUAGE_OVERRIDES[c];
  if (!/^[a-z]{2,3}(-[a-z0-9]+)?$/i.test(c)) return code.trim() || undefined;
  try {
    const n = languageNames.of(c);
    return n && n !== c ? n : undefined;
  } catch {
    return undefined;
  }
}

const isCountry = (s) => COUNTRIES.has(s.toLowerCase().trim());
const isLanguage = (s) => LANGUAGES.has(s.toLowerCase().trim());
const normCountry = (s) => COUNTRY_ALIASES[s.toLowerCase().trim()] || s.trim();
const normLanguage = (s) => (/^(bangla)$/i.test(s.trim()) ? 'Bengali' : s.trim());

// ---------------------------------------------------------------- titles

const SMALL_WORDS = new Set(
  'a an and as at but by for from in into nor of on or over per the to up via vs vs. with yet'.split(' '),
);
const ROMAN = /^(?=[ivx])(x{0,3})(ix|iv|v?i{0,3})$/i;

function capitalize(word) {
  // Capitalize the first letter after any leading punctuation, and after hyphens.
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
      if (ROMAN.test(bare) && bare.length > 0 && bare !== 'i') return tok.toUpperCase();
      if (bare === 'i') return tok.toUpperCase();
      if (!isFirst && !isLast && SMALL_WORDS.has(bare)) return tok;
      return capitalize(tok);
    })
    .join('');
}

function isAllCaps(str) {
  const letters = str.replace(/[^A-Za-z]/g, '');
  if (letters.length < 2 || /[a-z]/.test(str)) return false;
  // Keep short one-word titles like "RRR", "PK" or "JFK" as they are.
  if (!/\s/.test(str.trim()) && letters.length <= 3) return false;
  return true;
}

// Keep a note's own wording, but tidy it: strip wrapping punctuation and
// shouting.
function tidyNote(s) {
  let n = oneLine(s).replace(/^[\s,;:&+|–—-]+|[\s,;:|–—!-]+$/g, '').replace(/^\(|\)$/g, '').trim();
  if (!n) return null;
  if (isAllCaps(n)) n = n.charAt(0) + n.slice(1).toLowerCase();
  if (/^open[- ]?cap/i.test(n)) return 'Open captions';
  if (/^closed[- ]?cap/i.test(n)) return 'Closed captions';
  const mm = n.match(/^(?:in\s+|on\s+)?((?:16|35|70)\s?mm)$/i);
  if (mm) return mm[1].replace(/\s/g, '').toLowerCase();
  return n;
}

// A trailing "(…)" on a Tasveer title is usually metadata:
// "(La Hija Cóndor, Bolivia/Peru/Uruguay, 2025)", "(2026, USA)",
// "(2025, Japan, Japanese subtitled in English)", "(Hindi)". Returns null
// when nothing in it is recognizable, so the parenthetical stays in the title.
function parseParenthetical(content) {
  const info = { notes: [] };
  let recognized = 0;
  for (const raw of content.split(/\s*,\s*/)) {
    const part = raw.trim();
    if (!part) continue;
    let m;
    if (/^(18[89]\d|19\d\d|20\d\d)$/.test(part)) {
      info.year = +part;
      recognized++;
    } else if ((m = part.match(/^(.+?)\s+(?:(?:with\s+)?(?:english\s+)?sub(?:title)?s?(?:titled)?(?:\s+in\s+english)?|w\/\s*english\s+subtitles)$/i))) {
      info.language = m[1].split(/\s*(?:\/|&|\band\b)\s*/).map(normLanguage).filter(Boolean).join(', ');
      recognized++;
    } else if (/^(?:with\s+)?english\s+sub(?:title)?s$|^subtitled(?:\s+in\s+english)?$/i.test(part)) {
      recognized++;
    } else if (part.split(/\s*\/\s*/).every(isCountry)) {
      info.country = part.split(/\s*\/\s*/).map(normCountry).join(', ');
      recognized++;
    } else if (part.split(/\s*(?:\/|&)\s*/).every(isLanguage)) {
      info.language = part.split(/\s*(?:\/|&)\s*/).map(normLanguage).join(', ');
      recognized++;
    } else if (/^(?:in\s+)?(?:16|35|70)\s?mm$|^4k(?:\s+restoration)?$|restor(?:ed|ation)|^open[- ]?cap|^closed[- ]?cap/i.test(part)) {
      info.notes.push(tidyNote(part.replace(/^in\s+/i, '')));
      recognized++;
    }
    // Anything else (an original-language title, usually) is dropped when
    // the rest of the parenthetical is metadata.
  }
  return recognized ? info : null;
}

// Add-ons stuck to the end of a title: " in 35mm", " + Q&A", " - Open Caption".
const TRAILING_ADDONS = [
  /\s*[-–—:|,]?\s*\(?\b(?:in|on)\s+((?:16|35|70)\s?mm)\)?$/i,
  /\s*[-–—:|,]\s*((?:16|35|70)\s?mm)$/i,
  /\s*[-–—:|,]?\s*\(?\s*(open[- ]?cap(?:tion(?:ed|s)?)?)\s*\)?$/i,
  /\s*[-–—:|,]?\s*\(?\s*(closed[- ]?cap(?:tion(?:ed|s)?)?)\s*\)?$/i,
  /\s*[-–—:|,]?\s*\(?\s*((?:\+|w\/|with)\s*(?:a\s+)?(?:live\s+)?(?:q\s?&\s?a|q\s+and\s+a|discussion|panel|conversation|intro(?:duction)?|filmmakers?|directors?)\b[^()]*)\)?$/i,
  /\s*[-–—:|,]?\s*\(?\s*(sensory[- ]friendly(?:\s+screening)?)\s*\)?$/i,
  /\s*[-–—:|,]?\s*\(?\s*((?:new\s+)?4k\s+restoration|restored)\s*\)?$/i,
];

// "No Country for Mothers, Family Friendly Screening & Community Conversation"
const EVENT_SUFFIX =
  /^(.+?)\s*(?:,|:|\s[-–—|]\s|\s\+\s)\s*([^,:]*\b(?:screening|conversation|q\s?&\s?a|discussion|panel|in[- ]person|introduced by|intro by|presented by|celebration|reception|sing-?along|fundraiser|community (?:event|night))\b.*)$/i;

// "Series Name: Film Title" / "Series Name Presents: Film Title"
const SERIES_PREFIX = /^((?:[^:]*\b(?:presents?|series|showcase|spotlight|festival|night|nights|club|retrospective|celebration|tribute|matinee|classics?)\b)[^:]*):\s+(.+)$/i;

function parseTitle(raw) {
  let title = oneLine(raw);
  const notes = [];
  const info = {};

  for (let guard = 0; guard < 6; guard++) {
    const before = title;

    // Trailing "(…)" metadata; tolerate a doubled ")" as in "(… 2017))".
    const pm = title.match(/\s*\(([^()]*)\)\)*\s*$/);
    if (pm && pm.index > 0) {
      const parsed = parseParenthetical(pm[1]);
      if (parsed) {
        if (parsed.year && !info.year) info.year = parsed.year;
        if (parsed.country && !info.country) info.country = parsed.country;
        if (parsed.language && !info.language) info.language = parsed.language;
        notes.push(...parsed.notes);
        title = title.slice(0, pm.index).trim();
      }
    }

    for (const re of TRAILING_ADDONS) {
      const m = title.match(re);
      if (m && m.index > 0) {
        notes.push(tidyNote(m[1]));
        title = title.slice(0, m.index).trim();
      }
    }

    const em = title.match(EVENT_SUFFIX);
    if (em && em[1].trim().length >= 2) {
      for (const part of em[2].split(/\s+(?:&|\+|and)\s+/i)) notes.push(tidyNote(part));
      title = em[1].trim();
    }

    const sm = title.match(SERIES_PREFIX);
    if (sm && sm[2].trim().length >= 2) {
      notes.push(tidyNote(sm[1]));
      title = sm[2].trim();
    }

    if (title === before) break;
  }

  title = title.replace(/[\s,;:–—-]+$/, '').trim() || oneLine(raw);
  if (isAllCaps(title)) title = titleCase(title);
  return { title, notes: notes.filter(Boolean), ...info };
}

// ---------------------------------------------------------------- films

const NOT_A_FILM = /\bgift\s*cards?\b|\bprivate\s+(?:event|rental|party|screening)\b|\brentals?\b|\bworkshop\b|\bmaster\s*class\b|\bclass(?:es)?\b|\bmembership\b|\bmerch(?:andise)?\b|\bconcessions?\b|\bdonation\b|\bfilm market\b/i;

function isNonFilm(movie) {
  const cls = movie?.titleClass?.name || '';
  if (cls && NOT_A_FILM.test(cls)) return true;
  if (/\b(?:classes|rentals?|gift|merch|memberships?|concessions?|workshops?)\b/i.test(cls)) return true;
  return NOT_A_FILM.test(movie?.name || '');
}

function normRating(r) {
  const s = oneLine(r || '');
  if (!s) return undefined;
  if (/^(?:nr|not\s+(?:yet\s+)?rated|unrated|n\/a)$/i.test(s)) return 'NR';
  return s;
}

function yearOf(dateStr) {
  const y = +String(dateStr || '').slice(0, 4);
  return Number.isInteger(y) && y > 1880 && y < 2100 ? y : undefined;
}

function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
    out[k] = v;
  }
  return out;
}

function buildFilm(movie, parsed) {
  try {
    const runtime = Number.isInteger(movie.duration) && movie.duration > 0 && movie.duration < 1000 ? movie.duration : undefined;
    const year = parsed.year ?? yearOf(movie.releaseDate);
    const genres = oneLine(movie.allGenres || movie.genre || '')
      .split(/\s*,\s*/)
      .filter(Boolean);
    const image = movie.posterImage
      ? `${IMG}/${encodeURIComponent(movie.posterImage)}?${POSTER_PARAMS}`
      : movie.bannerImage
        ? `${IMG}/${encodeURIComponent(movie.bannerImage)}?fit=crop&w=1000&h=500&fm=jpeg&auto=format,compress&cs=origin`
        : undefined;
    return compact({
      description: htmlToText(movie.synopsis || '') || undefined,
      runtime,
      year: year && year > 1880 && year < 2100 ? year : undefined,
      director: oneLine(movie.directedBy || '') || undefined,
      country: parsed.country || regionName(movie.countryOfOrigin),
      language: parsed.language || languageName(movie.originalLanguage),
      rating: normRating(movie.rating),
      genres,
      image,
    });
  } catch (err) {
    console.warn(`tasveer: could not read details for "${movie?.name}": ${err.message}`);
    return {};
  }
}

// Per-showing badges. Accessibility-by-auditorium and "subtitled" flags are
// left out: they are about the room or the film, not this showing.
function badgeNote(name) {
  const n = oneLine(name || '');
  if (!n) return null;
  if (/wheelchair|stairs|elevator|ramp|accessib/i.test(n)) return null;
  if (/subtitle|subtitled|engligh/i.test(n)) return null;
  if (/^free\b/i.test(n)) return 'Free';
  return tidyNote(n);
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
  id: 'tasveer',

  async scrape() {
    const today = seattleToday();
    const first = addDays(today, 0);
    const last = addDays(today, DAYS_AHEAD);

    let siteId = DEFAULT_SITE_ID;
    let dates;
    try {
      dates = await fetchDates(siteId);
    } catch (err) {
      console.warn(`tasveer: site id ${siteId} failed (${err.message}); looking it up in the app bundle`);
      siteId = await discoverSiteId();
      dates = await fetchDates(siteId);
    }

    const wanted = [...new Set(dates)].filter((d) => d >= first && d <= last).sort();
    if (!wanted.length) return [];

    let failures = 0;
    const perDate = await mapLimit(wanted, 3, async (date) => {
      try {
        const list = await fetchShowings(siteId, date);
        if (!Array.isArray(list)) throw new Error('showingsForDate returned no list');
        return list;
      } catch (err) {
        failures++;
        console.warn(`tasveer: showings for ${date} failed: ${err.message}`);
        return [];
      }
    });
    if (failures === wanted.length) throw new Error('Tasveer: every showingsForDate request failed');

    const films = new Map(); // movie id -> { title, notes, film, url, slug }
    const out = [];
    const seen = new Set();

    for (const s of perDate.flat()) {
      try {
        if (!s || typeof s !== 'object' || !s.movie?.name) continue;
        if (s.private === true || s.published === false) continue;
        if (isNonFilm(s.movie)) continue;
        if (seen.has(s.id)) continue;
        seen.add(s.id);

        const start = s.time ? toSeattleISO(s.time) : null;
        if (!start) continue;
        const day = start.slice(0, 10);
        if (day < first || day > last) continue;

        const key = s.movie.id || s.movie.name;
        let f = films.get(key);
        if (!f) {
          const parsed = parseTitle(s.movie.name);
          const slug = s.movie.urlSlug || s.movie.id;
          f = {
            title: parsed.title,
            notes: parsed.notes,
            film: buildFilm(s.movie, parsed),
            slug,
            url: slug ? `${BASE}/movie/${encodeURIComponent(slug)}` : BASE + '/',
          };
          films.set(key, f);
        }

        const notes = dedupe([...f.notes, ...(s.showingBadges || []).map((b) => badgeNote(b?.displayName))]);
        const screening = {
          theater: 'tasveer',
          title: f.title,
          start,
          url: f.url,
        };
        if (f.slug && s.id) screening.tickets = `${BASE}/checkout/showing/${encodeURIComponent(f.slug)}/${encodeURIComponent(s.id)}`;
        if (notes.length) screening.notes = notes;
        if (Object.keys(f.film).length) screening.film = f.film;
        out.push(screening);
      } catch (err) {
        console.warn(`tasveer: skipped a showing: ${err.message}`);
      }
    }

    out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.title.localeCompare(b.title)));
    return out;
  },
};
