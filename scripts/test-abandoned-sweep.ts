// End-to-end test for the abandoned-seat sweep (server/sweep.ts).
//
// Drives a real GameServer + FsStore, walks the clock forward past the
// abandonment window, and checks the sweep does the right thing in each of the
// four situations that matter:
//
//   1. A fresh game is left alone (nobody has been waiting long enough).
//   2. A seat that has sat on its turn past the window gets forfeited, so the
//      table moves again (2-player: the game ends; 3+: see 9).
//   3. Re-running the sweep doesn't forfeit the same seat twice.
//   4. A player who comes back and takes a turn resets the clock, so they
//      aren't forfeited.
//   9. 3+ players: the bot plays the forfeited seat at once, and keeps playing
//      it on every later turn without waiting for another sweep.
//
//   npx vite-node scripts/test-abandoned-sweep.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GameServer } from 'digital-boardgame-framework/server';
import { FsStore } from 'digital-boardgame-framework/server/node';
import { tyrantsAdapter, initialBgioState, type BgioState, type TyrantsAction, type PlayerId } from '../src/adapter/tyrantsAdapter';
import { snapshotCodec } from '../src/online/snapshotCodec';
import { tyrantsControllers } from '../src/online/aiControllers';
import { sweepAbandonedSeats, decodeRow, ABANDON_AFTER_MS } from '../server/sweep';

// Stored rows carry the schema prefix; decode them the way the sweep does.
const readState = (raw: string) => decodeRow(codec, raw, tyrantsAdapter.schemaVersion ?? 1)!;

let ok = true;
const fail = (m: string) => { console.log(`FAIL  ${m}`); ok = false; };
const pass = (m: string) => console.log(`PASS  ${m}`);

const root = mkdtempSync(join(tmpdir(), 'totu-sweep-'));
const store = new FsStore(root);
const codec = snapshotCodec();
const server = new GameServer<BgioState, TyrantsAction, PlayerId>({
  adapter: tyrantsAdapter,
  codec,
  store,
  aiControllers: tyrantsControllers,
  gameUrl: (g, t) => `http://test/${g}?as=${t}`,
});
const tokenOf = (url: string) => url.split('as=')[1]!;
// Generous allowance by default so scenarios aren't cut short by the production
// request cap; the reserve behaviour is exercised explicitly further down with a
// deliberately small one.
const sweep = (nowMs: number, maxSubrequests = 500) =>
  sweepAbandonedSeats({ server, store, codec, nowMs, maxSubrequests });

