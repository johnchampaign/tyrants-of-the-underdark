// Regression harness: rewinding to an OLD-SCHEMA snapshot must not blank the app.
//
// The bug (reported against main @1280af3): pasting a codec from a published
// schemaVersion-1 log into the Game Log tab's "Load state" box rendered the
// turn-summary modal once and then threw inside <Board>, wiping
// document.getElementById('root').
//
// Root cause: `loadState` DELETES every field on G and re-assigns only what the
// codec carried. Fields added to TyrantsState after that codec was written come
// back `undefined`, and the Board reads several of them unguarded — most
// visibly `p.cardsPlayed.length` (added with the per-player "Played this turn"
// pile viewer, absent from every v1 codec). turn.onBegin carried an ad-hoc
// subset of legacy backfills, but it doesn't run until the NEXT turn begins,
// which is far too late: React re-renders the moment the move lands.
//
// This harness drives the real `loadState` move through the boardgame.io
// reducer for EVERY snapshot codec in three published logs, then
// server-renders the real <Board> over the result and runs the real scorer.
// Any newly-added state field the Board reads unguarded shows up as a render
// throw here instead of as a blank page in front of a player.
//
// Usage: npm run test:legacy-codec

import './dom-shim';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CreateGameReducer, InitializeGame } from 'boardgame.io/internal';
import '../src/engine/handlers';
import { TyrantsGame, type TyrantsState } from '../src/game';
import { Board } from '../src/App';
import { scoreAll } from '../src/engine/scoring';
import { setStoredFlag } from './dom-shim';

// Published logs to sweep. All 259 files in logs/ are schemaVersion 1, so any
// of them exercises the legacy path; these three cover the reported game plus
// both a base-game and an expansion half-deck pairing.
const LOG_FILES = [
  '0064f64cd92bd95e.json', // the log from the bug report (4P dragons+elemental)
  '1e9518e2a3ffda4c.json', // longest published game (4P drow+dragons, 105 turns)
  '1c473c6fe9c3973a.json', // expansion half-decks (4P aberrations+undead)
];

/** The marker `loadState` appends on success — how we tell a real load from a
 *  silently-rejected INVALID_MOVE (boardgame.io does not preserve the state
 *  reference on rejection, so identity comparison can't be used). */
const LOAD_MARKER = '[state loaded from codec]';

interface PublishedLog {
  game: {
    schemaVersion?: number;
    numPlayers?: number;
    halfDecks?: string[];
    snapshots?: Array<{ turn: number; playerId: string; color: string; codec: string }>;
  };
}

type Ctx = { currentPlayer: string; numPlayers: number; turn: number; gameover?: unknown };
type Store = { G: TyrantsState; ctx: Ctx };

const reducer = CreateGameReducer({ game: TyrantsGame as never });

function fresh(numPlayers: number, halfDecks: string[]): Store {
  return structuredClone(InitializeGame({
    game: TyrantsGame as never,
    numPlayers,
    setupData: { halfDecks } as never,
  }) as unknown as Store) as Store;
}

function makeMove(state: Store, type: string, args: unknown[], pid: string): Store {
  return reducer(state as never, {
    type: 'MAKE_MOVE',
    payload: { type, args, playerID: pid, credentials: undefined },
  } as never) as unknown as Store;
}

/** Run the real `loadState` move over a fresh game and assert it was accepted. */
function loadCodec(numPlayers: number, halfDecks: string[], codec: string): Store {
  const base = fresh(numPlayers, halfDecks);
  const after = makeMove(base, 'loadState', [codec], base.ctx.currentPlayer);
  const last = after.G.log[after.G.log.length - 1];
  if (!last || last.msg !== LOAD_MARKER) {
    throw new Error('loadState was rejected (INVALID_MOVE) — state not loaded');
  }
  return after;
}

/** Server-render the real Board over this state. `moves` are inert stubs — SSR
 *  never fires an onClick; we only care that the render pass completes. */
function renderBoard(st: Store): void {
  const moves = new Proxy({}, { get: () => () => { /* inert */ } }) as Record<string, unknown>;
  renderToStaticMarkup(createElement(Board as never, {
    G: st.G,
    ctx: st.ctx,
    moves,
    events: { endTurn() { }, endPhase() { } },
    playerID: '0',
    isActive: true,
    matchData: [],
  } as never));
}

