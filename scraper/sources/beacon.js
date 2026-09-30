// The Beacon (Columbia City) — thebeacon.film
//
// The site is a server-rendered Astro app with Square for ticketing; there is
// no public JSON API or feed. Two server-rendered pages carry everything:
//
//   /calendar                  every upcoming showtime (a month grid plus a
//                              day-by-day list), each with the film's page and
//                              a Square catalog id used as the ticket link.
//   /calendar/movie/<slug>     one per film: schema.org Movie JSON-LD (director,
//                              duration, year, image, and a ScreeningEvent with
//                              an exact UTC start for each showtime), the full
//                              synopsis, and the showtime rows with catalog ids.
//
// The calendar is the list of record (it has no years, so the film pages'
// JSON-LD settles those); anything a film page lists that the calendar missed
// is added too. "Rent the Beacon" slots on the calendar are private rentals
// and are skipped.

import * as cheerio from 'cheerio';
import { getText, mapLimit } from '../lib/http.js';
import { htmlToText, cleanText, oneLine, absUrl, jsonLd } from '../lib/text.js';
import { seattleISO, toSeattleISO, parseClock, parseDate, seattleToday } from '../lib/time.js';

const BASE = 'https://thebeacon.film';
const CALENDAR_URL = `${BASE}/calendar`;
const DAYS_AHEAD = 35;
const THEATER = 'beacon';

export default {
  id: THEATER,
  async scrape() {
    const html = await getText(CALENDAR_URL);
    const $ = cheerio.load(html);
    if (!$('.calendar-page, .cal-month, .cal-list').length) {
      throw new Error('beacon: calendar page structure not recognized');
    }

    const entries = parseCalendar($);
    const slugs = [...new Set(entries.map((e) => e.slug))];

    const pages = new Map();
    await mapLimit(slugs, 3, async (slug) => {
      try {
        const page = await getText(movieUrl(slug));
        pages.set(slug, parseMoviePage(page, slug));
      } catch (err) {
        console.warn(`beacon: couldn't load film page ${slug}: ${err.message}`);
      }
    });

    // slug -> Map(start ISO -> showing)
    const bySlug = new Map();
    const add = (slug, start, info) => {
      if (!bySlug.has(slug)) bySlug.set(slug, new Map());
      const m = bySlug.get(slug);
      if (!m.has(start)) m.set(start, info);
    };

    for (const e of entries) {
      const page = pages.get(e.slug);
      // The calendar prints no year; prefer the film page's exact start.
      const start = page?.startsByKey.get(dayTimeKey(e.m, e.d, e.hh, e.mm)) || seattleISO(e.y, e.m, e.d, e.hh, e.mm);
      add(e.slug, start, { tickets: e.tickets, soldOut: e.soldOut, rawTitle: e.rawTitle });
    }
    for (const [slug, page] of pages) {
      for (const start of page.starts) {
        const key = start.slice(5, 16); // 'MM-DDTHH:MM'
        add(slug, start, { tickets: page.ticketsByKey.get(key), soldOut: false, rawTitle: page.rawTitle });
      }
    }

    const { from, to } = windowDates();
    const out = [];
    for (const [slug, showings] of bySlug) {
      const page = pages.get(slug);
      const rawTitle = page?.rawTitle || [...showings.values()][0]?.rawTitle || '';
      const { title, notes: titleNotes, year: titleYear } = cleanTitle(rawTitle);
      if (!title) continue;
      const film = page?.film ? { ...page.film } : {};
      if (titleYear && !film.year) film.year = titleYear;

      for (const [start, info] of showings) {
        const day = start.slice(0, 10);
        if (day < from || day > to) continue;
        const notes = [...titleNotes];
        if (info.soldOut) notes.push('Sold out');
        const s = { theater: THEATER, title, start, url: movieUrl(slug) };
        if (info.tickets) s.tickets = info.tickets;
        if (notes.length) s.notes = notes;
        if (Object.keys(film).length) s.film = film;
        out.push(s);
      }
    }
    out.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
    return out;
  },
};

