// Measure how often each control-marker site actually gets taken.
//
// Raised on BGG by michael irsutti: "the AI focuses too much on the cities
// worth more VP and neglects the others — I often see games where no one takes
// 2 of the 3 bottom cities, whereas this never happens in IRL games." The
// logged corpus said the observation was right (2+ of the bottom three finish
// unclaimed in 25% of 259 games) but the explanation was not: the most
// neglected city is Araumycos at 52%, one of the two he named as over-favoured.
// What the neglect tracks is WHITE TROOPS GUARDING, not printed VP — and those
// cities finish untouched rather than contested, whites still standing.
//
// A marker site that starts full of whites cannot be deployed into at all: the
// only way in is presence from an adjacent site/route end (or a spy at the
// site), then assassinating a white to free a slot. This script plays whole
// games and reports how often each marker ends up claimed, so the behavioural
// claim can be checked rather than argued about.
//
// Usage:  npx vite-node scripts/measure-markers.ts <games> <useFittedEval 0|1>
import { CreateGameReducer, InitializeGame } from 'boardgame.io/internal';
import '../src/engine/handlers';
import { TyrantsGame, type TyrantsState } from '../src/game';
import { decideHeuristicMoveWithWeights } from '../src/ai/heuristic-ai';
import { DEFAULT_WEIGHTS } from '../src/ai/heuristic-weights';
import { SITES } from '../src/data/sites';
import type { SimulateMoveFn, RolloutToTurnEndFn } from '../src/ai/lookahead';

const GAMES = Number(process.argv[2] ?? 16);
const FITTED = Number(process.argv[3] ?? 1);
const weights = { ...DEFAULT_WEIGHTS, useFittedEval: FITTED };
const reducer = CreateGameReducer({ game: TyrantsGame as never });
type Store = { G: TyrantsState; ctx: { currentPlayer: string; gameover?: unknown } };
const act = (t: string, a: unknown[], p: string) => ({ type: 'MAKE_MOVE', payload: { type: t, args: a, playerID: p } });
const MARKERS = SITES.filter(s => s.hasControlMarker);
const BOTTOM = new Set(['chchitl', 'tsenviilyq', 'sszuraassnee']);

const unclaimed: Record<string, number> = {};
const inplay: Record<string, number> = {};
const bottomHist: Record<number, number> = {};
let finished = 0;

for (let g = 0; g < GAMES; g++) {
  let st = InitializeGame({ game: TyrantsGame as never, numPlayers: 4, setupData: { halfDecks: ['drow', 'dragons'] } as never }) as unknown as Store;
  const template = st;
  const simulate: SimulateMoveFn = (Gx, p, n, a) => {
    const w = { ...template, G: Gx, ctx: { ...template.ctx, currentPlayer: p } };
    const nx = reducer(w as never, act(n, a, p) as never) as unknown as Store;
    return nx === (w as unknown as Store) ? null : nx.G;
  };
  const rollout: RolloutToTurnEndFn = (Gx, p, n, a) => {
    let s = { ...template, G: Gx, ctx: { ...template.ctx, currentPlayer: p } } as unknown as Store;
    s = reducer(s as never, act(n, a, p) as never) as unknown as Store;
    if (s.G === Gx) return null;
    let i = 40;
    while (i-- > 0) {
      if (s.ctx.gameover || s.ctx.currentPlayer !== p) break;
      const m = decideHeuristicMoveWithWeights(s.G, p, weights);
      const nx = m ? reducer(s as never, act(m.name, m.args as unknown[], p) as never) as unknown as Store : s;
      s = nx === s ? reducer(s as never, act('endTurn', [], p) as never) as unknown as Store : nx;
    }
    return s.G;
  };
  let safety = 20000;
  while (safety-- > 0 && !st.ctx.gameover) {
    const pc = st.G.pendingChoice;
    const pid = pc?.playerId ?? st.ctx.currentPlayer;
    const m = decideHeuristicMoveWithWeights(st.G, pid, weights, simulate, rollout);
    const nx = m ? reducer(st as never, act(m.name, m.args as unknown[], pid) as never) as unknown as Store : st;
    st = nx === st ? reducer(st as never, act('endTurn', [], st.ctx.currentPlayer) as never) as unknown as Store : nx;
  }
  if (!st.ctx.gameover) continue;
  finished++;
  let nb = 0, nbin = 0;
  for (const site of MARKERS) {
    const ctl = st.G.siteControl[site.id];
    if (ctl === undefined) continue;
    inplay[site.id] = (inplay[site.id] ?? 0) + 1;
    if (ctl === null) unclaimed[site.id] = (unclaimed[site.id] ?? 0) + 1;
    if (BOTTOM.has(site.id)) { nbin++; if (ctl === null) nb++; }
  }
  if (nbin === 3) bottomHist[nb] = (bottomHist[nb] ?? 0) + 1;
}

console.log(`useFittedEval=${FITTED}  finished games: ${finished}`);
for (const s of MARKERS) {
  const n = inplay[s.id] ?? 0, u = unclaimed[s.id] ?? 0;
  if (n) console.log(`  ${s.id.padEnd(16)} whites=${s.whitesAtStart} vp=${s.vp}  unclaimed ${u}/${n} (${(u / n * 100).toFixed(0)}%)`);
}
const tot = Object.values(bottomHist).reduce((a, b) => a + b, 0);
const twoPlus = (bottomHist[2] ?? 0) + (bottomHist[3] ?? 0);
console.log(`  >=2 of the 3 bottom cities unclaimed: ${twoPlus}/${tot} (${tot ? (twoPlus / tot * 100).toFixed(0) : 0}%)`);
