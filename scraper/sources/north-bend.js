// North Bend Theatre (North Bend, WA).
//
// northbendtheatre.com is a Square Online (Weebly) brochure site; every show is
// sold on the theatre's own ticket site, tix.northbendtheatre.com, where each
// showing is a separate "event" (/event/<slug>) whose title carries its date:
// "The Matrix (Wednesday Oct. 7th @7pm)". There's no public API, but the ticket
// site's home page embeds the data behind its calendar view:
//   var calendarEventData = [{ title, start: '2026-10-07T19:00:00-07:00', end,
//                              url: '/event/…', description: '<p>…</p>',
//                              popoverContent: '<div>…<img …>…</div>' }, …]
// with every upcoming event, and the same page's Categories tab says which
// series each event belongs to (Essential Cinema, Free Shows!, …).
// Descriptions usually include a line like "1999 [R] 2h 16m" (year, rating,
// runtime), which is also how we tell films from the comedy nights and gaming
// tournaments the theatre hosts.
//
// One event page per film (mapLimit 3) adds the square poster (the listing
// only has wide banners with the dates printed on them) and the ticket prices
// (all $0 means a free show). If the calendar data ever disappears, the
// Chronological tab's HTML is parsed instead and descriptions come from the
// event pages.

import * as cheerio from 'cheerio';
import { getText, mapLimit } from '../lib/http.js';
import { localStringToISO, seattleISO, seattleToday, parseClock, parseDate } from '../lib/time.js';
import { htmlToText, cleanText, oneLine, absUrl } from '../lib/text.js';

const ID = 'north-bend';
const TIX = 'https://tix.northbendtheatre.com';
const DAYS_AHEAD = 35;

const pad = (n) => String(n).padStart(2, '0');