const movieUrl = (slug) => `${BASE}/calendar/movie/${slug}`;
const pad = (n) => String(n).padStart(2, '0');
const dayTimeKey = (m, d, hh, mm) => `${pad(m)}-${pad(d)}T${pad(hh)}:${pad(mm)}`;

function windowDates() {
  const t = seattleToday();
  const fmt = (ms) => new Date(ms).toISOString().slice(0, 10);
  return { from: fmt(Date.UTC(t.y, t.m - 1, t.d)), to: fmt(Date.UTC(t.y, t.m - 1, t.d + DAYS_AHEAD)) };
}

function slugFromHref(href) {
  const m = String(href || '').match(/\/calendar\/movie\/([^/?#]+)/);
  return m ? m[1] : null;
}

// Calendar entries: { slug, rawTitle, y, m, d, hh, mm, tickets, soldOut }.
// Reads the day-by-day list; falls back to the month grid if the list is gone.
function parseCalendar($) {
  const out = [];
  const take = ($entry, date, titleSel, timeSel) => {
    try {
      const $a = $entry.find(titleSel).first();
      const slug = slugFromHref($a.attr('href'));
      if (!slug) return; // "Rent the Beacon" and other non-film slots link elsewhere
      const clock = parseClock(oneLine($entry.find(timeSel).first().text()));
      if (!date || !clock) return;
      const $buy = $entry.find('[data-catalog-id]').first();
      const href = $buy.attr('href');
      const tickets = href && href !== '#' ? absUrl(href, BASE) : $buy.attr('data-catalog-id') ? `${movieUrl(slug)}?showtime=${$buy.attr('data-catalog-id')}` : undefined;
      const soldOut = !$buy.length && ($entry.hasClass('sold-out') || /sold\s*out/i.test($entry.text()));
      out.push({ slug, rawTitle: oneLine($a.text()), ...date, ...clock, tickets, soldOut });
    } catch (err) {
      console.warn(`beacon: skipped a calendar entry: ${err.message}`);
    }
  };

  $('.cal-list-day').each((_, day) => {
    const date = parseDate(oneLine($(day).find('.cal-list-date').first().text()));
    $(day).find('.cal-list-entry').each((_, el) => take($(el), date, '.cal-list-movie', '.cal-list-time'));
  });
  if (out.length) return out;

  // Fallback: the month grid ("October" heading, day number in each cell).
  $('.cal-month').each((_, month) => {
    const monthName = oneLine($(month).find('.month-heading, h2').first().text());
    $(month).find('.cal-cell').each((_, cell) => {
      const dayNum = oneLine($(cell).find('.cal-date').first().text());
      if (!dayNum) return;
      const date = parseDate(`${monthName} ${dayNum}`);
      $(cell).find('.cal-entry').each((_, el) => take($(el), date, '.cal-movie', '.cal-time'));
    });
  });
  return out;
}

const PLACEHOLDER = /^[?\s-]*$|^(tba|tbd|n\/a)$/i;
const real = (v) => {
  const s = oneLine(v ?? '');
  return s && !PLACEHOLDER.test(s) ? s : null;
};

function parseMoviePage(html, slug) {
  const $ = cheerio.load(html);
  const movie = jsonLd($).find((n) => [].concat(n['@type']).includes('Movie')) || {};

  const meta = {};
  $('.meta-field').each((_, el) => {
    const label = oneLine($(el).find('.meta-label').first().text()).toLowerCase();
    const values = $(el)
      .find('.meta-value')
      .map((_, v) => real($(v).text()))
      .get()
      .filter(Boolean);
    if (label) meta[label] = values;
  });

  const film = {};

  let description = '';
  const descHtml = $('.movie-description').first().html();
  if (descHtml) description = htmlToText(descHtml);
  if (!description && movie.description) description = cleanText(movie.description);
  if (description) film.description = description;

  const runtime = parseInt(meta.runtime?.[0], 10) || isoDurationMinutes(movie.duration);
  if (runtime > 0 && runtime < 1000) film.runtime = runtime;

  const yearText = real($('.movie-year').first().text()) || real(movie.datePublished);
  if (yearText && /^\d{4}$/.test(yearText)) film.year = +yearText; // skip "1943/1948" double bills

  const directors = meta.director?.length
    ? meta.director
    : [].concat(movie.director || []).map((p) => real(typeof p === 'string' ? p : p?.name)).filter(Boolean);
  if (directors.length) film.director = directors.join(', ');

  const image = pickImage(movie.image) || imageFromVercel($('.movie-media img').first().attr('src')) || $('meta[property="og:image"]').attr('content');
  if (image && /^https?:\/\//.test(image) && !/beacon-og\.png$/.test(image)) film.image = image;

  // Exact starts from JSON-LD, keyed by 'MM-DDTHH:MM' for matching the calendar.
  const starts = [];
  const startsByKey = new Map();
  for (const ev of [].concat(movie.subjectOf || [])) {
    if (!ev || ![].concat(ev['@type']).includes('ScreeningEvent') || !ev.startDate) continue;
    const iso = toSeattleISO(ev.startDate);
    if (!iso) continue;
    starts.push(iso);
    startsByKey.set(iso.slice(5, 16), iso);
  }

  // Ticket links from the showtime rows ("Sun, Oct 4 at 2:00 PM").
  const ticketsByKey = new Map();
  $('.showtime-row').each((_, row) => {
    const label = oneLine($(row).find('.showtime-datetime').first().text());
    const id = $(row).find('[data-catalog-id]').attr('data-catalog-id');
    const [datePart, timePart] = label.split(/\s+at\s+/i);
    const date = parseDate(datePart || '');
    const clock = parseClock(timePart || '');
    if (id && date && clock) ticketsByKey.set(dayTimeKey(date.m, date.d, clock.hh, clock.mm), `${movieUrl(slug)}?showtime=${encodeURIComponent(id)}`);
  });

  const rawTitle = oneLine($('h1.movie-title, h1').first().text()) || oneLine(movie.name || '');
  return { rawTitle, film, starts, startsByKey, ticketsByKey };
}

function pickImage(img) {
  if (!img) return null;
  if (Array.isArray(img)) return pickImage(img[0]);
  if (typeof img === 'string') return img;
  return img.url || img.contentUrl || null;
}

// '/_vercel/image?url=https%3A%2F%2F…&w=1920' -> the original image URL.
function imageFromVercel(src) {
  if (!src) return null;
  try {
    const u = new URL(src, BASE);
    return u.searchParams.get('url') || u.href;
  } catch {
    return null;
  }
}

// 'PT1H18M' -> 78
function isoDurationMinutes(d) {
  const m = String(d || '').match(/^PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!m || (!m[1] && !m[2])) return null;
  return (+m[1] || 0) * 60 + (+m[2] || 0);
}

// ---------------------------------------------------------------------------
// Titles: the Beacon writes every title in capitals, sometimes with the
// occasion folded in ("SECS FEST PRESENTS DRILLER", "L’AMOUR FOU W/ A.S. HAMRAH").

function cleanTitle(raw) {
  let t = titleCase(oneLine(raw));
  const notes = [];
  let year = null;
  let m;

  // "X Presents: Y" / "X Presents Y" (but not a title that ends in "Presents...")
  m = t.match(/^(.+?)\s+presents\s*:?\s+(.+)$/i);
  if (m && /[\p{L}\p{N}]/u.test(m[2])) {
    notes.push(`Presented by ${m[1]}`);
    t = m[2];
  }
  // "Narrow Margin Release Party: Buchanan Rides Alone"
  m = t.match(/^(.+?\b(?:release party|launch party|premiere|benefit|fundraiser))\s*:\s*(.+)$/i);
  if (m) {
    notes.push(m[1]);
    t = m[2];
  }
  // "L’Amour Fou w/ A.S. Hamrah"
  m = t.match(/^(.+?)\s+w\/\s*(.+)$/i);
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
  // Format add-ons at the end.
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
  m = t.match(/^(.+?)\s*\((\d{4})\)$/);
  if (m) {
    year = +m[2];
    t = m[1];
  }
  t = t.trim().replace(/[\s,:;–—-]+$/, '');
  if (t) t = t[0].toUpperCase() + t.slice(1);
  return { title: t, notes, year };
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
  const m = tok.match(/^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u);
  const [, pre, core, post] = m;
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
