// 1-ply lookahead utilities for the heuristic AI.
//
// The engine is deterministic given the current state + move (RNG is only
// used for reshuffles and rare reveals; for in-turn decisions the next
// state is fully determined). That means we can ask "if I made this move,
// what would the resulting state look like?" by running the move through
// the boardgame.io reducer and inspecting the new G.
//
// 1-ply lookahead (no opponent reply) is the simplest useful version:
//   for each candidate move:
//     next = simulate(G, pid, move)
//     value = stateValue(next, pid)
//   pick argmax
//
// This catches consequence-aware mistakes the heuristic's per-component
// scoring misses — e.g. "this assassinate target nets me total control
// AND a trophy; that one just gives me a trophy" or "this deploy is the
// one that flips site control."
//
// The lookahead path is opt-in: heuristic-ai accepts an optional
// SimulateMoveFn and falls back to pure heuristic scoring when no
// simulator is provided. The tournament runner and headless harness
// construct the simulator from their boardgame.io reducer and pass it in;
// the live web client (no lookahead) skips it.

import type { TyrantsState } from '../game';
import { scoreAll } from '../engine/scoring';
import { SITES_BY_ID } from '../data/sites';
import { differentialFeatures, applyFitted, EVAL_FEATURE_NAMES, type FittedEval } from './eval-features';
import FITTED_MODEL from './fitted-eval.json';

/** Linear evaluator fitted against the logged corpus (scripts/fit-eval.ts).
 *  Enabled per-decision via setFittedEval; null means "score by VP alone",
 *  which is the long-standing behaviour. */
let FITTED: FittedEval | null = null;

export function setFittedEval(on: boolean): FittedEval | null {
  const prev = FITTED;
  const m = FITTED_MODEL as unknown as FittedEval;
  // A model whose feature list has drifted from the code's is worse than no
  // model — the weights would be applied to the wrong quantities silently.
  const sameShape = on
    && Array.isArray(m?.featureNames)
    && m.featureNames.length === EVAL_FEATURE_NAMES.length
    && m.featureNames.every((n, i) => n === EVAL_FEATURE_NAMES[i]);
  FITTED = sameShape ? m : null;
  return prev;
}

/** Board presence that `scoreAll` cannot see, priced in VP-equivalents.
 *
 *  scoreAll answers "who would win if the game ended now?" — it counts VP and
 *  nothing else. A spy on the board is worth zero VP, so every evaluation that
 *  ends at turn-end priced a spy at nothing, while the alternative on the same
 *  card ("return a spy → +5 Power") priced out at whatever VP that power bought
 *  before the turn ended. The AI therefore cashed spies in almost every time it
 *  was offered the choice — reported from BGG as the AI making poor use of
 *  spies. These weights put a standing price on the presence itself. */
export interface PositionalWeights {
  /** VP-equivalent of one of your spies being on the board at all. */
  spy: number;
  /** Extra VP-equivalent when that spy sits at a control-marker site, where it
   *  denies the holder total control and taxes 3 power to remove. */
  spyAtMarker: number;
}

/** Module-level pointer, set by heuristic-ai for the duration of one move
 *  decision — same pattern as its WEIGHTS / SIMULATE globals. Null means
 *  "value VP only", which is the pre-existing behaviour. */
let POSITIONAL: PositionalWeights | null = null;

export function setPositionalWeights(w: PositionalWeights | null): PositionalWeights | null {
  const prev = POSITIONAL;
  POSITIONAL = w;
  return prev;
}

/** Raw presence score for one colour. Returns 0 once the end-game trigger has
 *  fired: from that point the game is decided on VP alone, and whatever a spy
 *  is still worth (denying total control in the final marker payouts) is
 *  already counted by scoreAll. This is the reporter's "except maybe during
 *  the last turn" caveat, read off the simulated state rather than guessed. */
function presenceFor(G: TyrantsState, color: string, w: PositionalWeights): number {
  if (G.endGameTriggeredAtTurn !== null) return 0;
  let v = 0;
  for (const [siteId, colors] of Object.entries(G.spies ?? {})) {
    if (!colors || !colors.includes(color as never)) continue;
    v += w.spy;
    if (SITES_BY_ID[siteId]?.hasControlMarker) v += w.spyAtMarker;
  }
  return v;
}

/** Apply one move to G and return the resulting G, or null if the move
 *  was rejected (INVALID_MOVE). The implementation lives in the harness
 *  (tournament-runner / headless) since it needs the boardgame.io reducer. */
export type SimulateMoveFn = (
  G: TyrantsState,
  playerId: string,
  moveName: string,
  args: unknown[],
) => TyrantsState | null;

