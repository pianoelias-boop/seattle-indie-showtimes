// Grand Illusion Cinema (grandillusioncinema.org).
//
// The site is a custom WordPress theme whose film posts aren't exposed in the
// REST API, and its Agile Ticketing pages sit behind bot protection, so:
//   1. The monthly calendar (/calendar/?month=YYYY-MM) is the index: each day
//      cell lists buttons with the film's post id, title and times.
//   2. Film details come from "film cards": director · year, runtime ·
//      format, the ticket link, the screening location and the description.
//      The homepage has one for every film under Now Playing / Coming Soon;
//      any calendar film not there gets its own page (/?p=ID redirects to it).
//
// Between homes, the Grand Illusion runs pop-ups, mostly at SIFF Film Center.
// Screenings anywhere else get an "At <venue>" note.

import * as cheerio from 'cheerio';
import { getText, mapLimit } from '../lib/http.js';
import { seattleISO, parseClock, parseDate, seattleToday } from '../lib/time.js';
import { cleanText, oneLine, absUrl } from '../lib/text.js';

const ID = 'grand-illusion';
const BASE = 'https://grandillusioncinema.org';
const WINDOW_DAYS = 35;
// Where screenings need no venue note. When the Varsity reopens as the
// Grand Illusion's home (and theaters.js moves the theater there), change
// this to /Varsity/i.
const HOME_VENUE = /SIFF Film Center/i;

const pad = (n) => String(n).padStart(2, '0');
const dayKey = ({ y, m, d }) => `${y}-${pad(m)}-${pad(d)}`;

