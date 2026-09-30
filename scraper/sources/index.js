// Every source, and the theaters it covers. A source that fails to load or run
// marks its theaters stale instead of stopping the whole update.

const REGISTRY = [
  { id: 'siff', theaters: ['siff-downtown', 'siff-uptown', 'siff-film-center'] },
  { id: 'grand-illusion', theaters: ['grand-illusion'] },
  { id: 'nwff', theaters: ['nwff'] },
  { id: 'central-cinema', theaters: ['central-cinema'] },
  { id: 'beacon', theaters: ['beacon'] },
  { id: 'tasveer', theaters: ['tasveer'] },
  { id: 'majestic-bay', theaters: ['majestic-bay'] },
  { id: 'admiral', theaters: ['admiral'] },
  { id: 'tin-room', theaters: ['tin-room'] },
  { id: 'north-bend', theaters: ['north-bend'] },
];

export const SOURCES = REGISTRY.map((entry) => ({
  ...entry,
  async scrape() {
    const mod = await import(`./${entry.id}.js`);
    return mod.default.scrape();
  },
}));
