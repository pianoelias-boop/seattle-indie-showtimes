// SIFF (siff.net): SIFF Cinema Downtown, SIFF Cinema Uptown, SIFF Film Center.
//
// siff.net is an Ingeniux CMS site that sells tickets through an embedded
// Elevent widget. There is no public listing API (goelevent.com only lists a
// handful of SIFF events), but every showtime button on siff.net carries the
// Elevent record as JSON in a data-screening attribute:
//   { EventName, EventUrlName, Showtime: "/Date(epoch ms)/", ShowtimeId,
//     LengthInMinutes, VenueName: "SIFF Cinema Uptown House 2", ... }
//
// 1. The calendar list view (/calendar?view=list&date=YYYY-MM-DD) gives one
//    day's showtimes, grouped under the film's title and page link. One
//    request per day, today through ~5 weeks out.
// 2. Each film page gives the details (synopsis, director, country, year,
//    running time, language, rating, image) and repeats every showtime, which
//    we union in as a safety net if a calendar day fails to load.

import * as cheerio from 'cheerio';
import { getText, mapLimit } from '../lib/http.js';
import { htmlToText, cleanText, oneLine, absUrl } from '../lib/text.js';
import { seattleISO, toSeattleISO, localStringToISO, parseClock, parseDate, seattleToday } from '../lib/time.js';

const BASE = 'https://www.siff.net/';
const DAYS_AHEAD = 35;

// ---------------------------------------------------------------- venues

function theaterFor(venueName, venueHref) {
  const s = `${venueName || ''} ${venueHref || ''}`.toLowerCase();
  if (/egyptian/.test(s)) return null; // closed
  if (/uptown/.test(s)) return 'siff-uptown';
  if (/downtown|cinerama/.test(s)) return 'siff-downtown';
  if (/film[\s-]*center/.test(s)) return 'siff-film-center';
  return null;
}

// ---------------------------------------------------------------- dates

const pad = (n) => String(n).padStart(2, '0');

