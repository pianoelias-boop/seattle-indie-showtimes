// Central Cinema (Central District) — central-cinema.com
//
// The site is an Indy Systems ticketing app (a Vue SPA). Its public GraphQL
// endpoint (/graphql) answers consumer queries when the request says which
// site it is for, via the same `site-id` / `client-type` headers the app
// sends. Two queries are enough:
//
//   datesWithShowing { value }            JSON list of local dates with showings
//   showingsForDate(date: "YYYY-MM-DD")   that day's showings, each with its movie
//                                         (synopsis, director, runtime, genres,
//                                         country, language, rating, images)
//
// Several days are batched into one request with GraphQL aliases.
//
// Central Cinema's "movies" include non-film events (trivia, private rentals,
// a jazz jam...). Features are always kept; "Special Event" titles are kept
// unless they look like a non-film event (sing-alongs, cartoon shows and
// hosted screenings stay).

import { fetchRaw, getText } from '../lib/http.js';
import { htmlToText, oneLine } from '../lib/text.js';
import { toSeattleISO, seattleToday } from '../lib/time.js';

const BASE = 'https://central-cinema.com';
const GRAPHQL = `${BASE}/graphql`;
const IMGIX = 'https://indy-systems.imgix.net';
// Baked into the site's app bundle (see discoverSiteId for the fallback).
const SITE_ID = '275';
const DAYS_AHEAD = 35;
const DATES_PER_REQUEST = 7;
const THEATER = 'central-cinema';

const FULL_FIELDS = `id time published private overrideReservedSeating overrideReservedSeatingValue
  screen { reservedSeating }
  showingBadges { displayName title }
  movie { id name urlSlug synopsis directedBy duration genre allGenres countryOfOrigin originalLanguage
    rating releaseDate posterImage bannerImage tmdbId isMarathon titleClass { name } }`;
// If Indy ever renames one of the extra fields, fall back to the essentials.
const MINIMAL_FIELDS = 'id time private movie { id name urlSlug synopsis }';

// Never screenings, whatever their class.
const ALWAYS_SKIP = /\b(private (rental|event|party|screening)|rental event|gift ?cards?|buy ?out|closed for|membership)\b/i;
// Non-film events among the "Special Event" titles.
const EVENT_SKIP =
  /\b(trivia|quiz|jam session|jazz|karaoke|comedy|stand[- ]?up|open mic|bingo|video ?games?|gaming|drag show|burlesque|concert|live music|dance party|workshop|class|market|podcast|book club|reading|auction|fundraiser gala)\b/i;
// Series that prefix the film title ("Cinemancy: The Elephant Man").
const KNOWN_SERIES = /^(cinemancy)$/i;
// Badges worth showing as a note on a showing.
const NOTE_BADGE = /caption|\b(35|70|16) ?mm\b|sensory|q ?& ?a|dubbed|\b3-?d\b|21\+|all ages|kids?\b|family|matinee|sing|quote/i;