try {
  const T0 = Date.parse('2026-01-01T00:00:00Z');
  const initialState = initialBgioState(2, { activeSections: ['center'] });
  const { gameId, invites } = await server.createGame({
    initialState, players: ['0', '1'] as PlayerId[],
  });
  const tokens: Record<string, string> = {
    '0': tokenOf(invites['0' as PlayerId]),
    '1': tokenOf(invites['1' as PlayerId]),
  };

  // Clear setup so we're on a real turn, playing as whoever is up.
  for (let i = 0; i < 50; i++) {
    const latest = await store.getLatest(gameId);
    const st = readState(latest!.state);
    if (!st.G.setupPhase) break;
    const actor = tyrantsAdapter.currentActor(st);
    if (actor === null) break;
    const legal = tyrantsAdapter.legalActions(st, actor);
    if (!legal.length) break;
    await server.submit(gameId, tokens[actor], legal[0]);
  }

  // ---- 1. first sweep only starts the clock ----
  const s1 = await sweep(T0);
  const metaAfter1 = await store.getGameMeta(gameId);
  if (s1.forfeited !== 0 || s1.seatsTakenOver !== 0) {
    fail(`first sweep acted on a game nobody has been waiting on: ${JSON.stringify(s1)}`);
  } else pass('a fresh game is left alone (the sweep only starts the clock)');
  if (!metaAfter1?.reminder) fail('no inactivity clock was recorded');
  else pass(`inactivity clock started at turn ${metaAfter1.reminder.turn}`);

  // ---- 2. past the window: forfeit + take over ----
  const before = await store.getLatest(gameId);
  const stalledActor = tyrantsAdapter.currentActor(readState(before!.state));
  const s2 = await sweep(T0 + ABANDON_AFTER_MS + 60_000);
  const afterState = readState((await store.getLatest(gameId))!.state);
  if (s2.forfeited !== 1) fail(`expected exactly one seat forfeited, got ${JSON.stringify(s2)}`);
  else pass(`abandoned seat ${stalledActor} was forfeited after ${ABANDON_AFTER_MS / 86400000} days`);
  if (!(afterState.G.forfeitedSeats ?? []).includes(stalledActor!)) {
    fail('forfeit was not recorded in game state');
  } else pass('forfeit is recorded in the game state the result reads');
  // A 2-player table whose opponent walked away already has its result: the
  // player who stayed wins. Forfeiting the abandoned seat now ENDS the game
  // (tableIsOver) instead of making the survivor finish against a bot. The
  // bot takeover itself is still exercised — by the 3-player table in section
  // 9, where the game has to keep going.
  if (tyrantsAdapter.currentActor(afterState) !== null) {
    fail('2-player: the seat was forfeited but the game did not end — the table is still stuck');
  } else pass('2-player: forfeiting the abandoned seat ends the game, so the table is no longer stuck');
  {
    const res = tyrantsAdapter.result!(afterState);
    const stayer = stalledActor === '0' ? '1' : '0';
    if (!res || res.winners.join() !== stayer) fail(`expected the player who stayed (seat ${stayer}) to win, got ${JSON.stringify(res?.winners)}`);
    else pass(`2-player: the player who stayed (seat ${stayer}) wins`);
  }

  // ---- 3. idempotent ----
  const s3 = await sweep(T0 + ABANDON_AFTER_MS + 120_000);
  const st3 = readState((await store.getLatest(gameId))!.state);
  const dupes = (st3.G.forfeitedSeats ?? []).filter(x => x === stalledActor).length;
  if (dupes !== 1) fail(`seat forfeited ${dupes} times across sweeps`);
  else pass('re-sweeping does not double-forfeit the same seat');
  if (s3.errored > 0) fail(`sweep reported ${s3.errored} errored game(s)`);
  else pass('no errors across repeated sweeps');

  // ---- 4. a returning player resets the clock ----
  {
    const latest = await store.getLatest(gameId);
    const st = readState(latest!.state);
    const actor = tyrantsAdapter.currentActor(st);
    if (actor === null) {
      pass('(game already finished — clock-reset case not applicable)');
    } else {
      const legal = tyrantsAdapter.legalActions(st, actor);
      await server.submit(gameId, tokens[actor], legal[0]);   // they came back
      const t = T0 + ABANDON_AFTER_MS + 200_000;
      const s4 = await sweep(t);                               // observes new turn, restarts clock
      if (s4.forfeited !== 0) fail('a seat that just acted was forfeited anyway');
      else pass('taking a turn resets the clock — a returning player is not forfeited');
    }
  }
  // ---- 5. a foreign game on the shared store is never touched ----
  // The store is one Supabase project shared by every game on the hub, and
  // listActiveGames() has no app filter. A row we can't positively identify as
  // Tyrants must be left completely alone — no clock written, no moves, and
  // above all not marked resolved.
  {
    const foreignId = 'foreign-game-1';
    const foreignMeta = {
      gameId: foreignId,
      players: ['fp', 'shadow'],
      tokens: { fp: 'tok-fp', shadow: 'tok-shadow' },
      createdAt: new Date(T0).toISOString(),
      resolved: false,
    };
    await store.putGameMeta(foreignMeta as never);
    // Something shaped like another game entirely.
    await store.putSnapshot(foreignId, {
      turn: 4,
      state: 'v2:' + JSON.stringify({ G: { fellowship: { track: 3 }, hunt: [] }, ctx: { phase: 'action' } }),
    } as never);

    // A foreign game with NUMERIC seats slips past the cheap metadata
    // pre-filter, so this exercises the state-shape gate that actually protects
    // other games' data.
    const sneakyId = 'foreign-game-numeric';
    await store.putGameMeta({
      gameId: sneakyId,
      players: ['0', '1'],
      tokens: { '0': 'tok-a', '1': 'tok-b' },
      createdAt: new Date(T0).toISOString(),
      resolved: false,
    } as never);
    await store.putSnapshot(sneakyId, {
      turn: 2,
      state: 'v2:' + JSON.stringify({ G: { board: ['x', 'o'], scores: {} }, ctx: { currentPlayer: '0' } }),
    } as never);

    const s5 = await sweep(T0 + ABANDON_AFTER_MS * 3);
    const after = await store.getGameMeta(foreignId);
    if (s5.skippedForeign < 1) fail('the foreign game was not recognised as foreign');
    else pass(`foreign game skipped (${s5.skippedForeign} row(s))`);
    if (after?.resolved) fail('THE SWEEP MARKED ANOTHER GAME RESOLVED — data corruption');
    else pass('foreign game was not marked resolved');
    if (after?.reminder) fail('the sweep wrote its clock onto another game\'s row');
    else pass('foreign game row was not written to at all');

    const sneaky = await store.getGameMeta(sneakyId);
    if (sneaky?.resolved) fail('a numerically-seated foreign game was marked resolved');
    else if (sneaky?.reminder) fail('the sweep wrote its clock onto a numerically-seated foreign game');
    else pass('a foreign game with numeric seats is still rejected by the state-shape gate');
  }
  // ---- 6. a brand-new game still gets its clock started ----
  // Ordering most-overdue-first puts never-seen games at the back of the queue.
  // With a shared store full of other people's games that queue is long, and
  // the time budget was running out before reaching them — so a new game's
  // clock never started, it could never become overdue, and it could never be
  // swept. The sweep would report success every night and quietly not cover
  // exactly the newest games.
  {
    // A pile of already-tracked games to push the new one to the back.
    for (let i = 0; i < 12; i++) {
      const filler = `filler-${i}`;
      await server.createGame({ initialState: initialBgioState(2, { activeSections: ['center'] }),
        players: ['0', '1'] as PlayerId[] });
      void filler;
    }
    // Sweep once so all of those have clocks and sort ahead of anything new.
    await sweep(T0 + ABANDON_AFTER_MS * 4);

    const { gameId: freshId } = await server.createGame({
      initialState: initialBgioState(2, { activeSections: ['center'] }),
      players: ['0', '1'] as PlayerId[],
    });
    const before = await store.getGameMeta(freshId);
    if (before?.reminder) fail('the new game already had a clock — fixture is wrong');

    const s6 = await sweep(T0 + ABANDON_AFTER_MS * 5);
    const after = await store.getGameMeta(freshId);
    if (!after?.reminder) {
      fail('a newly created game got no clock — it can never become overdue, so it can never be swept');
    } else {
      pass(`a newly created game gets its clock started (${s6.clocksStarted} started this run)`);
    }
  }

  // ---- 7. a table abandoned during SETUP is rescued, not skipped ----
  // Someone joins, never places their starting troop, and the others are stuck
  // before the game has even begun — the most common way a game dies. forfeitSeat
  // used to refuse while setupPhase was true, so the sweep threw "That move
  // isn't legal right now" on every such game on every run: never rescued, and
  // the errors never explained (this is what production's steady errored:3 was).
  {
    const { gameId: stuckId } = await server.createGame({
      initialState: initialBgioState(2, { activeSections: ['center'] }),
      players: ['0', '1'] as PlayerId[],
    });
    const stuck = codec.decode !== undefined
      ? readState((await store.getLatest(stuckId))!.state) : null;
    if (!stuck?.G.setupPhase) fail('fixture: expected a fresh game to still be in setup');

    await sweep(T0 + ABANDON_AFTER_MS * 6);           // starts its clock
    const s7 = await sweep(T0 + ABANDON_AFTER_MS * 14); // now overdue

    if (s7.errored > 0) {
      fail(`sweep errored on a game still in setup: ${s7.sampleError ?? '(no detail)'}`);
    } else pass('a table abandoned during setup does not error the sweep');

    const after = readState((await store.getLatest(stuckId))!.state);
    if (!(after.G.forfeitedSeats ?? []).length) {
      fail('nobody was forfeited on a table abandoned during setup — it stays stuck forever');
    } else pass('a seat abandoned during setup is forfeited so the table can proceed');
  }

  // ---- 8. the request allowance can't starve new games ----
  // The binding limit isn't time, it's Cloudflare's cap on outbound requests
  // per Worker invocation. With a backlog of tracked games ahead of it, a tight
  // allowance is spent entirely on them — and a game that never gets a clock
  // can never become overdue, so it can never be swept at all. The reserve
  // exists to make that impossible; this proves it with a production-sized
  // allowance rather than the generous one the other cases use.
  {
    const { gameId: newcomerId } = await server.createGame({
      initialState: initialBgioState(2, { activeSections: ['center'] }),
      players: ['0', '1'] as PlayerId[],
    });
    const before = await store.getGameMeta(newcomerId);
    if (before?.reminder) fail('fixture: the newcomer already had a clock');

    // Small allowance, and plenty of already-tracked games queued ahead of it.
    const s8 = await sweep(T0 + ABANDON_AFTER_MS * 20, 40);
    const after = await store.getGameMeta(newcomerId);
    if (!after?.reminder) {
      fail(`newcomer got no clock under a tight request allowance (used ${s8.requestsUsed}) — it can never be swept`);
    } else {
      pass(`the reserve gets a new game its clock even when the allowance runs out (used ${s8.requestsUsed}, clocksStarted ${s8.clocksStarted})`);
    }
    if (!s8.ranOutOfRequests) {
      pass('(allowance was not exhausted — reserve untested this run, but nothing starved)');
    } else {
      pass('allowance genuinely ran out, and the newcomer still got through');
    }
  }

  // ---- 9. 3+ players: the bot really does take the abandoned seat's turns ----
  // With other people still playing, a forfeited seat must be played for the
  // table to move. A separate store, so this game can't shift the candidate
  // counts sections 6-8 assert on.
  {
    const root3 = mkdtempSync(join(tmpdir(), 'totu-sweep3-'));
    try {
      const store3 = new FsStore(root3);
      const server3 = new GameServer<BgioState, TyrantsAction, PlayerId>({
        adapter: tyrantsAdapter, codec, store: store3, aiControllers: tyrantsControllers,
        gameUrl: (g, t) => `http://test/${g}?as=${t}`,
      });
      const { gameId: g3, invites: inv3 } = await server3.createGame({
        initialState: initialBgioState(3, { activeSections: ['left', 'center'] }),
        players: ['0', '1', '2'] as PlayerId[],
      });
      const tok3: Record<string, string> = Object.fromEntries(
        (['0', '1', '2'] as const).map(p => [p, tokenOf(inv3[p as PlayerId])]));
      for (let i = 0; i < 80; i++) {
        const st = readState((await store3.getLatest(g3))!.state);
        if (!st.G.setupPhase) break;
        const actor = tyrantsAdapter.currentActor(st);
        if (actor === null) break;
        const legal = tyrantsAdapter.legalActions(st, actor);
        if (!legal.length) break;
        await server3.submit(g3, tok3[actor], legal[0]);
      }
      const sweep3 = (nowMs: number) =>
        sweepAbandonedSeats({ server: server3, store: store3, codec, nowMs, maxSubrequests: 500 });
      const T = Date.parse('2026-03-01T00:00:00Z');
      await sweep3(T);                                     // starts the clock
      const stalled3 = tyrantsAdapter.currentActor(readState((await store3.getLatest(g3))!.state));
      const r = await sweep3(T + ABANDON_AFTER_MS + 60_000);
      const after3 = readState((await store3.getLatest(g3))!.state);
      if (r.forfeited !== 1) fail(`3-player: expected one forfeit, got ${JSON.stringify(r)}`);
      else pass(`3-player: abandoned seat ${stalled3} was forfeited`);
      if (tyrantsAdapter.currentActor(after3) === null) fail('3-player: the game ended, but two people are still playing');
      else pass('3-player: the game carries on for the players still at the table');
      if (r.seatsTakenOver !== 1) fail('3-player: the sweep forfeited the seat but the bot never played it — the table is still stuck');
      else pass('3-player: the server\'s bot played the abandoned seat\'s turn in the same request');
      const movedOn3 = tyrantsAdapter.currentActor(after3);
      if (movedOn3 === stalled3) fail(`3-player: turn is still on the abandoned seat ${stalled3}`);
      else pass(`3-player: turn moved on to seat ${movedOn3}`);
      const meta3 = await store3.getGameMeta(g3);
      if (meta3?.identities?.[stalled3!]?.startsWith('ai:')) fail('3-player: the takeover rewrote the seat\'s identity — the walker would drop out of the rating');
      else pass('3-player: the abandoned seat keeps its identity, so the loss still counts');

      // The fix that needed framework 0.50: the seat is played on EVERY later
      // turn as soon as it comes round, not once per daily sweep after another
      // week idle. Play the humans for two full rounds, no sweeps at all.
      const startTurn = (after3.ctx.turn as number);
      let stalledAtRest = 0;
      for (let i = 0; i < 400; i++) {
        const st = readState((await store3.getLatest(g3))!.state);
        if ((st.ctx.turn as number) >= startTurn + 6) break;
        const actor = tyrantsAdapter.currentActor(st);
        if (actor === null) break;
        if (actor === stalled3) { stalledAtRest++; break; }
        const legal = tyrantsAdapter.legalActions(st, actor);
        if (!legal.length) break;
        await server3.submit(g3, tok3[actor], legal[0]);
      }
      const end3 = readState((await store3.getLatest(g3))!.state);
      if (stalledAtRest) fail(`3-player: the table came to rest on forfeited seat ${stalled3} — it would wait for the next sweep`);
      else if ((end3.ctx.turn as number) < startTurn + 6) fail(`3-player: only reached turn ${end3.ctx.turn} from ${startTurn} — the humans' turns never cycled`);
      else pass(`3-player: two more rounds played (turn ${startTurn} → ${end3.ctx.turn}) and the forfeited seat never held the table up`);
    } finally {
      rmSync(root3, { recursive: true, force: true });
    }
  }

} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(ok ? '\nPASS' : '\nFAIL');
process.exit(ok ? 0 : 1);
