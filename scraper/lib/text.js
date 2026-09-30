import * as cheerio from 'cheerio';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…' };

export function decodeEntities(str) {
  return String(str)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

// HTML (or text with stray tags) -> clean plain text with paragraphs kept.
export function htmlToText(html) {
  if (!html) return '';
  const $ = cheerio.load(`<div id="root">${html}</div>`);
  $('script, style, iframe, noscript').remove();
  $('br').replaceWith('\n');
  $('p, div, li, h1, h2, h3, h4, h5, h6').each((_, el) => {
    $(el).append('\n\n');
  });
  return cleanText($('#root').text());
}

export function cleanText(str) {
  return decodeEntities(String(str ?? ''))
    .replace(/\r/g, '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Collapse to a single line.
export function oneLine(str) {
  return cleanText(str).replace(/\s+/g, ' ').trim();
}

// Resolve a possibly relative link against the page it came from.
export function absUrl(href, base) {
  if (!href) return undefined;
  try {
    return new URL(href, base).href;
  } catch {
    return undefined;
  }
}

// All schema.org JSON-LD objects on a page, flattened (handles @graph and arrays).
export function jsonLd($) {
  const out = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).contents().text());
      const walk = (node) => {
        if (Array.isArray(node)) node.forEach(walk);
        else if (node && typeof node === 'object') {
          out.push(node);
          if (node['@graph']) walk(node['@graph']);
        }
      };
      walk(data);
    } catch {
      /* ignore malformed blocks */
    }
  });
  return out;
}