function dayList(n) {
  const t = seattleToday();
  const out = [];
  for (let i = 0; i <= n; i++) {
    const d = new Date(Date.UTC(t.y, t.m - 1, t.d + i));
    out.push(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`);
  }
  return out;
}

// data-screening Showtime -> Seattle ISO. Falls back to the button's clock
// text on the given day ({y, m, d}).
function startFrom(rec, clockText, day) {
  const st = rec?.Showtime;
  if (st != null) {
    const ms = String(st).match(/Date\((-?\d+)/);
    if (ms) {
      const iso = toSeattleISO(+ms[1]);
      if (iso) return iso;
    } else if (typeof st === 'number') {
      const iso = toSeattleISO(st);
      if (iso) return iso;
    } else if (/^\d{4}-\d{2}-\d{2}T/.test(st)) {
      const iso = /(Z|[+-]\d{2}:?\d{2})$/.test(st) ? toSeattleISO(st) : localStringToISO(st);
      if (iso) return iso;
    }
  }
  const clock = clockText ? parseClock(clockText) : null;
  if (clock && day) return seattleISO(day.y, day.m, day.d, clock.hh, clock.mm);
  return null;
}

function readScreeningAttr($el) {
  try {
    const raw = $el.attr('data-screening');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- titles

const SMALL_WORDS = new Set(
  'a an and as at but by for from in into nor of on onto or over per the to up upon vs via with'.split(' '),
);
const ROMAN = /^(i{1,3}|iv|v|vi{1,3}|ix|x{1,3}|xi{1,3}|xiv|xv|xvi{1,3}|xix|xx)$/i;

function titleCase(str) {
  const parts = str.toLowerCase().split(/(\s+)/);
  const words = parts.filter((p) => p.trim());
  let wi = -1;
  let prevEndsBreak = true;
  return parts
    .map((p) => {
      if (!p.trim()) return p;
      wi++;
      const bare = p.replace(/[^\p{L}\p{N}']/gu, '');
      const first = prevEndsBreak;
      const last = wi === words.length - 1;
      prevEndsBreak = /[:.!?—–-]$/.test(p);
      if (ROMAN.test(bare) && bare.length > 1) return p.toUpperCase();
      if (!first && !last && SMALL_WORDS.has(bare)) return p;
      // Capitalise the first letter of each hyphen-separated piece.
      return p.replace(/(^|-)([^\p{L}\p{N}]*)(\p{L})/gu, (_, a, b, c) => a + b + c.toUpperCase());
    })
    .join('');
}

function isAllCaps(str) {
  const letters = str.replace(/[^\p{L}]/gu, '');
  if (letters.length < 2 || letters !== letters.toUpperCase() || letters === letters.toLowerCase()) return false;
  // A single short word in caps (NAZA, RRR, MASH) is probably the real title.
  return /\s/.test(str.trim()) || letters.length > 4;
}

// Things that belong in notes, not the title.
const ADDON =
  /\b(\d{2}\s?mm|4k|restor(?:ation|ed)|anniversary|q\s*&\s*a|q and a|open[- ]?capt\w*|closed[- ]?capt\w*|captioned|sing[- ]?a[- ]?long|quote[- ]?a[- ]?long|in person|live (?:score|music|accompaniment)|premiere|double feature|director'?s cut|sneak preview|encore|sensory[- ]friendly|relaxed screening|introduc\w+|discussion|members? only)\b/i;

// Series / presenter prefixes to drop ("SIFF Presents: X").
const KNOWN_SERIES =
  /^(SIFF(?: Cinema)? Presents|SIFF (?:Movie|Book) Club|Community Screenings?|Nouvelles Femmes|The Films of [^:]{2,40}|The Open Road|Scarecrowber(?: \d{4})?|Stage to Screen|Silent Movie Mondays?|Films4Families|FutureWave|Cinema Italiano|French Cinema Now|Noir City|Late Night|Midnight Adrenaline|Best of SIFF|Best of the Fest(?:ival)?|Rerun|Retrospective)\s*:\s*/i;

const STOP = new Set(['the', 'of', 'a', 'an', 'and', 'siff', 'films', 'film', 'cinema', 'series', 'presents']);
const words = (s) =>
  String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP.has(w) && !/^\d{4}$/.test(w))
    .map((w) => w.replace(/s$/, ''));

// /programs-and-events/<series>/<film> -> ['series', 'film'], else null.
function programSlugs(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] === 'programs-and-events' && parts.length >= 3) return [parts[1], parts[parts.length - 1]];
  } catch {
    /* ignore */
  }
  return null;
}

// The add-on term has to lead the phrase ("in 35mm", "+ Q&A with the
// director", "- 50th Anniversary"), so "Singin' in the Rain" stays whole.
function leadingAddon(phrase) {
  const hit = phrase.match(ADDON);
  return !!hit && /^(?:(?:the|a|an|new|special|restored|\d+\w*)\s+)*$/i.test(phrase.slice(0, hit.index));
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Returns { title, notes, series }.
function cleanTitle(raw, { url, director, pageText } = {}) {
  let t = oneLine(raw).replace(/[‘’]/g, "'");
  const notes = [];
  let series;

  // "Series: Film" prefixes, either a known series or the program folder the
  // page lives in (/programs-and-events/nouvelles-femmes/contempt).
  const m = t.match(/^([^:]{2,60}?)\s*:\s+(.+)$/);
  if (m) {
    const slugs = url && programSlugs(url);
    const prefixWords = words(m[1]);
    const inFilmSlug = slugs && prefixWords.length && prefixWords.every((w) => words(slugs[1]).includes(w));
    const known = KNOWN_SERIES.test(t);
    const fromUrl = slugs && prefixWords.some((w) => words(slugs[0]).includes(w));
    if ((known || fromUrl) && !inFilmSlug) {
      series = m[1].trim();
      t = m[2].trim();
    }
  }

  // "Somebody Presents, X" / "Somebody Presents: X"
  const pres = t.match(/^(.{2,60}?)\s+Presents?\s*[:,]\s*(.+)$/i);
  if (pres) {
    t = pres[2].trim();
    // Title in quotes followed by a description: '"The Way Out" 2026 Ski Film'.
    const q = t.match(/^["“](.+?)["”](?:\s+(.*))?$/);
    if (q) t = q[1].trim();
  }

  // "Glen Canyon Institute's What the River Knows", when the page says
  // "Presented by Glen Canyon Institute".
  const poss = t.match(/^(.{3,60}?)'s\s+(.+)$/);
  if (poss && pageText && new RegExp(`presented by\\s+(the\\s+)?${escapeRe(poss[1])}`, 'i').test(pageText)) {
    t = poss[2].trim();
  }

  // Trailing add-ons: "(35mm)", "+ Q&A", " - Open Caption", " in 70mm".
  for (let guard = 0; guard < 5; guard++) {
    let hit = false;
    const paren = t.match(/^(.*\S)\s*[([]([^()[\]]+)[)\]]\s*$/);
    if (paren && ADDON.test(paren[2])) {
      notes.unshift(paren[2].trim());
      t = paren[1];
      hit = true;
    }
    const plus = t.match(/^(.*?\S)\s+\+\s+(.+)$/);
    if (plus && leadingAddon(plus[2])) {
      notes.unshift(plus[2].trim());
      t = plus[1];
      hit = true;
    }
    // Leftmost separator whose remainder starts with an add-on.
    for (const sep of t.matchAll(/\s+(?:[-–—|]|with|in)\s+|:\s+/gi)) {
      const head = t.slice(0, sep.index).trim();
      const rest = t.slice(sep.index + sep[0].length).trim();
      if (head && leadingAddon(rest) && rest.split(/\s+/).length <= 8) {
        notes.unshift(rest);
        t = head;
        hit = true;
        break;
      }
    }
    const tail = t.match(/^(.*\S)\s+(\d{2}mm|4K|Sing-?a-?long|Quote-?a-?long|Open[- ]Caption(?:ed|s)?)$/i);
    if (tail) {
      notes.unshift(tail[2].trim());
      t = tail[1];
      hit = true;
    }
    if (!hit) break;
  }

  // "Ken Russell's The Devils" -> "The Devils" when the director matches.
  if (director) {
    for (const d of String(director).split(/,|\band\b|&/)) {
      const name = d.trim();
      if (name.length < 4) continue;
      const dm = t.match(new RegExp(`^${escapeRe(name)}'s\\s+(.+)$`, 'i'));
      if (dm) {
        t = dm[1];
        break;
      }
    }
  }

  t = t.replace(/\s+/g, ' ').trim();
  if (isAllCaps(t)) t = titleCase(t);
  if (!t) t = oneLine(raw);

  const fixed = notes.map((n) => (isAllCaps(n) ? titleCase(n) : n).replace(/(\d)\s?mm\b/i, '$1mm'));
  return { title: t, notes: fixed, series: series && (isAllCaps(series) ? titleCase(series) : series) };
}

