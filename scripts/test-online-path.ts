// Online-path integration test — the harness that would have caught the three
// online-ONLY failures that in-memory tests (and the AI-drive sweep) never do,
// because they all live in the seam that only online play exercises: the game
// state is serialized to the store and back on EVERY move.
//
// Unlike scripts/test-ai-drive.ts (which calls the adapter directly, in memory),
// this drives full games through the real framework GameServer + a real
// serializing store (FsStore) + the production snapshotCodec — the exact
// encode→store→decode cycle Cloudflare + Supabase run in production. It plays a
// human seat via server.submit() and lets the server auto-drive the AI seat,
// then polls via server.fetch(), for every half-deck pair.
//
// It fails (exit 1) on any of:
//   - the server throwing on a move (a crash the human would see),
//   - a STRANDED AI turn: after the human moves it becomes the AI's turn and
//     never comes back (the "Red is taking their turn" deadlock — driveAi only
//     ran on submit, and a poll didn't re-drive). Surfaces as no-progress.
//   - a RUNAWAY turn: one seat takes absurdly many actions without the turn
//     ending — a within-turn draw/replay loop, if random play happens to hit it.
//   - STATE BLOAT: the persisted state / log grows past any sane bound — the
//     symptom that ballooned the exploited game to ~3 MB and made the Function
//     503 on every read. Catches loops that DO get exercised, and runaway
//     growth generally.
//   - a game that never terminates.
//
// COVERAGE NOTE: this harness reliably catches the deadlock, crashes, and bloat
// classes through the real serialized path. The serialization-IDENTITY infinite
// loop (Information Broker reshuffle-redraw) has its own DETERMINISTIC guard in
// scripts/test-infinite-draw.ts (cases E/F JSON round-trip the state before
// drawing) — a random full game can't be relied on to reach that specific
// board state, so that root cause is pinned there, not here.
//
// Usage: npm run test:online-path [gamesPerPair]   (default 1)

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InitializeGame } from 'boardgame.io/internal';

import { GameServer } from 'digital-boardgame-framework/server';
import { FsStore } from 'digital-boardgame-framework/server/node';
import { TyrantsGame } from '../src/game';
import { tyrantsAdapter, type BgioState, type TyrantsAction, type PlayerId } from '../src/adapter/tyrantsAdapter';
import { snapshotCodec } from '../src/online/snapshotCodec';
import { tyrantsControllers, TYRANTS_AI_SLICE } from '../src/online/aiControllers';

// A normal Tyrants turn is a handful of actions; a whole game a few hundred.
// These caps sit far above legitimate play so they only trip on a real wedge.
const RUNAWAY_TURN_CAP = 600;   // one seat acting this many times in a single turn = a loop
const STEP_CAP = 30_000;        // total human submits across a whole game
const LOG_CAP = 6_000;          // a full legit game logs a few hundred–~1500 lines; past this = bloat/loop

interface Failure { kind: string; detail: Record<string, unknown> }

const tokenOf = (url: string) => url.split('as=')[1]!;

function makeServer(root: string) {
  return new GameServer<BgioState, TyrantsAction, PlayerId>({
    adapter: tyrantsAdapter,
    codec: snapshotCodec(),
    store: new FsStore(root),
    aiControllers: tyrantsControllers,
    // Production slicing, so this exercises AI runs continued across fetches.
    aiSlice: TYRANTS_AI_SLICE,
    snapshotHistory: 20,
    gameUrl: (g, t) => `http://test/${g}?as=${t}`,
  });
}

