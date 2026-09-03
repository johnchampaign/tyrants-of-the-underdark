// Regression test for #65: promote-from-discard (Matron Mother / Necromancer)
// must NOT offer cards played this turn — those sit in the play area, not the
// discard pile, even though the engine pushes them into `discard` during the
// turn. Tests promoteFromDiscardChoice's option list directly (no reducer).
import { promoteFromDiscardChoice } from '../src/engine/handler-helpers';
import { logLineText } from '../src/engine/log';
import { CardRegistry } from '../src/engine/registry';
import '../src/engine/handlers/undead';
import type { CardRef } from '../src/game';

let ok = true;
const check = (label: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) ok = false;
};
const C = (deck: string, slot: number, name: string): CardRef => ({ deck, slot, name, image: '' });

// G.log holds structured entries; render them to prose for the assertions.
function run(discard: CardRef[], playedThisTurn: CardRef[]): { options: number[]; log: string[] } {
  const log: any[] = [];
  const text = () => log.map(logLineText);
  const ctx: any = {
    G: { players: { '0': { discard } }, cardsPlayedThisTurn: playedThisTurn, log },
    card: C('undead', 28, 'Vampire'),
    actorId: '0',
    pendingChoice: null,
    paused: false,
    handlerState: null,
  };
  const done = promoteFromDiscardChoice()(ctx);
  if (done) return { options: [], log: text() }; // handler returned true => no eligible options
  return { options: ctx.pendingChoice.options as number[], log: text() };
}

function optionsFor(discard: CardRef[], playedThisTurn: CardRef[]): number[] {
  return run(discard, playedThisTurn).options;
}

// 1. A card played this turn is excluded from the discard options.
{
  const discard = [C('drow', 1, 'X'), C('drow', 2, 'Y-played'), C('drow', 3, 'Z')];
  const opts = optionsFor(discard, [C('drow', 2, 'Y-played')]);
  check('excludes the played-this-turn card (idx 1)', JSON.stringify(opts) === JSON.stringify([0, 2]));
}

// 2. Multiset: only ONE copy is excluded when a duplicate also sits in old discard.
{
  // Two Nobles in discard; ONE Noble played this turn -> exactly one excluded.
  const discard = [C('s', 42, 'Noble'), C('s', 44, 'Soldier'), C('s', 42, 'Noble')];
  const opts = optionsFor(discard, [C('s', 42, 'Noble')]);
  check('multiset excludes exactly one duplicate (keeps the other)',
    JSON.stringify(opts) === JSON.stringify([1, 2]));
}

// 3. The reporter's case: all discard entries are cards played this turn -> no options.
{
  const played = [C('drow', 10, 'A'), C('drow', 11, 'B'), C('drow', 12, 'C'), C('drow', 13, 'D')];
  const discard = [...played]; // engine dumped them all into discard during the turn
  const { options: opts, log } = run(discard, played);
  check('all-played-this-turn -> zero promotable discard cards (#65)', opts.length === 0);
  // #86 / #87: silently skipping confused players. We now log WHY no picker
  // appeared, distinguishing "all played this turn" from a truly empty pile.
  check('all-played-this-turn -> logs the "cards played this turn don\'t count" note',
    log.some(l => l.includes('cards played this turn')));
}

// 3b. Truly empty discard -> no options, and a distinct "pile is empty" note.
{
  const { options: opts, log } = run([], []);
  check('empty discard -> zero options', opts.length === 0);
  check('empty discard -> logs the "discard pile is empty" note',
    log.some(l => l.includes('discard pile is empty')));
}

// 4. Nothing played this turn -> every discard card is offered (Necromancer mid-deck).
{
  const discard = [C('drow', 1, 'X'), C('drow', 2, 'Y')];
  const opts = optionsFor(discard, []);
  check('no plays this turn -> all discard offered', JSON.stringify(opts) === JSON.stringify([0, 1]));
}

// 5. #108: the chooseOne menus that lead here must not OFFER the discard
// option when nothing in the discard pile is actually promotable. A bare
// `discard.length > 0` check offered it on a turn where the whole "discard"
// was this turn's play area — the player picked it and nothing happened.
function necromancerMenu(discard: CardRef[], playedThisTurn: CardRef[], hand: CardRef[]): string[] {
  const ctx: any = {
    G: { players: { '0': { discard, hand, innerCircle: [] } }, cardsPlayedThisTurn: playedThisTurn, log: [] },
    card: C('undead', 34, 'Necromancer'),
    actorId: '0',
    pendingChoice: null,
    paused: false,
    handlerState: null,
  };
  const done = CardRegistry.get('necromancer')!(ctx);
  return done ? [] : (ctx.pendingChoice.options as string[]);
}

{
  const played = [C('drow', 10, 'A'), C('drow', 11, 'B')];
  const menu = necromancerMenu([...played], played, []);
  check('Necromancer: discard option hidden when the pile is all play-area cards (#108)',
    !menu.some(o => o.toLowerCase().includes('discard')));
  check('Necromancer: the other options still show', menu.length === 2);
}
{
  const menu = necromancerMenu([C('drow', 1, 'X')], [], []);
  check('Necromancer: discard option shown when a real discard card exists',
    menu.some(o => o.toLowerCase().includes('discard')));
}
{
  const menu = necromancerMenu([], [], []);
  check('Necromancer: discard option hidden on an empty discard pile',
    !menu.some(o => o.toLowerCase().includes('discard')));
}

console.log(ok ? '\nALL PROMOTE-FROM-DISCARD TESTS PASSED' : '\nTESTS FAILED');
process.exit(ok ? 0 : 1);