export default {
  id: THEATER,
  async scrape() {
    let siteId = SITE_ID;
    let dates;
    try {
      dates = await datesWithShowing(siteId);
    } catch (err) {
      const found = await discoverSiteId().catch(() => null);
      if (!found || found === siteId) throw new Error(`central-cinema: GraphQL API not usable (${err.message})`);
      siteId = found;
      dates = await datesWithShowing(siteId);
    }

    const { from, to } = windowDates();
    dates = dates.filter((d) => d >= from && d <= to);
    if (!dates.length) return [];

    const showings = [];
    for (let i = 0; i < dates.length; i += DATES_PER_REQUEST) {
      const batch = dates.slice(i, i + DATES_PER_REQUEST);
      let data;
      try {
        data = await showingsFor(batch, siteId, FULL_FIELDS);
      } catch (err) {
        console.warn(`central-cinema: full query failed (${err.message}); retrying with minimal fields`);
        data = await showingsFor(batch, siteId, MINIMAL_FIELDS);
      }
      batch.forEach((date, j) => {
        const list = data[`d${j}`]?.data;
        if (!Array.isArray(list)) throw new Error(`central-cinema: unexpected response shape for ${date}`);
        showings.push(...list);
      });
    }

    // One cleaned-up record per movie, so every showing of it matches.
    const movies = new Map();
    for (const s of showings) {
      const m = s?.movie;
      if (m?.id && !movies.has(m.id)) {
        try {
          movies.set(m.id, describeMovie(m));
        } catch (err) {
          console.warn(`central-cinema: skipped movie ${m.name}: ${err.message}`);
        }
      }
    }
    linkEventsToFeatures([...movies.values()]);

    const out = [];
    const seen = new Set();
    for (const s of showings) {
      try {
        if (!s?.movie?.id || !s.time || s.private || s.published === false) continue;
        const mv = movies.get(s.movie.id);
        if (!mv || mv.skip) continue;
        const start = toSeattleISO(s.time);
        if (!start || start.slice(0, 10) < from || start.slice(0, 10) > to) continue;
        if (seen.has(`${s.id}`)) continue;
        seen.add(`${s.id}`);

        const notes = [...mv.notes];
        for (const b of s.showingBadges || []) {
          const name = oneLine(b?.displayName || b?.title || '');
          if (name && NOTE_BADGE.test(name) && !notes.includes(name)) notes.push(name);
        }
        const reserved = s.overrideReservedSeating ? s.overrideReservedSeatingValue : s.screen?.reservedSeating;
        const slug = s.movie.urlSlug || s.movie.id;
        const screening = {
          theater: THEATER,
          title: mv.title,
          start,
          url: `${BASE}/movie/${slug}/`,
          tickets: reserved ? `${BASE}/checkout/seats/${s.id}` : `${BASE}/checkout/showing/${slug}/${s.id}`,
        };
        if (notes.length) screening.notes = notes;
        if (Object.keys(mv.film).length) screening.film = mv.film;
        out.push(screening);
      } catch (err) {
        console.warn(`central-cinema: skipped showing ${s?.id}: ${err.message}`);
      }
    }
    out.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
    return out;
  },
};

// ---------------------------------------------------------------------------
// API

async function gql(query, siteId) {
  const res = await fetchRaw(GRAPHQL, {
    method: 'POST',
    body: JSON.stringify({ query }),
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Origin: BASE,
      Referer: `${BASE}/`,
      'site-id': siteId,
      'client-type': 'consumer',
    },
  });
  const json = await res.json();
  const err = json.error || json.errors?.[0];
  if (err) throw new Error(err.message_to_log || err.message || 'GraphQL error');
  if (!json.data) throw new Error('GraphQL response without data');
  return json.data;
}

async function datesWithShowing(siteId) {
  const data = await gql('query { datesWithShowing { value } }', siteId);
  const raw = data.datesWithShowing?.value;
  const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!Array.isArray(list)) throw new Error('datesWithShowing: unexpected shape');
  return list.map(String).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
}

function showingsFor(dates, siteId, fields) {
  const parts = dates.map((d, i) => `d${i}: showingsForDate(date: ${JSON.stringify(d)}) { data { ${fields} } }`);
  return gql(`query { ${parts.join('\n')} }`, siteId);
}