async function runGame(halfDecks: string[], aiDifficulty: string): Promise<Failure | null> {
  const root = mkdtempSync(join(tmpdir(), 'totu-online-'));
  try {
    const server = makeServer(root);
    const game = { ...TyrantsGame, setup: (a: any) => TyrantsGame.setup!(a, { halfDecks }) };
    const initialState = InitializeGame({ game: game as never, numPlayers: 2 }) as unknown as BgioState;

    // Seat '0' = human (driven here), seat '1' = server-driven AI.
    const { gameId, invites } = await server.createGame({
      initialState, players: ['0', '1'] as PlayerId[], ai: { '1': aiDifficulty } as any,
    });
    const human = tokenOf(invites['0' as PlayerId]);
    const rng = { int: (n: number) => Math.floor(Math.random() * n), float: () => Math.random(), next: () => Math.random() };

    let submits = 0;
    let turnStreak = 0;      // consecutive human actions this turn (loop detector)
    let noProgress = 0;      // consecutive fetches where it's neither our turn nor over (stall detector)

    for (;;) {
      let vr: any;
      try { vr = await server.fetch(gameId, human); }
      catch (e: any) { return { kind: 'fetch-threw', detail: { halfDecks, aiDifficulty, err: String(e?.message ?? e) } }; }

      if (vr.gameOver) return null;                 // clean termination

      // Bloat guard — the 503 symptom. The redacted view still carries G.log
      // (the field that ballooned), so its length is a faithful proxy.
      const logLen = vr.view?.G?.log?.length ?? 0;
      if (logLen > LOG_CAP) {
        return { kind: 'STATE-BLOAT (would 503 the Function)', detail: { halfDecks, aiDifficulty, turn: vr.turn, logLen } };
      }

      if (!vr.yourTurn) {
        // The AI seat should have been driven on our last submit, and fetch()
        // re-drives any stranded AI turn. If it's STILL the AI's turn many polls
        // running, the AI turn is deadlocked (the online lock).
        if (++noProgress > 50) {
          return { kind: 'STRANDED-AI-TURN (deadlock)', detail: { halfDecks, aiDifficulty, turn: vr.turn, note: 'AI turn never returned to the human after repeated polls' } };
        }
        continue;
      }
      noProgress = 0;

      let legal: any[];
      try { legal = await server.legalActions(gameId, human); }
      catch (e: any) { return { kind: 'legalActions-threw', detail: { halfDecks, aiDifficulty, err: String(e?.message ?? e) } }; }
      if (legal.length === 0) return { kind: 'NO-LEGAL-ACTIONS (stuck on our turn)', detail: { halfDecks, aiDifficulty, turn: vr.turn } };

      // Adversarial policy: prefer to keep PLAYING over ending the turn, so we
      // actively exercise draw/replay loops (Information Broker et al.). Only end
      // the turn when nothing else is legal. Under correct rules this still
      // terminates (hand + reshufflable deck deplete); under the identity bug it
      // loops forever → caught by RUNAWAY_TURN_CAP.
      const nonEnd = legal.filter(a => a.kind !== 'endTurn');
      const choices = nonEnd.length > 0 ? nonEnd : legal;
      const action = choices[rng.int(choices.length)];
      const endingTurn = action.kind === 'endTurn';

      try { await server.submit(gameId, human, action); }
      catch (e: any) { return { kind: 'submit-threw', detail: { halfDecks, aiDifficulty, action, err: String(e?.message ?? e), turn: vr.turn } }; }

      submits++;
      turnStreak = endingTurn ? 0 : turnStreak + 1;
      if (turnStreak > RUNAWAY_TURN_CAP) {
        return { kind: 'RUNAWAY-TURN (serialization identity loop)', detail: { halfDecks, aiDifficulty, turn: vr.turn, actionsThisTurn: turnStreak, lastAction: action } };
      }
      if (submits > STEP_CAP) {
        return { kind: 'NON-TERMINATING', detail: { halfDecks, aiDifficulty, submits, note: `exceeded ${STEP_CAP} human submits` } };
      }
    }
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort tmp cleanup */ }
  }
}

const DECKS = ['drow', 'dragons', 'elemental', 'demons', 'aberrations', 'undead'];
const PAIRS: string[][] = [];
for (let i = 0; i < DECKS.length; i++) for (let j = i + 1; j < DECKS.length; j++) PAIRS.push([DECKS[i], DECKS[j]]);

(async () => {
  const perPair = Math.max(1, parseInt(process.argv[2] ?? '1', 10) || 1);
  const failures: Failure[] = [];
  let games = 0;

  for (const pair of PAIRS) {
    for (let g = 0; g < perPair; g++) {
      games++;
      const f = await runGame(pair, 'standard');
      if (f) {
        failures.push(f);
        console.log(`FAIL  [${pair.join('+')}] game ${g}: ${f.kind}`);
        console.log('      ' + JSON.stringify(f.detail));
      } else {
        console.log(`ok    [${pair.join('+')}] game ${g} — full game through serialize→store→decode, no wedge`);
      }
      if (failures.length >= 5) break;
    }
    if (failures.length >= 5) break;
  }

  if (failures.length === 0) {
    console.log(`\nPASS  online-path: ${games} full games across ${PAIRS.length} deck pairs — every move round-tripped through the store, AI auto-driven, no deadlock / loop / crash.`);
    process.exit(0);
  } else {
    console.log(`\nFAILED  online-path: ${failures.length} online-only wedge(s). These reproduce a live-game break through the real serialization path. Do not ship.`);
    process.exit(1);
  }
})();
