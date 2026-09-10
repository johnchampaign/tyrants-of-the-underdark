// Tuneable weights for the heuristic AI. The defaults reproduce the
// hand-written numbers that were baked into heuristic-ai.ts before the
// tournament harness existed — running the AI with DEFAULT_WEIGHTS is
// byte-for-byte equivalent to the pre-parameterization version.
//
// To experiment, pass a partial override to `decideHeuristicMove` (it spreads
// over the defaults), or load a JSON weight-file from disk via the
// tournament script. The tournament runner (scripts/tournament.ts) plays
// two weight-sets head-to-head over N games and reports win rate.

export interface HeuristicWeights {
  // --- Deploy-space scoring (higher = AI prefers placing a troop there) ---
  /** Flat bonus for any space inside a real site (vs. a bare route space). */
  deployBaseSite: number;
  /** Bonus when the parent site carries a control marker. */
  deployControlMarker: number;
  /** Coefficient on the site's printed VP value. */
  deployVpMultiplier: number;
  /** Penalty per troop the AI already has at this site (encourages spreading out). */
  deployOwnPenalty: number;
  /** Bonus when this deploy would create or extend a control lead. */
  deployEstablishBonus: number;
  /** Bonus when the AI has no presence at the site yet. */
  deployFirstFootBonus: number;
  /** Score for a non-site (route) space. */
  deployRouteSpace: number;
  /** Opening deployment: coefficient on how close a candidate starting site
   *  is to the control-marker sites that are in play. Starting sites carry no
   *  control marker of their own, so ranking them by printed VP (the old
   *  behaviour) ignored the thing that actually decides the game — which
   *  markers you can reach and contest first. Scored as
   *  sum(marker payout / troops-to-take) / (1 + deploy-distance). 0 = old
   *  behaviour. Raised on BGG ("choose sites close to The Phaerlin or
   *  Gauntlgrym"), generalised to whichever markers are on the board for the
   *  current player count.
   *
   *  MEASURED at 10 over 240 games (40 x 4P + 200 x 2P) vs the old VP-only
   *  ranking: pooled gap -2.1pp in this knob's favour against a +/-8.5pp
   *  noise floor — a TIE. The two runs disagreed in direction (4P leaned
   *  baseline, 2P leaned this), which is what no real effect looks like.
   *  Shipped on the strength of the defect it fixes, not a measured win:
   *  ranking markerless starting sites by printed VP was answering a
   *  question nobody asked. Don't raise it expecting strength. */
  openingMarkerProximity: number;
  /** Opening-move variety: on its very first deploy of the game (no map
   *  presence yet), the AI samples its starting SITE from the top-K sites by
   *  deploy score, weighted by rank so the strongest stays most likely but
   *  isn't guaranteed. 1 = old behaviour (always the single best site).
   *  Per Drew W.'s feedback that the AI always opens at the same place (#83). */
  openingVarianceTopK: number;

  // --- Assassinate-space scoring ---
  assassinateWhite: number;
  assassinateEnemy: number;
  assassinateControlMarker: number;
  assassinateVpMultiplier: number;

  // --- Trash / promote / devour heuristics ---
  /** Base score for trashing a recruited (non-starter) card; cost is added to this.
   *  Higher = AI is more reluctant to trash recruited cards. */
  trashRecruitedBase: number;
  /** Don't let the cycling deck shrink below this when trashing optionally. */
  minCyclingDeck: number;

  // --- Action priorities ---
  /** Spend power on assassinate before deploy when power ≥ this. Note: the
   *  engine's assassinate base-action costs 3 power, so the heuristic floors
   *  this value at 3 internally — setting it lower in a weight file is a no-op.
   *  Raise it above 3 to make the AI MORE reluctant to assassinate (save the
   *  power for multi-deploys). */
  powerThresholdForAssassinate: number;

  // --- Site-pick (spy placement / return) ranking ---
  siteControlMarkerBonus: number;
  siteOwnSpyPenalty: number;
  /** Denial bonus: applied when placing a spy at a control-marker site
   *  that's currently controlled by an OPPONENT and has no opposing spy
   *  already there. A spy at such a site denies the opponent total
   *  control (TC) and forces them to spend power removing it — power
   *  they'd otherwise use to assassinate / deploy / build their lead.
   *  Per user's competitive-play notes. */
  siteDenialBonus: number;