function addDays({ y, m, d }, days) {
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

const norm = (s) =>
  oneLine(s || '')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

function dedupe(list) {
  const seen = new Set();
  return list.filter((x) => {
    if (!x) return false;
    const k = norm(x);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
    out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------- listing

// The JSON array assigned to `name` in an inline script (string-aware bracket
// matching, so "]" inside descriptions can't cut it short), or null.
function inlineArray(html, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*\\[`).exec(html);
  if (!m) return null;
  const start = m.index + m[0].length - 1;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          const val = JSON.parse(html.slice(start, i + 1));
          return Array.isArray(val) ? val : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// calendarEventData -> [{ url, start, rawTitle, descHtml, banner, venue }]
function fromCalendar(list) {
  const out = [];
  for (const e of list) {
    try {
      const url = absUrl(e?.url, TIX);
      // The wall-clock part is what the theatre means; the offset is ignored.
      const start = localStringToISO(e?.start || '');
      const rawTitle = oneLine(e?.title || '');
      if (!url || !start || !rawTitle) continue;
      let banner;
      let venue;
      if (e.popoverContent) {
        const $p = cheerio.load(String(e.popoverContent));
        banner = absUrl($p('img').first().attr('src'), TIX);
        venue = oneLine($p('.eventVenue').first().text()) || undefined;
      }
      out.push({ url, start, rawTitle, descHtml: String(e.description || ''), banner, venue });
    } catch (err) {
      console.warn(`${ID}: skipped a calendar entry: ${err.message}`);
    }
  }
  return out;
}

// Fallback: the Chronological tab (month headers, day blocks, time + link).
function fromChronological($) {
  const root = $('#chronologicalEventsList');
  if (!root.length) return null;
  const out = [];
  let month = null;
  let year = null;
  root.children().each((_, el) => {
    const $el = $(el);
    if ($el.is('.monthAndYear')) {
      const m = String($el.attr('data-month-year') || '').match(/^(\d{1,2})-(\d{4})$/);
      if (m) [month, year] = [+m[1], +m[2]];
      return;
    }
    if (!$el.is('.dayOfWeekBlock')) return;
    const date = parseDate(oneLine($el.find('.dayTitle').first().text()));
    if (!date) return;
    const y = month === date.m && year ? year : date.y;
    $el.find('.chronologicalEvent').each((_, ev) => {
      const $ev = $(ev);
      const $a = $ev.find('.title a').first();
      const url = absUrl($a.attr('href'), TIX);
      const clock = parseClock(oneLine($ev.find('.dateAndTime').first().text()));
      const rawTitle = oneLine($a.text());
      if (!url || !clock || !rawTitle) return;
      out.push({
        url,
        start: seattleISO(y, date.m, date.d, clock.hh, clock.mm),
        rawTitle,
        descHtml: '',
        banner: absUrl($ev.find('.eventImage img').first().attr('src'), TIX),
      });
    });
  });
  return out;
}

// Categories tab: event url -> [category names].
function categoriesByUrl($) {
  const map = new Map();
  $('.categoryBlock').each((_, block) => {
    const name = oneLine($(block).find('.categoryTitle').first().text());
    if (!name) return;
    $(block)
      .find('a[href*="/event/"]')
      .each((_, a) => {
        const url = absUrl($(a).attr('href'), TIX);
        if (!url) return;
        if (!map.has(url)) map.set(url, []);
        if (!map.get(url).includes(name)) map.get(url).push(name);
      });
  });
  return map;
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
  if (!/\s/.test(str.trim()) && letters.length <= 3) return false; // "RRR", "TGR"
  return true;
}

const WEEKDAY = String.raw`(?:mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:day)?`;
const MONTH = String.raw`(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?`;
const CLOCK = String.raw`\d{1,2}(?::\d{2})?\s*[ap]\.?m\b`;

// "(Wednesday Oct. 7th @7pm)", "(Sunday Oct. 4th at 12pm)", or unclosed.
const WHEN_PAREN = new RegExp(
  String.raw`\s*\((?=[^()]*(?:\b${WEEKDAY}\b|\b${MONTH}\s*\d|@|\b${CLOCK}))[^()]*\)?[\s_.,]*$`,
  'i',
);
// "… - Friday Oct. 3rd @ 7pm", "… | Oct 3"
const WHEN_TAIL = new RegExp(String.raw`\s*[-–—|,:]\s*(?=[^()]*\d)(?:\b${WEEKDAY}\b|\b${MONTH}\s*\d)[^()]*$`, 'i');
const AT_TAIL = new RegExp(String.raw`\s*(?:@|\bat\b)\s*${CLOCK}\.?\s*$`, 'i');

function stripWhen(raw) {
  let t = oneLine(raw).replace(/[\s_]+$/, '');
  for (let i = 0; i < 3; i++) {
    const before = t;
    t = t.replace(WHEN_PAREN, '').replace(WHEN_TAIL, '').replace(AT_TAIL, '').replace(/[\s_]+$/, '');
    if (t === before) break;
  }
  return t || oneLine(raw);
}

// Prefixes that name a series or kind of showing, not the film.
const PREFIX_KEY =
  /\b(?:presents?|presented by|screenings?|series|club|matinees?|give-?back|benefit|fundraiser|sneak (?:peek|preview)|premiere|(?:double|triple) feature|marathon|festival|showcase|spotlight|tribute|retrospective|celebration|essential cinema|caption(?:ed|s)?|sensory|accessib\w*|special event)\b/i;

const LEADING_TAG =
  /^(sneak (?:peek|preview)|advance screening|premiere(?: event)?|special (?:screening|event)|encore(?: screening)?)\s+(?!of\b|for\b|to\b|at\b|by\b)(\S.*)$/i;

const TRAILING_TAGS = [
  /\s*[-–—:|,]?\s*\(?\s*((?:presented|hosted)\s+by\s+[^()]+?)\)?$/i,
  /\s*[-–—:|,]?\s*\(?\s*((?:the\s+)?\d+(?:st|nd|rd|th)\s+annual\b[^()]*?)\)?$/i,
  /\s*[-–—:|,!]?\s*\(?\s*((?:double|triple)\s+feature)!*\)?$/i,
  /\s*[-–—:|,]?\s*\(?\s*(3-?D|open[- ]?cap(?:tion(?:ed|s)?)?|closed[- ]?cap(?:tion(?:ed|s)?)?|q\s?&\s?a|sing[- ]?a[- ]?long|sensory[- ]friendly(?:\s+screening)?|\d+(?:st|nd|rd|th)\s+anniversary(?:\s+(?:screening|edition|re-?release))?|(?:new\s+)?4k\s+restoration|(?:16|35|70)\s?mm|director'?s\s+cut|extended\s+(?:cut|edition))\s*!*\)?$/i,
];

// Words in a " with …" / " featuring …" tail that make it an add-on.
const ADDON_TAIL =
  /^(?:an?\s+|the\s+)?(?:live\b|special guests?\b|q\s?&\s?a\b|in[- ]person\b)|\b(?:shadow cast|accompaniment|live (?:score|music|soundtrack)|q\s?&\s?a|intro(?:duction)?|discussion|talkback|panel|in person)\b/i;
const GUEST_WORDS = /\b(?:guests?|q\s?&\s?a|in[- ]person|conversation|appearance|signing|talkback|joined by|join us|special)\b/i;
const NAME_TAIL = /^(?:[A-Z][\p{L}'’.-]+\s+){1,3}[A-Z][\p{L}'’.-]+!*$/u;

// A raw event title -> { title, year, notes }.
// `series` holds normalized category names that act as title prefixes.
function parseTitle(raw, descText, series) {
  const base = stripWhen(raw);
  let title = base;
  let year;
  const notes = [];
  const isPrefix = (p) => PREFIX_KEY.test(p) || series.has(norm(p));

  for (let guard = 0; guard < 6; guard++) {
    const before = title;

    const y = title.match(/\s*\(((?:18|19|20)\d\d)\)\s*$/);
    if (y && y.index > 0) {
      year = year ?? +y[1];
      title = title.slice(0, y.index).trim();
    }

    // "… with Live Shadow Cast!", "… + Q&A with director", "… with Ray Wise!".
    // Rightmost connector first, so "Fire Walk With Me with …" keeps its title.
    const joins = [...title.matchAll(/\s+(?:with|featuring|feat\.|ft\.|w\/|\+)\s+/gi)].reverse();
    for (const [i, j] of joins.entries()) {
      const head = title.slice(0, j.index);
      const tail = title.slice(j.index + j[0].length);
      if (head.length < 2 || !tail) continue;
      if (ADDON_TAIL.test(tail)) {
        notes.push(tail);
        title = head;
        break;
      }
      if (i === 0 && NAME_TAIL.test(tail) && descText) {
        const name = tail.replace(/!+$/, '').trim();
        if (descText.toLowerCase().includes(name.toLowerCase()) && GUEST_WORDS.test(descText)) {
          notes.push(`With ${isAllCaps(name) ? titleCase(name) : name}`);
          title = head;
          break;
        }
      }
    }

    for (const re of TRAILING_TAGS) {
      const m = title.match(re);
      if (m && m.index > 0) {
        notes.push(m[1]);
        title = title.slice(0, m.index).trim();
      }
    }

    let m;
    if ((m = title.match(/^([^!?:()]{3,40}?)!+\s+(\S.*)$/)) && isPrefix(m[1])) {
      // "Accessibility Screening! Project Hail Mary", "DOUBLE FEATURE! A & B"
      notes.push(m[1]);
      title = m[2];
    } else if ((m = title.match(/^(.{1,60}?[^\s-])-\s+(\S.*)$/))) {
      // "Essential Cinema- King of Hearts", "Sensory Screening- A Minecraft Movie"
      notes.push(m[1]);
      title = m[2];
    } else if ((m = title.match(/^([^:]{2,60}?):\s+(\S.*)$/)) && isPrefix(m[1])) {
      // "Jeff Warren Presents: The Thing", "Behind the Curtain: Lynch/Oz"
      notes.push(m[1]);
      title = m[2];
    } else if ((m = title.match(/^(.{2,60}?)\s+[-–—|]\s+(\S.*)$/)) && isPrefix(m[1])) {
      notes.push(m[1]);
      title = m[2];
    } else if ((m = title.match(LEADING_TAG))) {
      notes.push(m[1]);
      title = m[2];
    }

    title = title.replace(/^[\s,;:|–—-]+|[\s,;:|–—-]+$/g, '').trim();
    if (title.length < 2) {
      title = before;
      break;
    }
    if (title === before) break;
  }

  if (!title) title = base;
  title = isAllCaps(title) ? titleCase(title) : title;
  return { title, year, notes };
}

// ---------------------------------------------------------------- notes

// "Live Shadow Cast" -> "Live shadow cast", but only when every word is
// generic; series and people's names keep their capitals.
const GENERIC_WORDS = new Set(
  ('live shadow cast screening screenings special event premiere feature double triple sneak peek preview annual ' +
    'matinee matinees senior seniors free film films soundtrack accompaniment score music guest guests discussion ' +
    'intro introduction panel talkback in person with and the of a an edition anniversary restoration restored cut ' +
    "extended director's director directors filmmaker filmmakers crew ski mountain bike family kids").split(' '),
);

function sentenceCase(note) {
  const [head, ...tail] = note.split(/(\s+by\s+.*)$/i);
  const words = head.split(/\s+/);
  const ok = words.slice(1).every((w) => {
    const bare = w.replace(/[^\p{L}\p{N}'&]/gu, '');
    return !bare || GENERIC_WORDS.has(bare.toLowerCase()) || /^\d+(?:st|nd|rd|th)?$/i.test(bare) || /^[A-Z0-9&]{2,4}$/.test(bare);
  });
  if (!ok || words.length < 2) return note;
  const out = words.map((w, i) => (i === 0 || /^[A-Z0-9&]{2,4}$/.test(w.replace(/[^\p{L}\p{N}&]/gu, '')) ? w : w.toLowerCase()));
  return out.join(' ') + tail.join('');
}

function tidyNote(s, generic = false) {
  let n = oneLine(s || '')
    .replace(/^[\s,;:&+|–—!-]+|[\s,;:|–—!-]+$/g, '')
    .replace(/^\((.*)\)$/, '$1')
    .trim();
  if (!n) return null;
  if (isAllCaps(n)) n = n.charAt(0) + n.slice(1).toLowerCase();
  // "FREE Senior Matinee" -> "Free Senior Matinee"
  n = n.replace(/\b([A-Z])([A-Z]{3,})\b/g, (_, a, b) => a + b.toLowerCase());
  if (/^open[- ]?cap/i.test(n)) return 'Open captions';
  if (/^closed[- ]?cap/i.test(n)) return 'Closed captions';
  if (/^sing[- ]?a[- ]?long$/i.test(n)) return 'Sing-along';
  if (/^q\s?&\s?a$/i.test(n)) return 'Q&A';
  if (/^3-?d$/i.test(n)) return '3D';
  if (/^sensory/i.test(n)) return 'Sensory friendly';
  if (/^accessib/i.test(n)) return 'Accessibility screening';
  if (/^(?:16|35|70)\s?mm$/i.test(n)) return n.replace(/\s/g, '').toLowerCase();
  const p = n.match(/^(.+?)\s+presents?$/i);
  if (p) return `Presented by ${p[1]}`;
  n = n.charAt(0).toUpperCase() + n.slice(1);
  return generic ? sentenceCase(n) : n;
}

// Category names -> notes, leaving out the per-film buckets ("PAW Patrol: The
// Dino Movie", "Wicked", "How To Train Your Dragon 2025").
const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'in', 'on', 'to']);
const tokens = (s) => new Set(norm(s).split(' ').filter((w) => w && !STOP.has(w)));

function sameFilm(category, title) {
  const c = tokens(category);
  const t = tokens(title);
  if (!c.size || !t.size) return false;
  const inter = [...t].filter((w) => c.has(w)).length;
  if (inter === t.size || inter === c.size) return true;
  return inter / new Set([...c, ...t]).size >= 0.5;
}

function categoryNotes(cats, title) {
  const out = [];
  for (const cat of cats) {
    const c = oneLine(cat).replace(/!+$/, '').trim();
    if (!c || sameFilm(c, title)) continue;
    if (/^free (?:shows?|screenings?|movies?|films?|events?)$/i.test(c)) out.push('Free');
    else if (/open cap/i.test(c)) out.push('Open captions');
    else if (/sensory/i.test(c)) out.push('Sensory friendly');
    else {
      const m = c.match(/^(.+?)\s+(presented|sponsored|hosted)\s+by\s+(.+)$/i);
      if (m) {
        out.push(m[1]);
        if (!/sponsored/i.test(m[2])) out.push(`Presented by ${m[3]}`);
      } else out.push(c);
    }
  }
  return out;
}

const FREE_TEXT =
  /\bfree admission\b|\badmission is free\b|\bfree (?:of charge|event|screening|show)\b|\byour free tickets?\b|\bfree tickets?\b|\bno charge\b/i;

function descNotes(text) {
  const notes = [];
  if (!text) return notes;
  if (FREE_TEXT.test(text)) notes.push('Free');
  if (/\bmystery (?:showing|screening|movie|film)\b/i.test(text)) notes.push('Mystery movie');
  const fmt = text.match(/\b(?:on|in)\s+(?:glorious\s+|beautiful\s+|original\s+|vintage\s+)?(VHS|16\s?mm|35\s?mm|70\s?mm)\b/i);
  if (fmt) notes.push(/vhs/i.test(fmt[1]) ? 'VHS' : fmt[1].replace(/\s/g, '').toLowerCase());
  return notes;
}

// ---------------------------------------------------------------- films

const RATING = /\[\s*(G|PG|PG-13|R|NC-17|NR|Not Rated|Unrated|M|MA15\+|TV-[A-Z0-9]+)\s*\]/i;
const RUNTIME_HM = /\b(\d)\s*h(?:rs?|ours?)?\.?\s*(?:(\d{1,2})\s*m(?:in(?:ute)?s?)?\.?)?(?![a-z])/i;
const RUNTIME_MIN = /\b(\d{2,3})\s*min(?:ute)?s?\b/i;
const YEAR = /\b(18[89]\d|19\d\d|20\d\d)\b/;

const normRating = (r) => (/^(?:not rated|unrated)$/i.test(r) ? 'NR' : r.toUpperCase());

// "1999 [R] 2h 16m", "1968 [Not Rated] 1 h 28m", "2022 1h 48m", "1h 58m" -> fields, or null.
function metaLine(line) {
  if (!line || line.length > 60) return null;
  const rating = line.match(RATING);
  const hm = line.match(RUNTIME_HM);
  const mins = hm ? null : line.match(RUNTIME_MIN);
  if (!rating && !hm && !mins) return null;
  let rest = line.replace(RATING, ' ').replace(hm ? RUNTIME_HM : RUNTIME_MIN, ' ');
  const year = rest.match(YEAR);
  rest = rest
    .replace(YEAR, ' ')
    .replace(/\b(?:runtime|running time|run time|rated|rating|year|released?)\b/gi, ' ')
    .replace(/[\s()[\]|,.·•:;/–—-]+/g, '');
  if (rest.length) return null; // a sentence that happens to mention a rating
  let runtime;
  if (hm) runtime = +hm[1] * 60 + (hm[2] ? +hm[2] : 0);
  else if (mins) runtime = +mins[1];
  return {
    year: year ? +year[1] : undefined,
    rating: rating ? normRating(rating[1]) : undefined,
    runtime: runtime > 0 && runtime < 1000 ? runtime : undefined,
  };
}

function filmMeta(text) {
  const metas = String(text || '')
    .split('\n')
    .map((l) => metaLine(l.trim()))
    .filter(Boolean);
  const key = (m) => `${m.year}|${m.rating}|${m.runtime}`;
  // Double features list one line per film; don't guess which is "the" film.
  const meta = metas.length && metas.every((m) => key(m) === key(metas[0])) ? metas[0] : null;
  const out = { ...(meta || {}), hasMeta: metas.length > 0 };
  if (!out.rating) {
    const r = String(text || '').match(/\brated\s+\[?(PG-13|NC-17|PG|G|R|NR|Not Rated|Unrated)\]?(?![\w-])/i);
    if (r) out.rating = normRating(r[1]);
  }
  return out;
}

const NAME_PART = String.raw`(?:[A-Z][\p{L}'’.-]+|de|da|del|van|von|der|le|la|di|du)`;
const DIRECTED_BY = new RegExp(
  String.raw`(?:\b[Dd]irected by|(?<!\b(?:[Aa]rt|[Cc]asting|[Ee]xecutive|[Ff]estival|[Cc]reative|[Mm]usic(?:al)?|[Aa]rtistic|[Mm]anaging|[Pp]rogram(?:ming)?|[Tt]echnical|[Aa]ssistant|[Aa]ssociate)\s)\b[Dd]irector)\s+(${NAME_PART}(?:\s+${NAME_PART}){1,3})`,
  'u',
);

function tidyName(s) {
  let n = oneLine(s)
    .replace(/['’]s$/, '')
    .replace(/[\s,.;:!]+$/, '')
    .replace(/\s+(?:de|da|del|van|von|der|le|la|di|du)$/, '');
  if (!n || n.length > 80) return undefined;
  if (isAllCaps(n)) n = titleCase(n);
  return n;
}

function directorFrom(text) {
  const t = String(text || '');
  const label = t.match(/^\s*(?:directors?|directed by)\s*:\s*(.+)$/im);
  if (label) return tidyName(label[1]);
  const re = new RegExp(DIRECTED_BY.source, 'gu');
  for (const m of t.matchAll(re)) {
    // "director David Lynch's obsession" is about someone, not a credit.
    if (/['’]s$/.test(m[1]) || /^['’]s\b/.test(t.slice(m.index + m[0].length))) continue;
    const name = tidyName(m[1]);
    if (name) return name;
  }
  return undefined;
}

// Description -> synopsis: drop the meta line, credits labels, door times,
// ticket talk and the date/title header some events repeat.
const DROP_LINE =
  /^(?:doors?\b|show\s*(?:time)?\s*:?\s*\d|(?:directors?|directed by|writers?|written by|screenplay|stars|starring|cast|runtime|running time|rated|rating|genres?)\s*:|the film is rated\b)/i;
const DROP_SENTENCE =
  /\b(?:tickets?|preorder|pre-order|box office|on sale|rsvp|admit one|limited (?:seating|seats)|free admission|admission is free|thanks to our (?:generous )?sponsors?)\b/i;
// "-Your ticket includes a participation bag!" and other house rules.
const BULLET = /^[-•*]\s*\S/;
// "September 30 | 7pm | North Bend Theatre"
const HEADER_LINE = /^[^.!?]{0,80}\|[^.!?]{0,80}$/;
const HAS_WHEN = new RegExp(`\\b${CLOCK}|\\b${MONTH}\\s*\\d`, 'i');
const isHeader = (l) => HEADER_LINE.test(l) && HAS_WHEN.test(l);

function cleanDescription(text, titles) {
  const skipTitles = new Set(titles.map(norm).filter(Boolean));
  const paras = cleanText(text)
    .split(/\n{2,}/)
    .map((para) => {
      const lines = para
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !metaLine(l) && !DROP_LINE.test(l) && !BULLET.test(l) && !skipTitles.has(norm(l)))
        .filter((l) => !isHeader(l))
        .map((l) =>
          (l.match(/[^.!?]+(?:[.!?]+["”’)]*|$)\s*/g) || [l])
            .filter((s) => !DROP_SENTENCE.test(s))
            .join('')
            .trim(),
        )
        .filter(Boolean);
      // Rejoin lines that were only wrapped mid-sentence.
      return lines.reduce((acc, l) => {
        if (!acc) return l;
        const soft = /^[a-z(]/.test(l) || !/[.!?:;"”’)\]]$/.test(acc);
        return soft ? `${acc} ${l}` : `${acc}\n${l}`;
      }, '');
    })
    .filter(Boolean);
  return paras.join('\n\n');
}

// Comedy nights, gaming tournaments and the like. Only consulted when the
// event has no film meta line.
const NOT_FILM =
  /\b(?:comedy|comedians?|stand-?up|improv|concerts?|live music|tournament|gaming|trivia|karaoke|bingo|podcast|burlesque|drag (?:show|brunch)|magic show|magician|lecture|recital|open mic|auction|gala|rentals?|private (?:event|party)|workshop|seminar|live theat(?:er|re)|play reading|symphony|choir|jazz|bluegrass|tribute band|dance party)\b/i;
const NOT_FILM_DESC =
  /\b(?:concert|live music|stand-?up|comedians?|comedy (?:show|night|competition)|tournament|live performance|perform(?:s|ing)? live)\b/i;
const FILM_WORDS = /\b(?:films?|movies?|screenings?|documentar(?:y|ies)|cinema|cartoons?|animated)\b/i;

function isFilm(rawTitle, cats, text, hasMeta) {
  if (hasMeta) return true;
  if (NOT_FILM.test(rawTitle) || cats.some((c) => NOT_FILM.test(c))) return false;
  if (NOT_FILM_DESC.test(text || '') && !FILM_WORDS.test(`${rawTitle} ${text || ''}`)) return false;
  return true;
}

// ---------------------------------------------------------------- event pages

async function fetchEventPage(url) {
  const html = await getText(url);
  const $ = cheerio.load(html);
  const image = absUrl($('#largeImageContainer img').first().attr('src'), url);
  const descHtml = $('#descriptionContainer .sectionContent').first().html() || '';
  const prices = $('[data-ticket-price]')
    .map((_, el) => Number($(el).attr('data-ticket-price')))
    .get()
    .filter((n) => Number.isFinite(n));
  return {
    image: /^https?:\/\//.test(image || '') ? image : undefined,
    descText: htmlToText(descHtml),
    free: prices.length > 0 && prices.every((p) => p === 0),
  };
}

// ---------------------------------------------------------------- scrape

function mode(list) {
  const counts = new Map();
  for (const x of list) if (x) counts.set(x, (counts.get(x) || 0) + 1);
  let best;
  let bestN = 0;
  for (const [x, n] of counts) {
    if (n > bestN) [best, bestN] = [x, n];
  }
  return best;
}

export default {
  id: ID,

  async scrape() {
    const html = await getText(`${TIX}/`);
    const $ = cheerio.load(html);

    const calendar = inlineArray(html, 'calendarEventData');
    const listed = calendar ? fromCalendar(calendar) : fromChronological($);
    if (!listed) {
      const looksLikeListing = $('.eventListSection, #categoriesPageEventsList, #calendarPage').length > 0;
      if (looksLikeListing) return []; // listing with nothing on it
      throw new Error(`${ID}: ticket site structure not recognized (no calendarEventData or chronological list)`);
    }
    if (calendar && !listed.length && calendar.length) {
      throw new Error(`${ID}: calendarEventData has ${calendar.length} entries but none could be read`);
    }

    const today = seattleToday();
    const first = `${today.y}-${pad(today.m)}-${pad(today.d)}`;
    const last = addDays(today, DAYS_AHEAD);
    const events = listed.filter((e) => {
      const day = e.start.slice(0, 10);
      return day >= first && day <= last;
    });
    if (!events.length) return [];

    const cats = categoriesByUrl($);

    // Categories spanning several different titles are series; their names
    // can be stripped when used as a title prefix ("Behind the Curtain: …").
    const titlesByCat = new Map();
    for (const e of listed) {
      for (const c of cats.get(e.url) || []) {
        if (!titlesByCat.has(c)) titlesByCat.set(c, new Set());
        titlesByCat.get(c).add(norm(stripWhen(e.rawTitle)));
      }
    }
    const series = new Set([...titlesByCat].filter(([, t]) => t.size >= 2).map(([c]) => norm(c.replace(/!+$/, ''))));

    // Group showings into films by cleaned title.
    const films = new Map();
    for (const e of events) {
      try {
        const descText = htmlToText(e.descHtml);
        const parsed = parseTitle(e.rawTitle, descText, series);
        const key = norm(parsed.title) || norm(e.rawTitle);
        if (!films.has(key)) films.set(key, { key, showings: [] });
        films.get(key).showings.push({ ...e, descText, parsed, cats: cats.get(e.url) || [] });
      } catch (err) {
        console.warn(`${ID}: skipped "${e.rawTitle}": ${err.message}`);
      }
    }

    const list = [...films.values()];
    for (const f of list) f.showings.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

    // One event page per film: square poster, prices, and the description
    // when the calendar data didn't carry it.
    await mapLimit(list, 3, async (f) => {
      const url = f.showings[0].url;
      try {
        f.page = { url, ...(await fetchEventPage(url)) };
      } catch (err) {
        console.warn(`${ID}: event page failed for "${f.showings[0].rawTitle}": ${err.message}`);
      }
    });

    const out = [];
    for (const f of list) {
      try {
        const title = mode(f.showings.map((s) => s.parsed.title)) || f.showings[0].parsed.title;
        const rawTexts = f.showings.map((s) => s.descText).filter(Boolean);
        if (!rawTexts.length && f.page?.descText) rawTexts.push(f.page.descText);
        const text = mode(rawTexts) || '';
        let meta = filmMeta(text);
        if (!meta.hasMeta) {
          const other = rawTexts.map(filmMeta).find((m) => m.hasMeta);
          if (other) meta = { ...other, rating: other.rating || meta.rating };
        }

        const allCats = [...new Set(f.showings.flatMap((s) => s.cats))];
        if (!isFilm(f.showings[0].rawTitle, allCats, text, meta.hasMeta)) continue;

        const headerTitles = [title, ...f.showings.map((s) => stripWhen(s.rawTitle))];
        const description = cleanDescription(text, headerTitles);
        const film = compact({
          description: description || undefined,
          runtime: meta.runtime,
          year: meta.year ?? f.showings.map((s) => s.parsed.year).find(Boolean),
          director: directorFrom(text),
          rating: meta.rating,
          image: f.page?.image || f.showings.find((s) => s.banner)?.banner,
        });

        for (const s of f.showings) {
          const text1 = s.descText || f.page?.descText || '';
          let notes = [
            ...s.parsed.notes.map((n) => tidyNote(n, true)),
            ...categoryNotes(s.cats, title).map((n) => tidyNote(n)),
            ...descNotes(text1),
          ];
          if (f.page?.free && f.page.url === s.url) notes.push('Free');
          if (s.venue && !/north bend/i.test(s.venue)) notes.push(`At ${s.venue}`);
          notes = dedupe(notes);
          // "Free Matinees" already says it.
          if (notes.some((n) => n !== 'Free' && /\bfree\b/i.test(n))) notes = notes.filter((n) => n !== 'Free');
          else if (notes.includes('Free')) notes = [...notes.filter((n) => n !== 'Free'), 'Free'];

          const screening = { theater: ID, title, start: s.start, url: s.url, tickets: s.url };
          if (notes.length) screening.notes = notes;
          if (Object.keys(film).length) screening.film = film;
          out.push(screening);
        }
      } catch (err) {
        console.warn(`${ID}: skipped film "${f.key}": ${err.message}`);
      }
    }

    out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.title.localeCompare(b.title)));
    return out;
  },
};
