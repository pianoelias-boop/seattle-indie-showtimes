// The shape every source returns: an array of screenings.
//
// {
//   theater: 'beacon',                        // an id from scraper/theaters.js
//   title: 'Close-Up',                        // the film as the theater names it
//   start: '2026-10-03T19:30:00-07:00',       // Seattle local time with offset (lib/time.js)
//   url: 'https://…',                         // the film or event page at the theater
//   tickets: 'https://…',                     // optional: a direct ticket link for this showing
//   notes: ['35mm', 'Q&A with the director'], // optional: short facts about this showing only
//   film: {                                   // optional, but fill in whatever the theater gives
//     description: 'Plain text, paragraphs separated by blank lines.',
//     runtime: 98,                            // minutes
//     year: 1990,
//     director: 'Abbas Kiarostami',
//     country: 'Iran',
//     language: 'Farsi',
//     rating: 'PG-13',
//     genres: ['Drama'],
//     image: 'https://…',                     // a still or poster
//   },
// }

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

export function validateScreening(s, theaterIds) {
  const errs = [];
  if (!s || typeof s !== 'object') return ['not an object'];
  if (!theaterIds.has(s.theater)) errs.push(`unknown theater "${s.theater}"`);
  if (!s.title || typeof s.title !== 'string' || !s.title.trim()) errs.push('missing title');
  if (!ISO.test(s.start || '')) errs.push(`bad start "${s.start}"`);
  if (s.url && !/^https?:\/\//.test(s.url)) errs.push(`bad url "${s.url}"`);
  if (s.tickets && !/^https?:\/\//.test(s.tickets)) errs.push(`bad tickets "${s.tickets}"`);
  if (s.notes && !Array.isArray(s.notes)) errs.push('notes must be an array');
  const f = s.film;
  if (f) {
    if (f.runtime != null && !(Number.isInteger(f.runtime) && f.runtime > 0 && f.runtime < 1000)) errs.push(`bad runtime ${f.runtime}`);
    if (f.year != null && !(Number.isInteger(f.year) && f.year > 1880 && f.year < 2100)) errs.push(`bad year ${f.year}`);
    if (f.image && !/^https?:\/\//.test(f.image)) errs.push(`bad image "${f.image}"`);
  }
  return errs;
}
