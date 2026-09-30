// Northwest Film Forum (nwfilmforum.org).
//
// Sources, in order of authority:
//   1. The website calendar (/calendar/?start=YYYY-MM-DD, one week per page)
//      is the index. Each entry carries schema.org microdata (name, page URL,
//      start time, duration), a film/event type, and per-showing attribute
//      icons (Visiting Artist, On Film, Live Music, Discussion). Workshops,
//      classes and talks are dropped here.
//   2. NWFF sells tickets on Eventive. Its public API (the key is read from
//      Eventive's own tenant script) gives each showing's id, for a direct
//      ticket link, and clean film records: director, year, country,
//      language, runtime, synopsis, images. Matched to the calendar by start
//      time and name.
//   3. For anything Eventive doesn't cover, the NWFF film/event page itself
//      (Movie microdata, the "About" text, the ticket button).

import * as cheerio from 'cheerio';
import { getText, getJSON, mapLimit } from '../lib/http.js';
import { localStringToISO, toSeattleISO, seattleToday } from '../lib/time.js';
import { htmlToText, cleanText, oneLine, absUrl } from '../lib/text.js';

const ID = 'nwff';
const BASE = 'https://nwfilmforum.org';
const EVENTIVE_SITE = 'https://nwfilmforum.eventive.org';
const EVENTIVE_API = 'https://api.eventive.org';
const WINDOW_DAYS = 35;
const HOME_VENUE = /northwest film forum|\bnwff\b/i;

