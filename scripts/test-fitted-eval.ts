// Guards on the corpus-fitted evaluator (src/ai/fitted-eval.json, produced by
// scripts/fit-eval.ts).
//
// The failure this file exists to prevent is a silent one. A fitted model is
// just an array of numbers; if the feature list it was trained on drifts out of
// step with the code that builds feature vectors at runtime, every weight lands
// on the wrong quantity and the evaluator keeps returning plausible-looking
// numbers that mean nothing. Nothing throws, no test goes red, the AI simply
// plays worse for reasons no one can see. So: check the shapes match, check the
// model is numerically sane, and check the on/off lever actually moves.
import { InitializeGame } from 'boardgame.io/internal';
import '../src/engine/handlers';
import { TyrantsGame, type TyrantsState } from '../src/game';
import { EVAL_FEATURE_NAMES, differentialFeatures, featuresFor, applyFitted, type FittedEval } from '../src/ai/eval-features';
import { stateValue, setFittedEval } from '../src/ai/lookahead';
import { SITES_BY_ID } from '../src/data/sites';
import MODEL_JSON from '../src/ai/fitted-eval.json';

const model = MODEL_JSON as unknown as FittedEval;
let ok = true;
const check = (label: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) ok = false;
};

const d = EVAL_FEATURE_NAMES.length;

// ---- the model file itself
check(`model names exactly the ${d} features the code builds, in order`,
  Array.isArray(model.featureNames)
  && model.featureNames.length === d
  && model.featureNames.every((n, i) => n === EVAL_FEATURE_NAMES[i]));
check('weights / mean / std are all that same length',
  model.weights?.length === d && model.mean?.length === d && model.std?.length === d);
check('every number in the model is finite',
  [...model.weights, ...model.mean, ...model.std, model.intercept].every(Number.isFinite));
check('no zero standard deviations (they would divide by zero at runtime)',
  model.std.every(v => v !== 0));
check('the model records what it was fitted on', !!model.meta && !!model.meta.games);

// ---- feature extraction
const st = InitializeGame({
  game: TyrantsGame as never, numPlayers: 4,
  setupData: { halfDecks: ['drow', 'dragons'] } as never,
}) as unknown as { G: TyrantsState; ctx: { currentPlayer: string } };

const f0 = featuresFor(st.G, '0');
check('featuresFor returns one finite number per named feature',
  f0.length === d && f0.every(Number.isFinite));
const diff = differentialFeatures(st.G, '0');
check('differentialFeatures returns the same shape', diff.length === d && diff.every(Number.isFinite));
// At setup every seat is identical, so "me minus the average opponent" is zero
// across the board. A non-zero here means the differential is picking up seat
// identity rather than position — which would make the evaluator asymmetric.
check('at a symmetric opening position every differential feature is 0',
  diff.every(v => Math.abs(v) < 1e-9));
check('applyFitted returns a finite value', Number.isFinite(applyFitted(model, diff)));

// ---- the lever
//
// Test this on an ASYMMETRIC position, not the opening. At a symmetric setup
// both evaluators correctly report ~0, so "the value changed" would pass on a
// 1e-15 difference and assert nothing. Give seat 0 a real positional edge —
// troops parked at control-marker sites, which is the largest weight in the
// fitted model and worth exactly zero VP to the shipped one — and the two
// evaluators should disagree by a visible margin.
const edge = structuredClone(st.G);
{
  const black = edge.players['0'].color;
  let placed = 0;
  for (const [spaceId, occ] of Object.entries(edge.troops)) {
    if (occ || placed >= 6) continue;
    const site = spaceId.split(':')[0];
    if (!SITES_BY_ID[site]?.hasControlMarker) continue;
    edge.troops[spaceId] = black;
    placed++;
  }
  if (placed === 0) throw new Error('test setup: found no empty marker-site spaces to occupy');
}

setFittedEval(false);
const vpOnly = stateValue(edge, '0');
setFittedEval(true);
const fitted = stateValue(edge, '0');
setFittedEval(false);
const backToVp = stateValue(edge, '0');
console.log(`   six troops at marker sites — VP-only: ${vpOnly.toFixed(3)}   fitted: ${fitted.toFixed(3)}`);
check('the fitted evaluator sees a positional edge the VP score prices at nothing',
  Math.abs(fitted - vpOnly) > 1);
check('and it scores that edge as an advantage', fitted > vpOnly);
check('turning it off again restores the VP-only value exactly', backToVp === vpOnly);
check('both evaluators return finite values', Number.isFinite(vpOnly) && Number.isFinite(fitted));

// ---- a drifted model must be REFUSED, not applied to the wrong features
const realNames = model.featureNames;
(model as { featureNames: readonly string[] }).featureNames = ['bogus'];
setFittedEval(true);
const afterDrift = stateValue(edge, '0');
(model as { featureNames: readonly string[] }).featureNames = realNames;
setFittedEval(false);
check('a model whose feature list has drifted is ignored, falling back to VP',
  afterDrift === vpOnly);

console.log(ok ? '\nALL FITTED-EVAL TESTS PASSED' : '\nFAILURES PRESENT');
process.exit(ok ? 0 : 1);
