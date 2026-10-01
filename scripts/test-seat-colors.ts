// Seat colours for seats nobody picked (the AI seats in solo play).
//
// Black is the hardest colour to pick out on the map, and with any human pick
// other than black the first AI used to come out black every time (player
// feedback on BGG). Leftover colours now go red, orange, blue, black — so an AI
// only gets black once the other three are taken.
//
//   npx vite-node scripts/test-seat-colors.ts
import { initialBgioState } from '../src/adapter/tyrantsAdapter';
import type { Color } from '../src/game';

let ok = true;
const check = (label: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) ok = false;
};
const colors = (n: number, setup?: { humanColor?: Color; seatColors?: Color[] }) => {
  const G = initialBgioState(n, setup).G;
  return Array.from({ length: n }, (_, i) => G.players[String(i)].color).join(',');
};

check('human picks red → the AIs take orange, blue, black (black last)', colors(4, { humanColor: 'red' }) === 'red,orange,blue,black');
check('human picks teal, 2 players → the AI is red, not black', colors(2, { humanColor: 'teal' }) === 'teal,red');
check('human picks teal, 3 players → red, orange', colors(3, { humanColor: 'teal' }) === 'teal,red,orange');
check('human picks teal, 4 players → black only once the rest are taken', colors(4, { humanColor: 'teal' }) === 'teal,red,orange,blue');
check('human keeps black (the default) → unchanged: red, orange, blue', colors(4, { humanColor: 'black' }) === 'black,red,orange,blue');
check('no pick at all → the classic seat order is kept', colors(4) === 'black,red,orange,blue');
check('an explicit full table is honoured as given', colors(3, { seatColors: ['blue', 'black', 'red'] }) === 'blue,black,red');

console.log(ok ? '\nALL SEAT COLOUR TESTS PASSED' : '\nFAILURES PRESENT');
process.exit(ok ? 0 : 1);
