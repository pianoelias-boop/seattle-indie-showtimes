// Polite fetching: a real browser user agent (several ticketing sites turn
// away anything else), a timeout, a couple of retries, and a short pause
// between requests to the same host.

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const lastHit = new Map();
const GAP_MS = 350;

async function waitTurn(url) {
  const host = new URL(url).host;
  const last = lastHit.get(host) || 0;
  const wait = last + GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastHit.set(host, Date.now());
}

export async function fetchRaw(url, { headers = {}, retries = 2, timeout = 25000, method = 'GET', body } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await waitTurn(url);
    try {
      const res = await fetch(url, {
        method,
        body,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeout),
        headers: {
          'User-Agent': UA,
          'Accept-Language': 'en-US,en;q=0.9',
          ...headers,
        },
      });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} for ${url}`);
        err.status = res.status;
        // 4xx other than rate limiting won't get better on retry.
        if (res.status >= 400 && res.status < 500 && res.status !== 429) throw Object.assign(err, { fatal: true });
        throw err;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (err.fatal) break;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

export async function getText(url, opts = {}) {
  const res = await fetchRaw(url, {
    ...opts,
    headers: { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', ...(opts.headers || {}) },
  });
  return res.text();
}

export async function getJSON(url, opts = {}) {
  const res = await fetchRaw(url, {
    ...opts,
    headers: { Accept: 'application/json, */*;q=0.5', ...(opts.headers || {}) },
  });
  return res.json();
}

// Run fn over items with at most `limit` in flight.
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}
