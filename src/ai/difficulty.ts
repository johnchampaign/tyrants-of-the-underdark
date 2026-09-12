// The difficulty ladder, in measured strength order.
//
//   random    — picks a legal move. A sparring dummy for learning the rules.
//   easy      — heuristic, no lookahead. Beats humans ~8% in our logs.
//   heuristic — + rollout lookahead, judging a position by victory points.
//               Beats humans ~32%. Shown as "standard"; this is what the AI
//               has been for most of this game's life.
//   hard      — same search, judging positions with the evaluator fitted to
//               real recorded games. Beats the tier above it in 68% of 4P
//               games (p=0.003) and 77% of 2P games (p=1.4e-14).
//
// 'hard' shipped first and briefly WAS 'standard': the default opponent got
// sharply stronger overnight with nothing in the UI to say so, and a player who
// had found their level against the old standard had no way back to it. Hence
// the split — standard stays what people are used to, and the stronger AI is
// something you choose.
//
// This lives outside App.tsx so the tier->weights mapping has exactly ONE
// definition. scripts/test-difficulty-tiers.ts asserts against this same
// function rather than a copy of it; a test that re-implements the mapping
// would keep passing while the app drifted away from it.
import { DEFAULT_WEIGHTS, type HeuristicWeights } from './heuristic-weights';

export type AiStyle = 'random' | 'easy' | 'heuristic' | 'hard';

/** Order shown in the new-game dialog, weakest first. */
export const AI_STYLES: readonly AiStyle[] = ['random', 'easy', 'heuristic', 'hard'];

/** 'heuristic' is presented as "standard" — the internal name predates the
 *  ladder and is persisted in saved configs, so it stays. */
export function labelForStyle(style: AiStyle): string {
  return style === 'heuristic' ? 'standard' : style;
}

export function describeStyle(style: AiStyle): string {
  switch (style) {
    case 'random':
      return 'Picks a legal move at random. Almost never wins — good for learning the rules.';
    case 'easy':
      return 'Plays sensible individual moves, but does not look ahead to how the turn ends up. Beats humans ~8% of the time in our data.';
    case 'heuristic':
      return 'Plans a whole turn ahead and picks targets that pay off, judging a position by victory points. Beats humans ~32% of the time. This is what the AI has been for most of this game\'s life.';
    case 'hard':
      return 'Plans the same way, but judges a position by what actually wins games — learned from hundreds of recorded games instead of counting victory points. Beats the standard AI in about three games out of four.';
  }
}

/** Weights for one tier. 'standard' and 'hard' differ by the single
 *  `useFittedEval` switch — same search, different judgement of the positions
 *  it reaches. */
export function weightsForStyle(style: AiStyle): HeuristicWeights {
  if (style === 'easy') return { ...DEFAULT_WEIGHTS, useLookahead: 0, useFittedEval: 0 };
  return { ...DEFAULT_WEIGHTS, useFittedEval: style === 'hard' ? 1 : 0 };
}