  // --- Game-phase awareness (see src/ai/game-phase.ts) ---
  /** Minimum barracks across all players at which "late game" starts. */
  phaseLateBarracks: number;
  /** Minimum barracks across all players at which "endgame" starts (the
   *  user's "last turn or two" — promote-by-VP kicks in, etc.). */
  phaseEndgameBarracks: number;
  /** VP lead/deficit at which the AI considers itself "ahead" or "behind"
   *  for the purpose of late-game pacing. Symmetric: |lead| ≥ this triggers
   *  the corresponding strategy. */
  phaseLeadThreshold: number;
  /** Multiplier on assassinate priority when behind in late/endgame. Higher
   *  = AI farms trophies harder instead of deploying (which would hasten the
   *  game's end while it's losing). 1.0 = neutral. */
  behindAssassinateMultiplier: number;
  /** When behind in endgame, suppress deploys with this probability-like
   *  threshold (0.0 = always deploy as usual; 1.0 = never deploy in
   *  endgame-and-behind). Implemented as a hard skip when set above 0. */
  behindEndgameDeploySuppression: number;
  /** Multiplier on deploy priority when ahead in late/endgame. Higher
   *  = AI drains its barracks faster to trigger game-end while leading. */
  aheadDeployUrgencyMultiplier: number;
  /** In endgame phase, promote the highest-innerCircleVp card instead of
   *  the trashiest. Treated as 0 (off) or 1 (on); fractional values blend
   *  the two scoring strategies linearly (0.5 = tie-break by VP only). */
  endgamePromoteByVp: number;

  // --- Recruit value scoring (market row + aux stacks) ---
  // Per competitive-play wisdom, Priestess of Lolth (cost 2, +2 inf, IC VP 2)
  // is a great deal and players sometimes deny-buy them. The old "always
  // pick highest cost in market" rule never considered aux stacks at all
  // and underbought them as a fallback. These weights score each candidate
  // purchase; the AI picks the highest score across market + aux stacks.
  /** Coefficient on the card's innerCircleVp (banked at game end if promoted). */
  recruitIcVpWeight: number;
  /** Coefficient on the card's deckVp (small permanent VP per copy in deck). */
  recruitDeckVpWeight: number;
  /** Coefficient on the card's cost (proxy for in-play strength of the effect). */
  recruitCostWeight: number;
  /** Flat additive bonus for aux-stack candidates (Priestess, House Guard).
   *  Captures the denial value + reliability (15 copies, always available)
   *  that the per-card stats don't reflect. */
  recruitAuxStackBonus: number;
  /** Blend factor 0..1: 0 = score by raw value (favors high-cost cards),
   *  1 = score by value/cost (per-influence efficiency — favors Priestess
   *  and House Guard). Intermediate values interpolate. */
  recruitPerInfluenceBlend: number;
  /** Flat bonus added to a market candidate whose card is 'tactical' — i.e.
   *  its effect touches the board (place/return spy, assassinate, supplant,
   *  promote; categories from src/ai/card-classes.ts). Motivated by
   *  RedMedusa61s's feedback (#84): the AI never contests a human's
   *  total-site-control lead because its recruit step values cards only by
   *  VP + cost and so underbuys spy/assassinate denial cards.
   *
   *  KEPT AT 0 (no behavior change). Tournament testing (240-game 2P A/B vs
   *  default) showed a FLAT bonus does not help and overdoing it hurts: at
   *  +8 and +12 the baseline beat it ~62-64% (past the ±9pp noise floor); +4
   *  was a wash. Tactical cards tend to carry lower VP, so a flat acquisition
   *  bonus distorts buying toward cheap board-action filler over high-VP
   *  cards and the influence engine. A real fix needs CONDITIONAL valuation
   *  — e.g. only prize spy/denial cards when an opponent is at/near total
   *  control — not a blanket bonus. This knob is left as a tunable lever
   *  (same pattern as recruitAuxStackBonus) for that future work. */
  recruitTacticalBonus: number;