// ---------------------------------------------------------------- film details

function parseRuntime(str) {
  if (!str) return undefined;
  const s = String(str);
  let n;
  let m = s.match(/film\s*:?\s*(\d{1,3})\s*(?:min|m\b|minutes)?/i);
  if (m) n = +m[1];
  if (n == null) {
    m = s.match(/(\d)\s*(?:hours?|hrs?|h)(?![a-z])\.?\s*(?:(\d{1,2})\s*(?:minutes|mins?|m)\b)?/i);
    if (m && !/^\s*\d{2,3}\s*min/i.test(s)) n = +m[1] * 60 + (m[2] ? +m[2] : 0);
  }
  if (n == null) {
    m = s.match(/(\d{1,3})\s*(?:min|mins|minutes|m)\b/i);
    if (m) n = +m[1];
  }
  if (n == null) {
    m = s.match(/^\s*(\d{2,3})\s*$/);
    if (m) n = +m[1];
  }
  return Number.isInteger(n) && n > 0 && n < 1000 ? n : undefined;
}

function parseYear(str) {
  const m = String(str || '').match(/\b(18[89]\d|19\d\d|20\d\d)\b/);
  return m ? +m[1] : undefined;
}

// "USA | 2026 | 122 min. | Josef Kubota Wladyka" (calendar and film page).
function parseMeta(meta) {
  const out = {};
  const segs = String(meta || '')
    .split('|')
    .map((s) => oneLine(s))
    .filter(Boolean);
  let seenNumber = false;
  for (const s of segs) {
    if (s.length > 60) continue;
    if (/^\d{4}$/.test(s)) {
      out.year = +s;
      seenNumber = true;
    } else if (/\d/.test(s) && /(min|hour|hr|^\d{2,3}$)/i.test(s)) {
      out.runtime = parseRuntime(s);
      seenNumber = true;
    } else if (!seenNumber && !out.country) {
      out.country = s;
    } else if (seenNumber) {
      out.director = s;
    }
  }
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
  return out;
}

