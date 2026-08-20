// End-to-end test for the abandoned-seat sweep (server/sweep.ts).
//
// Drives a real GameServer + FsStore, walks the clock forward past the
// abandonment window, and checks the sweep does the right thing in each of the
// four situations that matter:
//
//   1. A fresh game is left alone (nobody has been waiting long enough).
//   2. A seat that has sat on its turn past the window gets forfeited AND
//      played, so the table moves again.
//   3. Re-running the sweep doesn't forfeit the same seat twice.
//   4. A player who comes back and takes a turn resets the clock — coming back
//      must not leave them permanently bot-driven.
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
const sweep = (nowMs: number) =>
  sweepAbandonedSeats({ server, store, codec, controllers: tyrantsControllers, nowMs });

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
  if (s1.forfeited !== 0 || s1.movesPlayed !== 0) {
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
  if (s2.movesPlayed < 1) fail('the sweep forfeited the seat but never played it — the table is still stuck');
  else pass(`bot played ${s2.movesPlayed} move(s) for the abandoned seat, unsticking the table`);
  const movedOn = tyrantsAdapter.currentActor(afterState);
  if (movedOn === stalledActor) fail(`turn is still on the abandoned seat ${stalledActor}`);
  else pass(`turn moved on to seat ${movedOn}`);

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
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(ok ? '\nPASS' : '\nFAIL');
process.exit(ok ? 0 : 1);