// The site id is a build-time constant in the app bundle:
// `…="consumer"…,O=y?"275":null,R=y?"139":null,…` (site, then circuit).
async function discoverSiteId() {
  const html = await getText(`${BASE}/`);
  const src = html.match(/src=["']?(\/js\/app\.[\w.-]+\.js)/)?.[1];
  if (!src) return null;
  const js = await getText(`${BASE}${src}`);
  return js.match(/=\w+\?"(\d+)":null,\w+=\w+\?"\d+":null/)?.[1] || null;
}

function windowDates() {
  const t = seattleToday();
  const fmt = (ms) => new Date(ms).toISOString().slice(0, 10);
  return { from: fmt(Date.UTC(t.y, t.m - 1, t.d)), to: fmt(Date.UTC(t.y, t.m - 1, t.d + DAYS_AHEAD)) };
}

// ---------------------------------------------------------------------------
// Movies -> { title, notes, film, skip, isFeature, key }

function describeMovie(m) {
  const rawName = oneLine(m.name || '');
  const isFeature = /feature/i.test(m.titleClass?.name || '');
  const out = { title: '', notes: [], film: {}, skip: false, isFeature, key: '' };
  if (!rawName || ALWAYS_SKIP.test(rawName) || (!isFeature && EVENT_SKIP.test(rawName))) {
    out.skip = true;
    return out;
  }

  const synopsisText = synopsisToText(m.synopsis);
  const { title, notes, year, filmTitle, series } = cleanTitle(rawName, synopsisText, isFeature);
  out.title = title;
  out.notes = notes;
  out.key = titleKey(title);

  // Trust the catalogue fields only for real features (Special Events carry
  // the slot length as "duration" and the date they were entered as "releaseDate").
  const trusted = isFeature || !!m.tmdbId;
  const film = {};
  const { description, free, discussion } = cleanDescription(synopsisText, filmTitle || title);
  if (description) film.description = description;
  if (free && !out.notes.some((n) => /free/i.test(n))) out.notes.push('Free admission');
  if (series) out.notes.unshift(discussion ? `${series}: post-film discussion` : series);

  if (trusted && Number.isInteger(m.duration) && m.duration > 0 && m.duration < 1000 && !m.isMarathon) film.runtime = m.duration;
  const releaseYear = trusted && !m.isMarathon ? +String(m.releaseDate || '').slice(0, 4) : NaN;
  if (year) film.year = year;
  else if (releaseYear > 1880 && releaseYear < 2100) film.year = releaseYear;
  const director = realValue(m.directedBy);
  if (director) film.director = director;
  const country = codesToNames(m.countryOfOrigin, 'region');
  if (country) film.country = country;
  const language = codesToNames(m.originalLanguage, 'language');
  if (language) film.language = language;
  const rating = normalizeRating(m.rating);
  if (rating) film.rating = rating;
  const genres = String(m.allGenres || m.genre || '')
    .split(/\s*[,/]\s*/)
    .map((g) => oneLine(g))
    .filter(Boolean);
  if (genres.length) film.genres = [...new Set(genres)];
  if (m.bannerImage) film.image = `${IMGIX}/${m.bannerImage}?fit=crop&w=1200&h=600&fm=jpeg&auto=format,compress`;
  else if (m.posterImage) film.image = `${IMGIX}/${m.posterImage}?fit=crop&w=600&h=900&fm=jpeg&auto=format,compress`;
  out.film = film;
  return out;
}

// "Seattle Scare Society presents: Hausu" is the same film as the feature
// "Hausu (House)": give the event the feature's title (so they merge) and fill
// in any film details the event lacks.
function linkEventsToFeatures(movies) {
  const features = new Map();
  for (const mv of movies) if (mv.isFeature && !mv.skip && mv.key && !features.has(mv.key)) features.set(mv.key, mv);
  for (const mv of movies) {
    if (mv.skip || mv.isFeature) continue;
    const f = features.get(mv.key);
    if (!f) continue;
    // Same title and film details as the feature; what's special about the
    // event stays in its notes ("Presented by …").
    mv.title = f.title;
    mv.film = { ...mv.film, ...f.film };
  }
}

function titleKey(title) {
  return String(title)
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/^(the|a|an)\s+/, '')
    .replace(/[^a-z0-9]+/g, '');
}

const PLACEHOLDER = /^[?\s-]*$|^(tba|tbd|n\/a|none|null|various)$/i;
function realValue(v) {
  const s = oneLine(v ?? '');
  return s && !PLACEHOLDER.test(s) ? s : null;
}

// TMDB-style codes ('US', 'GB, FR', 'ja') -> names.
const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
const languageNames = new Intl.DisplayNames(['en'], { type: 'language' });
const LANGUAGE_FIXES = { cn: 'Cantonese', xx: null, zxx: null };
function codesToNames(value, type) {
  const names = String(value || '')
    .split(/\s*[,/;]\s*/)
    .map((c) => c.trim())
    .filter(Boolean)
    .map((code) => {
      if (!/^[A-Za-z]{2,3}$/.test(code)) return code; // already a name
      if (type === 'language' && code.toLowerCase() in LANGUAGE_FIXES) return LANGUAGE_FIXES[code.toLowerCase()];
      try {
        const name = (type === 'region' ? regionNames : languageNames).of(type === 'region' ? code.toUpperCase() : code.toLowerCase());
        return name && name.toLowerCase() !== code.toLowerCase() ? name : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return names.length ? [...new Set(names)].join(', ') : null;
}

function normalizeRating(r) {
  const s = oneLine(r || '').replace(/^rated\s+/i, '');
  if (!s) return null;
  const m = s.match(/^(NC-17|PG-13|PG|G|R|NR|TV-(?:MA|14|PG|G|Y7|Y))(?![\w-])/i);
  if (m) return m[1].toUpperCase();
  if (/^(unrated|not rated)/i.test(s)) return 'NR';
  return s.length <= 12 ? s : null;
}

// ---------------------------------------------------------------------------
// Descriptions: plain text, minus house notes about tickets and discounts.

// Synopses are loose HTML: bare text followed by <div>s, raw newlines that the
// app shows as line breaks, and the odd **markdown**.
function synopsisToText(html) {
  if (!html) return '';
  const prepared = String(html)
    .replace(/\*\*/g, '')
    .replace(/\r?\n/g, '<br>')
    .replace(/<(div|p|h[1-6]|ul|ol|li|blockquote)\b/gi, '\n\n<$1');
  return htmlToText(prepared)
    .split(/\n{2,}/)
    .map((p) => p.replace(/([^.!?:;])\n(?=\p{Ll})/gu, '$1 ')) // a break in mid-sentence
    .join('\n\n');
}

const BOILERPLATE =
  /2-for-1|does not qualify|no tickets? (?:are )?needed|just show up|admission is free|free drop-in|lobby cafe|\bspoons?\b|plastic is very bad|tickets? (?:are|go) on sale|advance tickets|buy (?:your )?tickets|tickets are \$|\$\d+ (?:tickets|admission)/i;
const FREE = /free drop-in|admission is free|no tickets? (?:are )?needed/i;
const SCHEDULE_LINE = /^\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i;

function cleanDescription(text, filmTitle) {
  if (!text) return { description: '' };
  let paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const free = FREE.test(text);
  let discussion = false;

  // Series blurb, then the film's name on its own line, then the synopsis.
  const norm = (s) => titleKey(s);
  const idx = paras.findIndex((p) => norm(p) === norm(filmTitle));
  if (idx >= 0 && idx < paras.length - 1) {
    discussion = /discuss/i.test(paras.slice(0, idx).join(' '));
    paras = paras.slice(idx + 1);
  }

  paras = paras
    .map((p) =>
      p
        .split('\n')
        .filter((line) => !SCHEDULE_LINE.test(line.trim()))
        .map((line) =>
          line
            .split(/(?<=[.!?])\s+(?=["“(\p{Lu}])/u)
            .filter((sentence) => !BOILERPLATE.test(sentence))
            .join(' ')
            .trim(),
        )
        .filter(Boolean)
        .join('\n'),
    )
    .filter(Boolean);
  return { description: paras.join('\n\n').trim(), free, discussion };
}

// ---------------------------------------------------------------------------
// Titles

function cleanTitle(raw, synopsisText, isFeature) {
  let t = titleCase(raw);
  const notes = [];
  let year = null;
  let series = null;
  let m;

  // "Cinemancy: The Elephant Man" — a known series, or a prefix whose remainder
  // appears on its own line in the synopsis (the film's name as a header).
  m = t.match(/^([^:]{2,40}):\s+(.+)$/);
  if (m) {
    const lines = synopsisText.split('\n').map((l) => titleKey(l));
    if (KNOWN_SERIES.test(m[1].trim()) || lines.includes(titleKey(m[2]))) {
      series = m[1].trim();
      t = m[2];
    }
  }
  // "Camp Napalm presents: Basic Instinct"
  m = t.match(/^(.+?)\s+presents\s*:?\s+(.+)$/i);
  if (m && /[\p{L}\p{N}]/u.test(m[2])) {
    notes.push(`Presented by ${m[1]}`);
    t = m[2];
  }
  // "Halloween III with Baron Von Terror" (events only: "Dances with Wolves" is a film)
  m = t.match(/^(.+?)\s+w\/\s*(.+)$/i);
  if (!m && !isFeature) m = t.match(/^(.+?)\s+with\s+(?!(?:the|a|an|me|you|him|her|us|them|my|your|his|its|our|their|love)\b)(\p{Lu}.+)$/u);
  if (m) {
    notes.push(`With ${m[2]}`);
    t = m[1];
  }
  // "Title + Q&A"
  m = t.match(/^(.+?)\s+\+\s+(.+)$/);
  if (m) {
    notes.push(m[2]);
    t = m[1];
  }
  const FORMAT = [
    [/\s*[-–—:,]?\s*\(?\b(?:in|on)\s+(35|70|16|8)\s?mm\)?$/i, (x) => `${x[1]}mm`],
    [/\s*[-–—:,]?\s*\((35|70|16|8)\s?mm\)$/i, (x) => `${x[1]}mm`],
    [/\s*[-–—:,]?\s*\(?\b(open[- ]caption(?:s|ed)?)\)?$/i, () => 'Open captions'],
    [/\s*[-–—:,]?\s*\(?\b(sensory[- ]friendly)\)?$/i, () => 'Sensory friendly'],
    [/\s*[-–—:,]?\s*\(?\b([248]k)\s+restoration\)?$/i, (x) => `${x[1].toUpperCase()} restoration`],
  ];
  for (const [re, note] of FORMAT) {
    const x = t.match(re);
    if (x) {
      notes.push(note(x));
      t = t.slice(0, x.index);
    }
  }
  // "Frankenstein (1931)"
  m = t.match(/^(.+?)\s*\((\d{4})\)$/);
  if (m) {
    year = +m[2];
    t = m[1];
  }
  t = t.trim().replace(/[\s,:;–—-]+$/, '');
  if (t) t = t[0].toUpperCase() + t.slice(1);
  return { title: t, notes, year, series, filmTitle: t };
}

const SMALL = new Set(['a', 'an', 'the', 'and', 'but', 'or', 'nor', 'for', 'of', 'on', 'in', 'at', 'to', 'by', 'as', 'vs', 'via', 'with', 'from', 'into', 'de', 'del', 'du', 'des', 'et']);
const ACRONYMS = new Set(['USA', 'UFO', 'UFOS', 'NASA', 'CIA', 'SECS', 'SIFF', 'IMAX', 'LGBTQ', 'LGBTQIA', 'OK']);
const ABBR = new Set(['mr', 'mrs', 'ms', 'dr', 'st', 'jr', 'sr', 'vs', 'pt', 'mt', 'ft', 'lt', 'sgt']);
const ROMAN = /^(?=[IVX]{2,}$)X{0,3}(?:IX|IV|V?I{0,3})$/;

// ALL-CAPS -> Title Case. Mixed-case titles are left alone.
function titleCase(str) {
  if (!str || /\p{Ll}/u.test(str)) return str;
  const tokens = str.split(/(\s+)/);
  const words = tokens.map((t, i) => (/\S/.test(t) ? i : -1)).filter((i) => i >= 0);
  const first = words[0];
  const last = words[words.length - 1];
  let afterBreak = true;
  return tokens
    .map((tok, i) => {
      if (!/\S/.test(tok)) return tok;
      const out = caseWord(tok, afterBreak || i === first || i === last);
      afterBreak = /[:!?.–—]$/.test(tok) || tok === '-';
      return out;
    })
    .join('');
}

function caseWord(tok, forceCap) {
  const [, pre, core, post] = tok.match(/^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u);
  if (!core) return tok;
  if (/^(\p{L}\.)+\p{L}?$/u.test(core)) return tok; // A.S.
  if (ACRONYMS.has(core) || ROMAN.test(core)) return tok;
  if (/^\d+[A-Z]$/.test(core)) return tok; // 3D, 4K
  if (/^\d+MM$/.test(core)) return pre + core.toLowerCase() + post; // 35mm
  const letters = core.replace(/[^\p{L}]/gu, '');
  if (letters.length >= 2 && !/[AEIOUYÀ-ÆÈ-ÏÒ-ÖØ-Ý]/.test(letters) && !ABBR.has(core.toLowerCase())) return tok; // TV, VHS, RRR
  const lower = core.toLowerCase();
  if (!forceCap && SMALL.has(lower)) return pre + lower + post;
  const cased = lower
    .replace(/(^|[-/])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase())
    .replace(/^(\p{L})(['’])(\p{L})(\p{L})/u, (_, a, ap, b, c) => a + ap + b.toUpperCase() + c); // L’Amour, O’Brien
  return pre + cased + post;
}