  // --- Positional value (lookahead evaluation) ---
  /** VP-equivalent price of one of your spies being on the board, added to the
   *  lookahead's end-of-turn evaluation. See PositionalWeights in
   *  src/ai/lookahead.ts for why an evaluation built on scoreAll alone can't
   *  see a spy at all. 0 = old behaviour (VP only).
   *
   *  MEASURED AND REVERTED TO 0. Two instruments, same answer:
   *
   *  1. Tournaments (240 games) said TIE, both runs leaning baseline.
   *  2. scripts/bench-eval.ts, scoring the evaluator against 10,979 real
   *     logged positions with known outcomes, says any positive value makes
   *     it WORSE at naming the eventual winner, monotonically:
   *       0 -> 53.8%   0.5 -> 53.0%   1 -> 52.8%   2 -> 50.9%   5 -> 45.0%
   *     (Spearman falls 0.3945 -> 0.2041 across the same range.)
   *
   *  The premise was wrong, not just the magnitude. Over 20,599 mid-game
   *  seat-positions, spies ON THE BOARD correlate -0.12 with final margin:
   *  eventual winners are sitting on 0.94 of them, everyone else 1.34. A
   *  spy's value is in being SPENT (draw / power / supplant), not parked, so
   *  pricing a parked spy as an asset was pricing the wrong thing. The
   *  likeliest confound is worth stating: a player who is behind places spies
   *  defensively to deny total control, so this may be a symptom of losing
   *  rather than a cause. Either way the data does not support the term.
   *
   *  The knob and its code path are kept — the lever works, and
   *  scripts/test-ai-spy-opening.ts pins that it does — so a better-shaped
   *  version (decaying with game progress, or valuing only spies that deny
   *  an opponent's total control) can be tried and measured in seconds. */
  spyPresenceValue: number;
  /** Extra VP-equivalent when that spy sits at a control-marker site. */
  spyMarkerPresenceValue: number;

  // --- Lookahead toggle ---
  /** Enable 1-ply lookahead at high-leverage decision points (assassinate
   *  target, deploy target, spy site, supplant target). Treat as 0/1:
   *  fractional values don't blend usefully. When the heuristic is called
   *  with no simulator (e.g. the live web client), this knob is moot. */
  useLookahead: number;
  /** Enable category-based hand-play ordering (src/ai/card-classes.ts).
   *  0 = play hand[0] every time (legacy behavior), 1 = sort by category
   *  rank: hand-mutators first, power, tactical, influence. */
  useCardOrdering: number;
}

export const DEFAULT_WEIGHTS: HeuristicWeights = {
  deployBaseSite: 5,
  deployControlMarker: 12,
  deployVpMultiplier: 1,
  deployOwnPenalty: 2,
  deployEstablishBonus: 3,
  deployFirstFootBonus: 2,
  deployRouteSpace: 1,
  openingVarianceTopK: 4,
  openingMarkerProximity: 10,

  assassinateWhite: 2,
  assassinateEnemy: 6,
  assassinateControlMarker: 6,
  assassinateVpMultiplier: 1,

  trashRecruitedBase: 10,
  minCyclingDeck: 5,

  powerThresholdForAssassinate: 3,

  siteControlMarkerBonus: 10,
  siteOwnSpyPenalty: 5,
  siteDenialBonus: 15,

  // Phase thresholds — user-supplied rules-of-thumb: "38 barracks → still
  // getting started; 8 barracks → game will be over soon."
  phaseLateBarracks: 15,
  phaseEndgameBarracks: 5,
  phaseLeadThreshold: 10,
  behindAssassinateMultiplier: 1.5,
  behindEndgameDeploySuppression: 0.5,
  aheadDeployUrgencyMultiplier: 1.5,
  endgamePromoteByVp: 1.0,

  // Recruit scoring defaults: roughly preserves "buy highest-cost market
  // card" behavior when big market cards are affordable (recruitCostWeight
  // is high), but now ALSO considers aux stacks — so Priestess at 2 inf
  // gets bought when nothing pricier is affordable instead of ending the
  // turn with unspent influence. Tune recruitPerInfluenceBlend up to favor
  // efficiency (per competitive play, Priestess is great value).
  recruitIcVpWeight: 2,
  recruitDeckVpWeight: 1,
  recruitCostWeight: 2,
  recruitAuxStackBonus: 0,
  recruitPerInfluenceBlend: 0,
  recruitTacticalBonus: 4,

  spyPresenceValue: 0,
  spyMarkerPresenceValue: 0,

  useLookahead: 1,
  useCardOrdering: 1,
};

/** Merge a partial weights override onto the defaults. Missing fields fall
 *  through to DEFAULT_WEIGHTS so a tuner can mutate just one knob at a time. */
export function makeWeights(overrides?: Partial<HeuristicWeights>): HeuristicWeights {
  return { ...DEFAULT_WEIGHTS, ...(overrides ?? {}) };
}
