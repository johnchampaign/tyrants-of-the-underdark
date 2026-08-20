// Abandoned-seat forfeit semantics.
//
// Async multiplayer's failure mode is someone quietly stopping. The table then
// waits forever on a turn that will never come. The fix is to let a bot finish
// that seat — but a bot finishing your seat must not become a way to dodge a
// loss you were heading for. So an abandoned seat keeps playing (the table
// finishes) while forfeiting its placing (the walk-away is never profitable).
//
// What this pins:
//   1. `forfeitSeat` is server-side only — it must never appear in the legal
//      actions any client is offered, or a player could forfeit on demand.
//   2. It is idempotent — the sweep re-runs and must not double-record.
//   3. A forfeited seat can never win, even holding the top score.
//   4. A forfeited seat ranks below every seat that played its own game, which
//      is what the ratings report reads.
//
//   npx vite-node scripts/test-abandoned-seat.ts
import { tyrantsAdapter, initialBgioState, type BgioState, type PlayerId } from '../src/adapter/tyrantsAdapter';
import { scoreAll } from '../src/engine/scoring';

let ok = true;
const fail = (m: string) => { console.log(`FAIL  ${m}`); ok = false; };
const pass = (m: string) => console.log(`PASS  ${m}`);

// Past setup, so we're on a real turn.
let s: BgioState = initialBgioState(4, { activeSections: ['left', 'center', 'right'] });
for (let i = 0; i < 400 && s.G.setupPhase; i++) {
  const actor = tyrantsAdapter.currentActor(s);
  if (actor === null) break;
  const legal = tyrantsAdapter.legalActions(s, actor);
  if (!legal.length) break;
  const r = tyrantsAdapter.tryApplyAction!(s, legal[0], actor);
  if (!r.ok) break;
  s = r.state;
}
if (s.G.setupPhase) fail('could not clear setup — the rest of this test is meaningless');

// ---- 1. never offered to a client ----
{
  let leaked = 0;
  let probe = s;
  for (let i = 0; i < 25; i++) {
    const actor = tyrantsAdapter.currentActor(probe);
    if (actor === null) break;
    const legal = tyrantsAdapter.legalActions(probe, actor);
    if (legal.some(a => (a as { kind: string }).kind === 'forfeitSeat')) leaked++;
    if (!legal.length) break;
    const r = tyrantsAdapter.tryApplyAction!(probe, legal[0], actor);
    if (!r.ok) break;
    probe = r.state;
  }
  if (leaked > 0) fail(`forfeitSeat was offered in legalActions ${leaked}x — a player could forfeit at will`);
  else pass('forfeitSeat is never offered in legalActions');
}

// ---- 2. applies, and is idempotent ----
const victim = tyrantsAdapter.currentActor(s)!;
{
  const r1 = tyrantsAdapter.tryApplyAction!(s, { kind: 'forfeitSeat', seat: victim }, victim);
  if (!r1.ok) { fail(`forfeitSeat rejected: ${r1.reason}`); }
  else {
    s = r1.state;
    const after = s.G.forfeitedSeats ?? [];
    if (!after.includes(victim)) fail('forfeitSeat did not record the seat');
    else pass(`forfeitSeat recorded seat ${victim}`);

    const r2 = tyrantsAdapter.tryApplyAction!(s, { kind: 'forfeitSeat', seat: victim }, victim);
    const twice = r2.ok ? (r2.state.G.forfeitedSeats ?? []) : after;
    if (twice.filter(x => x === victim).length !== 1) fail(`re-forfeiting duplicated the seat: ${JSON.stringify(twice)}`);
    else pass('forfeitSeat is idempotent across repeated sweeps');

    // The seat must still be able to act — the whole point is that a bot
    // finishes the game rather than the table stalling.
    const stillLegal = tyrantsAdapter.legalActions(s, victim);
    if (!stillLegal.length) fail('forfeited seat has no legal actions — the table would still stall');
    else pass(`forfeited seat can still be played (${stillLegal.length} legal actions)`);
  }
}

// ---- 3 & 4. placement, on a finished game ----
{
  // Force a finished game and give the forfeited seat the TOP score, so the
  // only thing that can demote it is the forfeit itself.
  const fin = structuredClone(s) as BgioState & { ctx: { gameover?: unknown } };
  fin.ctx.gameover = { ended: true };
  const scores = scoreAll(fin.G);
  const seats = Object.keys(scores) as PlayerId[];
  const other = seats.filter(p => p !== victim);

  const res = tyrantsAdapter.result!(fin);
  if (!res) { fail('result() returned null on a finished game'); }
  else {
    const top = [...Object.entries(scores)].sort((a, b) => b[1].total - a[1].total)[0][0];
    console.log(`      (top scorer: seat ${top}; forfeited: ${victim}; scores: ${seats.map(p => `${p}=${scores[p].total}`).join(' ')})`);

    if (res.winners.includes(victim)) fail(`forfeited seat ${victim} was listed as a winner`);
    else pass('a forfeited seat is never a winner');

    const rank = res.ranking!;
    const victimPos = rank.indexOf(victim);
    const worstOther = Math.max(...other.map(p => rank.indexOf(p)));
    if (victimPos < worstOther) {
      fail(`forfeited seat placed ${victimPos + 1} of ${rank.length}, above a seat that played (${JSON.stringify(rank)})`);
    } else {
      pass(`forfeited seat ranks last (${JSON.stringify(rank)})`);
    }
    if (rank.length !== seats.length) fail(`ranking dropped seats: ${JSON.stringify(rank)}`);
    else pass('ranking still lists every seat (ratings need all of them)');
  }
}

console.log(ok ? '\nPASS' : '\nFAIL');
process.exit(ok ? 0 : 1);
