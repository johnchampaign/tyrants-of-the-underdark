// Giving up (#111).
//
// What this pins:
//   1. In a 2-player game, a concession ends the game at once and the other
//      player wins; the conceder ranks last (counted as a loss for ratings).
//   2. It works on the OPPONENT's turn too — you can give up while waiting.
//   3. Nobody can concede for someone else: the action carries no seat, and
//      the adapter uses the authenticated submitter even if one is smuggled in.
//   4. When every seat left playing is a bot, the table ends.
//   5. In a 3-4 player game with other people still playing, a concession is
//      REFUSED — the conceded seat would sit idle for a week per round, since
//      forfeited seats are only played by the daily abandoned-seat sweep.
//   6. It is never offered in legalActions (a bot must never choose it), and it
//      is the only action allowed out of turn.
//   7. An abandoned seat forfeited by the sweep ends a 2-player game the same
//      way (a deliberate change: previously the survivor had to finish vs a bot).
import { tyrantsAdapter, initialBgioState, type BgioState } from '../src/adapter/tyrantsAdapter';

let ok = true;
const check = (label: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) ok = false;
};
const A = tyrantsAdapter;
const concede = { kind: 'concede' } as const;

/** Play legal actions until setup is over, so tests run on a real turn. */
function pastSetup(s: BgioState): BgioState {
  for (let i = 0; i < 400 && s.G.setupPhase; i++) {
    const actor = A.currentActor(s);
    if (actor === null) break;
    const legal = A.legalActions(s, actor);
    if (!legal.length) break;
    const r = A.tryApplyAction!(s, legal[0], actor);
    if (!r.ok) break;
    s = r.state;
  }
  return s;
}

// ---- 1 + 2. two players ----
{
  const s = pastSetup(initialBgioState(2));
  const onTurn = A.currentActor(s)!;
  const waiting = onTurn === '0' ? '1' : '0';

  const r = A.tryApplyAction!(s, concede, onTurn);
  check('2P: the player on turn can give up', r.ok);
  if (r.ok) {
    check('2P: the game ends immediately', !!r.state.ctx.gameover && A.currentActor(r.state) === null);
    const res = A.result!(r.state);
    check('2P: the other player wins', !!res && res.winners.length === 1 && res.winners[0] === waiting);
    check('2P: the conceder ranks last', !!res && res.ranking?.[res.ranking.length - 1] === onTurn);
  }

  const off = A.tryApplyAction!(s, concede, waiting);
  check('2P: the WAITING player can give up on the opponent\'s turn', off.ok);
  if (off.ok) {
    const res = A.result!(off.state);
    check('2P: ...and the player on turn wins', !!res && res.winners[0] === onTurn);
  }
}

// ---- 3. no conceding for someone else ----
{
  const s = pastSetup(initialBgioState(2));
  const onTurn = A.currentActor(s)!;
  const other = onTurn === '0' ? '1' : '0';
  const smuggled = { kind: 'concede', seat: other } as never;
  const r = A.tryApplyAction!(s, smuggled, onTurn);
  check('a smuggled seat is ignored — only the submitter concedes',
    r.ok && (r.state.G.forfeitedSeats ?? []).join() === onTurn);
}

// ---- 4. only bots left ----
{
  const s = pastSetup(initialBgioState(4, { activeSections: ['left', 'center', 'right'], botSeats: ['1', '2', '3'] }));
  check('bot seats are recorded in the game state', (s.G.botSeats ?? []).join() === '1,2,3');
  const r = A.tryApplyAction!(s, concede, '0');
  check('the only person vs 3 bots can give up', r.ok);
  if (r.ok) check('...and the table ends', !!r.state.ctx.gameover);
}

// ---- 5. refused while other people are still playing ----
{
  const s = pastSetup(initialBgioState(4, { activeSections: ['left', 'center', 'right'], botSeats: ['2', '3'] }));
  const r = A.tryApplyAction!(s, concede, '0');
  check('4P with another person still playing: giving up is refused', !r.ok);
  check('...nothing is recorded', !(s.G.forfeitedSeats ?? []).length && !s.ctx.gameover);

  const legacy = pastSetup(initialBgioState(3, { activeSections: ['left', 'center'] }));
  check('3P with bot seats unknown (older game): refused', !A.tryApplyAction!(legacy, concede, '0').ok);
}

// ---- 6. never offered; the only out-of-turn action ----
{
  let s = pastSetup(initialBgioState(2));
  let offered = 0;
  for (let i = 0; i < 40; i++) {
    const actor = A.currentActor(s);
    if (actor === null) break;
    const legal = A.legalActions(s, actor);
    if (legal.some(a => (a as { kind: string }).kind === 'concede')) offered++;
    if (!legal.length) break;
    const r = A.tryApplyAction!(s, legal[0], actor);
    if (!r.ok) break;
    s = r.state;
  }
  check('concede is never offered in legalActions (bots must not pick it)', offered === 0);
  const allows = (A as { allowsOutOfTurn?: (a: unknown) => boolean }).allowsOutOfTurn;
  check('concede is allowed out of turn', !!allows && allows(concede));
  check('...and ordinary moves are not', !!allows && !allows({ kind: 'endTurn' }) && !allows({ kind: 'forfeitSeat', seat: '0' }));
}

// ---- 7. an abandoned seat ends a 2-player game too ----
{
  const s = pastSetup(initialBgioState(2));
  const onTurn = A.currentActor(s)!;
  const r = A.tryApplyAction!(s, { kind: 'forfeitSeat', seat: onTurn }, onTurn);
  check('2P: when the sweep forfeits an abandoned seat, the game ends', r.ok && !!r.state.ctx.gameover);
}

// ---- already out ----
{
  const s = pastSetup(initialBgioState(4, { activeSections: ['left', 'center', 'right'], botSeats: ['1', '2', '3'] }));
  const once = A.tryApplyAction!(s, concede, '0');
  check('a seat cannot give up twice', once.ok && !A.tryApplyAction!(once.state, concede, '0').ok);
}

console.log(ok ? '\nALL CONCEDE TESTS PASSED' : '\nFAILURES PRESENT');
process.exit(ok ? 0 : 1);
