// The Tin Room (Burien): a bar and restaurant with a small theater in back.
//
// tinroombar.com is a SpotHopper restaurant site. Its events page is built
// from SpotHopper's public JSON API, which we read directly:
//   GET https://www.spothopperapp.com/api/spots/354871/events
//     -> { events: [{ id, name, rich_text, event_date, start_time: 'HH:MM',
//                     recurrence: { type, active_days, repeat_every_x_weeks, … },
//                     links: { images: [id] } }],
//          linked: { images: [{ id, path, url }] } }
//   event_date is the local calendar date written as UTC midnight, and
//   start_time is Seattle wall-clock time. duration_minutes is the room booking
//   (always 120 for films), not the runtime, so it is not used.
// If the API fails we read the same fields from the cards on /events
// (data-event-start-date, data-event-start-time, …).
//
// The calendar mixes films with karaoke, "Game Day" (sports on the big
// screen) and other bar events; those are filtered out by name. Films get only
// a title, a synopsis and a poster: there are no film pages or ticket links.
//
// The Seattle Film Festival (not SIFF) takes over the theater for a few days
// each fall. The Tin Room lists each festival day as one "SEATTLE FILM
// FESTIVAL" event; the actual program blocks are sold on Ticket Tailor
// (buytickets.at/theseattlefilmfestival/… redirects there). When the calendar
// shows the festival in our window we read the box office list, then each
// event page for its JSON-LD and description, and return one screening per
// block, titled with the block name and with the films listed in the
// description. Ticket Tailor quirks:
// - The organizer set a different time zone on almost every event (+09:00,
//   -04:00, -07:00), so only the wall-clock part of startDate is meaningful.
// - Block 1's startDate is a month early (Sept 1, ending Oct 1). A start more
//   than a day before the end is moved to the end's date.
// - The awards show is not a screening and is skipped.
// Festival days the box office doesn't cover fall back to the Tin Room's own
// listing, so a Ticket Tailor outage still leaves the festival on the calendar.

import * as cheerio from 'cheerio';
import { getJSON, getText, mapLimit } from '../lib/http.js';
import { seattleISO, seattleToday, parseClock, monthNumber } from '../lib/time.js';
import { htmlToText, cleanText, oneLine, absUrl, jsonLd } from '../lib/text.js';

const THEATER = 'tin-room';
const SITE = 'https://tinroombar.com';
const EVENTS_PAGE = `${SITE}/events`;
const SPOT_ID = 354871;
const API = `https://www.spothopperapp.com/api/spots/${SPOT_ID}/events`;
const IMAGE_HOST = 'https://static.spotapps.co/';
const HORIZON_DAYS = 35;

const FESTIVAL_NAME = 'Seattle Film Festival';
const FESTIVAL_BOX_OFFICE = 'https://www.tickettailor.com/events/theseattlefilmfestival';
const FESTIVAL_RE = /\bfilm\s+fest(?:ival)?\b/i;

const warn = (msg) => console.warn(`tin-room: ${msg}`);

// ---------------------------------------------------------------- dates

const pad = (n) => String(n).padStart(2, '0');
const dayKey = ({ y, m, d }) => `${y}-${pad(m)}-${pad(d)}`;

