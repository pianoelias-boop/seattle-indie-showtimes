// Runs every theater's scraper and writes site/data/showtimes.json.
//
// One broken scraper never takes the site down: if a source fails, its
// theaters keep their showings from the previous run (the ones still in the
// future) and are marked stale, so the page can say so.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { THEATERS, THEATER_IDS } from './theaters.js';
import { SOURCES } from './sources/index.js';
import { validateScreening } from './lib/validate.js';
import { toSeattleISO } from './lib/time.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'site', 'data', 'showtimes.json');
const HORIZON_DAYS = 42;
const SOURCE_TIMEOUT_MS = 4 * 60 * 1000;

// Venues that share a room: the same film at the same minute is one screening,
// credited to the presenter rather than the building.
const SAME_ROOM = [['siff-film-center', 'grand-illusion']];

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));

async function loadPrevious() {
  try {
    return JSON.parse(await readFile(OUT, 'utf8'));
  } catch {
    return null;
  }
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function titleKey(title) {
  return String(title)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\(\d{4}\)\s*$/, '')
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function slug(str) {
  return titleKey(str).replace(/\s+/g, '-').slice(0, 60) || 'film';
}

// Pick the most useful value among several sources' versions of a field.
function pickDescription(values) {
  const good = values.filter((v) => typeof v === 'string' && v.trim().length >= 40);
  if (!good.length) return values.find((v) => typeof v === 'string' && v.trim()) || undefined;
  // The fullest synopsis, but not a wall of text.
  good.sort((a, b) => score(b) - score(a));
  return good[0].trim();
  function score(v) {
    const n = v.length;
    return n > 2500 ? 2500 - (n - 2500) : n;
  }
}

function mostCommon(values) {
  const counts = new Map();
  for (const v of values) if (v != null && v !== '') counts.set(v, (counts.get(v) || 0) + 1);
  let best;
  let bestN = 0;
  for (const [v, n] of counts) if (n > bestN) [best, bestN] = [v, n];
  return best;
}

function prettiestTitle(titles) {
  // Prefer mixed case over ALL CAPS, then the most common spelling.
  const mixed = titles.filter((t) => t !== t.toUpperCase());
  return mostCommon(mixed.length ? mixed : titles);
}

async function main() {
  const previous = await loadPrevious();
  const now = new Date();
  const nowISO = toSeattleISO(now);
  const horizon = new Date(now.getTime() + HORIZON_DAYS * 86400000);
  // Keep showings that started up to 3 hours ago: the page hides past ones itself,
  // and this keeps "today" intact if the job runs late.
  const cutoff = new Date(now.getTime() - 3 * 3600000);

  const sources = only.length ? SOURCES.filter((s) => only.includes(s.id)) : SOURCES;
  const results = await Promise.all(
    sources.map(async (source) => {
      const t0 = Date.now();
      try {
        const raw = await withTimeout(source.scrape(), SOURCE_TIMEOUT_MS, source.id);
        if (!Array.isArray(raw)) throw new Error('scrape() did not return an array');
        const valid = [];
        let invalid = 0;
        for (const s of raw) {
          if (validateScreening(s, THEATER_IDS).length) invalid++;
          else valid.push(s);
        }
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`✓ ${source.id}: ${valid.length} screenings${invalid ? `, ${invalid} invalid dropped` : ''} (${secs}s)`);
        return { source, ok: true, screenings: valid };
      } catch (err) {
        console.error(`✗ ${source.id}: ${err.message}`);
        return { source, ok: false, error: err.message };
      }
    }),
  );

  // Which theaters each source covered this run.
  const theaterStatus = new Map();
  let screenings = [];
  for (const r of results) {
    if (r.ok) {
      const covered = new Set(r.source.theaters);
      for (const s of r.screenings) covered.add(s.theater);
      for (const id of covered) {
        theaterStatus.set(id, { ok: true, checked: nowISO, lastSuccess: nowISO });
      }
      screenings.push(...r.screenings);
    } else {
      for (const id of r.source.theaters) {
        theaterStatus.set(id, { ok: false, checked: nowISO, error: r.error });
      }
    }
  }

  // Carry forward previous data for theaters that failed, or that this run skipped.
  if (previous) {
    const prevFilms = new Map(previous.films.map((f) => [f.id, f]));
    const prevTheaters = new Map(previous.theaters.map((t) => [t.id, t]));
    for (const t of THEATERS) {
      const st = theaterStatus.get(t.id);
      if (st?.ok) continue;
      const carried = previous.showings
        .filter((s) => s.theater === t.id && new Date(s.start) > cutoff)
        .map((s) => {
          const f = prevFilms.get(s.film) || {};
          return {
            theater: s.theater,
            title: f.title || s.film,
            start: s.start,
            url: s.url || f.links?.[s.theater],
            tickets: s.tickets,
            notes: s.notes,
            film: f,
          };
        });
      screenings.push(...carried);
      const prevStatus = prevTheaters.get(t.id)?.status;
      if (st) {
        st.lastSuccess = prevStatus?.lastSuccess;
        st.stale = true;
      } else if (prevStatus) {
        // Not run this time (a partial run from the command line): keep its old status.
        theaterStatus.set(t.id, prevStatus);
      }
    }
  }

  // A presenter's show at another theater on the list ("At Central Cinema")
  // belongs to that theater, so it lands on the right pin and merges with
  // that theater's own listing of it.
  const byName = new Map(THEATERS.map((t) => [t.name.toLowerCase().replace(/^the\s+/, ''), t.id]));
  for (const s of screenings) {
    const i = (s.notes || []).findIndex((n) => /^At /.test(n));
    if (i === -1) continue;
    const host = byName.get(s.notes[i].slice(3).trim().toLowerCase().replace(/^the\s+/, ''));
    if (!host || host === s.theater) continue;
    const presenter = THEATERS.find((t) => t.id === s.theater)?.name || s.theater;
    s.notes = s.notes.map((n, j) => (j === i ? `Presented by ${presenter.startsWith('The ') ? presenter : `the ${presenter}`}` : n));
    s.theater = host;
  }

  // Window: from a little before now to the horizon.
  screenings = screenings.filter((s) => {
    const d = new Date(s.start);
    return d > cutoff && d < horizon;
  });

  // Build the film list, merging the same film across theaters.
  const groups = new Map();
  for (const s of screenings) {
    const key = titleKey(s.title);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  const films = [];
  const filmIdByKey = new Map();
  const usedIds = new Set();
  for (const [key, list] of groups) {
    const details = list.map((s) => s.film || {});
    let id = slug(key);
    while (usedIds.has(id)) id += '-2';
    usedIds.add(id);
    filmIdByKey.set(key, id);
    const links = {};
    for (const s of list) if (s.url && !links[s.theater]) links[s.theater] = s.url;
    const genres = [...new Set(details.flatMap((d) => d.genres || []))].slice(0, 4);
    films.push({
      id,
      title: prettiestTitle(list.map((s) => s.title.trim())),
      description: pickDescription(details.map((d) => d.description)),
      runtime: mostCommon(details.map((d) => d.runtime)),
      year: mostCommon(details.map((d) => d.year)),
      director: mostCommon(details.map((d) => d.director)),
      country: mostCommon(details.map((d) => d.country)),
      language: mostCommon(details.map((d) => d.language)),
      rating: mostCommon(details.map((d) => d.rating)),
      genres: genres.length ? genres : undefined,
      image: details.find((d) => d.image)?.image,
      links,
    });
  }

  // Showings, de-duplicated.
  const seen = new Map();
  const showings = [];
  for (const s of screenings) {
    const film = filmIdByKey.get(titleKey(s.title));
    if (!film) continue;
    let theater = s.theater;
    const room = SAME_ROOM.find((pair) => pair.includes(theater));
    const roomKey = room ? room.join('+') : theater;
    const key = `${roomKey}|${film}|${new Date(s.start).getTime()}`;
    if (seen.has(key)) {
      // Credit the presenter (the later entry in SAME_ROOM) if both listed it.
      const existing = seen.get(key);
      if (room && room.indexOf(theater) > room.indexOf(existing.theater)) existing.theater = theater;
      const notes = new Set([...(existing.notes || []), ...(s.notes || [])]);
      existing.notes = notes.size ? [...notes] : undefined;
      existing.tickets ||= s.tickets;
      continue;
    }
    const entry = {
      film,
      theater,
      start: s.start,
      url: s.url,
      tickets: s.tickets,
      notes: s.notes?.length ? [...new Set(s.notes.map((n) => String(n).trim()).filter(Boolean))] : undefined,
    };
    seen.set(key, entry);
    showings.push(entry);
  }
  showings.sort((a, b) => new Date(a.start) - new Date(b.start) || a.theater.localeCompare(b.theater));

  // Drop films whose showings all got merged away.
  const liveFilms = new Set(showings.map((s) => s.film));
  const finalFilms = films.filter((f) => liveFilms.has(f.id)).sort((a, b) => a.title.localeCompare(b.title));

  // Per-theater counts and how far out each theater has published.
  const theaters = THEATERS.map((t) => {
    const mine = showings.filter((s) => s.theater === t.id);
    const status = theaterStatus.get(t.id) || { ok: false, checked: nowISO, error: 'No scraper ran for this theater' };
    return {
      ...t,
      status: {
        ...status,
        showings: mine.length,
        through: mine.length ? mine[mine.length - 1].start.slice(0, 10) : undefined,
      },
    };
  });

  const data = {
    updated: nowISO,
    theaters,
    films: finalFilms.map(stripEmpty),
    showings: showings.map(stripEmpty),
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(data, null, 1) + '\n');

  const failed = theaters.filter((t) => !t.status.ok);
  console.log(`\nWrote ${showings.length} showings of ${finalFilms.length} films at ${theaters.length} theaters.`);
  if (failed.length) {
    console.log(`Stale or failed: ${failed.map((t) => `${t.id} (${t.status.error})`).join(', ')}`);
  }
  // Summary for the GitHub Actions run page.
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [
      '| Theater | Showings | Through | Status |',
      '|---|---|---|---|',
      ...theaters.map(
        (t) => `| ${t.name} | ${t.status.showings} | ${t.status.through || '–'} | ${t.status.ok ? 'OK' : `Failed: ${t.status.error}${t.status.stale ? ' (kept previous data)' : ''}`} |`,
      ),
    ];
    await writeFile(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n', { flag: 'a' });
  }
  // Fail the job only if every source failed, so one bad site doesn't block the rest.
  if (results.length && results.every((r) => !r.ok)) process.exit(1);
}

function stripEmpty(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v == null || v === '') continue;
    if (Array.isArray(v) && !v.length) continue;
    if (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length) continue;
    out[k] = v;
  }
  return out;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
