// Card-data sanity gate.
//
// In-game reports #40 / #41 / #43 were all the same defect: House Guard's deck
// VP had been transcribed as 13 instead of 1. Nothing crashed — the wrong
// number simply flowed into end-game scoring AND the AI's recruit evaluation,
// so House Guards looked like treasure and players' scores didn't add up. It
// took three separate reports from players to surface a single bad cell.
//
// A typo in a data table cannot be caught by the engine tests, which happily
// compute with whatever numbers they are given. This asserts the numbers are
// POSSIBLE in the first place: every printed value in range, nothing missing,
// and the specific cells players caught pinned to their real values.
//
//   npx vite-node scripts/test-card-data-sanity.ts
import cardData from '../assets/card-data.json';

interface Card {
  deck: string; slot: number; name: string;
  cost: number; deckVp: number; innerCircleVp: number; aspect: string;
}
const cards = (Array.isArray(cardData) ? cardData : Object.values(cardData)) as Card[];

let ok = true;
const fail = (msg: string) => { console.log(`FAIL  ${msg}`); ok = false; };
const pass = (msg: string) => console.log(`PASS  ${msg}`);

// Bounds come from the physical components: the highest-VP cards in the box are
// Demogorgon / Orcus (5 deck VP, 10 inner-circle VP) and the priciest market
// card costs 8. Insane Outcast is the only negative (-1 deck VP). Anything
// outside these is a transcription error, not a card.
const RANGES = {
  cost:            { min: 0,  max: 8  },
  deckVp:          { min: -1, max: 5  },
  innerCircleVp:   { min: 0,  max: 10 },
} as const;

for (const field of Object.keys(RANGES) as Array<keyof typeof RANGES>) {
  const { min, max } = RANGES[field];
  const bad = cards.filter(c => {
    const v = c[field] as unknown;
    return typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max;
  });
  if (bad.length) {
    for (const c of bad.slice(0, 10)) {
      fail(`${field}=${JSON.stringify(c[field])} out of range [${min}..${max}] on ${c.name} (${c.deck}/${c.slot})`);
    }
    if (bad.length > 10) fail(`…and ${bad.length - 10} more ${field} violations`);
  } else {
    pass(`every card's ${field} is an integer within [${min}..${max}] (${cards.length} cards)`);
  }
}

// Every card needs an aspect — the Focus keyword and every aspect-filtered
// promote read it, and a blank one silently makes those effects no-ops.
const noAspect = cards.filter(c => !c.aspect || !String(c.aspect).trim());
if (noAspect.length) fail(`${noAspect.length} card(s) have no aspect, e.g. ${noAspect[0].name}`);
else pass(`every card has an aspect`);

// Values players actually reported wrong — pinned so a regression is loud.
const PINNED: Array<{ name: string; field: keyof typeof RANGES; value: number; report: string }> = [
  { name: 'House Guard',      field: 'deckVp', value: 1, report: '#40/#41/#43' },
  { name: 'Priestess of Lolth', field: 'cost', value: 2, report: 'setup' },
];
for (const p of PINNED) {
  const c = cards.find(x => x.name === p.name);
  if (!c) { fail(`pinned card "${p.name}" not found in card data`); continue; }
  if (c[p.field] !== p.value) fail(`${p.name}.${p.field} is ${c[p.field]}, expected ${p.value} (${p.report})`);
  else pass(`${p.name}.${p.field} === ${p.value} (${p.report})`);
}

console.log(ok ? '\nALL PASS' : '\nFAILURES PRESENT');
process.exit(ok ? 0 : 1);