function ymd(str) {
  const m = String(str || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
}

function addDays({ y, m, d }, days) {
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

const dayNumber = ({ y, m, d }) => Math.round(Date.UTC(y, m - 1, d) / 86400000);
const weekday = (date) => new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay(); // 0 = Sunday

// The dates an event falls on between first and last (inclusive). SpotHopper
// repeats weekly ("Every" / "Every other") on recurrence.active_days.
function occurrences(ev, first, last) {
  if (!ev.date) return [];
  const lo = dayKey(first);
  const hi = dayKey(last);
  const inWindow = (d) => dayKey(d) >= lo && dayKey(d) <= hi;
  const type = oneLine(ev.recurrence?.type || '');
  if (!type || /does\s+not\s+repeat/i.test(type)) return inWindow(ev.date) ? [ev.date] : [];
  if (!/^every(?:\s+other)?$/i.test(type)) {
    warn(`unknown recurrence "${type}" for "${oneLine(ev.name)}"; using its first date only`);
    return inWindow(ev.date) ? [ev.date] : [];
  }

  const start = ev.recurrence.start || ev.date;
  const end = ev.recurrence.end && dayKey(ev.recurrence.end) < hi ? ev.recurrence.end : last;
  const days = Array.isArray(ev.recurrence.days) && ev.recurrence.days.length ? ev.recurrence.days.map(Number) : [weekday(start)];
  let every = Math.max(1, parseInt(ev.recurrence.every, 10) || 1);
  if (/other/i.test(type)) every = Math.max(every, 2);
  const startWeek = dayNumber(start) - weekday(start);

  const out = [];
  let d = dayKey(start) > lo ? start : first;
  for (let guard = 0; guard < 400 && dayKey(d) <= dayKey(end); guard++, d = addDays(d, 1)) {
    if (!days.includes(weekday(d))) continue;
    const weeks = Math.round((dayNumber(d) - weekday(d) - startWeek) / 7);
    if (weeks % every === 0) out.push(d);
  }
  return out;
}

// ---------------------------------------------------------------- SpotHopper

function imageUrl(img) {
  if (!img) return undefined;
  // "w926" keeps the poster's shape; "full" is an 800px square crop.
  if (img.path && /^[\w/.-]+\/$/.test(img.path)) return `${IMAGE_HOST}${img.path}w926`;
  const u = absUrl(img.url || img.urls?.full, IMAGE_HOST);
  return u && /^https?:\/\//.test(u) ? u : undefined;
}

function fromApi(data) {
  if (!data || !Array.isArray(data.events)) throw new Error('events API reply has no events list');
  const images = new Map((data.linked?.images || []).filter((i) => i?.id != null).map((i) => [i.id, i]));
  return data.events
    .filter((e) => e && e.show_on_website !== false && !e.is_template)
    .map((e) => ({
      id: e.id,
      name: e.name,
      html: e.rich_text || cleanText(e.text || ''),
      date: ymd(e.event_date),
      time: e.all_day ? null : parseClock(e.start_time || ''),
      recurrence: {
        type: e.recurrence?.type,
        days: e.recurrence?.active_days,
        every: e.recurrence?.repeat_every_x_weeks,
        start: ymd(e.recurrence?.start_date),
        end: ymd(e.recurrence?.end_date),
      },
      image: imageUrl(images.get((e.links?.images || [])[0])),
    }));
}

function fromHtml(html) {
  const $ = cheerio.load(html);
  const cards = $('.event-calendar-card');
  if (!cards.length && !$('.events-calendar-page-content, .no-events-message').length) {
    throw new Error('events page structure not recognized');
  }
  return cards
    .map((_, el) => {
      const c = $(el);
      const info = c.find('.event-info-text').first().clone();
      info.find('[data-event-id]').remove();
      const date = ymd(c.attr('data-event-start-date'));
      const time = parseClock(c.attr('data-event-start-time') || c.find('.event-time').first().text().split('-')[0]);
      const src = c.find('.event-image-holder img, img').first().attr('src');
      return {
        id: c.attr('id'),
        name: c.find('h2').first().text(),
        html: info.html() || '',
        date,
        time,
        recurrence: {
          type: c.attr('data-event-recurrence-type'),
          days: date ? [weekday(date)] : [],
          every: 1,
          start: date,
          end: ymd(c.attr('data-event-end-date')),
        },
        image: src ? absUrl(src, SITE) : undefined,
      };
    })
    .get();
}

async function loadEvents() {
  try {
    return fromApi(await getJSON(API));
  } catch (err) {
    warn(`events API failed (${err.message}); reading ${EVENTS_PAGE}`);
    return fromHtml(await getText(EVENTS_PAGE));
  }
}

// ---------------------------------------------------------------- films or not

// Never films.
const NOT_A_FILM = new RegExp(
  '\\b(?:' +
    [
      'karaoke', 'trivia', 'quiz', 'bingo', 'game\\s*day', 'watch\\s+party', 'happy\\s*hour', 'open\\s*mic',
      'trick\\W*or\\W*treat', 'costume\\s+contest', 'paint\\s*(?:&|and|n)\\s*sip', 'private\\s+(?:event|party|rental)',
      'closed\\s+for', 'super\\s*bowl', 'seahawks', 'mariners', 'kraken', 'sounders', 'huskies', 'nfl', 'nba', 'mlb',
      'nhl', 'ufc', 'world\\s+cup', 'march\\s+madness', 'playoffs?', 'fantasy\\s+draft', 'pub\\s+crawl',
    ].join('|') +
    ')\\b',
  'i',
);
// Bar events unless the text reads like a synopsis ("Game Night" is also a film).
const MAYBE_NOT_A_FILM =
  /\b(?:game\s+night|live\s+(?:music|band|jazz|comedy|show)|comedy\s+(?:night|show)|stand[-\s]?up|drag\b|dj\b|dance\s+party|burlesque|brunch|tasting|halloween\s+(?:party|bash|fun)|holiday\s+party|party\b|boo\b)/i;
const BAR_EVENT_TEXT =
  /\b(?:karaoke|trivia|trick\W*or\W*treat|(?:enjoy|watch|join us for)\s+the\s+game|live\s+music|happy\s+hour|all\s+ages\s+welcome)\b/i;

function isFilm(name, text) {
  if (NOT_A_FILM.test(name)) return false;
  const synopsis = text.length >= 200;
  if (!synopsis && BAR_EVENT_TEXT.test(text)) return false;
  if (!synopsis && MAYBE_NOT_A_FILM.test(name)) return false;
  return true;
}

// ---------------------------------------------------------------- titles

const SMALL_WORDS = new Set('a an and as at but by for from in into nor of on or over per the to up via vs vs. with yet'.split(' '));
const ROMAN = /^(?=[ivx])(x{0,3})(ix|iv|v?i{0,3})$/i;
// Kept in capitals when the whole title arrives in capitals (the Tin Room's house style).
const ACRONYMS = new Set('jfk rrr uhf tv fbi cia nyc ufo uss nasa vhs thx dc'.split(' '));

function capitalize(word) {
  return word
    .replace(/(^|[-‐/])([^\p{L}\p{N}]*)(\p{L})/gu, (_, sep, punct, ch) => sep + punct + ch.toUpperCase())
    .replace(/^([^\p{L}]*)([OD])(['’])(\p{L})/u, (_, p, a, q, c) => p + a + q + c.toUpperCase()); // O'Brien
}

function titleCase(str) {
  const tokens = str.toLowerCase().split(/(\s+)/);
  const words = tokens.filter((t) => t && !/^\s+$/.test(t));
  let wi = 0;
  let clauseStart = true;
  return tokens
    .map((tok) => {
      if (!tok || /^\s+$/.test(tok)) return tok;
      const isFirst = wi === 0 || clauseStart;
      const isLast = wi === words.length - 1;
      wi++;
      clauseStart = /[:!?–—]$/.test(tok) || tok === '-'; // a '.' mid-title is an abbreviation (E.T., Dr.)
      const bare = tok.replace(/[^\p{L}\p{N}.]/gu, '');
      const letters = bare.replace(/\./g, '');
      if (bare === 'i' || (letters && ROMAN.test(letters) && !/^(?:mix|dix|vix)$/.test(letters))) return tok.toUpperCase();
      if (ACRONYMS.has(letters)) return tok.toUpperCase();
      if (/^(?:\p{L}\.){2,}\p{L}?$/u.test(bare)) return tok.toUpperCase(); // E.T., L.A.
      if (/\d/.test(letters) && /\p{L}/u.test(letters) && !/^\d+(?:st|nd|rd|th|s)$/.test(letters)) return tok.toUpperCase(); // M3GAN, 3D
      if (!isFirst && !isLast && SMALL_WORDS.has(bare)) return tok;
      return capitalize(tok);
    })
    .join('');
}

const isAllCaps = (s) => /[A-Z]/.test(s) && !/[a-z]/.test(s);

// Misspellings seen on the Tin Room calendar.
const TYPOS = [
  [/\bfrankenstien\b/gi, 'Frankenstein'],
  [/\bsleepy\s+hallow\b/gi, 'Sleepy Hollow'],
];

function tidyNote(s) {
  let n = oneLine(s || '').replace(/^[\s,;:&+|–—-]+|[\s,;:|–—!-]+$/g, '').replace(/^\(|\)$/g, '').trim();
  if (!n || /^(?:the\s+)?(?:movies?|films?|screening|feature)$/i.test(n)) return null;
  if (isAllCaps(n)) n = n.charAt(0) + n.slice(1).toLowerCase();
  if (/^open[- ]?cap/i.test(n)) return 'Open captions';
  if (/^closed[- ]?cap/i.test(n)) return 'Closed captions';
  if (/^(?:q\s?&\s?a|q\s+and\s+a)$/i.test(n)) return 'Q&A';
  const mm = n.match(/^(?:in\s+|on\s+)?((?:16|35|70)\s?mm)$/i);
  if (mm) return mm[1].replace(/\s/g, '').toLowerCase();
  return n.charAt(0).toUpperCase() + n.slice(1);
}

const TRAILING_ADDONS = [
  /\s*[-–—:|,]?\s*\(?\b(?:in|on)\s+((?:16|35|70)\s?mm)\)?$/i,
  /\s*[-–—:|,]\s*((?:16|35|70)\s?mm)$/i,
  /\s*\(((?:16|35|70)\s?mm)\)$/i,
  /\s*[-–—:|,]?\s*\(?\s*(open[- ]?cap(?:tion(?:ed|s)?)?)\s*\)?$/i,
  /\s*[-–—:|,]?\s*\(?\s*(closed[- ]?cap(?:tion(?:ed|s)?)?)\s*\)?$/i,
  /\s*[-–—:|,]?\s*\(?\s*((?:\+|w\/|with)\s*(?:a\s+)?(?:live\s+)?(?:q\s?&\s?a|q\s+and\s+a|discussion|panel|conversation|intro(?:duction)?|filmmakers?|directors?|shadow\s+cast|costume\s+contest|trivia)\b[^()]*)\)?$/i,
  /\s*[-–—:|,]?\s*\(\s*(q\s?&\s?a)\s*\)$/i,
  /\s*[-–—:|,]\s*(q\s?&\s?a)$/i,
  /\s*[-–—:|,]?\s*\(?\s*((?:sing|quote)[- ]?a[- ]?long)\s*\)?$/i,
  /\s*[-–—:|,]?\s*\(?\s*(sensory[- ]friendly(?:\s+screening)?)\s*\)?$/i,
  /\s*[-–—:|,]?\s*\(?\s*(\d+(?:st|nd|rd|th)\s+anniversary(?:\s+(?:screening|edition))?)\s*\)?$/i,
  /\s*[-–—:|,]?\s*\(?\s*((?:new\s+)?4k\s+restoration)\s*\)?$/i,
  /\s*[-–—:|]\s*(double\s+feature)$/i,
];

const SERIES_PREFIX =
  /^((?:[^:]*\b(?:presents?|series|night|nights|movie|movies|matinee|classics?|club|marathon|double\s+feature|spooky\s+season)\b)[^:]*):\s+(.+)$/i;

const yearIn = (t) => {
  const m = t.match(/\s*\((18[89]\d|19\d\d|20\d\d)\)\s*$/);
  return m ? { year: +m[1], rest: t.slice(0, m.index).trim() } : null;
};

function cleanTitle(raw) {
  let title = oneLine(raw || '');
  const notes = [];
  let year;
  for (let guard = 0; guard < 6; guard++) {
    const before = title;
    const y = yearIn(title);
    if (y && y.rest) {
      year = year ?? y.year;
      title = y.rest;
    }
    for (const re of TRAILING_ADDONS) {
      const m = title.match(re);
      if (m && m.index > 0) {
        notes.unshift(tidyNote(m[1]));
        title = title.slice(0, m.index).trim();
      }
    }
    const sm = title.match(SERIES_PREFIX);
    if (sm && sm[2].trim().length >= 2) {
      notes.unshift(tidyNote(sm[1]));
      title = sm[2].trim();
    }
    if (title === before) break;
  }
  title = title.replace(/[\s,;:–—-]+$/, '').trim() || oneLine(raw || '');
  if (isAllCaps(title)) title = titleCase(title);
  for (const [re, fix] of TYPOS) title = title.replace(re, fix);
  return { title, notes: [...new Set(notes.filter(Boolean))], year };
}

// ---------------------------------------------------------------- film details

const TICKET_HOST = /eventbrite|tickettailor|buytickets\.at|ticketsource|brownpapertickets|eventive|universe\.com|ticketleap|showclix|simpletix|ticketstripe|tix\.|\/tickets?\b/i;

function describe(html) {
  let text = htmlToText(html || '');
  text = text
    .split('\n')
    .filter((line) => !/^every\s+(?:other\s+)?\w+days?$/i.test(line.trim()))
    .join('\n');
  text = cleanText(text);
  if (isAllCaps(text)) {
    text = text
      .split('\n')
      .map((l) => (l ? l.charAt(0) + l.slice(1).toLowerCase() : l))
      .map((l) => l.replace(/\b[\w-]+(?:\.[\w-]+)*\.(?:com|org|net|film|us)\b/gi, (d) => d.toLowerCase()))
      .join('\n');
  }
  return text;
}

function ticketLink(html) {
  if (!html) return undefined;
  const $ = cheerio.load(`<div>${html}</div>`);
  let found;
  $('a[href]').each((_, a) => {
    const href = absUrl($(a).attr('href'), SITE);
    if (!found && href && /^https?:\/\//.test(href) && TICKET_HOST.test(href)) found = href;
  });
  return found;
}

function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v != null && v !== '' && !(Array.isArray(v) && !v.length)) out[k] = v;
  return Object.keys(out).length ? out : undefined;
}

// ---------------------------------------------------------------- festival

// The wall-clock part of an ISO string, whatever offset it claims.
function wallClock(str) {
  const m = String(str || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? { y: +m[1], m: +m[2], d: +m[3], hh: +m[4], mm: +m[5] } : null;
}

// "Thu Oct 1, 2026 7:45 PM" in the page text, for pages without JSON-LD.
function visibleStart(text) {
  const m = text.match(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s+([A-Z][a-z]{2,8})\.?\s+(\d{1,2}),?\s+(\d{4}),?\s+(\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?)/i);
  const month = m && monthNumber(m[1]);
  const clock = m && parseClock(m[4]);
  return month && clock ? { y: +m[3], m: month, d: +m[2], ...clock } : null;
}

const ADDRESS = /\baddress\b|\b(?:WA|Washington)\s+9\d{4}\b|\b\d{3,5}\s+(?:[NSEW]{1,2}\s+)?\d*\w*\s+(?:St|Street|Ave|Avenue)\b/i;
const NOT_A_SCREENING = /\b(?:awards?(?:\s+show)?|gala|red\s+carpet|reception|after[-\s]?party|party|mixer|meet\W*(?:n|and|&)\W*greet|passes?|workshop|brunch)\b/i;
const SCREENING_WORDS = /\b(?:block|screenings?|shorts?|programs?|films?|features?|premiere|showcase)\b/i;

function parseFestivalPage(html, url) {
  const $ = cheerio.load(html);
  const ev = jsonLd($).find((n) => /Event$/.test([].concat(n?.['@type'] || []).join(' ')));
  const name = oneLine(ev?.name || $('h1').first().text());

  const descEl = $('.event-page-description').first();
  let paras = descEl.find('p').toArray();
  if (!paras.length && descEl.length) paras = [descEl.get(0)];
  paras = paras.map((p) => ({ el: p, text: htmlToText($(p).html() || '') })).filter((p) => p.text);
  const allText = paras.map((p) => p.text).join('\n\n') || htmlToText(ev?.description || '');

  let start = wallClock(ev?.startDate);
  const end = wallClock(ev?.endDate);
  if (start && end) {
    const s = Date.UTC(start.y, start.m - 1, start.d, start.hh, start.mm);
    const e = Date.UTC(end.y, end.m - 1, end.d, end.hh, end.mm);
    const fixed = Date.UTC(end.y, end.m - 1, end.d, start.hh, start.mm);
    if (e - s > 24 * 3600000 && fixed <= e) start = { ...start, y: end.y, m: end.m, d: end.d };
  }
  if (!start) {
    const main = $('main').first().clone();
    main.find('script, style').remove();
    start = visibleStart(oneLine(main.text() || ''));
  }

  const where = oneLine([ev?.location?.name, ev?.location?.address?.streetAddress, $('.detail-content__location').text()].join(' '));
  const offers = [].concat(ev?.offers || []);
  const soldOut = offers.length > 0 && offers.every((o) => /SoldOut|OutOfStock|Discontinued/i.test(String(o?.availability || '')));
  const images = [].concat(ev?.image || []).filter((u) => typeof u === 'string' && /^https?:\/\//.test(u));
  // Ticket Tailor's stock artwork (userfiles/global/abstract-1.jpg) says nothing about the films.
  const image = images.find((u) => !/\/userfiles\/global\//.test(u));

  return { $, url, name, start, where, paras, allText, soldOut, image };
}

// The films in a block, from the paragraph that names the block:
// "The films playing in Block 2 are <b><i>Zombae</i></b>, <b><i>Sound Again</i></b>, and …"
function blockFilms($, paras) {
  const films = [];
  for (const p of paras) {
    if (!/\bfilms?\b/i.test(p.text)) continue;
    $(p.el)
      .find('b, strong, i, em')
      .filter((_, e) => $(e).parentsUntil(p.el).filter('b, strong, i, em').length === 0)
      .each((_, e) => {
        const t = oneLine($(e).text()).replace(/^["“”']+|["“”',.]+$/g, '');
        if (t && t.length <= 120 && !/^(?:block\b|q\s?&\s?a\b|tickets?\b|the address)/i.test(t)) films.push(t);
      });
  }
  if (!films.length) {
    const text = paras.map((p) => p.text).join(' ');
    const m = text.match(/\bfilms?\s+(?:playing|screening|showing)\b[^.]*?\b(?:are|is)\s+(.+?)\.(?:\s|$)/i);
    if (m) films.push(...m[1].split(/\s*,\s*(?:and\s+)?|\s+and\s+/).map((s) => oneLine(s)).filter(Boolean));
  }
  return [...new Set(films)];
}

async function festivalScreenings(festDays, first, last) {
  const lo = dayKey(first);
  const hi = dayKey(last);
  const flyer = festDays.find((f) => f.ev.image)?.ev.image;
  const out = [];
  const covered = new Set();

  try {
    const listing = cheerio.load(await getText(FESTIVAL_BOX_OFFICE));
    const prefix = new URL(FESTIVAL_BOX_OFFICE).pathname.replace(/\/$/, '');
    const urls = new Set();
    listing('a[href]').each((_, a) => {
      const u = absUrl(listing(a).attr('href'), FESTIVAL_BOX_OFFICE);
      if (!u) return;
      const path = new URL(u).pathname;
      if (path.startsWith(`${prefix}/`) && /^\d+\/?$/.test(path.slice(prefix.length + 1))) urls.add(u.split(/[?#]/)[0]);
    });
    if (!urls.size) warn('festival box office lists no events');

    const pages = await mapLimit([...urls], 3, async (url) => {
      try {
        return parseFestivalPage(await getText(url), url);
      } catch (err) {
        warn(`festival event ${url} failed (${err.message})`);
        return null;
      }
    });

    for (const pg of pages) {
      try {
        if (!pg?.name || !pg.start) continue;
        const key = dayKey(pg.start);
        if (key < lo || key > hi) continue;
        if (!/tin\s*room/i.test(`${pg.where} ${pg.allText}`)) continue; // another venue
        covered.add(key);
        if (NOT_A_SCREENING.test(pg.name) || !SCREENING_WORDS.test(`${pg.name} ${pg.allText}`)) continue;

        let title = pg.name.replace(/^the\s+/i, '');
        if (isAllCaps(title)) title = titleCase(title);

        const label = pg.name.match(/\bblock\s*(\d+)\b/i);
        let keep = label ? pg.paras.filter((p) => new RegExp(`\\bblock\\s*${label[1]}\\b`, 'i').test(p.text)) : [];
        if (!keep.length) keep = pg.paras.filter((p) => !ADDRESS.test(p.text));
        const films = blockFilms(pg.$, keep);
        const body = keep.map((p) => p.text).join('\n\n');
        const description = [films.length ? `Films: ${films.join(', ')}.` : '', body].filter(Boolean).join('\n\n');

        const notes = [FESTIVAL_NAME];
        if (/\bQ\s?(?:&|and)\s?A\b/i.test(body)) notes.push('Q&A');
        if (pg.soldOut) notes.push('Sold out');

        const screening = {
          theater: THEATER,
          title,
          start: seattleISO(pg.start.y, pg.start.m, pg.start.d, pg.start.hh, pg.start.mm),
          url: pg.url,
        };
        if (!pg.soldOut) screening.tickets = pg.url;
        screening.notes = notes;
        const film = compact({ description, image: pg.image || flyer });
        if (film) screening.film = film;
        out.push(screening);
      } catch (err) {
        warn(`skipped festival event "${pg?.name}" (${err.message})`);
      }
    }
  } catch (err) {
    warn(`festival box office failed (${err.message}); using the Tin Room's own festival listing`);
  }

  // Festival days the box office didn't account for: list them as the Tin Room does.
  for (const { ev, date } of festDays) {
    if (covered.has(dayKey(date)) || !ev.time) continue;
    const { title } = cleanTitle(ev.name);
    const screening = {
      theater: THEATER,
      title,
      start: seattleISO(date.y, date.m, date.d, ev.time.hh, ev.time.mm),
      url: EVENTS_PAGE,
    };
    if (title.toLowerCase() !== FESTIVAL_NAME.toLowerCase()) screening.notes = [FESTIVAL_NAME];
    const film = compact({ description: describe(ev.html), image: ev.image });
    if (film) screening.film = film;
    out.push(screening);
  }
  return out;
}

// ---------------------------------------------------------------- scrape

async function scrape() {
  const today = seattleToday();
  const first = today;
  const last = addDays(today, HORIZON_DAYS);

  const events = await loadEvents();
  const films = new Map(); // title -> film details, shared by every showing
  const shows = [];
  const festDays = [];

  for (const ev of events) {
    try {
      const name = oneLine(ev.name);
      if (!name) continue;
      const dates = occurrences(ev, first, last);
      if (!dates.length) continue;
      if (FESTIVAL_RE.test(name)) {
        for (const date of dates) festDays.push({ ev, date });
        continue;
      }
      const text = describe(ev.html);
      if (!isFilm(name, text)) continue;
      if (!ev.time) {
        warn(`"${name}" has no start time; skipped`);
        continue;
      }

      const cleaned = cleanTitle(name);
      const details = compact({ description: text || undefined, year: cleaned.year, image: ev.image }) || {};
      const known = films.get(cleaned.title);
      films.set(cleaned.title, { ...details, ...(known || {}) });

      const tickets = ticketLink(ev.html);
      for (const date of dates) shows.push({ title: cleaned.title, notes: cleaned.notes, date, time: ev.time, tickets });
    } catch (err) {
      warn(`skipped event "${oneLine(ev?.name)}" (${err.message})`);
    }
  }

  const out = [];
  for (const s of shows) {
    const screening = {
      theater: THEATER,
      title: s.title,
      start: seattleISO(s.date.y, s.date.m, s.date.d, s.time.hh, s.time.mm),
      url: EVENTS_PAGE,
    };
    if (s.tickets) screening.tickets = s.tickets;
    if (s.notes.length) screening.notes = s.notes;
    const film = films.get(s.title);
    if (film && Object.keys(film).length) screening.film = film;
    out.push(screening);
  }

  if (festDays.length) out.push(...(await festivalScreenings(festDays, first, last)));

  const seen = new Set();
  const unique = out.filter((s) => {
    const k = `${s.title.toLowerCase()}|${s.start}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  unique.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
  return unique;
}

export default {
  id: THEATER,
  scrape,
};
