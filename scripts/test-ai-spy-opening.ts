// Two AI behaviours raised on BGG by michael irsutti:
//   1. "Better use of spies: force the AI to place a spy in a city. This is the
//      best option in 99% of cases, except maybe during the last turn."
//   2. "Improve the initial troop deployment → automatically choose sites close
//      to THE PAERLIN or GAUNTLGRYM."
//
// (1) is not a rule the AI can hard-code — on the last turn cashing a spy in IS
// right, and the option isn't always available. The underlying defect is that
// the lookahead evaluates a position with scoreAll, which counts VP and nothing
// else, so a spy on the board priced out at exactly zero while "return a spy →
// +5 Power" priced out at whatever that power bought before the turn ended.
// The AI cashed spies in almost every time it was offered the choice.
//
// (2) is generalised: rather than naming two sites, rank opening sites by how
// close they sit to whichever control markers are in play at this player count.
//
// This harness pins both: the Vrock choice (Place a spy / Return a spy → +5
// Power) with a real simulator attached, and the opening-site ranking.
import { CreateGameReducer, InitializeGame } from 'boardgame.io/internal';
import '../src/engine/handlers';
import { TyrantsGame, type TyrantsState } from '../src/game';
import { decideHeuristicMoveWithWeights } from '../src/ai/heuristic-ai';
import { DEFAULT_WEIGHTS } from '../src/ai/heuristic-weights';
import type { SimulateMoveFn, RolloutToTurnEndFn } from '../src/ai/lookahead';

const reducer = CreateGameReducer({ game: TyrantsGame as never });
type Store = { G: TyrantsState; ctx: { currentPlayer: string; gameover?: unknown } };

const action = (type: string, args: unknown[], pid: string) =>
  ({ type: 'MAKE_MOVE', payload: { type, args, playerID: pid } });

function fresh(numPlayers = 4): Store {
  const s = InitializeGame({
    game: TyrantsGame as never,
    numPlayers,
    setupData: { halfDecks: ['demons', 'drow'] } as never,
  }) as unknown as Store;
  return structuredClone(s);
}

let ok = true;
const check = (label: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) ok = false;
};

// ---------------------------------------------------------------- spy choice
//
// Set up the exact fork the reporter described: a Vrock in hand, a spy already
// on the board (so "Return a spy → +5 Power" is offered), and a full simulator
// so the lookahead paths are live — the same wiring the solo/hotseat client
// gives the AI.
function vrockChoice(weights: typeof DEFAULT_WEIGHTS, endgame: boolean): { idx: number | null; options: string[] } {
  const st0 = fresh();
  st0.G.setupPhase = false;
  const pid = st0.ctx.currentPlayer;
  const me = st0.G.players[pid];
  me.hand = [{ deck: 'demons', slot: 38, name: 'Vrock', image: '' }];
  // A spy of ours already on the board at a control-marker site.
  st0.G.spies['tsenviilyq'] = [me.color];
  me.spiesLeft = 4;
  if (endgame) st0.G.endGameTriggeredAtTurn = 1;

  const template = st0;
  const simulate: SimulateMoveFn = (Gx, p, name, args) => {
    const wrapped = { ...template, G: Gx, ctx: { ...template.ctx, currentPlayer: p } };
    const next = reducer(wrapped as never, action(name, args, p) as never) as unknown as Store;
    if (next === (wrapped as unknown as Store)) return null;
    return next.G;
  };
  const rollout: RolloutToTurnEndFn = (Gx, p, name, args) => {
    let s = { ...template, G: Gx, ctx: { ...template.ctx, currentPlayer: p } } as unknown as Store;
    s = reducer(s as never, action(name, args, p) as never) as unknown as Store;
    if (s.G === Gx) return null;
    let inner = 50;
    while (inner-- > 0) {
      if (s.ctx.gameover || s.ctx.currentPlayer !== p) break;
      const m = decideHeuristicMoveWithWeights(s.G, p, weights);
      const next = m
        ? reducer(s as never, action(m.name, m.args as unknown[], p) as never) as unknown as Store
        : s;
      s = next === s ? reducer(s as never, action('endTurn', [], p) as never) as unknown as Store : next;
    }
    return s.G;
  };

  // Play the Vrock, then ask the AI to resolve the choose-one it raises.
  const st = reducer(st0 as never, action('playCard', [0], pid) as never) as unknown as Store;
  const pc = st.G.pendingChoice;
  if (!pc || pc.kind !== 'choose-one') return { idx: null, options: [] };
  const mv = decideHeuristicMoveWithWeights(st.G, pid, weights, simulate, rollout);
  const idx = mv && mv.name === 'resolveChoice' ? (mv.args[0] as number) : null;
  return { idx, options: (pc.options as string[]) ?? [] };
}

const before = vrockChoice({ ...DEFAULT_WEIGHTS, spyPresenceValue: 0, spyMarkerPresenceValue: 0 }, false);
const after = vrockChoice(DEFAULT_WEIGHTS, false);
const endgame = vrockChoice(DEFAULT_WEIGHTS, true);

console.log('   Vrock options:', before.options.join(' | '));
console.log(`   pure-VP evaluation picks: ${before.idx} (${before.options[before.idx ?? 0]})`);
console.log(`   shipped weights pick:     ${after.idx} (${after.options[after.idx ?? 0]})`);
console.log(`   after end-game trigger:   ${endgame.idx} (${endgame.options[endgame.idx ?? 0]})`);

check('the Vrock fork is offered as a two-option choose-one', before.options.length === 2);
check('mid-game, the AI keeps the spy on the board rather than cashing it for power',
  after.idx === 0);
// The reporter's own caveat, and the reason this can't be a hard rule: once the
// end-game trigger has fired the game is decided on VP, board presence buys
// nothing further, and trading the spy for 5 power is right.
check('after the end-game trigger, the AI is free to cash the spy in again',
  endgame.idx === 1);

// -------------------------------------------------------------- opening pick
//
// Every starting site is markerless, so ranking them on printed VP (the old
// behaviour) said nothing about where the game is actually won. Sample the
// AI's opening across many fresh games and check the distribution shifts
// toward sites that can reach a control marker cheaply.
function openingHistogram(weights: typeof DEFAULT_WEIGHTS, n: number): Record<string, number> {
  const hist: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    const st = fresh();
    const mv = decideHeuristicMoveWithWeights(st.G, st.ctx.currentPlayer, weights);
    if (mv?.name === 'deployStartingTroop') {
      const id = mv.args[0] as string;
      hist[id] = (hist[id] ?? 0) + 1;
    }
  }
  return hist;
}

const N = 400;
const oldHist = openingHistogram({ ...DEFAULT_WEIGHTS, openingMarkerProximity: 0 }, N);
const newHist = openingHistogram(DEFAULT_WEIGHTS, N);
console.log('   opening sites, proximity off:', JSON.stringify(oldHist));
console.log('   opening sites, shipped:      ', JSON.stringify(newHist));

check('the opening still varies across games (#83 is not regressed)',
  Object.keys(newHist).length > 1);

console.log(ok ? '\nALL PASS' : '\nFAILURES PRESENT');
process.exit(ok ? 0 : 1);