/** Apply one move AND continue playing the rest of the turn heuristically
 *  (no recursive lookahead), returning the state at end-of-turn. Returns
 *  null if the initial move was rejected. The "rest of turn" is simulated
 *  with the same heuristic the AI uses, called WITHOUT a simulator — so
 *  rollouts don't trigger deeper lookahead and blow up combinatorially.
 *
 *  Used by tactical-phase decision points (assassinate target, deploy
 *  target, supplant target, spy site) where the end-of-turn consequence
 *  of a choice differs meaningfully from the immediate result — e.g.
 *  "play Master of Melee here → unlock Advance Scout at the new site →
 *  finish the turn with two trophies instead of one." */
export type RolloutToTurnEndFn = (
  G: TyrantsState,
  playerId: string,
  moveName: string,
  args: unknown[],
) => TyrantsState | null;

/** Value of a state from `pid`'s perspective: own total VP minus the
 *  MEAN of opponents' total VPs. Uses the full scoreAll so trophies,
 *  control markers, inner-circle VP, and final-scoring riders all count.
 *
 *  Why mean (not max) for an n-player game: a move that harms opponent X
 *  by 1 VP shifts my (score − mean) by 1/(N−1), not by 1. In a 4-player
 *  game that means harming any one opponent is worth roughly 1/3 as
 *  much to me as the same harm in a 2-player game — because the other
 *  two opponents (who I'm also competing with) are unaffected. Using
 *  `max` instead would credit only the leader's harm and miss the other
 *  two players' relative positioning. Per user's notes on per-player-
 *  count strategy.
 *
 *  scoreLead in game-phase.ts deliberately KEEPS `my − max(opp)`: that
 *  function decides "do I expect to WIN if the game ends now?", which
 *  is a binary against the leader, not an expected-value calculation. */
export function stateValue(G: TyrantsState, pid: string): number {
  // Fitted evaluator, when enabled: a linear model over position features
  // trained on real logged games to predict final margin directly. On held-out
  // games it identifies the eventual winner ~14pp more often than the VP-only
  // score below, and ~18pp more often in the opening third — where the VP score
  // is barely better than guessing and the AI's choices matter most.
  if (FITTED) {
    try { return applyFitted(FITTED, differentialFeatures(G, pid)); }
    catch { /* malformed position — fall through to the VP score */ }
  }
  const all = scoreAll(G);
  const w = POSITIONAL;
  const pres = (id: string) =>
    w ? presenceFor(G, G.players[id]?.color ?? '', w) : 0;
  const my = (all[pid]?.total ?? 0) + pres(pid);
  let oppSum = 0;
  let oppCount = 0;
  for (const [id, s] of Object.entries(all)) {
    if (id === pid) continue;
    oppSum += s.total + pres(id);
    oppCount++;
  }
  if (oppCount === 0) return my;
  return my - oppSum / oppCount;
}

/** Pick the best candidate by 1-ply lookahead.
 *
 *  Score = stateValue(after-move) + TIEBREAK_WEIGHT * heuristicScore(candidate).
 *
 *  The heuristic-tiebreak term is critical: most moves in this game produce
 *  identical immediate state-values (deploying into an uncontested space
 *  adds 0 VP, assassinating any troop adds +1 trophy = +1 VP, etc.). Without
 *  a tiebreak, lookahead picks arbitrarily among indistinguishable options
 *  and throws away the heuristic's per-component guidance ("this assassinate
 *  target sits at a control-marker site so it's strategically richer").
 *
 *  The tiebreak weight is small (0.01) so a genuine VP-changing consequence
 *  always trumps a heuristic preference — but among VP-equivalent options,
 *  heuristic order wins. If heuristicScore is omitted the function behaves
 *  as pure state-value argmax (identical to the prior version).
 *
 *  If simulate returns null for ALL candidates (every move rejected), the
 *  first candidate is returned as a fallback. */
const TIEBREAK_WEIGHT = 0.01;

export function lookaheadPick<C>(
  candidates: C[],
  toMove: (c: C) => { name: string; args: unknown[] },
  G: TyrantsState,
  pid: string,
  simulate: SimulateMoveFn,
  heuristicScore?: (c: C) => number,
): C {
  if (candidates.length === 1) return candidates[0];
  let bestC = candidates[0];
  let bestScore = -Infinity;
  let anyValid = false;
  for (const c of candidates) {
    const { name, args } = toMove(c);
    const next = simulate(G, pid, name, args);
    if (!next) continue;
    anyValid = true;
    let score = stateValue(next, pid);
    if (heuristicScore) score += TIEBREAK_WEIGHT * heuristicScore(c);
    if (score > bestScore) {
      bestScore = score;
      bestC = c;
    }
  }
  return anyValid ? bestC : candidates[0];
}