let ok = true;
let checks = 0;
function check(label: string, fn: () => void): void {
  checks++;
  try {
    fn();
  } catch (err) {
    ok = false;
    console.log(`FAIL  ${label}`);
    console.log(String((err as Error)?.stack ?? err).split('\n').slice(0, 6)
      .map(l => `        ${l.trim()}`).join('\n'));
    return;
  }
  console.log(`PASS  ${label}`);
}

// No-images mode keeps <Card> on the text-placeholder path (no image cache or
// blob URLs under SSR).
setStoredFlag('totu.no-images', true);

for (const file of LOG_FILES) {
  const raw = JSON.parse(readFileSync(join('logs', file), 'utf-8')) as PublishedLog;
  const snapshots = raw.game.snapshots ?? [];
  const numPlayers = raw.game.numPlayers ?? 4;
  const halfDecks = raw.game.halfDecks ?? ['drow', 'dragons'];
  const schema = raw.game.schemaVersion ?? 1;

  console.log(`\n--- ${file} (schemaVersion ${schema}, ${snapshots.length} snapshots, `
    + `${numPlayers}P ${halfDecks.join('+')}) ---`);

  if (snapshots.length === 0) {
    ok = false;
    console.log('FAIL  no snapshots to replay');
    continue;
  }

  // The default "game" tab and the split-view "play" tab render different
  // hand / scoreboard blocks and read different per-player fields, so sweep
  // every codec through both.
  for (const splitView of [false, true]) {
    setStoredFlag('totu.split-view', splitView);
    const view = splitView ? 'play tab' : 'game tab';
    check(`all ${snapshots.length} codecs load + render + score (${view})`, () => {
      for (const snap of snapshots) {
        let st: Store;
        try {
          st = loadCodec(numPlayers, halfDecks, snap.codec);
        } catch (err) {
          throw new Error(`turn ${snap.turn}: ${(err as Error).message}`);
        }
        try {
          renderBoard(st);
        } catch (err) {
          throw new Error(`turn ${snap.turn}: Board render threw — ${(err as Error).message}`);
        }
        try {
          scoreAll(st.G);
        } catch (err) {
          throw new Error(`turn ${snap.turn}: scoreAll threw — ${(err as Error).message}`);
        }
      }
    });
  }
  setStoredFlag('totu.split-view', false);

  // A loaded legacy state must be PLAYABLE, not merely renderable. Ending the
  // turn runs turn.onEnd + turn.onBegin over the backfilled state, which is
  // where a missing pendingEotInnerCircleVp / devouredPile / cardsPlayed
  // surfaces as an engine throw rather than a render throw.
  check('last mid-game codec survives an endTurn round-trip', () => {
    // Setup-phase snapshots can't take `endTurn` (the move is gated on
    // !G.setupPhase), so rewind to the last snapshot that isn't in setup.
    const playable = [...snapshots].reverse().find(
      s => !loadCodec(numPlayers, halfDecks, s.codec).G.setupPhase,
    );
    if (!playable) throw new Error('no post-setup snapshot in this log');
    const st = loadCodec(numPlayers, halfDecks, playable.codec);
    const after = makeMove(st, 'endTurn', [], st.ctx.currentPlayer);
    if (after.ctx.turn === st.ctx.turn) {
      throw new Error(`turn ${playable.turn}: endTurn was rejected on the loaded state`);
    }
    renderBoard(after);
    scoreAll(after.G);
  });

  // Field parity with a freshly-initialized state. This is the check that
  // fails loudly the next time a field is added to TyrantsState without a
  // matching entry in backfillLegacyState.
  check('loaded state carries every field a fresh state has', () => {
    const base = fresh(numPlayers, halfDecks);
    const st = loadCodec(numPlayers, halfDecks, snapshots[snapshots.length - 1].codec);
    const missing = Object.keys(base.G).filter(
      k => (st.G as unknown as Record<string, unknown>)[k] === undefined,
    );
    if (missing.length) throw new Error(`missing top-level field(s): ${missing.join(', ')}`);
    const refPlayer = base.G.players['0'] as unknown as Record<string, unknown>;
    for (const pid of Object.keys(st.G.players)) {
      const p = st.G.players[pid] as unknown as Record<string, unknown>;
      const missingP = Object.keys(refPlayer).filter(k => p[k] === undefined);
      if (missingP.length) throw new Error(`player ${pid} missing field(s): ${missingP.join(', ')}`);
    }
  });
}

console.log(`\n${ok ? 'ALL PASS' : 'FAILURES'} — ${checks} checks`);
process.exit(ok ? 0 : 1);
