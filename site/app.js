(function () {
  'use strict';

  const TZ = 'America/Los_Angeles';
  const DATA_URL = 'data/showtimes.json';
  const STRIP_DAYS = 7;

  const TIME_BUCKETS = [
    { value: 'matinee', label: 'Before 5 pm', test: (m) => m < 17 * 60 },
    { value: 'evening', label: '5 to 9 pm', test: (m) => m >= 17 * 60 && m < 21 * 60 },
    { value: 'late', label: '9 pm and later', test: (m) => m >= 21 * 60 },
  ];

  const VIEWS = ['theaters', 'films', 'days'];

  // ---------- helpers ----------

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);

  const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

  function groupBy(list, keyFn) {
    const map = new Map();
    for (const item of list) {
      const k = keyFn(item);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(item);
    }
    return map;
  }

  function fold(s) {
    return String(s || '')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase();
  }

  function sortTitle(t) {
    return fold(t).replace(/^(the|a|an)\s+/, '').replace(/^[^a-z0-9]+/, '');
  }

  const dateParts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  function seattleDateKey(date) {
    const p = Object.fromEntries(dateParts.formatToParts(date).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  }

  function addDays(key, n) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  }

  function keyDate(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d, 12));
  }

  const fmtWeekdayShort = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' });
  const fmtRow = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
  const fmtLong = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' });
  const fmtShortDate = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
  const fmtClock = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });

  function relDay(key) {
    if (key === today) return 'Today';
    if (key === addDays(today, 1)) return 'Tomorrow';
    return null;
  }
  const dayRow = (key) => relDay(key) || fmtRow.format(keyDate(key));
  const dayLong = (key) => fmtLong.format(keyDate(key));

  function fmtTime(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return { hm: `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}`, ap: h < 12 ? 'am' : 'pm' };
  }

  function fmtRuntime(min) {
    if (!min) return '';
    const h = Math.floor(min / 60);
    const m = min % 60;
    return h ? `${h}h${m ? ` ${m}m` : ''}` : `${m}m`;
  }

  function storage(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, value);
    } catch {
      return null;
    }
  }

  // ---------- state ----------

  let data = null;
  let theaters = {};
  let films = {};
  let all = []; // upcoming showings, enriched
  let filtered = [];
  let today = seattleDateKey(new Date());
  let stripKeys = [];
  let horizon = {}; // theater id -> last date it has published
  let hoodOrder = [];
  let mapReady = false;

  const state = {
    view: 'theaters',
    days: new Set(),
    times: new Set(),
    hoods: new Set(),
    theaters: new Set(),
    fav: false,
    q: '',
  };

  const STAR =
    '<svg class="star" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 16.8l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" fill="currentColor"/></svg>';
  const favMark = (t) => (t.favorite ? `${STAR}<span class="visually-hidden">Favorite: </span>` : '');
  const favFirst = (a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0);

  // ---------- data ----------

  function prepare(raw) {
    data = raw;
    theaters = Object.fromEntries(raw.theaters.map((t) => [t.id, t]));
    films = Object.fromEntries(raw.films.map((f) => [f.id, f]));
    for (const f of raw.films) {
      f._sort = sortTitle(f.title);
      f._search = fold([f.title, f.director].filter(Boolean).join(' '));
    }

    // Seattle neighborhoods north to south, like reading the map, then the
    // places outside the city, nearest first.
    const pts = {};
    for (const t of raw.theaters) (pts[t.neighborhood] ||= []).push(t);
    const downtown = { lat: 47.6101, lng: -122.3421 };
    const km = (h) => avg(pts[h].map((t) => Math.hypot((t.lat - downtown.lat) * 111, (t.lng - downtown.lng) * 75)));
    const inCity = (h) => km(h) < 10;
    hoodOrder = Object.keys(pts).sort((a, b) => {
      if (inCity(a) !== inCity(b)) return inCity(a) ? -1 : 1;
      if (inCity(a)) return avg(pts[b].map((t) => t.lat)) - avg(pts[a].map((t) => t.lat));
      return km(a) - km(b);
    });

    refreshUpcoming();
  }

  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

  // Called on load and every few minutes, so showings drop off as they start.
  function refreshUpcoming() {
    const now = Date.now();
    today = seattleDateKey(new Date());
    stripKeys = Array.from({ length: STRIP_DAYS }, (_, i) => addDays(today, i));
    all = [];
    for (const s of data.showings) {
      if (!films[s.film] || !theaters[s.theater]) continue;
      const ts = Date.parse(s.start);
      if (!(ts > now)) continue;
      const hh = Number(s.start.slice(11, 13));
      const mm = Number(s.start.slice(14, 16));
      all.push({ ...s, ts, date: s.start.slice(0, 10), mins: hh * 60 + mm });
    }
    all.sort((a, b) => a.ts - b.ts);
    horizon = {};
    for (const s of all) if (!horizon[s.theater] || s.date > horizon[s.theater]) horizon[s.theater] = s.date;
    // Drop selected days that have passed.
    for (const d of state.days) if (d !== 'later' && d < today) state.days.delete(d);
  }

  function dayBucket(s) {
    return s.date > stripKeys[stripKeys.length - 1] ? 'later' : s.date;
  }

  function timeBucket(s) {
    return TIME_BUCKETS.find((b) => b.test(s.mins)).value;
  }

  function matches(s, except) {
    if (except !== 'day' && state.days.size && !state.days.has(dayBucket(s))) return false;
    if (except !== 'time' && state.times.size && !state.times.has(timeBucket(s))) return false;
    if (except !== 'hood' && state.hoods.size && !state.hoods.has(theaters[s.theater].neighborhood)) return false;
    if (except !== 'theater' && state.theaters.size && !state.theaters.has(s.theater)) return false;
    if (except !== 'fav' && state.fav && !theaters[s.theater].favorite) return false;
    if (except !== 'q' && state.q) {
      const words = fold(state.q).split(/\s+/).filter(Boolean);
      const hay = films[s.film]._search;
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  }

  function activeFilterCount() {
    return (
      (state.days.size ? 1 : 0) +
      (state.times.size ? 1 : 0) +
      (state.hoods.size ? 1 : 0) +
      (state.theaters.size ? 1 : 0) +
      (state.fav ? 1 : 0) +
      (state.q ? 1 : 0)
    );
  }

  // How a film's run reads at one theater: opening later, or ending soon.
  // A run "ends" only when other films at that theater carry on past its
  // last date; otherwise the theater just hasn't posted further out yet.
  function runInfo(filmId, theaterId) {
    const here = all.filter((s) => s.theater === theaterId);
    const mine = here.filter((s) => s.film === filmId);
    if (mine.length < 3) return '';
    const first = mine[0].date;
    const last = mine[mine.length - 1].date;
    if (first > today) return first === addDays(today, 1) ? 'Opens tomorrow' : `Opens ${dayRow(first)}`;
    if (first === last) return '';
    const spans = new Map();
    for (const s of here) {
      if (s.film === filmId) continue;
      const sp = spans.get(s.film) || { a: s.date, b: s.date };
      if (s.date < sp.a) sp.a = s.date;
      if (s.date > sp.b) sp.b = s.date;
      spans.set(s.film, sp);
    }
    const continues = [...spans.values()].some((sp) => sp.a <= last && sp.b > last);
    if (!continues) return '';
    return last === today ? 'Last shows today' : `Last show ${dayRow(last)}`;
  }

  // ---------- URL and storage ----------

  function readUrl() {
    const p = new URLSearchParams(location.search);
    const view = p.get('view') || storage('view');
    if (VIEWS.includes(view)) state.view = view;
    const list = (k) => (p.get(k) || '').split(',').map((x) => x.trim()).filter(Boolean);
    state.days = new Set(list('day').filter((d) => d === 'later' || /^\d{4}-\d{2}-\d{2}$/.test(d)));
    state.times = new Set(list('time').filter((t) => TIME_BUCKETS.some((b) => b.value === t)));
    state.hoods = new Set(list('hood'));
    state.theaters = new Set(list('theater'));
    state.fav = p.get('fav') === '1';
    state.q = p.get('q') || '';
    return p.get('film');
  }

  function writeUrl(filmId) {
    const p = new URLSearchParams();
    if (state.view !== 'theaters') p.set('view', state.view);
    if (state.days.size) p.set('day', [...state.days].join(','));
    if (state.times.size) p.set('time', [...state.times].join(','));
    if (state.hoods.size) p.set('hood', [...state.hoods].join(','));
    if (state.theaters.size) p.set('theater', [...state.theaters].join(','));
    if (state.fav) p.set('fav', '1');
    if (state.q) p.set('q', state.q);
    if (filmId) p.set('film', filmId);
    const qs = p.toString();
    return `${location.pathname}${qs ? `?${qs}` : ''}`;
  }

  function syncUrl() {
    history.replaceState(history.state, '', writeUrl(currentFilm));
  }

  // ---------- rendering: shared pieces ----------

  function filmMeta(f, extra = []) {
    const bits = [f.director, f.year, fmtRuntime(f.runtime), f.rating].filter(Boolean).map(esc);
    const all = bits.concat(extra.filter(Boolean));
    return all.length ? `<p class="film-meta">${all.join(' · ')}</p>` : '';
  }

  function runHtml(text) {
    return text ? `<span class="film-run">${esc(text)}</span>` : '';
  }

  function descHtml(f, clamp = true) {
    if (!f.description) return '';
    const first = f.description.split(/\n\s*\n/)[0];
    return `<p class="film-desc${clamp ? ' is-clamped' : ''}">${esc(clamp ? first : f.description)}</p>`;
  }

  function linkFor(s) {
    return safeUrl(s.tickets) || safeUrl(s.url) || safeUrl(films[s.film].links?.[s.theater]) || safeUrl(theaters[s.theater].url);
  }

  // Notes every showing shares get said once, not on each time.
  function sharedNotes(list) {
    const [first, ...rest] = list.map((s) => s.notes || []);
    return (first || []).filter((n) => rest.every((r) => r.includes(n)));
  }

  function timeHtml(s, skip = []) {
    const { hm, ap } = fmtTime(s.mins);
    const notes = (s.notes || []).filter((n) => !skip.includes(n));
    const noteText = notes.join(', ');
    const note = notes.length ? `<span class="time-note">${esc(noteText.length > 38 ? noteText.slice(0, 36) + '…' : noteText)}</span>` : '';
    const inner = `${hm}<span class="time-ampm">\u2009${ap}</span>${note}`;
    const href = linkFor(s);
    const title = noteText ? ` title="${esc(noteText)}"` : '';
    return href
      ? `<a class="time" href="${esc(href)}" target="_blank" rel="noopener"${title}>${inner}</a>`
      : `<span class="time"${title}>${inner}</span>`;
  }

  function timesHtml(list, { limit = 4, skip = [] } = {}) {
    const byDay = groupBy(list, (s) => s.date);
    const days = [...byDay.keys()];
    const rows = days.map((d, i) => {
      const hide = i >= limit ? ' hidden' : '';
      return `<div class="times-day${d === today ? ' is-today' : ''}"${hide}>${esc(dayRow(d))}</div><div class="times-list"${hide}>${byDay
        .get(d)
        .map((s) => timeHtml(s, skip))
        .join('')}</div>`;
    });
    const more = days.length > limit ? `<button type="button" class="link-button times-more" data-more>${plural(days.length - limit, 'more day')}</button>` : '';
    return `<div class="times">${rows.join('')}${more}</div>`;
  }

  function filmButton(f) {
    return `<button type="button" class="film-link" data-film="${esc(f.id)}">${esc(f.title)}</button>`;
  }

  // ---------- views ----------

  function renderTheaters() {
    const byTheater = groupBy(filtered, (s) => s.theater);
    const narrowing = state.days.size || state.times.size || state.q;
    const tiers = [
      { id: 'favorites', title: `${STAR}Favorites`, fav: true },
      { id: 'more', title: 'More independent theaters', fav: false },
    ];
    const out = [];
    for (const tier of tiers) {
      if (state.fav && !tier.fav) continue;
      const hoods = [];
      for (const hood of hoodOrder) {
        if (state.hoods.size && !state.hoods.has(hood)) continue;
        const list = data.theaters
          .filter((t) => !!t.favorite === tier.fav && t.neighborhood === hood)
          .filter((t) => !state.theaters.size || state.theaters.has(t.id))
          .filter((t) => byTheater.has(t.id) || !narrowing)
          .sort((a, b) => a.name.localeCompare(b.name));
        if (!list.length) continue;
        const hid = `hood-${tier.id}-${slug(hood)}`;
        hoods.push(
          `<section class="hood" aria-labelledby="${hid}"><h3 class="hood-title" id="${hid}">${esc(hood)}</h3>${list
            .map((t) => theaterHtml(t, byTheater.get(t.id) || []))
            .join('')}</section>`,
        );
      }
      if (!hoods.length) continue;
      out.push(
        `<section class="tier${tier.fav ? ' is-fav' : ''}" aria-labelledby="tier-${tier.id}"><h2 class="tier-title" id="tier-${tier.id}">${tier.title}</h2>${hoods.join('')}</section>`,
      );
    }
    return out.join('');
  }

  function slug(s) {
    return fold(s).replace(/[^a-z0-9]+/g, '-');
  }

  function staleHtml(t) {
    const st = t.status || {};
    if (st.ok !== false) return '';
    if (st.lastSuccess) {
      return `<p class="stale-note">Couldn’t reach their website on the last check. These times are from ${esc(fmtShortDate.format(keyDate(st.lastSuccess.slice(0, 10))))}, so confirm with the theater.</p>`;
    }
    return `<p class="stale-note">Couldn’t reach their website on the last check. See their site for showtimes.</p>`;
  }

  function directionsUrl(t) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${t.name}, ${t.address}, Seattle, WA`)}`;
  }

  function theaterHtml(t, list) {
    const head = `
      <div class="theater-head">
        <h4 class="theater-name">${esc(t.name)}</h4>
        <p class="theater-meta">${esc(t.address)} · <a href="${esc(directionsUrl(t))}" target="_blank" rel="noopener">Directions ↗</a> · <a href="${esc(safeUrl(t.url) || '#')}" target="_blank" rel="noopener">Website ↗</a></p>
        ${t.blurb ? `<p class="theater-blurb">${esc(t.blurb)}</p>` : ''}
      </div>`;
    let body;
    if (!list.length) {
      body = `<p class="theater-empty">No showtimes listed right now. <a href="${esc(safeUrl(t.url) || '#')}" target="_blank" rel="noopener">Check their website ↗</a></p>`;
    } else {
      const byFilm = groupBy(list, (s) => s.film);
      body = `<div class="theater-films">${[...byFilm]
        .map(([filmId, shows]) => {
          const f = films[filmId];
          const shared = sharedNotes(shows);
          return `<article class="showing">
            <div class="showing-info">
              <h5 class="film-title">${filmButton(f)}</h5>
              ${filmMeta(f, [runHtml(runInfo(filmId, t.id)), ...shared.map((n) => `<span class="film-note">${esc(n)}</span>`)])}
              ${descHtml(f)}
            </div>
            ${timesHtml(shows, { limit: 4, skip: shared })}
          </article>`;
        })
        .join('')}</div>`;
    }
    return `<section class="theater" id="theater-${esc(t.id)}" data-theater="${esc(t.id)}" aria-labelledby="theater-${esc(t.id)}-name">
      ${head.replace('class="theater-name"', `class="theater-name" id="theater-${esc(t.id)}-name"`)}
      ${staleHtml(t)}
      ${body}
    </section>`;
  }

  function filmHtml(f, shows) {
    const byTheater = [...groupBy(shows, (s) => s.theater)].sort((a, b) => favFirst(theaters[a[0]], theaters[b[0]]));
    const img = safeUrl(f.image);
    const at = byTheater
      .map(([tid, ts]) => {
        const t = theaters[tid];
        const shared = sharedNotes(ts);
        const run = runInfo(f.id, tid);
        const sub = [t.neighborhood, run, ...shared].filter(Boolean).map(esc).join(' · ');
        return `<div class="film-at" data-theater="${esc(tid)}">
          <p class="film-at-name">${favMark(t)}${esc(t.name)}<span class="film-at-hood">${sub}</span></p>
          ${timesHtml(ts, { limit: 3, skip: shared })}
        </div>`;
      })
      .join('');
    return `<article class="film${img ? '' : ' no-image'}" id="film-${esc(f.id)}">
      ${img ? `<div class="film-still"><img src="${esc(img)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer"></div>` : ''}
      <div class="film-body">
        <h3 class="film-title">${filmButton(f)}</h3>
        ${filmMeta(f, [f.country, f.language].filter(Boolean).map(esc))}
        ${descHtml(f)}
        <div class="film-theaters">${at}</div>
      </div>
    </article>`;
  }

  function renderFilms() {
    const byFilm = groupBy(filtered, (s) => s.film);
    const list = [...byFilm.keys()].map((id) => films[id]).sort((a, b) => a._sort.localeCompare(b._sort));
    const atFav = (f) => byFilm.get(f.id).some((s) => theaters[s.theater].favorite);
    const tiers = [
      { id: 'favorites', title: `${STAR}At your favorites`, films: list.filter(atFav), fav: true },
      { id: 'more', title: 'Only at other theaters', films: list.filter((f) => !atFav(f)), fav: false },
    ].filter((t) => t.films.length);
    return tiers
      .map(
        (tier) =>
          `<section class="tier${tier.fav ? ' is-fav' : ''}" aria-labelledby="tier-${tier.id}"><h2 class="tier-title" id="tier-${tier.id}">${tier.title}</h2>${tier.films
            .map((f) => filmHtml(f, byFilm.get(f.id)))
            .join('')}</section>`,
      )
      .join('');
  }

  function renderDays() {
    const byDay = groupBy(filtered, (s) => s.date);
    return [...byDay]
      .map(([date, dayShows]) => {
        const shows = dayShows.slice().sort((a, b) => a.ts - b.ts || favFirst(theaters[a.theater], theaters[b.theater]));
        const rel = relDay(date);
        const title = rel ? `${rel} <span class="day-rel">${esc(dayLong(date))}</span>` : esc(dayLong(date));
        const rows = shows
          .map((s) => {
            const f = films[s.film];
            const t = theaters[s.theater];
            const meta = [f.director, fmtRuntime(f.runtime)].filter(Boolean).map(esc).join(' · ');
            return `<li class="slot" data-theater="${esc(t.id)}">
              ${timeHtml(s)}
              <div class="slot-film">${filmButton(f)}${meta ? `<p class="film-meta">${meta}</p>` : ''}</div>
              <p class="slot-where"><strong>${favMark(t)}${esc(t.name)}</strong><span>${esc(t.neighborhood)}</span></p>
            </li>`;
          })
          .join('');
        return `<section class="day"><h2 class="day-title">${title}</h2><ol>${rows}</ol></section>`;
      })
      .join('');
  }

  function describeFilters() {
    const parts = [];
    if (state.days.size) parts.push([...state.days].map((d) => (d === 'later' ? 'later dates' : dayRow(d))).join(', '));
    if (state.times.size) parts.push(TIME_BUCKETS.filter((b) => state.times.has(b.value)).map((b) => b.label).join(', '));
    if (state.hoods.size) parts.push([...state.hoods].join(', '));
    if (state.theaters.size) parts.push([...state.theaters].map((id) => theaters[id]?.name).filter(Boolean).join(', '));
    if (state.fav) parts.push('favorites only');
    if (state.q) parts.push(`“${state.q}”`);
    return parts.join('; ');
  }

  function render() {
    filtered = all.filter((s) => matches(s));
    const filmCount = new Set(filtered.map((s) => s.film)).size;
    const theaterCount = new Set(filtered.map((s) => s.theater)).size;
    const active = activeFilterCount();

    $('#summary-text').textContent = filtered.length
      ? `${plural(filmCount, 'film')} at ${plural(theaterCount, 'theater')}`
      : '';
    $('#clear-filters').hidden = !active || !filtered.length;

    const results = $('#results');
    if (!filtered.length && (active || state.view !== 'theaters')) {
      results.innerHTML = active
        ? `<div class="empty"><p>Nothing matches ${esc(describeFilters())}.</p><p><button type="button" class="link-button" data-clear>Clear filters</button></p></div>`
        : `<div class="empty"><p>No upcoming showtimes right now.</p></div>`;
    } else {
      results.innerHTML = state.view === 'films' ? renderFilms() : state.view === 'days' ? renderDays() : renderTheaters();
    }
    requestAnimationFrame(markClamped);

    updateControls();
    updateMap();
    syncUrl();
  }

  // Only offer "More" where the description is actually cut off.
  function markClamped() {
    for (const p of $$('.film-desc.is-clamped', $('#results'))) {
      if (p.scrollHeight > p.clientHeight + 2 && !p.nextElementSibling?.matches('.more-button')) {
        p.insertAdjacentHTML('afterend', '<button type="button" class="link-button more-button" data-expand>More</button>');
      }
    }
  }

  // ---------- controls ----------

  // Each date is a cell: weekday over the day of the month, like a cinema's date strip.
  function buildDayToggles() {
    const hasLater = all.some((s) => s.date > stripKeys[stripKeys.length - 1]);
    const cell = (value, top, num, label) =>
      `<button type="button" class="toggle day-cell" data-value="${value}" aria-pressed="false"${label ? ` aria-label="${esc(label)}"` : ''}>` +
      (num ? `<span class="dc-top">${esc(top)}</span><span class="dc-num">${esc(num)}</span>` : `<span class="dc-only">${esc(top)}</span>`) +
      '</button>';
    const cells = [cell('', 'Any day')];
    for (const k of stripKeys) {
      const top = relDay(k) || fmtWeekdayShort.format(keyDate(k));
      cells.push(cell(k, top, String(Number(k.slice(8))), `${relDay(k) ? `${relDay(k)}, ` : ''}${dayLong(k)}`));
    }
    if (hasLater) cells.push(cell('later', 'Later', '', `After ${dayLong(stripKeys[stripKeys.length - 1])}`));
    $('#day-filter').innerHTML = cells.join('');
  }

  function buildTimeToggles() {
    const items = [{ value: '', label: 'Any time' }].concat(TIME_BUCKETS);
    $('#time-filter').innerHTML = items
      .map((it) => `<button type="button" class="toggle" data-value="${it.value}" aria-pressed="false">${esc(it.label)}</button>`)
      .join('');
  }

  function updateToggles(container, set) {
    for (const b of $$('.toggle', container)) {
      const v = b.dataset.value;
      b.setAttribute('aria-pressed', String(v ? set.has(v) : set.size === 0));
    }
  }

  function menuOptions(name) {
    const pool = all.filter((s) => matches(s, name));
    if (name === 'hood') {
      return hoodOrder.map((h) => {
        const count = new Set(pool.filter((s) => theaters[s.theater].neighborhood === h).map((s) => s.film)).size;
        return { value: h, label: h, count };
      });
    }
    const order = (t) => hoodOrder.indexOf(t.neighborhood);
    return data.theaters
      .slice()
      .sort((a, b) => favFirst(a, b) || order(a) - order(b) || a.name.localeCompare(b.name))
      .map((t) => ({
        value: t.id,
        label: t.name,
        fav: !!t.favorite,
        sub: t.neighborhood,
        count: new Set(pool.filter((s) => s.theater === t.id).map((s) => s.film)).size,
      }));
  }

  function renderMenu(menu) {
    const name = menu.dataset.filter;
    const set = name === 'hood' ? state.hoods : state.theaters;
    const panel = $('.menu-panel', menu);
    const focused = document.activeElement?.closest('.menu-panel') === panel ? document.activeElement.value : null;
    const opts = menuOptions(name);
    panel.innerHTML =
      `<fieldset style="border:0;margin:0;padding:0;min-width:0"><legend class="visually-hidden">${name === 'hood' ? 'Neighborhoods' : 'Theaters'}</legend>` +
      opts
        .map(
          (o) => `<label class="${o.count || set.has(o.value) ? '' : 'is-zero'}">
            <input type="checkbox" value="${esc(o.value)}"${set.has(o.value) ? ' checked' : ''}>
            <span class="option-name">${o.fav ? STAR : ''}${esc(o.label)}${o.sub ? `<span class="option-sub">${esc(o.sub)}</span>` : ''}</span>
            <span class="option-count" aria-label="${plural(o.count, 'film')}">${o.count}</span>
          </label>`,
        )
        .join('') +
      '</fieldset>' +
      (set.size ? `<div class="menu-panel-foot"><button type="button" class="link-button" data-menu-clear>Clear</button></div>` : '');
    if (focused != null) {
      const input = [...panel.querySelectorAll('input')].find((i) => i.value === focused);
      input?.focus();
    }
    const button = $('.menu-button', menu);
    const base = name === 'hood' ? 'Neighborhood' : 'Theater';
    const names = [...set].map((v) => (name === 'hood' ? v : theaters[v]?.short || v));
    $('.menu-label', button).textContent = names.length ? `${base}: ${names.join(', ')}` : base;
    button.classList.toggle('is-active', set.size > 0);
  }

  function updateControls() {
    for (const input of $$('input[name="view"]')) input.checked = input.value === state.view;
    updateToggles($('#day-filter'), state.days);
    updateToggles($('#time-filter'), state.times);
    $('#fav-toggle').setAttribute('aria-pressed', String(state.fav));
    for (const menu of $$('.menu')) renderMenu(menu);
    const search = $('#search');
    if (search.value !== state.q) search.value = state.q;
    const n = activeFilterCount();
    const badge = $('#filters-count');
    badge.hidden = !n;
    badge.textContent = n;
    const filmsN = new Set(filtered.map((s) => s.film)).size;
    $('#filters-done').textContent = filtered.length ? `Show ${plural(filmsN, 'film')}` : 'Show results';
  }

  function openMenu(menu) {
    closeMenus(menu);
    const button = $('.menu-button', menu);
    const panel = $('.menu-panel', menu);
    renderMenu(menu);
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    // Keep the panel on screen.
    panel.style.left = '0';
    panel.style.right = 'auto';
    const r = panel.getBoundingClientRect();
    if (r.right > window.innerWidth - 8) {
      panel.style.left = 'auto';
      panel.style.right = '0';
    }
    $('input', panel)?.focus();
  }

  function closeMenus(except) {
    for (const menu of $$('.menu')) {
      if (menu === except) continue;
      const panel = $('.menu-panel', menu);
      if (window.matchMedia('(max-width: 720px)').matches) continue;
      if (!panel.hidden) {
        panel.hidden = true;
        $('.menu-button', menu).setAttribute('aria-expanded', 'false');
      }
    }
  }

  function clearAll() {
    state.days.clear();
    state.times.clear();
    state.hoods.clear();
    state.theaters.clear();
    state.fav = false;
    state.q = '';
    render();
  }

  function afterFilterChange() {
    render();
    // If the reader is down in the list, bring them back to the top of the results.
    const listings = $('#listings');
    const top = listings.getBoundingClientRect().top;
    if (top < 0 && !$('#filters').classList.contains('is-open')) {
      listings.scrollIntoView({ block: 'start' });
    }
  }

  // ---------- mobile filter sheet ----------

  function setFiltersOpen(open) {
    const filters = $('#filters');
    filters.classList.toggle('is-open', open);
    $('#filters-toggle').setAttribute('aria-expanded', String(open));
    document.body.style.overflow = open ? 'hidden' : '';
    if (open) {
      filters.setAttribute('role', 'dialog');
      filters.setAttribute('aria-modal', 'true');
      filters.setAttribute('aria-label', 'Filters');
      $('#filters-close').focus();
    } else {
      filters.removeAttribute('role');
      filters.removeAttribute('aria-modal');
      filters.removeAttribute('aria-label');
      $('#filters-toggle').focus();
    }
  }

  // ---------- film sheet ----------

  let currentFilm = null;

  function openFilm(id, { push = true } = {}) {
    const f = films[id];
    if (!f) return;
    currentFilm = id;
    const shows = all.filter((s) => s.film === id);
    const byTheater = groupBy(shows, (s) => s.theater);
    const img = safeUrl(f.image);
    const links = Object.entries(f.links || {})
      .filter(([tid, url]) => theaters[tid] && safeUrl(url))
      .map(([tid, url]) => `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(theaters[tid].short || theaters[tid].name)} page ↗</a>`)
      .join(' · ');
    $('#sheet-body').innerHTML = `
      <h2 id="sheet-title">${esc(f.title)}</h2>
      ${filmMeta(f, [f.country, f.language].filter(Boolean).map(esc))}
      ${img ? `<div class="sheet-still"><img src="${esc(img)}" alt="" referrerpolicy="no-referrer"></div>` : ''}
      ${f.description ? `<p class="film-desc">${esc(f.description)}</p>` : ''}
      ${links ? `<p class="sheet-links">${links}</p>` : ''}
      <div class="sheet-section">
        <h3>Showtimes</h3>
        ${
          shows.length
            ? [...byTheater]
                .map(([tid, ts]) => {
                  const t = theaters[tid];
                  const shared = sharedNotes(ts);
                  const sub = [t.neighborhood, runInfo(id, tid), ...shared].filter(Boolean).map(esc).join(' · ');
                  return `<div class="film-at"><p class="film-at-name">${esc(t.name)}<span class="film-at-hood">${sub}</span></p>${timesHtml(ts, { limit: 14, skip: shared })}</div>`;
                })
                .join('')
            : '<p>No upcoming showtimes.</p>'
        }
      </div>`;
    $('#sheet-body .sheet-still img')?.addEventListener('error', (e) => e.target.closest('.sheet-still').remove());
    const dialog = $('#film-sheet');
    if (!dialog.open) dialog.showModal();
    $('.sheet-inner', dialog).scrollTop = 0;
    document.title = `${f.title} · Seattle Indie Showtimes`;
    if (push) history.pushState({ film: id }, '', writeUrl(id));
  }

  function closeFilm({ fromHistory = false } = {}) {
    const dialog = $('#film-sheet');
    if (dialog.open) dialog.close();
    if (!currentFilm) return;
    currentFilm = null;
    document.title = 'Seattle Indie Showtimes';
    if (!fromHistory) {
      if (history.state?.film) history.back();
      else syncUrl();
    }
  }

  // ---------- map ----------

  function updateMap() {
    if (!mapReady) return;
    const counts = {};
    const byTheater = groupBy(filtered, (s) => s.theater);
    for (const [tid, list] of byTheater) counts[tid] = new Set(list.map((s) => s.film)).size;
    window.TheaterMap.update(counts);
  }

  function popupContent(ids) {
    const wrap = document.createElement('div');
    wrap.innerHTML = ids
      .map((id) => {
        const t = theaters[id];
        const list = filtered.filter((s) => s.theater === id);
        const filmsN = new Set(list.map((s) => s.film)).size;
        const next = list[0];
        let line;
        if (next) {
          const { hm, ap } = fmtTime(next.mins);
          line = `${plural(filmsN, 'film')}${activeFilterCount() ? ' matching' : ''}. Next up: ${esc(films[next.film].title)}, ${esc(dayRow(next.date).toLowerCase() === 'today' ? 'today' : dayRow(next.date))} at ${hm} ${ap}.`;
        } else {
          line = activeFilterCount() ? 'Nothing here matches your filters.' : 'No showtimes listed right now.';
        }
        return `<div class="popup-theater">
          <h3>${favMark(t)}${esc(t.name)}</h3>
          <p>${esc(t.neighborhood)} · ${esc(t.address)}</p>
          <p>${line}</p>
          <p>${next ? `<button type="button" class="link-button" data-goto="${esc(id)}">See showtimes</button> · ` : ''}<a href="${esc(directionsUrl(t))}" target="_blank" rel="noopener">Directions ↗</a></p>
        </div>`;
      })
      .join('');
    wrap.addEventListener('click', (e) => {
      const go = e.target.closest('[data-goto]');
      if (!go) return;
      goToTheater(go.dataset.goto);
    });
    return wrap;
  }

  function goToTheater(id) {
    window.TheaterMap.closePopup();
    if (state.view !== 'theaters') {
      state.view = 'theaters';
      storage('view', state.view);
      render();
    }
    const el = document.getElementById(`theater-${id}`);
    if (!el) return;
    el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    const heading = $('.theater-name', el);
    heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: true });
  }

  // ---------- header bits ----------

  function renderUpdated() {
    if (!data.updated) return;
    const d = new Date(data.updated);
    const key = seattleDateKey(d);
    const clock = fmtClock.format(d).toLowerCase().replace(' ', ' ');
    let when;
    if (key === today) when = `today at ${clock}`;
    else if (key === addDays(today, -1)) when = `yesterday at ${clock}`;
    else when = `on ${fmtShortDate.format(keyDate(key))}`;
    $('#updated').textContent = `Showtimes last checked ${when}.`;
  }

  function renderFooter() {
    $('#footer-theaters').innerHTML = data.theaters
      .slice()
      .sort((a, b) => favFirst(a, b) || a.name.localeCompare(b.name))
      .map((t) => `<li><a href="${esc(safeUrl(t.url) || '#')}" target="_blank" rel="noopener">${esc(t.name)}</a></li>`)
      .join('');
  }

  // ---------- events ----------

  function wire() {
    for (const input of $$('input[name="view"]')) {
      input.addEventListener('change', () => {
        state.view = input.value;
        storage('view', state.view);
        afterFilterChange();
      });
    }

    const toggleHandler = (set) => (e) => {
      const b = e.target.closest('.toggle');
      if (!b) return;
      const v = b.dataset.value;
      if (!v) set.clear();
      else if (set.has(v)) set.delete(v);
      else set.add(v);
      afterFilterChange();
    };
    $('#day-filter').addEventListener('click', toggleHandler(state.days));
    $('#fav-toggle').addEventListener('click', () => {
      state.fav = !state.fav;
      afterFilterChange();
    });
    $('#time-filter').addEventListener('click', toggleHandler(state.times));

    for (const menu of $$('.menu')) {
      menu.dataset.title = menu.dataset.filter === 'hood' ? 'Neighborhood' : 'Theater';
      const button = $('.menu-button', menu);
      const panel = $('.menu-panel', menu);
      button.addEventListener('click', () => (panel.hidden ? openMenu(menu) : closeMenus()));
      panel.addEventListener('change', (e) => {
        const input = e.target.closest('input[type="checkbox"]');
        if (!input) return;
        const set = menu.dataset.filter === 'hood' ? state.hoods : state.theaters;
        if (input.checked) set.add(input.value);
        else set.delete(input.value);
        afterFilterChange();
      });
      panel.addEventListener('click', (e) => {
        if (!e.target.closest('[data-menu-clear]')) return;
        (menu.dataset.filter === 'hood' ? state.hoods : state.theaters).clear();
        afterFilterChange();
        button.focus();
      });
      menu.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !panel.hidden && !window.matchMedia('(max-width: 720px)').matches) {
          e.stopPropagation();
          closeMenus();
          button.focus();
        }
      });
    }
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.menu')) closeMenus();
    });

    let searchTimer;
    const search = $('#search');
    search.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.q = search.value.trim();
        render();
      }, 120);
    });
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && search.value) {
        e.stopPropagation();
        search.value = '';
        state.q = '';
        render();
      }
    });

    document.addEventListener('keydown', (e) => {
      const typing = e.target.closest('input, textarea, select, [contenteditable]');
      if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        if (window.matchMedia('(max-width: 720px)').matches) setFiltersOpen(true);
        search.focus();
      }
      if (e.key === 'Escape' && $('#filters').classList.contains('is-open')) setFiltersOpen(false);
    });

    $('#clear-filters').addEventListener('click', () => clearAll());
    $('#filters-clear-sheet').addEventListener('click', () => clearAll());
    $('#filters-toggle').addEventListener('click', () => setFiltersOpen(true));
    $('#filters-close').addEventListener('click', () => setFiltersOpen(false));
    $('#filters-done').addEventListener('click', () => {
      setFiltersOpen(false);
      $('#listings').scrollIntoView({ block: 'start' });
    });

    // Clicks inside listings and the film sheet.
    const onContentClick = (e) => {
      const film = e.target.closest('[data-film]');
      if (film) {
        openFilm(film.dataset.film);
        return;
      }
      const more = e.target.closest('[data-more]');
      if (more) {
        const times = more.closest('.times');
        for (const el of $$('[hidden]', times)) el.hidden = false;
        more.remove();
        $('.times-list:nth-of-type(5) .time', times)?.focus();
        return;
      }
      const expand = e.target.closest('[data-expand]');
      if (expand) {
        const p = expand.previousElementSibling;
        p.classList.remove('is-clamped');
        const filmId = expand.closest('article')?.querySelector('[data-film]')?.dataset.film;
        if (filmId && films[filmId]?.description) p.textContent = films[filmId].description;
        p.style.whiteSpace = 'pre-line';
        expand.remove();
        return;
      }
      if (e.target.closest('[data-clear]')) clearAll();
    };
    $('#results').addEventListener('click', onContentClick);
    // A still that fails to load leaves no empty box behind.
    $('#results').addEventListener(
      'error',
      (e) => {
        const still = e.target.closest?.('.film-still');
        if (!still) return;
        still.closest('.film')?.classList.add('no-image');
        still.remove();
      },
      true,
    );
    $('#film-sheet').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeFilm();
      else if (e.target.closest('.sheet-close')) closeFilm();
      else onContentClick(e);
    });
    $('#film-sheet').addEventListener('cancel', (e) => {
      e.preventDefault();
      closeFilm();
    });

    window.addEventListener('popstate', () => {
      const id = new URLSearchParams(location.search).get('film');
      if (id && films[id]) openFilm(id, { push: false });
      else closeFilm({ fromHistory: true });
    });

    // Highlight a theater's pin while reading about it.
    let hoverId = null;
    $('#results').addEventListener('mouseover', (e) => {
      const el = e.target.closest('[data-theater]');
      const id = el ? el.dataset.theater : null;
      if (id !== hoverId && mapReady) {
        hoverId = id;
        window.TheaterMap.highlight(id ? [id] : null);
      }
    });
    $('#results').addEventListener('mouseleave', () => {
      hoverId = null;
      if (mapReady) window.TheaterMap.highlight(null);
    });

    // Shadow under the controls once they stick.
    const controls = $('#controls');
    const sentinel = document.createElement('div');
    sentinel.setAttribute('aria-hidden', 'true');
    controls.before(sentinel);
    new IntersectionObserver(([entry]) => controls.classList.toggle('is-stuck', !entry.isIntersecting)).observe(sentinel);
    const setH = () => document.documentElement.style.setProperty('--controls-h', `${controls.offsetHeight}px`);
    new ResizeObserver(setH).observe(controls);
    setH();

    // Keep "today" honest if the page stays open.
    setInterval(() => {
      const before = all.length;
      const dayBefore = today;
      refreshUpcoming();
      if (today !== dayBefore) buildDayToggles();
      if (all.length !== before || today !== dayBefore) render();
    }, 5 * 60 * 1000);
  }

  // ---------- start ----------

  async function start() {
    buildTimeToggles();
    let raw;
    try {
      const res = await fetch(DATA_URL, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      raw = await res.json();
    } catch (err) {
      console.error(err);
      $('#results').innerHTML = '<div class="empty"><p>Couldn’t load the showtimes. Reload the page to try again.</p></div>';
      return;
    }
    prepare(raw);
    const film = readUrl();
    buildDayToggles();
    renderUpdated();
    renderFooter();
    wire();

    mapReady = window.TheaterMap?.init($('#map'), data.theaters, {
      renderPopup: popupContent,
    });
    if (!mapReady) {
      $('#map-fallback').hidden = false;
    }

    render();
    if (film && films[film]) openFilm(film, { push: false });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
