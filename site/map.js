// The map at the top of the page: a custom-styled Seattle basemap from
// OpenFreeMap (free, no key) with one pin per theater. app.js drives it
// through window.TheaterMap.

(function () {
  const TILES = 'https://tiles.openfreemap.org/planet';
  const GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
  const ATTRIBUTION =
    '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">© OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  const NAME = ['coalesce', ['get', 'name:en'], ['get', 'name']];
  const LINES = ['LineString', 'MultiLineString'];

  function buildStyle() {
    const c = {
      land: cssVar('--map-land'),
      water: cssVar('--map-water'),
      park: cssVar('--map-park'),
      road: cssVar('--map-road'),
      major: cssVar('--map-road-major'),
      building: cssVar('--map-building'),
      label: cssVar('--map-label'),
    };
    const lineOnly = (extra) => ['all', ['match', ['geometry-type'], LINES, true, false], extra];
    return {
      version: 8,
      glyphs: GLYPHS,
      sources: {
        omt: { type: 'vector', url: TILES, attribution: ATTRIBUTION },
      },
      layers: [
        { id: 'land', type: 'background', paint: { 'background-color': c.land } },
        {
          id: 'green',
          type: 'fill',
          source: 'omt',
          'source-layer': 'landcover',
          filter: ['match', ['get', 'class'], ['wood', 'grass'], true, false],
          paint: { 'fill-color': c.park, 'fill-opacity': 0.75 },
        },
        { id: 'park', type: 'fill', source: 'omt', 'source-layer': 'park', paint: { 'fill-color': c.park } },
        {
          id: 'water',
          type: 'fill',
          source: 'omt',
          'source-layer': 'water',
          filter: ['!=', ['get', 'brunnel'], 'tunnel'],
          paint: { 'fill-color': c.water },
        },
        {
          id: 'waterway',
          type: 'line',
          source: 'omt',
          'source-layer': 'waterway',
          paint: { 'line-color': c.water, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.6, 16, 3] },
        },
        {
          id: 'building',
          type: 'fill',
          source: 'omt',
          'source-layer': 'building',
          minzoom: 14,
          paint: { 'fill-color': c.building, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0, 15.5, 1] },
        },
        {
          id: 'ferry',
          type: 'line',
          source: 'omt',
          'source-layer': 'transportation',
          filter: lineOnly(['==', ['get', 'class'], 'ferry']),
          paint: { 'line-color': c.label, 'line-opacity': 0.5, 'line-width': 1.1, 'line-dasharray': [3, 3] },
        },
        {
          id: 'road-minor',
          type: 'line',
          source: 'omt',
          'source-layer': 'transportation',
          minzoom: 12,
          filter: lineOnly(['match', ['get', 'class'], ['minor', 'service'], true, false]),
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': c.road,
            'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 12, 0.4, 16, 7, 18, 16],
            'line-opacity': ['interpolate', ['linear'], ['zoom'], 12, 0.4, 13, 1],
          },
        },
        {
          id: 'road-major',
          type: 'line',
          source: 'omt',
          'source-layer': 'transportation',
          filter: lineOnly(['match', ['get', 'class'], ['primary', 'secondary', 'tertiary', 'trunk'], true, false]),
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': c.major,
            'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 9, 0.5, 12, 1.6, 16, 11, 18, 22],
          },
        },
        {
          id: 'road-motorway',
          type: 'line',
          source: 'omt',
          'source-layer': 'transportation',
          filter: lineOnly(['==', ['get', 'class'], 'motorway']),
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': c.major,
            'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 8, 0.8, 12, 2.6, 16, 14, 18, 26],
          },
        },
        {
          id: 'light-rail',
          type: 'line',
          source: 'omt',
          'source-layer': 'transportation',
          filter: lineOnly(['all', ['==', ['get', 'class'], 'transit'], ['!=', ['get', 'brunnel'], 'tunnel']]),
          paint: { 'line-color': c.label, 'line-opacity': 0.35, 'line-width': 1.2 },
        },
        {
          id: 'water-name',
          type: 'symbol',
          source: 'omt',
          'source-layer': 'water_name',
          filter: ['match', ['geometry-type'], ['Point', 'MultiPoint'], true, false],
          layout: {
            'text-field': NAME,
            'text-font': ['Noto Sans Italic'],
            'text-size': ['interpolate', ['linear'], ['zoom'], 10, 12, 15, 15],
            'text-max-width': 6,
            'text-letter-spacing': 0.04,
          },
          paint: { 'text-color': c.label, 'text-halo-color': c.water, 'text-halo-width': 1.2, 'text-opacity': 0.9 },
        },
        {
          id: 'road-name',
          type: 'symbol',
          source: 'omt',
          'source-layer': 'transportation_name',
          minzoom: 14.5,
          filter: ['match', ['get', 'class'], ['primary', 'secondary', 'tertiary', 'minor', 'trunk'], true, false],
          layout: {
            'symbol-placement': 'line',
            'text-field': NAME,
            'text-font': ['Noto Sans Regular'],
            'text-size': 11.5,
          },
          paint: { 'text-color': c.label, 'text-halo-color': c.land, 'text-halo-width': 1.4 },
        },
        {
          id: 'neighborhood',
          type: 'symbol',
          source: 'omt',
          'source-layer': 'place',
          minzoom: 10.5,
          filter: ['match', ['get', 'class'], ['suburb', 'neighbourhood', 'quarter'], true, false],
          layout: {
            'text-field': NAME,
            'text-font': ['Noto Sans Regular'],
            'text-size': ['interpolate', ['linear'], ['zoom'], 11, 11, 15, 14],
            'text-max-width': 7,
            'text-padding': 6,
          },
          paint: { 'text-color': c.label, 'text-halo-color': c.land, 'text-halo-width': 1.5, 'text-opacity': 0.85 },
        },
      ],
    };
  }

  // Pins closer than this on screen merge into one, and split again as you zoom in.
  const MERGE_PX = 24;
  // The map frames the city; theaters farther out than this point in from the edge.
  const FAR_KM = 12;
  const DOWNTOWN = { lat: 47.6101, lng: -122.3421 };

  const STAR =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 16.8l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" fill="currentColor"/></svg>';

  function distanceMeters(a, b) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  // ---------- pins ----------

  let theaterList = [];
  let groups = []; // current pins: { ids, theaters, lat, lng, el, marker, fav }
  let counts = {};
  let clusterKey = '';

  // Group theaters whose dots would overlap at the current zoom.
  function cluster() {
    const pts = theaterList.map((t) => ({ t, p: map.project([t.lng, t.lat]) }));
    const out = [];
    for (const pt of pts) {
      // Join the nearest pin within reach, not just the first one found.
      let best = null;
      let bestD = MERGE_PX;
      for (const c of out) {
        const d = Math.min(...c.pts.map((q) => Math.hypot(q.x - pt.p.x, q.y - pt.p.y)));
        if (d < bestD) [best, bestD] = [c, d];
      }
      if (best) {
        best.members.push(pt.t);
        best.pts.push(pt.p);
      } else out.push({ pts: [pt.p], members: [pt.t] });
    }
    return out.map((c) => {
      // Favorites first inside a merged pin.
      const theaters = c.members.slice().sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0));
      return {
        theaters,
        ids: theaters.map((t) => t.id),
        lat: theaters.reduce((s, t) => s + t.lat, 0) / theaters.length,
        lng: theaters.reduce((s, t) => s + t.lng, 0) / theaters.length,
        fav: theaters.some((t) => t.favorite),
      };
    });
  }

  function recluster() {
    if (!map) return;
    const next = cluster();
    const key = next.map((g) => g.ids.join('+')).join('|');
    if (key === clusterKey) return;
    clusterKey = key;
    for (const g of groups) g.marker.remove();
    groups = next;
    for (const g of groups) {
      g.el = makePin(g);
      g.marker = new maplibregl.Marker({ element: g.el, anchor: 'center' }).setLngLat([g.lng, g.lat]).addTo(map);
      renderPin(g);
    }
    queuePlace();
  }

  function makePin(group) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `pin${group.fav ? ' is-fav' : ''}`;
    el.innerHTML = `<span class="pin-dot" aria-hidden="true">${group.fav ? STAR : ''}</span><span class="pin-text"></span>`;
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      openPopup(group);
    });
    return el;
  }

  function renderPin(group) {
    const text = group.el.querySelector('.pin-text');
    const parts = [];
    const label = [];
    let total = 0;
    for (const t of group.theaters) {
      const n = counts[t.id] || 0;
      total += n;
      const count = n === 1 ? '1 film' : `${n} films`;
      // In a pin that merges favorites with others, star the favorites.
      const star = t.favorite && group.theaters.length > 1 && !group.theaters.every((x) => x.favorite) ? `<span class="pin-star">${STAR}</span>` : '';
      parts.push(`<span class="pin-line">${star}<span class="pin-name">${escapeHtml(t.short || t.name)}</span> <span class="pin-count">${n ? count : 'nothing listed'}</span></span>`);
      label.push(`${t.name}${t.favorite ? ' (favorite)' : ''}, ${n ? count : 'nothing listed'}`);
    }
    text.innerHTML = parts.join('');
    group.el.classList.toggle('is-empty', total === 0);
    group.el.setAttribute('aria-label', label.join('; '));
    group.size = null;
  }

  // How far inside the frame a pin must be to count as on the map. Pins
  // closer to the edge hide, and an edge arrow stands in for them.
  const EDGE_MARGIN = 20;
  const onMap = (p, W, H) => p.x >= EDGE_MARGIN && p.x <= W - EDGE_MARGIN && p.y >= EDGE_MARGIN && p.y <= H - EDGE_MARGIN;

  // ---------- label placement ----------

  // Put each label where it overlaps the fewest other labels and pins.
  // Candidates are tried in order of preference; a few passes let early
  // choices move once their neighbours have settled.
  const GAP = 15;
  const CANDIDATES = [
    (x, y, w, h) => [x + GAP, y - h / 2, 'right'],
    (x, y, w, h) => [x - GAP - w, y - h / 2, 'left'],
    (x, y, w, h) => [x + 9, y - 9 - h, 'top-right'],
    (x, y, w, h) => [x + 9, y + 9, 'bottom-right'],
    (x, y, w, h) => [x - 9 - w, y - 9 - h, 'top-left'],
    (x, y, w, h) => [x - 9 - w, y + 9, 'bottom-left'],
    (x, y, w, h) => [x - w / 2, y - GAP - h, 'top'],
    (x, y, w, h) => [x - w / 2, y + GAP, 'bottom'],
  ];

  function overlap(a, b) {
    const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return w > 0 && h > 0 ? w * h : 0;
  }

  function placeLabels() {
    if (!map || !groups.length) return;
    const W = map.getContainer().clientWidth;
    const H = map.getContainer().clientHeight;
    for (const g of groups) {
      const text = g.el.querySelector('.pin-text');
      if (!g.size) g.size = { w: text.offsetWidth + 2, h: text.offsetHeight };
      const p = map.project([g.lng, g.lat]);
      g.px = p.x;
      g.py = p.y;
    }
    const visible = [];
    for (const g of groups) {
      const shown = onMap({ x: g.px, y: g.py }, W, H);
      g.el.style.visibility = shown ? '' : 'hidden';
      if (shown) visible.push(g);
    }
    const dots = visible.map((g) => ({ x: g.px - 12, y: g.py - 12, w: 24, h: 24 }));
    // Edge arrows go first; labels steer around them.
    for (const r of placeEdges(W, H)) dots.push({ x: r.x - 4, y: r.y - 4, w: r.w + 8, h: r.h + 8 });
    const cost = (g, box, pref) => {
      let c = pref * 30;
      for (const o of visible) if (o !== g && o.box) c += overlap(box, o.box) * 3;
      for (const d of dots) c += overlap(box, d) * 4;
      // Keep clear of the zoom buttons and the attribution.
      c += overlap(box, { x: W - 56, y: 0, w: 56, h: 96 }) * 4;
      c += overlap(box, { x: W - 300, y: H - 28, w: 300, h: 28 }) * 2;
      const out = Math.max(0, -box.x) + Math.max(0, box.x + box.w - W) + Math.max(0, -box.y) + Math.max(0, box.y + box.h - H);
      return c + out * box.h * 2;
    };
    for (const g of visible) g.box = null;
    for (let pass = 0; pass < 3; pass++) {
      for (const g of visible) {
        let best = null;
        CANDIDATES.forEach((fn, i) => {
          const [x, y, pos] = fn(g.px, g.py, g.size.w, g.size.h);
          const box = { x, y, w: g.size.w, h: g.size.h };
          const c = cost(g, box, i);
          if (!best || c < best.c) best = { c, box, pos };
        });
        g.box = best.box;
        g.pos = best.pos;
      }
    }
    for (const g of visible) {
      const text = g.el.querySelector('.pin-text');
      text.style.transform = `translate(${Math.round(g.box.x - g.px)}px, ${Math.round(g.box.y - g.py)}px)`;
      text.dataset.pos = g.pos;
    }
  }

  let placeQueued = false;
  function queuePlace() {
    if (placeQueued) return;
    placeQueued = true;
    requestAnimationFrame(() => {
      placeQueued = false;
      placeLabels();
    });
  }

  // ---------- off-screen theaters ----------

  // A theater outside the frame gets a small arrow at the edge, pointing at
  // it. Clicking it widens the view to include that theater.
  const edges = new Map(); // theater id -> element
  let edgeLayer = null;

  function placeEdges(W, H) {
    const rects = [];
    if (!edgeLayer) return rects;
    const seen = new Set();
    const c = { x: W / 2, y: H / 2 };
    for (const t of theaterList) {
      const p = map.project([t.lng, t.lat]);
      // A theater in a merged pin follows its pin.
      const g = groups.find((x) => x.ids.includes(t.id));
      if (onMap(g ? map.project([g.lng, g.lat]) : p, W, H)) continue;
      seen.add(t.id);
      let el = edges.get(t.id);
      if (!el) {
        el = document.createElement('button');
        el.type = 'button';
        el.className = `edge-pin${t.favorite ? ' is-fav' : ''}`;
        el.innerHTML = `<span class="edge-arrow" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12h13M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="edge-name"></span>`;
        el.addEventListener('click', () => showTheater(t));
        edgeLayer.appendChild(el);
        edges.set(t.id, el);
      }
      const mi = Math.round((distanceMeters(DOWNTOWN, t) / 1000) * 0.621);
      el.querySelector('.edge-name').textContent = `${t.short || t.name}, ${mi} mi`;
      el.setAttribute('aria-label', `${t.name}, ${mi} miles from downtown, off the map. Show it.`);
      // Where the line from the center to the theater leaves the frame.
      const dx = p.x - c.x;
      const dy = p.y - c.y;
      const m = 22;
      const sx = dx ? (dx > 0 ? (W - m - c.x) / dx : (m - c.x) / dx) : Infinity;
      const sy = dy ? (dy > 0 ? (H - m - c.y) / dy : (m - c.y) / dy) : Infinity;
      const s = Math.min(sx, sy);
      const ex = c.x + dx * s;
      const ey = c.y + dy * s;
      const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
      el.hidden = false;
      el.querySelector('.edge-arrow svg').style.transform = `rotate(${angle}deg)`;
      // Anchor the pill on the edge it points through, and keep it inside the frame.
      const side = sx < sy ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'bottom' : 'top';
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      let left = side === 'right' ? ex - w + 11 : side === 'left' ? ex - 11 : ex - w / 2;
      let top = side === 'bottom' ? ey - h + 11 : side === 'top' ? ey - 11 : ey - h / 2;
      left = Math.max(8, Math.min(W - w - (side === 'top' ? 60 : 8), left));
      top = Math.max(8, Math.min(H - h - 30, top));
      el.style.left = `${Math.round(left)}px`;
      el.style.top = `${Math.round(top)}px`;
      // The arrow sits on the side it points to.
      el.classList.toggle('is-east', dx > 0);
      rects.push({ x: left, y: top, w, h });
    }
    for (const [id, el] of edges) if (!seen.has(id)) el.hidden = true;
    return rects;
  }

  function showTheater(t) {
    const b = map.getBounds();
    b.extend([t.lng, t.lat]);
    map.fitBounds(b, { padding: 70, maxZoom: map.getZoom(), duration: reduceMotion() ? 0 : 700 });
  }

  const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- popup ----------

  let popup = null;

  function openPopup(group) {
    if (!map) return;
    popup?.remove();
    const content = handlers.renderPopup?.(group.ids);
    if (!content) return;
    popup = new maplibregl.Popup({ offset: 16, maxWidth: '300px', focusAfterOpen: true, closeButton: true })
      .setLngLat([group.lng, group.lat])
      .setDOMContent(content)
      .addTo(map);
    const el = group.el;
    popup.on('close', () => {
      if (el.isConnected) el.focus({ preventScroll: true });
    });
  }

  // ---------- setup ----------

  function supportsWebGL() {
    try {
      const canvas = document.createElement('canvas');
      return !!(window.WebGL2RenderingContext && canvas.getContext('webgl2')) || !!canvas.getContext('webgl');
    } catch {
      return false;
    }
  }

  function fit(animate) {
    if (!map || !theaterList.length) return;
    const narrow = map.getContainer().clientWidth < 900;
    const inFrame = theaterList.filter((t) => distanceMeters(DOWNTOWN, t) / 1000 < FAR_KM);
    const bounds = new maplibregl.LngLatBounds();
    for (const t of inFrame) bounds.extend([t.lng, t.lat]);
    map.fitBounds(bounds, {
      padding: narrow ? { top: 40, bottom: 64, left: 56, right: 72 } : { top: 50, bottom: 56, left: 120, right: 180 },
      maxZoom: 13.5,
      animate: !!animate,
    });
  }

  let handlers = {};
  let map = null;
  const dark = window.matchMedia('(prefers-color-scheme: dark)');

  window.TheaterMap = {
    init(container, theaters, opts = {}) {
      handlers = opts;
      theaterList = theaters;
      if (!window.maplibregl || !supportsWebGL()) return false;
      try {
        map = new maplibregl.Map({
          container,
          style: buildStyle(),
          center: [-122.335, 47.6],
          zoom: 10,
          minZoom: 8,
          maxZoom: 17.5,
          maxBounds: [
            [-123.2, 47.2],
            [-121.4, 48.0],
          ],
          attributionControl: { compact: true },
          cooperativeGestures: true,
          dragRotate: false,
          pitchWithRotate: false,
          touchPitch: false,
        });
      } catch (err) {
        console.warn('Map failed to start', err);
        return false;
      }
      map.touchZoomRotate.disableRotation();
      map.keyboard.disableRotation();
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
      map.on('error', (e) => console.warn('Map error', e?.error?.message || e));

      edgeLayer = document.createElement('div');
      edgeLayer.className = 'edge-layer';
      container.appendChild(edgeLayer);

      fit(false);
      recluster();
      // On small maps the attribution starts folded into its (i) button.
      if (container.clientWidth < 640) {
        map.once('load', () => container.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'));
      }
      map.on('zoomend', recluster);
      map.on('move', queuePlace);
      map.on('resize', () => {
        recluster();
        queuePlace();
      });
      new ResizeObserver(() => map.resize()).observe(container);

      dark.addEventListener('change', () => {
        // Let the CSS variables switch first.
        requestAnimationFrame(() => {
          map.setStyle(buildStyle(), { diff: false });
          document.documentElement.toggleAttribute('data-map-dark', dark.matches);
        });
      });
      document.documentElement.toggleAttribute('data-map-dark', dark.matches);
      return true;
    },

    // next: { theaterId: number of films matching the current filters }
    update(next) {
      counts = next;
      for (const g of groups) renderPin(g);
      queuePlace();
    },

    highlight(ids) {
      const set = new Set(ids || []);
      for (const g of groups) g.el.classList.toggle('is-highlighted', g.ids.some((id) => set.has(id)));
    },

    closePopup() {
      popup?.remove();
    },
  };
})();
