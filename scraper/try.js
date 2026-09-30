// Run one source and check what it returns, without touching the site data.
//   node scraper/try.js beacon            summary + a few samples
//   node scraper/try.js beacon --json     every screening as JSON

import { THEATER_IDS } from './theaters.js';
import { validateScreening } from './lib/validate.js';

const [name, flag] = process.argv.slice(2);
if (!name) {
  console.error('Usage: node scraper/try.js <source> [--json]');
  process.exit(1);
}

const mod = await import(`./sources/${name}.js`);
const source = mod.default;
const t0 = Date.now();
const screenings = await source.scrape();
const secs = ((Date.now() - t0) / 1000).toFixed(1);

if (flag === '--json') {
  // No process.exit here: it would cut off output piped to another command.
  process.stdout.write(JSON.stringify(screenings, null, 2) + '\n');
} else {
  report();
}

function report() {
  const problems = [];
  for (const s of screenings) {
    const errs = validateScreening(s, THEATER_IDS);
    if (errs.length) problems.push({ s, errs });
  }

  const byTheater = {};
  for (const s of screenings) {
    const t = (byTheater[s.theater] ||= { count: 0, films: new Set(), first: s.start, last: s.start });
    t.count++;
    t.films.add(s.title);
    if (s.start < t.first) t.first = s.start;
    if (s.start > t.last) t.last = s.start;
  }

  console.log(`${source.id}: ${screenings.length} screenings in ${secs}s`);
  for (const [id, t] of Object.entries(byTheater)) {
    console.log(`  ${id}: ${t.count} screenings, ${t.films.size} films, ${t.first} → ${t.last}`);
  }
  const withDesc = screenings.filter((s) => s.film?.description).length;
  const withImg = screenings.filter((s) => s.film?.image).length;
  console.log(`  with description: ${withDesc}/${screenings.length}, with image: ${withImg}/${screenings.length}`);
  if (problems.length) {
    console.log(`\n${problems.length} invalid screenings, first few:`);
    for (const p of problems.slice(0, 5)) console.log('  ', p.errs.join('; '), JSON.stringify(p.s).slice(0, 200));
  }
  const films = [...new Map(screenings.map((s) => [s.title, s])).values()];
  console.log('\nSample films:');
  for (const s of films.slice(0, 6)) {
    const f = s.film || {};
    console.log(`- ${s.title} | ${s.start} | ${s.theater} | ${f.runtime ?? '?'} min | ${f.director ?? ''} ${f.year ?? ''}`);
    if (f.description) console.log(`    ${f.description.slice(0, 160).replace(/\n/g, ' ')}…`);
    if (s.notes?.length) console.log(`    notes: ${s.notes.join(', ')}`);
  }
}