const BOILERPLATE =
  /(passes? (and|&) vouchers?|vouchers? (are )?not valid|not valid for this|year-round pass|buy tickets|tickets? (are )?(on sale|available)|click here|sign up|become a member|members save|box office|runtime includes|advance tickets)/i;

function cleanBody(html) {
  let text = htmlToText(html);
  if (!text) return '';
  let paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  // A leading series label ("Nouvelles Femmes", "Scarecrowber").
  if (paras.length > 1 && paras[0].length < 50 && !/[.!?"”)]$/.test(paras[0])) paras.shift();
  paras = paras.filter((p) => !(p.length < 240 && BOILERPLATE.test(p)));
  // A trailing byline ("—Dan Doody").
  if (paras.length > 1 && /^[—–-]\s*\S/.test(paras[paras.length - 1]) && paras[paras.length - 1].length < 60) paras.pop();
  return cleanText(paras.join('\n\n'));
}

function parseFilmPage(html, url) {
  const $ = cheerio.load(html);
  const main = $('main').length ? $('main') : $('body');
  const out = { showings: [] };

  out.title = oneLine(main.find('h1').first().text()) || undefined;

  const det = {};
  main.find('ul.film-detail li, ul.details li').each((_, li) => {
    const label = oneLine($(li).find('.label').first().text()).replace(/:$/, '').toLowerCase();
    const value = oneLine($(li).find('.detail').first().text());
    if (label && value && !det[label]) det[label] = value;
  });
  out.details = det;
  out.meta =
    main
      .find('p.small, p.meta')
      .map((_, el) => oneLine($(el).text()))
      .get()
      .find((t) => t.includes('|') || /^\d{1,3}\s*min/i.test(t)) || '';

  out.pageText = main
    .find('.body-copy')
    .map((_, el) => oneLine($(el).text()))
    .get()
    .join(' ');
  const bodies = main
    .find('.body-copy')
    .map((_, el) => cleanBody($(el).html()))
    .get()
    .filter(Boolean);
  // The first block is a short blurb; the second, when there is one, is the
  // full synopsis.
  const long = bodies.slice(1).find((b) => b.length >= 120);
  out.description = long || bodies[0] || bodies[1] || undefined;

  const og = $('meta[property="og:image"]').attr('content') || $('meta[name="twitter:image"]').attr('content');
  const img = main.find('.img-wrap img, img').first().attr('src');
  out.image = absUrl(og, url) || absUrl(img, url);

  // Showtimes, grouped by day.
  main.find('.screenings .day').each((_, dayEl) => {
    const day = parseDate(oneLine($(dayEl).find('.h3, h3').first().text()));
    $(dayEl)
      .find('[data-screening]')
      .each((_, a) => {
        const $a = $(a);
        const rec = readScreeningAttr($a);
        const venueHref = $a.closest('.item').find('h4 a, h3 a').first().attr('href');
        const venueText = oneLine($a.closest('.item').find('h4, h3').first().text());
        out.showings.push({ rec, clock: oneLine($a.text()), day, venueHref, venueText });
      });
  });
  return out;
}

function filmFromDetails(page, fallbackMeta) {
  const d = page?.details || {};
  const meta = { ...parseMeta(fallbackMeta), ...parseMeta(page?.meta) };
  const film = {};
  if (page?.description) film.description = page.description;
  film.runtime = parseRuntime(d['running time'] || d.runtime) ?? meta.runtime;
  film.year = parseYear(d.year) ?? meta.year;
  film.director = d.director || d.directors || meta.director;
  film.country = d.country || d.countries || meta.country;
  const lang = d.language || d.languages;
  if (lang) film.language = lang.replace(/\s*,?\s*with English subtitles\.?$/i, '').trim();
  const rating = d.rating || d['mpaa rating'];
  if (rating && rating.length <= 12) film.rating = rating;
  if (page?.image) film.image = page.image;
  for (const k of Object.keys(film)) if (film[k] == null || film[k] === '') delete film[k];
  return film;
}

// ---------------------------------------------------------------- calendar

function parseCalendarDay(html, dateStr) {
  const $ = cheerio.load(html);
  const [y, m, d] = dateStr.split('-').map(Number);
  const day = { y, m, d };
  const out = [];
  $('[data-screening]').each((_, a) => {
    const $a = $(a);
    const rec = readScreeningAttr($a);
    const $item = $a.closest('.item');
    const $link = $item.find('.small-copy h3 a, h3 a').first();
    const $group = $a.closest('.button-group');
    const venueH3 = $group.prevAll('h3').first();
    out.push({
      rec,
      clock: oneLine($a.text()),
      day,
      title: oneLine($link.text()) || undefined,
      filmUrl: absUrl($link.attr('href'), BASE),
      meta: oneLine($item.find('p.meta').first().text()),
      thumb: absUrl($item.find('.thumb-wrap img, img').first().attr('src'), BASE),
      venueHref: venueH3.find('a').attr('href'),
      venueText: oneLine(venueH3.text()),
    });
  });
  return out;
}

// ---------------------------------------------------------------- scrape

const NOT_FILM =
  /\b(workshops?|master ?class(es)?|(film|filmmaking|acting|screenwriting|editing|cinematography|online|virtual) class(es)?|seminars?|lectures?|member(ship)? (meeting|mixer|party|social)|annual meeting|open house|info(rmation)? session|trivia night|(festival|film|cinema) pass(es)?|6-pack|gift cards?|private (event|rental|party))\b/i;

export default {
  id: 'siff',

  async scrape() {
    const dates = dayList(DAYS_AHEAD);
    const firstDate = dates[0];
    const lastDate = dates[dates.length - 1];

    // 1. Calendar, one day per request.
    let failedDays = 0;
    const perDay = await mapLimit(dates, 3, async (date) => {
      try {
        const html = await getText(`${BASE}calendar?view=list&date=${date}`);
        return parseCalendarDay(html, date);
      } catch (err) {
        failedDays++;
        console.warn(`siff: calendar ${date} failed: ${err.message}`);
        return [];
      }
    });
    if (failedDays === dates.length) throw new Error('siff: every calendar request failed');

    // Showtimes keyed by Elevent ShowtimeId (or venue+time when missing).
    const shows = new Map();
    const films = new Map(); // key -> { url, title, meta, thumb }
    const filmKey = (url, rec) => url || (rec?.EventUrlName ? `event:${rec.EventUrlName}` : null);

    const addShow = (s, film) => {
      const start = startFrom(s.rec, s.clock, s.day);
      if (!start) return;
      const date = start.slice(0, 10);
      if (date < firstDate || date > lastDate) return;
      const theater = theaterFor(s.rec?.VenueName, s.venueHref || s.venueText);
      if (!theater) return;
      const id = s.rec?.ShowtimeId || `${theater}|${start}|${film.key}`;
      if (shows.has(id)) return;
      shows.set(id, { id, start, theater, rec: s.rec, key: film.key });
    };

    for (const list of perDay) {
      for (const s of list) {
        try {
          const key = filmKey(s.filmUrl, s.rec);
          if (!key) continue;
          if (!films.has(key)) {
            films.set(key, {
              key,
              url: s.filmUrl,
              title: s.title || oneLine(s.rec?.EventName || ''),
              meta: s.meta,
              thumb: s.thumb,
            });
          }
          addShow(s, films.get(key));
        } catch (err) {
          console.warn(`siff: skipped a calendar entry: ${err.message}`);
        }
      }
    }

    // 2. Film pages for details (and any showtimes a failed day missed).
    const withPages = [...films.values()].filter((f) => f.url);
    await mapLimit(withPages, 3, async (f) => {
      try {
        const page = parseFilmPage(await getText(f.url), f.url);
        f.page = page;
        if (!f.title && page.title) f.title = page.title;
        for (const s of page.showings) {
          try {
            addShow(s, f);
          } catch {
            /* ignore one odd showtime */
          }
        }
      } catch (err) {
        console.warn(`siff: film page ${f.url} failed: ${err.message}`);
      }
    });

    // 3. Assemble.
    for (const f of films.values()) {
      f.film = filmFromDetails(f.page, f.meta);
      if (!f.film.image && f.thumb) f.film.image = f.thumb;
      const cleaned = cleanTitle(f.title || '', {
        url: f.url,
        director: f.film.director,
        pageText: f.page?.pageText,
      });
      f.cleanTitle = cleaned.title;
      f.baseNotes = [];
      if (cleaned.series && !/^SIFF(?: Cinema)? Presents$/i.test(cleaned.series)) f.baseNotes.push(cleaned.series);
      f.baseNotes.push(...cleaned.notes);
      const format = f.page?.details?.format;
      if (format && /\b\d{2}\s?mm\b/i.test(format)) f.baseNotes.push(format.replace(/\s?mm\b/i, 'mm'));
      const blob = `${f.title} ${f.page?.description || ''}`;
      if (/grand illusion/i.test(blob)) f.baseNotes.push('Grand Illusion Cinema pop-up');
      f.skip = NOT_FILM.test(f.cleanTitle) || /\/(education|passes|membership|support)\b/i.test(f.url || '');
      if (f.skip) console.warn(`siff: skipping non-film "${f.title}"`);
    }

    const out = [];
    for (const s of shows.values()) {
      try {
        const f = films.get(s.key);
        if (!f || f.skip || !f.cleanTitle) continue;
        const notes = [...f.baseNotes];
        // Per-showing variants often only show up in the Elevent event name.
        if (s.rec?.EventName) {
          for (const n of cleanTitle(s.rec.EventName).notes) notes.push(n);
        }
        const pct = Math.max(+s.rec?.PublicAllocationSoldOutPercentage || 0, +s.rec?.CapacitySoldOutPercentage || 0);
        if (pct >= 100 || s.rec?.IsSoldOut === true) notes.push('Sold out');
        const seen = new Set();
        const uniq = notes.filter((n) => {
          const k = n.toLowerCase().replace(/\s+/g, '');
          if (!n || seen.has(k)) return false;
          seen.add(k);
          return true;
        });

        const screening = { theater: s.theater, title: f.cleanTitle, start: s.start };
        if (f.url) screening.url = f.url;
        if (f.url && s.rec?.ShowtimeId) screening.tickets = `${f.url}#screening-${s.rec.ShowtimeId}`;
        if (uniq.length) screening.notes = uniq;
        const film = { ...f.film };
        if (film.runtime == null) {
          const len = +s.rec?.LengthInMinutes;
          if (Number.isInteger(len) && len > 0 && len < 1000) film.runtime = len;
        }
        if (Object.keys(film).length) screening.film = film;
        out.push(screening);
      } catch (err) {
        console.warn(`siff: skipped a showing: ${err.message}`);
      }
    }

    out.sort((a, b) => a.start.localeCompare(b.start) || a.theater.localeCompare(b.theater));
    return out;
  },
};
