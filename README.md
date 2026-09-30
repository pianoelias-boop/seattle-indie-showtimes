# Seattle Indie Showtimes

What's playing at independent movie theaters in and around Seattle, on a map and in lists you can browse by theater, by film, or day by day. It's a static site on GitHub Pages, and a GitHub Action refreshes the showtimes every morning.

## Theaters

Favorites (red star pins, listed first, and a "Favorites only" filter):

- SIFF Cinema Downtown, SIFF Cinema Uptown, SIFF Film Center (siff.net)
- Central Cinema
- The Beacon
- Tasveer Film Center
- Majestic Bay Theatres
- The Tin Room (Burien)
- North Bend Theatre

Also included: Northwest Film Forum, the Grand Illusion Cinema (pop-ups at SIFF Film Center until it reopens at the Varsity), and the Admiral Theater in West Seattle.

Chains (AMC, Regal, Cinemark, Landmark) are left out on purpose.

## How it works

```
scraper/                 Node scripts that read each theater's website
  theaters.js            the theater list: names, addresses, map positions, favorites
  sources/*.js           one scraper per theater (or per chain of venues, like SIFF)
  index.js               runs them all and writes site/data/showtimes.json
site/                    the website GitHub Pages serves
  index.html, styles.css, app.js, map.js
  data/showtimes.json    the showtimes, rewritten every morning
.github/workflows/update.yml
```

Every morning at about 6:15 am Seattle time, the workflow:

1. runs every scraper,
2. commits the new `site/data/showtimes.json`,
3. publishes the `site/` folder to GitHub Pages.

If one theater's site is down or changes its layout, that scraper fails on its own. Its theater keeps the showtimes from the last good run (the ones still in the future), and the page says so under that theater. The run's summary page on GitHub lists every theater with its count and status, so a broken scraper is easy to spot.

Where each scraper gets its data:

| Theater | Source |
|---|---|
| SIFF (3 venues) | siff.net calendar and film pages (the showtime buttons carry the ticketing data) |
| Central Cinema, Tasveer | Indy Systems ticketing GraphQL API |
| The Beacon | thebeacon.film calendar and film pages (schema.org data) |
| Majestic Bay | the site's box office JSON, with Veezi ticket links |
| Admiral Theater | Far Away Entertainment's showtime API |
| Northwest Film Forum | NWFF calendar pages plus Eventive for ticket links |
| Grand Illusion | grandillusioncinema.org calendar and film pages |
| The Tin Room | SpotHopper events API (filtered to films), plus Ticket Tailor for Seattle Film Festival blocks |
| North Bend Theatre | the event data embedded in tix.northbendtheatre.com's calendar, plus each event page for posters |

## Running it locally

Needs Node 22 or newer.

```bash
npm install
```

```bash
npm run scrape
```

```bash
npm run serve
```

Then open http://localhost:8321. To test one scraper without touching the site data:

```bash
npm run try -- beacon
```

## Changing things

- **Favorites:** set or remove `favorite: true` on a theater in `scraper/theaters.js`.
- **Add a theater:** add it to `scraper/theaters.js`, write `scraper/sources/<id>.js` (copy a similar one; the shape it must return is described at the top of `scraper/lib/validate.js`), register it in `scraper/sources/index.js`, and check it with `npm run try -- <id>`.
- **When the Grand Illusion moves into the Varsity:** update its address and map position in `scraper/theaters.js` (the Varsity's are in the comment there), and `HOME_VENUE` in `scraper/sources/grand-illusion.js`.
- **Update time:** the `cron` line in `.github/workflows/update.yml` (it's in UTC).

## Setting up GitHub Pages

1. Push this folder to a GitHub repository.
2. In the repository's **Settings → Pages**, set **Source** to **GitHub Actions**.
3. Run the **Update showtimes** workflow once from the **Actions** tab (or push a commit). After that it runs every morning.

GitHub pauses scheduled workflows in repositories with no activity for 60 days. The daily data commit counts as activity, but if the schedule ever stops, re-enable it from the Actions tab.

## Design

The look follows the City of Seattle's brand standards (seattle.gov and the City's style guide). Seattle Blue (#0046AD) is the main color: the header, the sticky filter bar, each theater's name bar, and the footer. The City's accent colors each have one job: gold marks a favorite theater, lime marks a showing starting within the hour, and sky blue is the water on the map. Type is Fira Sans, a free humanist sans close to the City's "Seattle Text" heading face.

Motion is small and purposeful, and all of it switches off for people who ask their system for reduced motion: pins fall onto the map when it loads, pins with a showing in the next hour ripple three times in lime, the tab underline slides to the chosen view, and results rise in when a filter changes.

The tokens are at the top of `site/styles.css`.

## Credits

Map data © OpenStreetMap contributors, tiles from OpenFreeMap and OpenMapTiles. Showtimes and descriptions belong to the theaters; the site links back to them for tickets.
