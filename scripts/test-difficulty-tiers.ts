// The difficulty ladder must actually be a ladder.
//
// 'hard' shipped first and briefly WAS 'standard': the default opponent got
// sharply stronger overnight with nothing in the UI to say so, and a player who
// had found their level against the old standard had no way back to it. The
// split fixes that, but only if each tier really maps to the AI it claims —
// and the difference between standard and hard is one boolean deep inside the
// weights, which is exactly the kind of wiring that silently collapses.
import { InitializeGame } from 'boardgame.io/internal';
import '../src/engine/handlers';
import { TyrantsGame, type TyrantsState } from '../src/game';
import { stateValue, setFittedEval } from '../src/ai/lookahead';
import { SITES_BY_ID } from '../src/data/sites';
// The SAME mapping the app uses, not a copy of it. A test that re-implemented
// weightsForStyle would keep passing while the dialog drifted away from it.
import { AI_STYLES, weightsForStyle, labelForStyle } from '../src/ai/difficulty';

let ok = true;
const check = (label: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) ok = false;
};

const easy = weightsForStyle('easy');
const std = weightsForStyle('heuristic');
const hard = weightsForStyle('hard');

check('the ladder offers four tiers, weakest first',
  AI_STYLES.length === 4 && AI_STYLES[0] === 'random' && AI_STYLES[3] === 'hard');
check('the heuristic tier is presented to players as "standard"',
  labelForStyle('heuristic') === 'standard' && labelForStyle('hard') === 'hard');
check('easy is the only tier that turns lookahead off',
  easy.useLookahead === 0 && std.useLookahead > 0 && hard.useLookahead > 0);
check('hard is the only tier that uses the fitted evaluator',
  hard.useFittedEval === 1 && std.useFittedEval === 0 && easy.useFittedEval === 0);
check('standard and hard differ ONLY in the evaluator',
  Object.keys({ ...std, ...hard }).filter(k =>
    (std as unknown as Record<string, number>)[k] !== (hard as unknown as Record<string, number>)[k]
  ).join(',') === 'useFittedEval');

// The two evaluators must actually disagree about a position, or the ladder has
// two rungs at the same height. Use a positional edge worth no victory points:
// troops parked at control-marker sites.
const st = InitializeGame({
  game: TyrantsGame as never, numPlayers: 4,
  setupData: { halfDecks: ['drow', 'dragons'] } as never,
}) as unknown as { G: TyrantsState };
const edge = structuredClone(st.G);
const mine = edge.players['0'].color;
let placed = 0;
for (const [spaceId, occ] of Object.entries(edge.troops)) {
  if (occ || placed >= 6) continue;
  if (!SITES_BY_ID[spaceId.split(':')[0]]?.hasControlMarker) continue;
  edge.troops[spaceId] = mine;
  placed++;
}
check('test setup placed troops at marker sites', placed > 0);

setFittedEval(std.useFittedEval > 0);
const vStd = stateValue(edge, '0');
setFittedEval(hard.useFittedEval > 0);
const vHard = stateValue(edge, '0');
setFittedEval(false);
console.log(`   six troops at marker sites — standard: ${vStd.toFixed(3)}   hard: ${vHard.toFixed(3)}`);
check('the standard tier scores that positional edge at nothing (victory points only)',
  Math.abs(vStd) < 1e-9);
check('the hard tier scores it as a real advantage', vHard > 1);

console.log(ok ? '\nALL DIFFICULTY-TIER TESTS PASSED' : '\nFAILURES PRESENT');
process.exit(ok ? 0 : 1);
