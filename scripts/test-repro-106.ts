// Regression test for report #106 — "undo during an obligatory promote phase
// breaks the game".
//
// Root cause: turn.maxMoves (was 50). boardgame.io force-ends the turn from
// outside our move handlers the moment ctx.numMoves reaches the cap, which
// bypasses `endTurn`'s `if (G.pendingChoice) return INVALID_MOVE` guard. A long
// human turn (every prompt click is a move; "Load turn" and undo replays keep
// counting on the same ctx) hit the cap on the very move that raised the
// mandatory end-of-turn promote prompt, so the turn advanced to the next seat
// with that prompt still standing and nobody able to answer it.
//
// Asserts:
//   1. No move cap on the turn config, and a move dispatched at a high
//      ctx.numMoves does NOT advance the seat.
//   2. Undo during a mandatory end-of-turn promote restores the prompt and
//      leaves the seat alone (the thing the reporter actually wanted).
//   3. Safety net: if a turn is force-ended with a prompt outstanding, onEnd
//      clears it instead of leaking it into the next seat's turn.
import { CreateGameReducer, InitializeGame } from 'boardgame.io/internal';
import { TyrantsGame, type TyrantsState, type EotPromoteTrigger } from '../src/game';
import { decideAiMove } from '../src/ai/random-ai';

type BgState = { G: TyrantsState; ctx: { currentPlayer: string; numMoves?: number; gameover?: unknown } };
type Reducer = (s: BgState, a: unknown) => BgState;

const action = (type: string, args: unknown[], playerID: string) => ({
  type: 'MAKE_MOVE', payload: { type, args, playerID },
});
const event = (type: string, args: unknown[], playerID: string) => ({
  type: 'GAME_EVENT', payload: { type, args, playerID },
});

const reducer = CreateGameReducer({ game: TyrantsGame as never }) as unknown as Reducer;

let ok = true;
const check = (label: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) ok = false;
};

/** Drive the random AI until seat 0 has a clean turn (setup done, no prompt). */
function toSeat0CleanTurn(): BgState {
  let state = InitializeGame({ game: TyrantsGame as never, numPlayers: 4 }) as unknown as BgState;
  let guard = 0;
  while (guard++ < 5000) {
    const { G, ctx } = state;
    if (!G.setupPhase && ctx.currentPlayer === '0' && !G.pendingChoice) break;
    const pid = ctx.currentPlayer;
    const mv = decideAiMove(G, pid);
    state = mv ? reducer(state, action(mv.name, (mv.args as unknown[]) ?? [], pid))
               : reducer(state, action('endTurn', [], pid));
  }
  return state;
}

/** Play the plain resource cards in hand — no prompts, no hidden-info reveals —
 *  so cardsPlayedThisTurn has something for an end-of-turn promote to pick. */
function playPlainCards(state: BgState, want: number): BgState {
  let guard = 0;
  while (guard++ < 10 && state.G.cardsPlayedThisTurn.length < want) {
    const i = state.G.players['0'].hand.findIndex(c => c.name === 'Noble' || c.name === 'Soldier');
    if (i < 0) break;
    state = reducer(state, action('playCard', [i], '0'));
  }
  return state;
}

/** Immer freezes G, so hand-built scenarios have to swap in a fresh top level. */
const withG = (s: BgState, patch: Partial<TyrantsState>): BgState =>
  ({ ...s, G: { ...s.G, ...patch } });

// A trigger that is not itself one of the played cards, so every played card is
// eligible. Only `name` and the filters are read off it by the promote loop.
const fakeTrigger = (name: string): EotPromoteTrigger =>
  ({ deck: 'drow', slot: 999, name, image: '' } as unknown as EotPromoteTrigger);

// ---------------------------------------------------------------- 1. no cap
const turnCfg = TyrantsGame.turn as { maxMoves?: number } | undefined;
check('turn config declares no maxMoves', turnCfg?.maxMoves === undefined);