function addDays({ y, m, d }, n) {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

// ---------- titles ----------

const SMALL_WORDS = new Set(['a', 'an', 'the', 'and', 'but', 'or', 'nor', 'for', 'of', 'on', 'in', 'at', 'to', 'by', 'with', 'from', 'as', 'vs', 'vs.', 'via']);

// 'NIGHT OF THE LIVING DEAD' -> 'Night of the Living Dead'. Leaves anything
// with lower-case letters alone.
function fixAllCaps(title) {
  if (!/[A-Z]/.test(title) || /[a-z]/.test(title)) return title;
  const words = title.toLowerCase().split(/(\s+)/);
  let idx = 0;
  const count = words.filter((w) => w.trim()).length;
  return words
    .map((w) => {
      if (!w.trim()) return w;
      const i = idx++;
      if (/^(?=[ivxlc]+$)m*(c[md]|d?c{0,3})(x[cl]|l?x{0,3})(i[xv]|v?i{0,3})$/.test(w.replace(/[^a-z]/g, '')) && w.replace(/[^a-z]/g, '').length > 1) {
        return w.toUpperCase(); // roman numerals: II, III, IV
      }
      if (/^([a-z]\.){2,}$/.test(w)) return w.toUpperCase(); // I.K.U.
      if (i > 0 && i < count - 1 && SMALL_WORDS.has(w)) return w;
      return w.replace(/(^|[-/(“"'‘])([a-z])/g, (_, p, c) => p + c.toUpperCase());
    })
    .join('');
}

const sentenceCase = (s) => {
  const t = s.trim().replace(/[!]+$/, '').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : t;
};

// Split a Grand Illusion post title into the film's title and notes about
// this presentation: 'The Most Dangerous Game (1932) plus shorts, on 16mm'
// -> { title: 'The Most Dangerous Game', notes: ['16mm', 'Plus shorts'], year: 1932 }.
export function cleanTitle(raw) {
  let t = oneLine(raw).replace(/\s+/g, ' ');
  const notes = [];
  let year;
  const take = (re, toNote) => {
    const m = t.match(re);
    if (!m) return false;
    t = (t.slice(0, m.index) + t.slice(m.index + m[0].length)).trim();
    const n = toNote(m);
    if (n) notes.push(n);
    return true;
  };

  // Series / presentation prefixes.
  take(/^outdoor (?:movie|screening)\s*:\s*/i, () => 'Outdoor screening');
  take(/^(?:the )?grand illusion (?:cinema )?presents\s*:?\s*/i, () => null);

  // Trailing add-ons, peeled off one at a time from the end.
  for (let guard = 0; guard < 6; guard++) {
    const before = t;
    // ', on 16mm' / ' in 35mm' / ' on 35mm film'
    take(/[\s,]+(?:in|on)\s+((?:35|16|70|8)\s?mm|super\s?8|vhs)(?:\s+film)?\s*$/i, (m) => m[1].replace(/\s/g, '').replace(/^super8$/i, 'Super 8').replace(/^vhs$/i, 'VHS'));
    // ' – New 4K Restoration' / ' – 35mm double feature' / ' - Open Caption'
    take(/\s+[–—-]\s+((?:new\s+)?(?:\d+k\s+)?restor(?:ation|ed)|(?:35|16|70)mm[^–—-]*|open[ -]caption(?:ed)?|double feature|triple feature|director[’']s cut|final cut)\s*$/i, (m) => sentenceCase(m[1].toLowerCase()).replace(/(\d+)k\b/i, '$1K'));
    // '(New 4K Restoration)' / '(35mm)' / '(Open Caption)'
    take(/\s*\(((?:new\s+)?(?:\d+k\s+)?restor(?:ation|ed)|(?:35|16|70)\s?mm|open[ -]caption(?:ed)?)\)\s*$/i, (m) => sentenceCase(m[1].toLowerCase()).replace(/(\d+)k\b/i, '$1K'));
    // ': The Director's Cut' / ': Final Cut'
    take(/\s*:\s*(?:the\s+)?(director[’']s|final|extended|uncut)\s+cut\s*$/i, (m) => sentenceCase(`${m[1].toLowerCase()} cut`));
    // '(with Climax Golden Twins!)' / '(Q&A with the director)'
    take(/\s*\(((?:with|plus|followed by|featuring|feat\.)\s[^()]+|[^()]*\bq\s?&\s?a\b[^()]*|[^()]*\bin person\b[^()]*|live [^()]+)\)\s*$/i, (m) => sentenceCase(m[1]));
    // ' + Q&A' / ' plus shorts' / ' with live score'
    take(/\s*\+\s+([^+]+)$/, (m) => (/^(?:q\s?&\s?a|discussion|panel|live|intro|shorts?)\b/i.test(m[1]) ? sentenceCase(m[1]) : sentenceCase(`with ${m[1]}`)));
    take(/,?\s+plus\s+((?:selected\s+|spooky\s+|bonus\s+)?shorts?\b.*|(?:a\s+)?short film.*|q\s?&\s?a.*|discussion.*|live\s.*|special guests?.*|intro.*|bonus.*)$/i, (m) => sentenceCase(`plus ${m[1]}`));
    take(/,?\s+with\s+(live\s+[^,]+|q\s?&\s?a[^,]*|special guests?[^,]*)$/i, (m) => sentenceCase(m[1]));
    // '(1932)' -> year hint
    take(/\s*\(((?:18|19|20)\d\d)\)\s*$/, (m) => {
      year = +m[1];
      return null;
    });
    t = t.replace(/[\s,:;–—-]+$/, '').trim();
    if (t === before) break;
  }

  if (!t) t = oneLine(raw); // never strip a title down to nothing
  return { title: fixAllCaps(t), notes, year };
}

// ---------- film page ----------

const FILM_FORMAT = /^((?:35|16|70|8)\s?mm|super\s?8|vhs|nitrate)$/i;

function isPullQuote(text) {
  const t = text.replace(/^critic[’']s pick!?\s*/i, '').trim();
  if (!/^[“"]/.test(t)) return false;
  const close = Math.max(t.lastIndexOf('”'), t.lastIndexOf('"'));
  if (close < 10) return false;
  const attribution = t.slice(close + 1).trim();
  return attribution.length <= 100 && close / t.length > 0.5;
}

// One "film card" (the homepage lists one per current film; a film page has
// one). og is the page's og:image, used on film pages for a full-size poster.
function parseCard($, card, pageUrl, og) {
  const film = {};
  const notes = [];

  const titleLink = card.find('.film-card--title a').first();
  const url = absUrl(titleLink.attr('href'), pageUrl) || pageUrl;

  // 'Tsui Hark · 1980' and '96min · DCP' (either may be missing).
  card.find('.film-card--film-info > div').each((_, el) => {
    for (let part of $(el).text().split('·')) {
      part = oneLine(part).replace(/\s*\(and others\)\s*/gi, ' ').trim();
      if (!part) continue;
      let m;
      if ((m = part.match(/^(\d{1,3})\s*min/i))) film.runtime = +m[1];
      else if ((m = part.match(/^(\d+)\s*h(?:r|ours?)?\s*(\d+)?\s*m?/i)) && !film.runtime) film.runtime = +m[1] * 60 + (+m[2] || 0);
      else if ((m = part.match(/^((?:18|19|20)\d\d)\b/))) film.year = +m[1];
      else if (FILM_FORMAT.test(part)) notes.push(part.replace(/\s/g, '').replace(/^vhs$/i, 'VHS').replace(/^super8$/i, 'Super 8'));
      else if (/^(?:4k\s+)?(?:dcp|digital|blu-?ray|dvd|video|hd)$/i.test(part)) continue;
      // A director starts with a letter ('1960s, 70s, and 80s' is not one).
      else if (!film.director && /^\p{L}/u.test(part) && !/^(?:various|tba|tbd|n\/a)$/i.test(part)) film.director = part;
    }
  });

  // Poster: a film page's og:image is the full-size featured image, unless
  // the film has none and it falls back to the site-wide share image.
  const cardImg = absUrl(card.find('.film-card--poster img').first().attr('src'), pageUrl);
  if (og && /\/wp-content\/uploads\//.test(og) && !/grand-illusion-cinema-og/i.test(og)) film.image = og;
  else if (cardImg) film.image = cardImg;

  const tickets = absUrl(card.find('.film-card--buy-tickets a').attr('href'), pageUrl);

  // 'Screening location: Central Cinema – 1411 21st Ave, Seattle'
  let venue;
  card.find('.film-card--screening-info p, .film-card--screening-info div').each((_, el) => {
    const text = oneLine($(el).text());
    const m = text.match(/screening location:\s*(.+)/i);
    if (m && !venue) venue = m[1];
  });

  // Description: the synopsis paragraphs, minus pull quotes; the subtitle line
  // becomes the language.
  const paras = [];
  card.find('.film-card--description')
    .children()
    .each((_, el) => {
      const text = cleanText($(el).text());
      if (!text) return;
      const lang = text.match(/^in ([A-Z][^.]{1,60}?) with (?:English )?subtitles\.?$/i) || text.match(/^in ([A-Z][a-z]+(?:(?:,| and) [A-Z][a-z]+)*)\.?$/);
      if (lang) {
        film.language = lang[1].replace(/\s+and\s+/g, ', ');
        return;
      }
      if (isPullQuote(text)) return;
      paras.push(text);
    });
  if (!paras.length) {
    const text = cleanText(card.find('.film-card--description').text());
    if (text) paras.push(text);
  }
  if (paras.length) film.description = paras.join('\n\n');

  // The card's own screening list ('Saturday, Oct 3, 2026, 5:30pm'), to check
  // a homepage card against a calendar entry.
  const days = new Set();
  card.find('.screenings-list li').each((_, el) => {
    const d = parseDate($(el).text());
    if (d) days.add(dayKey(d));
  });

  return { url, title: oneLine(titleLink.text()), film, notes, tickets, venue, days };
}

// All film cards on a page.
export function parseFilmCards(html, pageUrl) {
  const $ = cheerio.load(html);
  const og = absUrl($('meta[property="og:image"]').attr('content'), pageUrl);
  const cards = $('.film-card').toArray();
  return cards.map((el) => parseCard($, $(el), pageUrl, cards.length === 1 ? og : undefined));
}

function venueNote(venue) {
  if (!venue || HOME_VENUE.test(venue)) return null;
  const name = venue.split(/\s+[–—-]\s+|,|\(/)[0].trim();
  if (!name) return null;
  return `At ${name.replace(/^The\s+/i, 'the ')}`;
}

// ---------- calendar ----------

function monthsToFetch(from, to) {
  const out = [];
  let y = from.y;
  let m = from.m;
  while (y < to.y || (y === to.y && m <= to.m)) {
    out.push(`${y}-${pad(m)}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

// -> [{ filmId, title, date: {y,m,d}, times: [{hh,mm}] }]
export function parseCalendar(html) {
  const $ = cheerio.load(html);
  const cal = $('ul.calendar, .calendar--monthly').first();
  if (!cal.length || !cal.find('li.day').length) {
    throw new Error('Grand Illusion: calendar structure not recognized');
  }
  const out = [];
  cal.find('li.day').each((_, day) => {
    const dateText = oneLine($(day).find('.date-display--day__full').first().text());
    if (!dateText) return; // empty padding cells
    const date = parseDate(dateText);
    if (!date) return;
    $(day)
      .find('.films-display .film, button[data-filmid]')
      .each((_, btn) => {
        const b = $(btn);
        const filmId = b.attr('data-filmid');
        const title = oneLine(b.find('.film-title').text()) || oneLine(b.text());
        const timeText = oneLine(b.find('.film-times').text());
        const times = (timeText.match(/\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?)/gi) || []).map(parseClock).filter(Boolean);
        if (!title) return;
        out.push({ filmId, title, date, times, timeText });
      });
  });
  return out;
}

export default {
  id: ID,
  async scrape() {
    const today = seattleToday();
    const last = addDays(today, WINDOW_DAYS);
    const fromKey = dayKey(today);
    const toKey = dayKey(last);

    // 1. The calendar months covering the window.
    const entries = [];
    for (const month of monthsToFetch(today, last)) {
      const html = await getText(`${BASE}/calendar/?month=${month}`);
      for (const e of parseCalendar(html)) {
        const k = dayKey(e.date);
        if (k >= fromKey && k <= toKey) entries.push(e);
      }
    }

    // 2. Film details. The homepage has a full card for every film under Now
    // Playing and Coming Soon; a card counts for a calendar film when the
    // title matches and it lists the same dates. Anything else gets its own
    // film page. A failure here only costs details.
    const key = (t) => oneLine(t).toLowerCase().replace(/[’‘]/g, "'").replace(/[–—]/g, '-');
    const homeCards = new Map();
    try {
      for (const c of parseFilmCards(await getText(`${BASE}/`), `${BASE}/`)) {
        if (c.title && !homeCards.has(key(c.title))) homeCards.set(key(c.title), c);
      }
    } catch (err) {
      console.warn(`[${ID}] homepage: ${err.message}`);
    }
    const filmKey = (e) => e.filmId || `title:${key(e.title)}`;
    const details = new Map();
    const byFilm = new Map();
    for (const e of entries) {
      if (!byFilm.has(filmKey(e))) byFilm.set(filmKey(e), []);
      byFilm.get(filmKey(e)).push(e);
    }
    const missing = [];
    for (const [id, list] of byFilm) {
      const c = homeCards.get(key(list[0].title));
      if (c && (!c.days.size || list.every((e) => c.days.has(dayKey(e.date))))) details.set(id, c);
      else if (/^\d+$/.test(id)) missing.push(id);
    }
    await mapLimit(missing, 3, async (id) => {
      try {
        const url = `${BASE}/?p=${encodeURIComponent(id)}`;
        const [card] = parseFilmCards(await getText(url), url);
        if (card) details.set(id, card);
      } catch (err) {
        console.warn(`[${ID}] film ${id}: ${err.message}`);
      }
    });

    // 3. Screenings.
    const seen = new Set();
    const screenings = [];
    for (const e of entries) {
      try {
        const d = details.get(filmKey(e));
        const cleaned = cleanTitle(d?.title || e.title);
        const film = { ...(d?.film || {}) };
        if (!film.year && cleaned.year) film.year = cleaned.year;
        for (const k of Object.keys(film)) if (film[k] == null || film[k] === '') delete film[k];

        const notes = [...cleaned.notes];
        for (const n of d?.notes || []) if (!notes.some((x) => x.toLowerCase().includes(n.toLowerCase()))) notes.push(n);
        const vn = venueNote(d?.venue);
        if (vn) notes.push(vn);

        if (!e.times.length) {
          console.warn(`[${ID}] no time for "${e.title}" on ${dayKey(e.date)} ("${e.timeText}")`);
          continue;
        }
        for (const { hh, mm } of e.times) {
          const start = seattleISO(e.date.y, e.date.m, e.date.d, hh, mm);
          const dedupe = `${filmKey(e)}|${start}`;
          if (seen.has(dedupe)) continue;
          seen.add(dedupe);
          const s = {
            theater: ID,
            title: cleaned.title,
            start,
            url: d?.url || `${BASE}/calendar/`,
          };
          if (d?.tickets) s.tickets = d.tickets;
          if (notes.length) s.notes = notes;
          if (Object.keys(film).length) s.film = film;
          screenings.push(s);
        }
      } catch (err) {
        console.warn(`[${ID}] skipped "${e.title}": ${err.message}`);
      }
    }
    screenings.sort((a, b) => a.start.localeCompare(b.start));
    return screenings;
  },
};