const pad = (n) => String(n).padStart(2, '0');
function addDays({ y, m, d }, n) {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
const dayKey = ({ y, m, d }) => `${y}-${pad(m)}-${pad(d)}`;
const toInt = (v) => {
  const n = parseInt(String(v ?? '').replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : undefined;
};
const validYear = (y) => (Number.isInteger(y) && y > 1880 && y < 2100 ? y : undefined);
const validRuntime = (r) => (Number.isInteger(r) && r > 0 && r < 1000 ? r : undefined);

// 'PT118M' / 'PT1H58M' -> 118
function isoDuration(s) {
  const m = String(s || '').match(/^PT(?:(\d+)H)?(?:(\d+)M)?/i);
  if (!m || (!m[1] && !m[2])) return undefined;
  return validRuntime((+m[1] || 0) * 60 + (+m[2] || 0));
}
// '1h 58m' / '118 min' / '82 min TRT' -> minutes
function textRuntime(s) {
  let m = String(s).match(/(\d+)\s*h(?:rs?|ours?)?\.?\s*(?:(\d+)\s*m)?/i);
  if (m) return validRuntime(+m[1] * 60 + (+m[2] || 0));
  m = String(s).match(/(\d+)\s*(?:min|mins|minutes|m)\b/i);
  if (m) return validRuntime(+m[1]);
  return undefined;
}

// ---------- titles ----------

const SMALL_WORDS = new Set(['a', 'an', 'the', 'and', 'but', 'or', 'nor', 'for', 'of', 'on', 'in', 'at', 'to', 'by', 'with', 'from', 'as', 'vs', 'vs.', 'via']);

function fixAllCaps(title) {
  if (!/[A-Z]/.test(title) || /[a-z]/.test(title)) return title;
  const words = title.toLowerCase().split(/(\s+)/);
  const count = words.filter((w) => w.trim()).length;
  let idx = 0;
  return words
    .map((w) => {
      if (!w.trim()) return w;
      const i = idx++;
      const letters = w.replace(/[^a-z]/g, '');
      if (letters.length > 1 && /^m*(c[md]|d?c{0,3})(x[cl]|l?x{0,3})(i[xv]|v?i{0,3})$/.test(letters)) return w.toUpperCase();
      if (/^([a-z]\.){2,}$/.test(w)) return w.toUpperCase();
      if (i > 0 && i < count - 1 && SMALL_WORDS.has(w)) return w;
      return w.replace(/(^|[-/(“"'‘])([a-z])/g, (_, p, c) => p + c.toUpperCase());
    })
    .join('');
}

const sentenceCase = (s) => {
  const t = String(s).trim().replace(/!+$/, '').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : t;
};
const fmtRestoration = (s) => sentenceCase(s.toLowerCase()).replace(/(\d+)k\b/i, '$1K');

// Series and presenter prefixes: 'NWFF Presents: X', 'Earshot Jazz Presents: X',
// 'TRAUMA BOND: X', 'STUFF 2026: X', 'SFCS at 10: X', 'Staff Selects - X'.
const KNOWN_SERIES = /^(?:SFCS at \d+|Truth to Fiction|Staff Selects|WTF with STUFF|Unstreamable|Animation Domination|Mourning Sickness(?: Vol\.? ?\d+)?|Trauma Bond|Local Sightings(?: (?:19|20)\d\d)?|STUFF(?: (?:19|20)\d\d)?)\s*(?::|\s[-–—])\s*/i;
const PRESENTS = /^(?:[\p{L}\d'’&.,! ]{2,50}?\s)?presents?\s*(?::|\s[-–—])\s*/iu;
const KNOWN_PRESENTER = /^(?:NWFF|Northwest Film Forum|Three Dollar Bill Cinema)\s+presents?\s+/i;
// An all-caps series name of two or more words, or with a year: 'TRAUMA BOND: '.
const CAPS_SERIES = /^((?:[A-Z0-9][A-Z0-9'’&.!]*\s+)+[A-Z0-9][A-Z0-9'’&.!]*)\s*(?::|\s[-–—])\s+(?=\S)/;

function stripPrefix(t) {
  for (let guard = 0; guard < 3; guard++) {
    const before = t;
    t = t.replace(KNOWN_SERIES, '').replace(PRESENTS, '').replace(KNOWN_PRESENTER, '');
    const m = t.match(CAPS_SERIES);
    if (m && /[A-Z]{2}/.test(m[1])) t = t.slice(m[0].length);
    if (t === before) break;
  }
  return t.trim();
}

// Peel format and event add-ons off the end of a title into notes.
function peel(raw) {
  let t = oneLine(raw);
  const notes = [];
  const take = (re, toNote) => {
    const m = t.match(re);
    if (!m) return false;
    t = t.slice(0, m.index).trim();
    const n = toNote(m);
    if (n) notes.unshift(n);
    return true;
  };
  for (let guard = 0; guard < 6; guard++) {
    const before = t;
    take(/[\s,]+(?:in|on)\s+((?:35|16|70|8)\s?mm|super\s?8|vhs)(?:\s+film)?\s*$/i, (m) => m[1].replace(/\s/g, '').replace(/^vhs$/i, 'VHS').replace(/^super8$/i, 'Super 8'));
    take(/\s*\(((?:new\s+)?(?:\d+k\s+)?restor(?:ation|ed))\)\s*$/i, (m) => fmtRestoration(m[1]));
    take(/\s+[–—-]\s+((?:new\s+)?(?:\d+k\s+)?restor(?:ation|ed))\s*$/i, (m) => fmtRestoration(m[1]));
    take(/\s*[(\[]((?:35|16|70)\s?mm|open[ -]caption(?:ed|s)?|(?:with )?captions?|(?:(?:19|20)\d\d\s+)?(?:extended|director[’']s|final|uncut|restored)\s+(?:cut|version|edition))[)\]]\s*$/i, (m) => sentenceCase(m[1].toLowerCase()));
    take(/\s+[–—-]\s+(open[ -]caption(?:ed|s)?|(?:35|16|70)mm[^–—-]*|double feature|director[’']s cut)\s*$/i, (m) => sentenceCase(m[1].toLowerCase()));
    take(/\s*\(((?:with|plus|followed by|featuring|feat\.)\s[^()]+|[^()]*\bq\s?&\s?a\b[^()]*|[^()]*\bin[- ]person\b[^()]*|live [^()]+)\)\s*$/i, (m) => sentenceCase(m[1]));
    take(/\s*\+\s*([^+]+)$/, (m) => (/^(q\s?&\s?a|discussion|panel|live|conversation|intro|shorts?)\b/i.test(m[1]) ? sentenceCase(m[1]) : `With ${m[1].trim()}`));
    take(/,?\s+with\s+(live\s+[^,]+|q\s?&\s?a[^,]*|special guests?[^,]*|director[^,]*|filmmakers?[^,]*)$/i, (m) => sentenceCase(m[1]));
    t = t.replace(/[\s,:;–—-]+$/, '').trim();
    if (t === before) break;
  }
  return { title: t || oneLine(raw), notes };
}

// ' (4K Restoration)' -> ['4K restoration'], ' + Objectionable Fruit' ->
// ['With Objectionable Fruit'], " with Charlie's Queer Books" -> ["With Charlie's Queer Books"].
function suffixNotes(suffix) {
  const s = oneLine(suffix);
  if (!s) return [];
  const peeled = peel(`X ${s}`);
  if (peeled.title === 'X') return peeled.notes;
  let t = s.replace(/^[\s:–—-]+/, '').trim();
  if (/^\(.*\)$/.test(t)) t = t.slice(1, -1).trim();
  if (!t) return [];
  if (/^restor/i.test(t) || /\bk restoration$/i.test(t)) return [fmtRestoration(t)];
  return [sentenceCase(t.replace(/^\+\s*/, 'with '))];
}

// Normalize for comparing titles; keeps string length so indexes line up.
const norm = (s) => s.toLowerCase().replace(/[’‘`]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/\s/g, ' ');

// The film's title plus notes, from the calendar name and (when Eventive
// matched a single film) Eventive's cleaner film name.
function deriveTitle(siteName, eventiveFilmName) {
  const site = oneLine(siteName);
  if (eventiveFilmName) {
    const fn = stripPrefix(oneLine(eventiveFilmName));
    const i = fn ? norm(site).indexOf(norm(fn)) : -1;
    if (i >= 0) {
      const prefix = site.slice(0, i);
      const suffix = site.slice(i + fn.length);
      const prefixOk = !prefix.trim() || /(?::|[-–—]|presents?)\s*$/i.test(prefix);
      const suffixOk = !suffix.trim() || /^\s*(?:\(|\[|\+|[-–—]\s|with\b|plus\b|in\b|on\b|&)/i.test(suffix);
      if (prefixOk && suffixOk) {
        const p = peel(fn);
        return { title: fixAllCaps(p.title), notes: [...p.notes, ...suffixNotes(suffix)] };
      }
    }
  }
  const p = peel(stripPrefix(site));
  return { title: fixAllCaps(p.title), notes: p.notes };
}

// ---------- descriptions ----------

// '(Yasujirō Ozu, 1958, Japan, 118 min, in Japanese with English subtitles)'
function parseCreditLine(line) {
  let inner = line.replace(/^\(|\)$/g, '');
  const out = {};
  // 'in English, Spanish, and Italian with English Subtitles' runs to the end.
  const lang = inner.match(/(?:^|,\s*)in ([^()]+?)(?:\s+with [^()]*subtitles?)?\s*$/i);
  if (lang) {
    out.language = lang[1].replace(/,?\s+and\s+/g, ', ').replace(/\s*,\s*/g, ', ').trim();
    inner = inner.slice(0, lang.index);
  }
  const parts = inner.split(/,\s*(?![^()]*\))/).map((p) => p.trim()).filter(Boolean);
  const rest = [];
  for (const p of parts) {
    let m;
    if ((m = p.match(/^((?:18|19|20)\d\d)$/))) out.year = +m[1];
    else if (/^\d+\s*(?:h|min|m\b)|^\d+h\s*\d+m|\bTRT\b/i.test(p)) out.runtime = textRuntime(p);
    else rest.push(p);
  }
  if (rest.length && rest.length <= 3) {
    out.director = rest[0];
    if (rest[1]) out.country = rest[1];
  }
  return out;
}

const BOILERPLATE = [
  /^(?:synopsis|description|text|copy|image)s? (?:courtesy|provided) (?:of|by)\b/i,
  /^\$\d/,
  /^(?:general admission|tickets?\b|rsvp\b|purchase\b|buy tickets\b)/i,
];

// Plain-text synopsis from an HTML description. Returns the text and the
// facts found in a leading credit line.
function cleanDescription(html) {
  const text = htmlToText(html || '');
  if (!text) return { text: '', credits: {} };
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  let credits = {};
  if (paras.length && /^\([^()]*(?:\([^()]*\)[^()]*)*\)$/.test(paras[0]) && paras[0].length < 300) {
    credits = parseCreditLine(paras.shift());
  }
  const kept = paras.filter((p) => !(p.length < 300 && BOILERPLATE.some((re) => re.test(p))));
  return { text: kept.join('\n\n'), credits };
}

const titleCaseWords = (s) => s.replace(/\b([a-z])/g, (c) => c.toUpperCase());
const GENRE_TAGS = { documentary: 'Documentary', experimental: 'Experimental', animation: 'Animation', animated: 'Animation', shorts: 'Shorts', horror: 'Horror', comedy: 'Comedy', drama: 'Drama', musical: 'Musical' };

function filmFromEventive(ev) {
  const films = (ev.films || []).filter(Boolean);
  const film = {};
  if (films.length === 1) {
    const f = films[0];
    const d = f.details || {};
    const c = f.credits || {};
    const desc = cleanDescription(f.description || ev.description);
    film.description = desc.text || undefined;
    film.runtime = validRuntime(toInt(d.runtime)) ?? desc.credits.runtime;
    film.year = validYear(toInt(d.year)) ?? validYear(desc.credits.year);
    film.director = oneLine(c.director || '') || desc.credits.director;
    const country = oneLine(d.country || '') || desc.credits.country;
    if (country) film.country = /[A-Z]/.test(country) ? country : titleCaseWords(country);
    const lang = oneLine(d.language || '') || desc.credits.language;
    if (lang && !/^(?:no(?:ne| language| dialogue)?|n\/a|silent)$/i.test(lang)) film.language = lang;
    const genres = [...new Set((Array.isArray(f.tags) ? f.tags : []).map((t) => GENRE_TAGS[String(t.name || '').toLowerCase()]).filter(Boolean))];
    if (genres.length) film.genres = genres;
    film.image = f.still_image || (f.poster_image ? f.poster_image.replace(/\?.*$/, '') : undefined);
  } else if (films.length > 1) {
    const parts = films.map((f) => {
      const t = cleanDescription(f.description).text;
      return t ? `${oneLine(f.name)}\n${t}` : '';
    });
    const joined = parts.filter(Boolean).join('\n\n') || cleanDescription(ev.description).text;
    if (joined) film.description = joined;
    const img = films.find((f) => f.still_image)?.still_image;
    if (img) film.image = img;
  } else {
    const t = cleanDescription(ev.description).text;
    if (t) film.description = t;
  }
  return film;
}

// ---------- NWFF film / event page (fallback) ----------

export function parseNwffPage(html, pageUrl) {
  const $ = cheerio.load(html);
  const film = {};
  const movie = $('[itemtype$="schema.org/Movie"]').first();
  const meta = (scope, prop) => oneLine(scope.children(`meta[itemprop="${prop}"]`).attr('content') || '');
  if (movie.length) {
    film.runtime = isoDuration(meta(movie, 'duration'));
    film.year = validYear(toInt(meta(movie, 'copyrightYear')));
    film.country = meta(movie, 'country') || undefined;
    film.director = meta(movie, 'director') || undefined;
  }
  if (!film.runtime) {
    $('.film-details__item').each((_, el) => {
      const r = textRuntime($(el).text());
      if (r && !film.runtime) film.runtime = r;
    });
  }
  const about = $('[itemprop="about"]').first();
  const desc = cleanDescription(about.html() || '');
  if (desc.text) film.description = desc.text;
  for (const k of ['director', 'country', 'language', 'year', 'runtime']) {
    if (film[k] == null && desc.credits[k] != null) film[k] = desc.credits[k];
  }
  const og = $('meta[property="og:image"]').attr('content');
  if (og) film.image = absUrl(og, pageUrl);
  const offer = $('a[itemprop="url"].button, [itemtype$="schema.org/Offer"] meta[itemprop="url"]').first();
  const tickets = absUrl(offer.attr('href') || offer.attr('content'), pageUrl);
  return { film, tickets: tickets && /^https?:/.test(tickets) ? tickets : undefined };
}

// ---------- calendar ----------

// Workshops, classes, talks and the like. Only applied to calendar entries
// that aren't in NWFF's "films" section.
const NON_FILM = /\b(?:discussion group|book club|reading group|workshops?|class(?:es)?|course|lectures?|panel|artist talk|gala|fundraiser|auction|mixer|meet-?up|happy hour|open house|office hours|orientation|info(?:rmation)? session|networking|trivia|karaoke|potluck|volunteer)\b/i;
const NON_FILM_PATH = /^\/(?:education|workshops?|youth|classes|camps?)\//i;

export function parseCalendarWeek(html) {
  const $ = cheerio.load(html);
  if (!$('[component-calendar-list], .calendar__grid, .calendar__day-list').length) {
    throw new Error('NWFF: calendar structure not recognized');
  }
  const labels = {};
  $('[component-calendar-attribute-filter]').each((_, el) => {
    const key = $(el).attr('component-calendar-attribute-filter');
    const name = oneLine($(el).find('.attribute-calendar-filters__item__name').text());
    if (key && name) labels[key] = name;
  });
  const items = [];
  $('.calendar__item').each((_, el) => {
    const it = $(el);
    const link = it.find('a.calendar__item__link').first();
    const url = absUrl(link.attr('href') || it.find('meta[itemprop="url"], meta[itemprop="mainEntityOfPage"]').first().attr('content'), BASE);
    const name = oneLine(link.text()) || oneLine(it.find('meta[itemprop="name"]').first().attr('content') || '') || oneLine(it.find('.calendar-popup__title').text());
    const startDate = it.find('meta[itemprop="startDate"]').first().attr('content') || '';
    const type = it.hasClass('calendar__item--film') ? 'film' : it.hasClass('calendar__item--event') ? 'event' : oneLine(it.find('.calendar-popup__type').text()).toLowerCase() || 'other';
    const attrs = [];
    it.find('.calendar-popup__attributes .attribute-icon, .calendar-popup__attributes i').each((_, i) => {
      const cls = ($(i).attr('class') || '').split(/\s+/).find((c) => c.startsWith('icon-'));
      if (!cls) return;
      const key = cls.slice(5);
      const label = labels[key] || key.replace(/_/g, ' ');
      attrs.push(sentenceCase(label.toLowerCase()));
    });
    items.push({
      url,
      name,
      type,
      startDate,
      runtime: isoDuration(it.find('meta[itemprop="duration"]').first().attr('content')),
      location: oneLine(it.find('[itemprop="location"] meta[itemprop="name"]').first().attr('content') || ''),
      image: absUrl(it.find('.calendar-popup [component-graceful-image-load]').first().attr('component-graceful-image-load'), BASE),
      attrs,
    });
  });
  return items;
}

function isScreening(item) {
  let path = '';
  try {
    path = new URL(item.url).pathname;
  } catch {
    /* no url */
  }
  if (NON_FILM_PATH.test(path)) return false;
  if (/^\/films?\//i.test(path) || item.type === 'film') return true;
  return !NON_FILM.test(item.name);
}

// ---------- Eventive ----------

// Eventive's web app embeds the tenant config (event bucket + public API key)
// in a per-tenant script; read it rather than hard-coding the key.
async function eventiveConfig() {
  const html = await getText(`${EVENTIVE_SITE}/`);
  const srcs = [...html.matchAll(/<script[^>]+src="([^"]+\.js)"/g)].map((m) => m[1]).filter((s) => !/stripe|global\.|embedded|cookieconsent/i.test(s));
  for (const src of srcs) {
    const js = await getText(absUrl(src, EVENTIVE_SITE));
    const bucket = js.match(/"event_bucket"\s*:\s*"([0-9a-f]{24})"/)?.[1];
    const key = js.match(/"api_key"\s*:\s*"([0-9a-f]{16,64})"/)?.[1];
    if (bucket && key) return { bucket, key };
  }
  throw new Error('Eventive tenant config not found');
}

async function eventiveEvents() {
  const { bucket, key } = await eventiveConfig();
  const data = await getJSON(`${EVENTIVE_API}/event_buckets/${bucket}/events?api_key=${key}&upcoming_only=true`);
  if (!Array.isArray(data?.events)) throw new Error('Eventive: unexpected response');
  return data.events;
}

const STOP = new Set(['the', 'a', 'an', 'and', 'of', 'in', 'on', 'with', 'at', 'to', 'for', 'presents', 'present', 'film', 'shorts', 'restoration', '4k', 'nwff']);
const tokens = (s) => new Set(norm(s).replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w && !STOP.has(w)));
function similarity(a, b) {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}

// ---------- scrape ----------

export default {
  id: ID,
  async scrape() {
    const today = seattleToday();
    const fromKey = dayKey(today);
    const toKey = dayKey(addDays(today, WINDOW_DAYS));

    // 1. Calendar weeks covering the window. (The site shows the week around
    // ?start=, sometimes starting a day early; stepping by 7 leaves no gaps.)
    const items = [];
    const seen = new Set();
    for (let off = 0; off <= WINDOW_DAYS; off += 7) {
      const html = await getText(`${BASE}/calendar/?start=${dayKey(addDays(today, off))}`);
      for (const it of parseCalendarWeek(html)) {
        if (!/T\d{1,2}:\d{2}/.test(it.startDate)) continue; // pass bundles with no time
        const start = localStringToISO(it.startDate);
        if (!start || !it.name) continue;
        const k = start.slice(0, 10);
        if (k < fromKey || k > toKey) continue;
        const key = `${it.url || it.name}|${start}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({ ...it, start });
      }
    }
    const screeningsIn = items.filter(isScreening);

    // 2. Eventive: per-showing ticket links and film records.
    let events = [];
    try {
      events = await eventiveEvents();
    } catch (err) {
      console.warn(`[${ID}] Eventive unavailable, using film pages: ${err.message}`);
    }
    const byStart = new Map();
    for (const ev of events) {
      if (!ev?.start_time) continue;
      const k = toSeattleISO(ev.start_time);
      if (!k) continue;
      if (!byStart.has(k)) byStart.set(k, []);
      byStart.get(k).push(ev);
    }
    for (const it of screeningsIn) {
      let best = null;
      let bestScore = 0;
      for (const ev of byStart.get(it.start) || []) {
        const names = [ev.name, ...(ev.films || []).map((f) => f?.name)].filter(Boolean);
        const score = Math.max(...names.map((n) => similarity(it.name, n)));
        if (score > bestScore) {
          best = ev;
          bestScore = score;
        }
      }
      if (best && bestScore >= 0.5) it.ev = best;
    }

    // 3. Per page: one title and one set of film details for all its showings.
    const pages = new Map();
    for (const it of screeningsIn) {
      const key = it.url || it.name;
      if (!pages.has(key)) pages.set(key, { name: it.name, url: it.url, items: [] });
      pages.get(key).items.push(it);
    }
    for (const p of pages.values()) {
      try {
        const ev = p.items.find((i) => i.ev?.films?.length === 1)?.ev || p.items.find((i) => i.ev)?.ev;
        p.ev = ev;
        p.film = ev ? filmFromEventive(ev) : {};
        const filmName = ev?.films?.length === 1 ? ev.films[0].name : undefined;
        Object.assign(p, deriveTitle(p.name, filmName));
      } catch (err) {
        // An odd Eventive record: fall back to the calendar name and the page.
        console.warn(`[${ID}] ${p.name}: ${err.message}`);
        p.ev = undefined;
        p.film = {};
        for (const i of p.items) i.ev = undefined;
        Object.assign(p, deriveTitle(p.name));
      }
    }

    // 4. NWFF pages for anything Eventive didn't cover.
    const needPage = [...pages.values()].filter((p) => p.url && (!p.ev || p.items.some((i) => !i.ev)));
    await mapLimit(needPage, 3, async (p) => {
      try {
        const got = parseNwffPage(await getText(p.url), p.url);
        p.pageTickets = got.tickets;
        for (const [k, v] of Object.entries(got.film)) if (p.film[k] == null && v != null && v !== '') p.film[k] = v;
      } catch (err) {
        console.warn(`[${ID}] ${p.url}: ${err.message}`);
      }
    });

    // Series blurbs pasted into every film of a series ("This Halloween series
    // is co-presented by…") aren't synopsis: drop long paragraphs that appear
    // in more than one film's description.
    const paraFilms = new Map();
    for (const p of pages.values()) {
      for (const para of new Set((p.film.description || '').split(/\n{2,}/))) {
        if (para.length < 80) continue;
        if (!paraFilms.has(para)) paraFilms.set(para, new Set());
        paraFilms.get(para).add(p.title.toLowerCase());
      }
    }
    for (const p of pages.values()) {
      if (!p.film.description) continue;
      const paras = p.film.description.split(/\n{2,}/);
      const kept = paras.filter((para) => !(paraFilms.get(para)?.size > 1));
      if (kept.length && kept.length < paras.length) p.film.description = kept.join('\n\n');
    }

    // 5. Screenings. Different pages for the same film (a series one-off and
    // a regular run) share the title, so fill details across them too.
    const byTitle = new Map();
    for (const p of pages.values()) {
      const k = p.title.toLowerCase();
      if (!byTitle.has(k)) byTitle.set(k, {});
      const acc = byTitle.get(k);
      for (const [f, v] of Object.entries(p.film)) if (acc[f] == null && v != null && v !== '') acc[f] = v;
    }

    const out = [];
    for (const p of pages.values()) {
      for (const it of p.items) {
        try {
          if (it.ev?.is_virtual) continue;
          const film = { ...byTitle.get(p.title.toLowerCase()), ...Object.fromEntries(Object.entries(p.film).filter(([, v]) => v != null && v !== '')) };
          if (it.image) film.image = it.image; // NWFF's own 1200px still
          if (!film.runtime && it.runtime && !(it.ev?.films?.length > 1)) film.runtime = it.runtime;
          for (const k of Object.keys(film)) if (film[k] == null || film[k] === '' || (Array.isArray(film[k]) && !film[k].length)) delete film[k];

          const notes = [...p.notes];
          for (const a of it.attrs) if (!notes.includes(a)) notes.push(a);
          const venue = it.location || it.ev?.venue?.name;
          if (venue && !HOME_VENUE.test(venue)) notes.push(`At ${venue.replace(/^The\s+/i, 'the ')}`);

          const s = { theater: ID, title: p.title, start: it.start, url: it.url || `${BASE}/calendar/` };
          const tickets = it.ev ? `${EVENTIVE_SITE}/schedule/${it.ev.id}` : p.pageTickets;
          if (tickets) s.tickets = tickets;
          if (notes.length) s.notes = notes;
          if (Object.keys(film).length) s.film = film;
          out.push(s);
        } catch (err) {
          console.warn(`[${ID}] skipped "${it.name}" ${it.start}: ${err.message}`);
        }
      }
    }
    out.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
    return out;
  },
};