let state = toSeat0CleanTurn();
check('reached seat-0 clean turn', !state.G.setupPhase && state.ctx.currentPlayer === '0' && !state.G.pendingChoice);

// Pretend this seat has already burned a long turn's worth of moves — exactly
// what a real turn full of prompt clicks plus a Load-turn replay produces.
state = { ...state, ctx: { ...state.ctx, numMoves: 99 } };
const nobleIdx = state.G.players['0'].hand.findIndex(c => c.name === 'Noble');
check('have a Noble in hand', nobleIdx >= 0);
state = reducer(state, action('playCard', [nobleIdx], '0'));
check('move at numMoves=99 did not force-end the turn', state.ctx.currentPlayer === '0');
check('move at numMoves=99 still applied', state.G.cardsPlayedThisTurn.length > 0);

// ----------------------------------- 2. undo during a mandatory eot promote
let promo = playPlainCards(toSeat0CleanTurn(), 3);
check('played enough plain cards to promote from', promo.G.cardsPlayedThisTurn.length >= 2);
// Two mandatory triggers, so answering the first re-issues the prompt for the
// second rather than ending the turn — the state the reporter was undoing from.
promo = withG(promo, { pendingEotPromotions: [fakeTrigger('Test Cultist'), fakeTrigger('Test Myrmidon')] });
promo = reducer(promo, action('endTurn', [], '0'));
check('End Turn raised the mandatory promote prompt', promo.G.pendingChoice?.cardKey === '__eot__');
check('End Turn did not advance the seat while the prompt stands', promo.ctx.currentPlayer === '0');
const promptBefore = promo.G.pendingChoice!.prompt;
const playedBefore = promo.G.cardsPlayedThisTurn.length;
const innerBefore = promo.G.players['0'].innerCircle.length;

const answered = reducer(promo, action('resolveChoice', [0], '0'));
check('answering promoted a card', answered.G.players['0'].innerCircle.length === innerBefore + 1);
check('answering re-issued the prompt for the second trigger', answered.G.pendingChoice?.cardKey === '__eot__');
check('answering pushed an undo point', answered.G.undoStack.length > promo.G.undoStack.length);

const undone = reducer(answered, action('undo', [], '0'));
check('undo restored the original promote prompt', undone.G.pendingChoice?.prompt === promptBefore);
check('undo put the promoted card back', undone.G.players['0'].innerCircle.length === innerBefore);
check('undo restored cards played this turn', undone.G.cardsPlayedThisTurn.length === playedBefore);
check('undo did not advance the seat', undone.ctx.currentPlayer === '0');

// The prompt is answerable again — this is the whole point of the report.
const reanswered = reducer(undone, action('resolveChoice', [1], '0'));
check('the restored prompt can be answered again', reanswered.G.players['0'].innerCircle.length === innerBefore + 1);

// ------------------------------------------- 3. forced end never leaks a prompt
// Force a turn end straight through the event system while a prompt is standing
// (what maxMoves used to do). onEnd must drop the prompt rather than hand it to
// the next seat.
let forced = playPlainCards(toSeat0CleanTurn(), 2);
forced = withG(forced, {
  pendingChoice: {
    kind: 'select-played-card',
    prompt: 'End of turn — promote a card played this turn (test).',
    options: [0],
    optional: false,
    playerId: '0',
    cardKey: '__eot__',
  } as TyrantsState['pendingChoice'],
});
forced = reducer(forced, event('endTurn', [], '0'));
check('forced turn end advanced the seat', forced.ctx.currentPlayer !== '0');
check('forced turn end did not leak the prompt', !forced.G.pendingChoice);
check('forced turn end cleared paused handler state', !forced.G.pausedHandlerState);

console.log(ok ? '\nALL #106 TESTS PASSED' : '\n#106 TESTS FAILED');
process.exit(ok ? 0 : 1);
